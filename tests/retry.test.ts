import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { retry } from '../src/retry/retry'
import { fixed } from '../src/retry/backoff'
import { BreakwaterError, isRetryExhaustedError } from '../src/errors'

import { drain } from './helpers'

/** Fails `failures` times, then succeeds. */
function flaky (failures: number): () => string {
  let calls = 0
  return () => {
    calls++
    if (calls <= failures) throw new Error(`failure ${calls}`)
    return `ok after ${calls}`
  }
}

describe('retry()', () => {
  test('rejects invalid options', () => {
    assert.throws(() => retry({ attempts: 0 }), RangeError)
    assert.throws(() => retry({ attempts: 1.5 }), RangeError)
    assert.throws(() => retry({ deadline: -1 }), RangeError)
  })

  test('returns on first success without waiting', async () => {
    const policy = retry({ attempts: 3, backoff: fixed(1_000) })
    assert.equal(await policy.execute(() => 'immediate'), 'immediate')
  })

  test('retries until success and exposes the 0-based attempt in the context', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = retry({ attempts: 3, backoff: fixed(100) })
    const seenAttempts: number[] = []
    const fail = flaky(2)

    const promise = policy.execute(({ attempt }) => {
      seenAttempts.push(attempt)
      return fail()
    })
    const settled = promise.then((v) => v)

    await drain()
    t.mock.timers.tick(100)
    await drain()
    t.mock.timers.tick(100)

    assert.equal(await settled, 'ok after 3')
    assert.deepEqual(seenAttempts, [0, 1, 2])
  })

  test('throws RetryExhaustedError with the last error as cause when every attempt fails', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = retry({ attempts: 2, backoff: fixed(10) })

    const promise = policy.execute(() => { throw new Error('always down') })
    const assertion = assert.rejects(promise, (error: unknown) => {
      assert.ok(isRetryExhaustedError(error))
      assert.equal(error.attempts, 2)
      assert.match((error.cause as Error).message, /always down/)
      return true
    })

    await drain()
    t.mock.timers.tick(10)
    await assertion
  })

  test('emits retry and giveUp events with attempt, error and delay', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = retry({ attempts: 2, backoff: fixed(10) })
    const retries: Array<{ attempt: number, delay: number }> = []
    let gaveUp = 0
    policy
      .on('retry', ({ attempt, delay }) => retries.push({ attempt, delay }))
      .on('giveUp', () => { gaveUp++ })

    const promise = policy.execute(() => { throw new Error('down') })
    const assertion = assert.rejects(promise, isRetryExhaustedError)

    await drain()
    t.mock.timers.tick(10)
    await assertion

    assert.deepEqual(retries, [{ attempt: 1, delay: 10 }])
    assert.equal(gaveUp, 1)
  })

  test('does not retry when retryIf returns false, propagating the original error', async () => {
    const policy = retry({ attempts: 3, backoff: fixed(1), retryIf: (e) => (e as Error).message !== 'fatal' })
    let calls = 0

    await assert.rejects(
      policy.execute(() => { calls++; throw new Error('fatal') }),
      /fatal/
    )
    assert.equal(calls, 1)
  })

  test('does not retry errors flagged retryable: false by default', async () => {
    const policy = retry({ attempts: 3, backoff: fixed(1) })
    let calls = 0

    await assert.rejects(
      policy.execute(() => {
        calls++
        throw new BreakwaterError('circuit is open', 'CIRCUIT_OPEN', { retryable: false })
      }),
      /circuit is open/
    )
    assert.equal(calls, 1)
  })

  test('does not retry real circuit breaker rejections by default', async () => {
    const { circuitBreaker } = await import('../src/circuit-breaker/circuit-breaker')
    const { compose } = await import('../src/compose/compose')
    const breaker = circuitBreaker({ consecutiveFailures: 1 })
    const policy = compose(retry({ attempts: 5, backoff: fixed(0) }), breaker)
    let calls = 0

    // First attempt fails and opens the circuit; second attempt hits the
    // open breaker and the default retryIf stops immediately.
    await assert.rejects(policy.execute(() => { calls++; throw new Error('down') }))
    assert.equal(calls, 1)
  })

  test('gives up immediately when the next delay would exceed the deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const policy = retry({ attempts: 10, backoff: fixed(500), deadline: 800 })
    let calls = 0

    const promise = policy.execute(() => { calls++; throw new Error('down') })
    const assertion = assert.rejects(promise, isRetryExhaustedError)

    await drain()
    t.mock.timers.tick(500) // first delay: elapsed 500
    await drain()
    // second delay would end at 1000 > 800: gives up without a third call
    await assertion
    assert.equal(calls, 2)
  })

  test('abort during the delay rejects with the abort reason and stops retrying', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const controller = new AbortController()
    const policy = retry({ attempts: 5, backoff: fixed(1_000) })
    let calls = 0

    const promise = policy.execute(
      () => { calls++; throw new Error('down') },
      { signal: controller.signal }
    )
    const assertion = assert.rejects(promise, /stop everything/)

    await drain()
    controller.abort(new Error('stop everything'))
    await assertion
    assert.equal(calls, 1)
  })

  test('does not retry when the signal aborted during the execution itself', async () => {
    const controller = new AbortController()
    const policy = retry({ attempts: 5, backoff: fixed(1) })
    let calls = 0

    await assert.rejects(
      policy.execute(({ signal }) => {
        calls++
        controller.abort(new Error('cancelled mid-flight'))
        assert.equal(signal.aborted, true)
        throw new Error('failed because of cancellation')
      }, { signal: controller.signal }),
      /failed because of cancellation/
    )
    assert.equal(calls, 1)
  })

  test('a factory-level signal also cancels retries', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const controller = new AbortController()
    const policy = retry({ attempts: 5, backoff: fixed(1_000), signal: controller.signal })
    let calls = 0

    const promise = policy.execute(() => { calls++; throw new Error('down') })
    const assertion = assert.rejects(promise, /shutdown/)

    await drain()
    controller.abort(new Error('shutdown'))
    await assertion
    assert.equal(calls, 1)
  })
})
