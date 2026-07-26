import { RateLimitedError } from '../errors'
import { basePolicy, type Policy } from '../policy'
import { assertPositiveFinite, assertPositiveInt } from '../validate'
import { createEmitter, withObservable, type Observable } from '../events'

export interface RateLimitOptions {
  /** Executions allowed per interval. */
  limit: number
  /** The interval, in milliseconds. */
  interval: number
  /**
   * - `token-bucket` (default): tokens refill continuously at
   *   limit/interval; short bursts up to `burst` are absorbed.
   * - `sliding-window`: exact — never more than `limit` executions in any
   *   window of `interval` ms.
   */
  strategy?: 'token-bucket' | 'sliding-window'
  /** Token bucket only: bucket capacity (burst size). Default: `limit`. */
  burst?: number
  /** Identifies this rate limit in metrics. */
  name?: string
}

export interface RateLimitStats {
  /** Executions currently allowed without waiting. */
  remaining: number
  limit: number
  interval: number
  strategy: 'token-bucket' | 'sliding-window'
}

export interface RateLimitEvents extends Record<string, unknown> {
  reject: { stats: RateLimitStats, retryAfterMs: number, correlationId: string }
}

export interface RateLimitPolicy extends Policy, Observable<RateLimitEvents> {
  readonly kind: 'rateLimit'
  stats: () => RateLimitStats
}

/** Admission strategy: either admits now or says how long until it would. */
interface Limiter {
  tryAcquire: (now: number) => number
  remaining: (now: number) => number
}

const ADMITTED = 0

function tokenBucket (limit: number, interval: number, capacity: number): Limiter {
  const ratePerMs = limit / interval
  // State commits ONLY on admission. Reads (rejections, stats) are pure:
  // segmented refills accumulate float error differently than a single
  // refill, so a mutating read could flip admission outcomes at the margin.
  let tokens = capacity
  let refilledAt: number | undefined

  // Monotonic clamp: after a backwards clock step, time simply stands still
  // for the bucket — no tokens minted when the clock recovers, no freeze.
  const clamp = (now: number): number =>
    refilledAt === undefined || now > refilledAt ? now : refilledAt

  const tokensAt = (now: number): number =>
    refilledAt === undefined
      ? tokens
      : Math.min(capacity, tokens + (now - refilledAt) * ratePerMs)

  return {
    tryAcquire (rawNow) {
      const now = clamp(rawNow)
      const available = tokensAt(now)

      if (available >= 1) {
        tokens = available - 1
        refilledAt = now
        return ADMITTED
      }

      // Sufficient by construction: bump until the exact arithmetic the
      // next call will run actually clears one token (float rounding can
      // leave the naive ceil one millisecond short).
      let wait = Math.max(1, Math.ceil((1 - available) / ratePerMs))
      while (tokensAt(now + wait) < 1) wait++
      return wait
    },
    remaining (rawNow) {
      return Math.floor(tokensAt(clamp(rawNow)))
    }
  }
}

function slidingWindow (limit: number, interval: number): Limiter {
  // Ring of the last `limit` admission timestamps: O(1) admission and O(limit)
  // memory — exact sliding log without unbounded growth.
  const ring = new Float64Array(limit)
  let filled = 0
  let oldest = 0
  // Monotonic clamp: keeps the ring sorted and the limiter alive when the
  // wall clock steps backwards (otherwise a backstep freezes admissions for
  // backstep + interval and can corrupt the oldest-entry invariant).
  let lastSeen = -Infinity

  const clamp = (now: number): number => {
    if (now > lastSeen) lastSeen = now
    return lastSeen
  }

  return {
    tryAcquire (rawNow) {
      const now = clamp(rawNow)

      if (filled < limit) {
        ring[(oldest + filled) % limit] = now
        filled++
        return ADMITTED
      }

      const oldestAt = ring[oldest] as number

      if (now - oldestAt >= interval) {
        ring[oldest] = now
        oldest = (oldest + 1) % limit
        return ADMITTED
      }

      // Sufficient by construction, as in the token bucket.
      let wait = Math.max(1, Math.ceil(oldestAt + interval - now))
      while (now + wait - oldestAt < interval) wait++
      return wait
    },
    remaining (rawNow) {
      const now = clamp(rawNow)
      let inWindow = 0
      for (let i = 0; i < filled; i++) {
        if (now - (ring[(oldest + i) % limit] as number) < interval) inWindow++
      }
      return limit - inWindow
    }
  }
}

/**
 * Caps the execution rate: calls beyond the quota reject immediately with
 * RateLimitedError carrying `retryAfterMs`. Client-side quota — protects a
 * dependency's documented rate limit before the wire, not instead of the
 * server's own enforcement.
 */
export function rateLimit (options: RateLimitOptions): RateLimitPolicy {
  const { limit, interval } = options
  assertPositiveInt('limit', limit)
  assertPositiveFinite('interval', interval)
  const strategy = options.strategy ?? 'token-bucket'
  const burst = options.burst ?? limit
  assertPositiveInt('burst', burst)

  const limiter = strategy === 'token-bucket'
    ? tokenBucket(limit, interval, burst)
    : slidingWindow(limit, interval)

  const emitter = createEmitter<RateLimitEvents>()

  const stats = (): RateLimitStats => ({
    remaining: limiter.remaining(Date.now()),
    limit,
    interval,
    strategy
  })

  const base = basePolicy(async (fn, ctx) => {
    ctx.signal.throwIfAborted()

    const retryAfterMs = limiter.tryAcquire(Date.now())
    if (retryAfterMs !== ADMITTED) {
      emitter.emit('reject', { stats: stats(), retryAfterMs, correlationId: ctx.correlationId })
      throw new RateLimitedError(stats(), retryAfterMs)
    }

    return await fn(ctx)
  })

  const policy = {
    ...base,
    kind: 'rateLimit' as const,
    stats
  }

  return withObservable(policy, emitter)
}
