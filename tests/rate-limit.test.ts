import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { rateLimit } from '../src/rate-limit/rate-limit'
import { isRateLimitedError } from '../src/errors'

describe('rateLimit() options', () => {
  test('rejects invalid options', () => {
    assert.throws(() => rateLimit({ limit: 0, interval: 1_000 }), RangeError)
    assert.throws(() => rateLimit({ limit: 1.5, interval: 1_000 }), RangeError)
    assert.throws(() => rateLimit({ limit: 10, interval: 0 }), RangeError)
    assert.throws(() => rateLimit({ limit: 10, interval: 1_000, burst: 0 }), RangeError)
  })
})

describe('token bucket (default)', () => {
  test('admits up to the burst immediately, then rejects with retryAfterMs', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    // 10 per second, bucket of 2.
    const policy = rateLimit({ limit: 10, interval: 1_000, burst: 2 })

    assert.equal(await policy.execute(() => 'a'), 'a')
    assert.equal(await policy.execute(() => 'b'), 'b')

    await assert.rejects(policy.execute(() => 'c'), (error: unknown) => {
      assert.ok(isRateLimitedError(error))
      assert.equal(error.code, 'RATE_LIMITED')
      assert.equal(error.retryable, true)
      assert.equal(error.retryAfterMs, 100) // 1 token every 100ms
      assert.equal(error.stats.remaining, 0)
      return true
    })
  })

  test('tokens refill continuously with time', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 10, interval: 1_000, burst: 1 })

    assert.equal(await policy.execute(() => 'a'), 'a')
    await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)

    t.mock.timers.tick(100) // exactly one token refilled
    assert.equal(await policy.execute(() => 'b'), 'b')
    await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)
  })

  test('the bucket never exceeds its capacity', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 10, interval: 1_000, burst: 2 })

    t.mock.timers.tick(60_000) // a long quiet hour would not mint extra burst
    assert.equal(policy.stats().remaining, 2)

    assert.equal(await policy.execute(() => 'a'), 'a')
    assert.equal(await policy.execute(() => 'b'), 'b')
    await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)
  })

  test('default burst equals limit', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 3, interval: 1_000 })

    for (const id of ['a', 'b', 'c']) assert.equal(await policy.execute(() => id), id)
    await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)
  })
})

describe('sliding window', () => {
  test('never admits more than limit in any window of interval ms', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 2, interval: 1_000, strategy: 'sliding-window' })

    assert.equal(await policy.execute(() => 'a'), 'a')
    t.mock.timers.tick(400)
    assert.equal(await policy.execute(() => 'b'), 'b')

    // Window [600_000ms ago..now] holds 2 admissions: reject with the time
    // until the OLDEST leaves the window.
    await assert.rejects(policy.execute(() => 'x'), (error: unknown) => {
      assert.ok(isRateLimitedError(error))
      assert.equal(error.retryAfterMs, 600)
      return true
    })

    t.mock.timers.tick(600) // the first admission leaves the window
    assert.equal(await policy.execute(() => 'c'), 'c')

    // Now the window holds b (t+400) and c (t+1000): full again.
    await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)
  })

  test('remaining reflects live occupancy of the window', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 3, interval: 1_000, strategy: 'sliding-window' })

    assert.equal(policy.stats().remaining, 3)
    await policy.execute(() => 'a')
    await policy.execute(() => 'b')
    assert.equal(policy.stats().remaining, 1)

    t.mock.timers.tick(1_000)
    assert.equal(policy.stats().remaining, 3)
  })
})

describe('clock and float-precision hardening', () => {
  test('waiting exactly retryAfterMs is always sufficient (float rounding)', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    // Configuration reproduced from the review: naive ceil((1-tokens)/rate)
    // landed one millisecond short here.
    const policy = rateLimit({ limit: 1, interval: 8_737, burst: 1 })

    await policy.execute(() => 'a')
    let retryAfterMs = 0
    await assert.rejects(policy.execute(() => 'x'), (error: unknown) => {
      assert.ok(isRateLimitedError(error))
      retryAfterMs = error.retryAfterMs
      return true
    })

    t.mock.timers.tick(retryAfterMs)
    assert.equal(await policy.execute(() => 'b'), 'b')
  })

  test('polling stats() never changes admission outcomes (pure reads)', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    // Configuration reproduced from the review: per-ms segmented refills
    // accumulated to 0.999… while a single refill reaches 1.0.
    const policy = rateLimit({ limit: 1, interval: 7, burst: 1 })

    await policy.execute(() => 'a')
    for (let i = 0; i < 7; i++) {
      t.mock.timers.tick(1)
      policy.stats() // a monitoring loop must be a pure observer
    }
    assert.equal(await policy.execute(() => 'b'), 'b')
  })

  test('token bucket: a backwards clock step never mints tokens', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 1, interval: 60_000, burst: 1 })

    await policy.execute(() => 'a')

    t.mock.timers.setTime(940_000) // clock steps back a minute
    await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)

    t.mock.timers.setTime(1_000_000) // clock recovers to the same instant
    // The already-spent interval must not be credited twice.
    await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)

    t.mock.timers.setTime(1_060_000) // one real interval later
    assert.equal(await policy.execute(() => 'b'), 'b')
  })

  test('sliding window: a backwards clock step neither freezes nor corrupts the ring', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 2, interval: 1_000, strategy: 'sliding-window' })

    await policy.execute(() => 'a')
    await policy.execute(() => 'b')

    t.mock.timers.setTime(400_000) // clock steps back 10 minutes
    await assert.rejects(policy.execute(() => 'x'), (error: unknown) => {
      assert.ok(isRateLimitedError(error))
      // The limiter must not be dead for backstep + interval.
      assert.ok(error.retryAfterMs <= 1_000, `retryAfterMs ${error.retryAfterMs} exceeds the interval`)
      return true
    })

    t.mock.timers.setTime(1_001_000) // one interval after the admissions
    assert.equal(await policy.execute(() => 'c'), 'c')
    assert.equal(await policy.execute(() => 'd'), 'd')
  })
})

describe('behavior as a policy', () => {
  test('a rejected call does not consume quota', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 1, interval: 1_000 })

    await policy.execute(() => 'a')
    for (let i = 0; i < 5; i++) {
      await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)
    }

    // Five rejections later, one interval still admits exactly one call.
    t.mock.timers.tick(1_000)
    assert.equal(await policy.execute(() => 'b'), 'b')
  })

  test('failures still consume quota (the call was made)', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 1, interval: 1_000 })

    await assert.rejects(policy.execute(() => { throw new Error('boom') }), /boom/)
    await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)
  })

  test('an already-aborted signal rejects without consuming quota', async () => {
    const policy = rateLimit({ limit: 1, interval: 1_000 })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    await assert.rejects(policy.execute(() => 'x', { signal: controller.signal }), /cancelled/)
    assert.equal(policy.stats().remaining, 1)
  })

  test('emits reject with stats, retryAfterMs and correlationId', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 1, interval: 1_000 })
    const events: Array<{ retryAfterMs: number, correlationId: string }> = []
    policy.on('reject', ({ retryAfterMs, correlationId }) => events.push({ retryAfterMs, correlationId }))

    await policy.execute(() => 'a')
    await assert.rejects(policy.execute(() => 'x', { correlationId: 'req-1' }))

    assert.equal(events.length, 1)
    assert.equal(events[0]?.correlationId, 'req-1')
    assert.equal(events[0]?.retryAfterMs, 1_000)
  })
})
