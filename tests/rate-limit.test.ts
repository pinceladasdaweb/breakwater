import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { rateLimit } from '../src/rate-limit/rate-limit'
import { isRateLimitedError } from '../src/errors'

describe('rateLimit() options', () => {
  test('rejects invalid options, naming the offending one', () => {
    assert.throws(() => rateLimit({ limit: 0, interval: 1_000 }), { name: 'RangeError', message: /limit/ })
    assert.throws(() => rateLimit({ limit: 1.5, interval: 1_000 }), { name: 'RangeError', message: /limit/ })
    assert.throws(() => rateLimit({ limit: 10, interval: 0 }), { name: 'RangeError', message: /interval/ })
    assert.throws(() => rateLimit({ limit: 10, interval: 1_000, burst: 0 }), { name: 'RangeError', message: /burst/ })
    // A typo would otherwise silently select the other strategy.
    assert.throws(
      () => rateLimit({ limit: 10, interval: 1_000, strategy: 'token_bucket' as never }),
      { name: 'RangeError', message: /strategy/ }
    )
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

  test('retryAfterMs discounts the tokens already refilled', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 10, interval: 1_000, burst: 1 }) // one token per 100ms

    await policy.execute(() => 'a')
    t.mock.timers.tick(50) // half a token is already back

    await assert.rejects(policy.execute(() => 'x'), (error: unknown) => {
      assert.ok(isRateLimitedError(error))
      // Half the wait has been served: telling the caller to wait 100ms again
      // would throttle it below the configured rate.
      assert.equal(error.retryAfterMs, 50)
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

  test('refills at limit/interval, not a whole bucket at a time', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    // 10 per second (one token every 100ms), burst of 3.
    const policy = rateLimit({ limit: 10, interval: 1_000, burst: 3 })

    for (const id of ['a', 'b', 'c']) await policy.execute(() => id)
    await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)

    t.mock.timers.tick(100)
    assert.equal(policy.stats().remaining, 1)
    assert.equal(await policy.execute(() => 'd'), 'd')
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

  test('remaining bottoms out at zero, never below', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 2, interval: 1_000, strategy: 'sliding-window' })

    await policy.execute(() => 'a')
    await policy.execute(() => 'b')
    assert.equal(policy.stats().remaining, 0)

    // A dashboard reading a saturated limiter must never see a negative quota.
    await assert.rejects(policy.execute(() => 'x'), isRateLimitedError)
    assert.equal(policy.stats().remaining, 0)
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

describe('sliding window occupancy search', () => {
  test('remaining stays exact after the ring wraps around', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = rateLimit({ limit: 3, interval: 1_000, strategy: 'sliding-window' })

    // Two full laps around the ring, 500ms apart each.
    for (let i = 0; i < 6; i++) {
      await policy.execute(() => i)
      t.mock.timers.tick(500)
    }

    // The ring wrapped twice and now holds t+1500, t+2000, t+2500. At
    // t+3000 only t+2500 is strictly inside the window (t+2000 is exactly
    // interval old, which counts as out).
    assert.equal(policy.stats().remaining, 2)

    t.mock.timers.tick(600) // t+3600: everything has left the window
    assert.equal(policy.stats().remaining, 3)
  })
})

describe('clock and float-precision hardening', () => {
  test('waiting exactly retryAfterMs is always sufficient (float rounding)', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    // 1/161 cannot be represented exactly: 161 * (1/161) is 0.999…, so the
    // naive ceil((1 - tokens) / rate) lands one millisecond short here and
    // the answer has to be verified against the arithmetic the next call
    // will actually run.
    const policy = rateLimit({ limit: 1, interval: 161, burst: 1 })

    await policy.execute(() => 'a')
    await assert.rejects(policy.execute(() => 'x'), (error: unknown) => {
      assert.ok(isRateLimitedError(error))
      assert.equal(error.retryAfterMs, 162)
      return true
    })

    t.mock.timers.tick(162)
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

describe('a shared quota', () => {
  test('a store decides admission, and stats() reports what it left', async () => {
    const decisions = [
      { admitted: true, retryAfterMs: 0, remaining: 2 },
      { admitted: false, retryAfterMs: 250, remaining: 0 }
    ]
    const asked: Array<{ name: string, quota: unknown }> = []
    const limiter = rateLimit({
      limit: 10,
      interval: 1_000,
      burst: 3,
      name: 'partner-api',
      store: {
        acquire: (name, quota) => {
          asked.push({ name, quota })
          return decisions.shift() as { admitted: boolean, retryAfterMs: number, remaining: number }
        }
      }
    })

    assert.equal(limiter.stats().remaining, 3, 'the burst, before the fleet has said anything')

    assert.equal(await limiter.execute(() => 'ok'), 'ok')
    assert.equal(limiter.stats().remaining, 2)

    await assert.rejects(limiter.execute(() => 'ok'), (error: unknown) => {
      const rejected = error as { code: string, retryAfterMs: number }
      assert.equal(rejected.code, 'RATE_LIMITED')
      assert.equal(rejected.retryAfterMs, 250)
      return true
    })
    assert.equal(limiter.stats().remaining, 0)

    // The quota travels with the call, so the store can never hold a
    // different limit than the policy was configured with.
    assert.deepEqual(asked[0], {
      name: 'partner-api',
      quota: { limit: 10, interval: 1_000, strategy: 'token-bucket', burst: 3 }
    })
  })

  test('a rejection always carries a wait, even from a store that reports none', async () => {
    const limiter = rateLimit({
      limit: 1,
      interval: 1_000,
      name: 'api',
      store: { acquire: () => ({ admitted: false, retryAfterMs: 0, remaining: 0 }) }
    })

    // "Rejected, try again in zero milliseconds" is not an instruction
    // anybody can follow — a caller backing off needs a real number.
    await assert.rejects(limiter.execute(() => 'ok'), (error: unknown) => {
      assert.ok((error as { retryAfterMs: number }).retryAfterMs >= 1)
      return true
    })
  })

  test('an async store is awaited before the call is admitted', async () => {
    let admitted = false
    const limiter = rateLimit({
      limit: 1,
      interval: 1_000,
      name: 'api',
      store: {
        acquire: async () => {
          await new Promise((resolve) => setImmediate(resolve))
          admitted = true
          return { admitted: true, retryAfterMs: 0, remaining: 0 }
        }
      }
    })

    assert.equal(await limiter.execute(() => {
      assert.equal(admitted, true, 'the quota decides before the function runs')
      return 'ok'
    }), 'ok')
  })

  test('a shared quota without a name is refused at construction', () => {
    const store = { acquire: () => ({ admitted: true, retryAfterMs: 0, remaining: 1 }) }
    assert.throws(() => rateLimit({ limit: 1, interval: 1_000, store }), { name: 'RangeError', message: /stable name/ })
    assert.throws(() => rateLimit({ limit: 1, interval: 1_000, name: '', store }), { name: 'RangeError', message: /stable name/ })
  })

  test('the sliding window strategy reaches the store as itself', async () => {
    let seen: string | undefined
    const limiter = rateLimit({
      limit: 1,
      interval: 1_000,
      strategy: 'sliding-window',
      name: 'api',
      store: {
        acquire: (_name, quota) => {
          seen = quota.strategy
          return { admitted: true, retryAfterMs: 0, remaining: 0 }
        }
      }
    })

    await limiter.execute(() => 'ok')
    assert.equal(seen, 'sliding-window')
  })
})
