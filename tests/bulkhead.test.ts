import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { bulkhead } from '../src/bulkhead/bulkhead'
import { isBulkheadRejectedError } from '../src/errors'
import { drain, gated } from './helpers'

describe('bulkhead() options', () => {
  test('rejects invalid options, naming the offending one', () => {
    assert.throws(() => bulkhead({ concurrency: 0 }), { name: 'RangeError', message: /concurrency/ })
    assert.throws(() => bulkhead({ concurrency: 1.5 }), { name: 'RangeError', message: /concurrency/ })
    assert.throws(() => bulkhead({ queue: -1 }), { name: 'RangeError', message: /queue/ })
    assert.throws(() => bulkhead({ queue: 0.5 }), { name: 'RangeError', message: /queue/ })
  })
})

describe('admission', () => {
  test('runs immediately below the concurrency limit', async () => {
    const policy = bulkhead({ concurrency: 2 })
    assert.equal(await policy.execute(() => 'a'), 'a')
    assert.equal(await policy.execute(() => 'b'), 'b')
    assert.deepEqual(policy.stats(), { active: 0, queued: 0, concurrency: 2, queueLimit: 0 })
  })

  test('never exceeds the concurrency limit under a concurrent burst', async () => {
    const policy = bulkhead({ concurrency: 2, queue: 10 })
    let concurrent = 0
    let maxConcurrent = 0
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()

    const calls = Array.from({ length: 8 }, async () =>
      await policy.execute(async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await gate
        concurrent--
        return 'ok'
      })
    )

    await drain()
    assert.equal(policy.stats().active, 2)
    assert.equal(policy.stats().queued, 6)

    release()
    await Promise.all(calls)
    assert.ok(maxConcurrent <= 2, `expected at most 2 concurrent, saw ${maxConcurrent}`)
    assert.equal(policy.stats().active, 0)
  })

  test('rejects with BULKHEAD_REJECTED carrying stats when slots and queue are full', async () => {
    const policy = bulkhead({ concurrency: 1, queue: 1 })
    const g = gated()

    const first = policy.execute(g.fn)
    await drain()
    const second = policy.execute(g.fn) // occupies the single queue spot
    await drain()

    await assert.rejects(policy.execute(() => 'third'), (error: unknown) => {
      assert.ok(isBulkheadRejectedError(error))
      assert.equal(error.code, 'BULKHEAD_REJECTED')
      assert.equal(error.retryable, true)
      assert.deepEqual(error.stats, { active: 1, queued: 1, concurrency: 1, queueLimit: 1 })
      return true
    })

    g.release()
    assert.equal(await first, 'done')
    assert.equal(await second, 'done')
  })

  test('default queue is zero: saturation rejects immediately', async () => {
    const policy = bulkhead({ concurrency: 1 })
    const g = gated()

    const first = policy.execute(g.fn)
    await drain()
    await assert.rejects(policy.execute(() => 'x'), isBulkheadRejectedError)

    g.release()
    await first
  })
})

describe('queue', () => {
  test('admits waiters in FIFO order', async () => {
    const policy = bulkhead({ concurrency: 1, queue: 3 })
    const order: string[] = []
    const g = gated()

    const blocker = policy.execute(g.fn)
    await drain()

    const waiters = ['a', 'b', 'c'].map(async (id) =>
      await policy.execute(() => { order.push(id); return id })
    )
    await drain()
    assert.equal(policy.stats().queued, 3)

    g.release()
    await blocker
    await Promise.all(waiters)
    assert.deepEqual(order, ['a', 'b', 'c'])
  })

  test('a failing execution still hands its slot to the next waiter', async () => {
    const policy = bulkhead({ concurrency: 1, queue: 2 })
    const g = gated()

    const failing = policy.execute(g.fn).catch((e: unknown) => (e as Error).message)
    await drain()
    const queued = policy.execute(() => 'queued ran')

    g.fail(new Error('exploded'))
    assert.equal(await failing, 'exploded')
    assert.equal(await queued, 'queued ran')
    assert.equal(policy.stats().active, 0)
  })

  test('aborting a queued execution frees its queue position and never runs it', async () => {
    const policy = bulkhead({ concurrency: 1, queue: 1 })
    const controller = new AbortController()
    const g = gated()
    let ran = false

    const first = policy.execute(g.fn)
    await drain()
    const cancelled = policy.execute(
      () => { ran = true; return 'never' },
      { signal: controller.signal }
    )
    const assertion = assert.rejects(cancelled, /left the queue/)
    await drain()
    assert.equal(policy.stats().queued, 1)

    controller.abort(new Error('left the queue'))
    await assertion
    assert.equal(ran, false)
    assert.equal(policy.stats().queued, 0)

    // The freed position admits someone else while the slot is still busy.
    const replacement = policy.execute(() => 'replacement')
    await drain()
    assert.equal(policy.stats().queued, 1)

    g.release()
    await first
    assert.equal(await replacement, 'replacement')
  })

  test('aborting a waiter in the middle of the queue removes that one', async () => {
    const policy = bulkhead({ concurrency: 1, queue: 3 })
    const controller = new AbortController()
    const g = gated()
    const order: string[] = []

    const blocker = policy.execute(g.fn)
    await drain()

    const first = policy.execute(() => { order.push('first'); return 'first' })
    const cancelled = policy.execute(
      () => { order.push('cancelled'); return 'x' },
      { signal: controller.signal }
    )
    const last = policy.execute(() => { order.push('last'); return 'last' })
    await drain()
    const assertion = assert.rejects(cancelled, /gave up waiting/)

    controller.abort(new Error('gave up waiting'))
    await assertion
    assert.equal(policy.stats().queued, 2)

    g.release()
    await blocker
    assert.equal(await first, 'first')
    assert.equal(await last, 'last')
    // Neither neighbour was evicted in its place.
    assert.deepEqual(order, ['first', 'last'])
  })

  test('an already-aborted signal rejects before consuming slot or queue', async () => {
    const policy = bulkhead({ concurrency: 1, queue: 1 })
    const controller = new AbortController()
    controller.abort(new Error('pre-aborted'))

    await assert.rejects(
      policy.execute(() => 'x', { signal: controller.signal }),
      /pre-aborted/
    )
    assert.deepEqual(policy.stats(), { active: 0, queued: 0, concurrency: 1, queueLimit: 1 })
  })
})

describe('events and stats', () => {
  test('emits reject with a stats snapshot and the correlationId', async () => {
    const policy = bulkhead({ concurrency: 1 })
    const rejections: string[] = []
    policy.on('reject', ({ stats, correlationId }) => {
      assert.equal(stats.active, 1)
      rejections.push(correlationId)
    })
    const g = gated()

    const first = policy.execute(g.fn)
    await drain()
    await assert.rejects(policy.execute(() => 'x', { correlationId: 'req-9' }))

    assert.deepEqual(rejections, ['req-9'])
    g.release()
    await first
  })

  test('stats reflect live occupancy', async () => {
    const policy = bulkhead({ concurrency: 2, queue: 2 })
    const g = gated()

    const calls = [policy.execute(g.fn), policy.execute(g.fn), policy.execute(g.fn)]
    await drain()
    assert.deepEqual(policy.stats(), { active: 2, queued: 1, concurrency: 2, queueLimit: 2 })

    g.release()
    await Promise.all(calls)
    assert.deepEqual(policy.stats(), { active: 0, queued: 0, concurrency: 2, queueLimit: 2 })
  })
})
