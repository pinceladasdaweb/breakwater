import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { timeout } from '../src/timeout/timeout'
import { isTimeoutError, TimeoutError } from '../src/errors'

import { drain } from './helpers'

describe('timeout()', () => {
  test('rejects invalid ms', () => {
    assert.throws(() => timeout(0), RangeError)
    assert.throws(() => timeout(-5), RangeError)
    assert.throws(() => timeout(Infinity), RangeError)
  })

  test('resolves normally when the function finishes in time', async () => {
    const policy = timeout(1_000)
    assert.equal(await policy.execute(() => 'fast'), 'fast')
  })

  test('cooperative: aborts the signal and maps the rejection to TimeoutError', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = timeout(50)
    const events: unknown[] = []
    policy.on('timeout', (e) => events.push(e))

    const promise = policy.execute(async ({ signal }) => {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const assertion = assert.rejects(promise, (error: unknown) => {
      assert.ok(isTimeoutError(error))
      assert.equal(error.ms, 50)
      assert.equal(error.mode, 'cooperative')
      return true
    })

    await drain()
    t.mock.timers.tick(50)
    await assertion
    assert.equal(events.length, 1)
  })

  test('cooperative: a function that rejects with its own abort error is normalized to TimeoutError with cause', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = timeout(50)
    // What fetch and friends reject with when their signal aborts.
    const abortError = new DOMException('The operation was aborted', 'AbortError')

    const promise = policy.execute(async ({ signal }) => {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(abortError), { once: true })
      })
    })
    const assertion = assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof TimeoutError)
      assert.equal(error.cause, abortError)
      return true
    })

    await drain()
    t.mock.timers.tick(50)
    await assertion
  })

  test('cooperative: a function that ignores the signal and resolves later still succeeds, with no timeout event', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = timeout(50)
    const events: unknown[] = []
    policy.on('timeout', (e) => events.push(e))

    const promise = policy.execute(async () => {
      return await new Promise((resolve) => setTimeout(() => resolve('late but done'), 100))
    })
    // Prevent an unhandled-rejection crash if the implementation ever changes.
    const settled = promise.catch((e) => { throw e })

    await drain()
    t.mock.timers.tick(50)
    await drain()
    t.mock.timers.tick(50)
    assert.equal(await settled, 'late but done')
    // The call did not end in a timeout: telemetry must not say it did.
    assert.equal(events.length, 0)
  })

  test('cooperative: a genuine domain error landing after the deadline is not masked as TimeoutError', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = timeout(50)
    const events: unknown[] = []
    policy.on('timeout', (e) => events.push(e))

    const promise = policy.execute(async () => {
      return await new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('db constraint violation')), 100))
    })
    const assertion = assert.rejects(promise, /db constraint violation/)

    await drain()
    t.mock.timers.tick(50)
    await drain()
    t.mock.timers.tick(50)
    await assertion
    assert.equal(events.length, 0)
  })

  test('external abort while the timer is pending is cancellation, not timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = timeout(50)
    const events: unknown[] = []
    policy.on('timeout', (e) => events.push(e))
    const controller = new AbortController()

    const promise = policy.execute(async ({ signal }) => {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 100), { once: true })
      })
    }, { signal: controller.signal })
    const assertion = assert.rejects(promise, /user cancelled/)

    await drain()
    controller.abort(new Error('user cancelled'))
    await drain()
    t.mock.timers.tick(50) // the timer fires while fn winds down — must be a no-op
    await drain()
    t.mock.timers.tick(100)
    await assertion
    assert.equal(events.length, 0)
  })

  test('aggressive: external abort rejects promptly even though fn ignores signals', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = timeout(30_000, { mode: 'aggressive' })
    const controller = new AbortController()

    const promise = policy.execute(
      async () => await new Promise(() => {}), // ignores the signal forever
      { signal: controller.signal }
    )
    const assertion = assert.rejects(promise, /shutdown now/)

    await drain()
    controller.abort(new Error('shutdown now'))
    await assertion // resolves without ticking the 30s timer
  })

  test('aggressive: rejects immediately while the function keeps running', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = timeout(50, { mode: 'aggressive' })
    let finished = false

    const promise = policy.execute(async () => {
      return await new Promise((resolve) => setTimeout(() => { finished = true; resolve('orphan') }, 1_000))
    })
    const assertion = assert.rejects(promise, (error: unknown) => {
      assert.ok(isTimeoutError(error))
      assert.equal(error.mode, 'aggressive')
      return true
    })

    await drain()
    t.mock.timers.tick(50)
    await assertion
    assert.equal(finished, false)
  })

  test('failures unrelated to the timeout pass through untouched', async () => {
    const policy = timeout(1_000)
    await assert.rejects(policy.execute(() => { throw new Error('domain error') }), /domain error/)
  })

  test('an already-aborted external signal rejects before running the function', async () => {
    const policy = timeout(1_000)
    const controller = new AbortController()
    controller.abort(new Error('cancelled by caller'))
    let ran = false

    await assert.rejects(
      policy.execute(() => { ran = true; return 'x' }, { signal: controller.signal }),
      /cancelled by caller/
    )
    assert.equal(ran, false)
  })

  test('external abort during execution propagates the abort reason, not TimeoutError', async () => {
    const policy = timeout(1_000)
    const controller = new AbortController()

    const promise = policy.execute(async ({ signal }) => {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }, { signal: controller.signal })
    const assertion = assert.rejects(promise, /user cancelled/)

    controller.abort(new Error('user cancelled'))
    await assertion
  })
})
