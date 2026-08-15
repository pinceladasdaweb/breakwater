import { RateLimitedError } from '../errors'
import { basePolicy, type Policy } from '../policy'
import { assertOneOf, assertPositiveFinite, assertPositiveInt } from '../validate'
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
  /** Identifies this rate limit in metrics, and keys it in a shared store. */
  name?: string
  /**
   * Shares the quota across instances. Without it the limit is this
   * process's alone, so a fleet of N allows N times the rate. Requires a
   * stable `name` — that is the key the quota is shared under.
   */
  store?: RateLimitStore
}

/**
 * The quota a store is asked to enforce. It travels with every call rather
 * than being configured on the store, so the policy stays the single source
 * of truth and the two can never disagree about the limit.
 */
export interface RateLimitQuota {
  limit: number
  interval: number
  strategy: 'token-bucket' | 'sliding-window'
  /** Token bucket only: capacity. Equals `limit` unless `burst` was set. */
  burst: number
}

/** One admission decision, and what it leaves behind. */
export interface RateLimitDecision {
  admitted: boolean
  /** 0 when admitted; otherwise how long until a slot frees. */
  retryAfterMs: number
  /** Executions still allowed without waiting, after this decision. */
  remaining: number
}

/**
 * Pluggable quota backend. The default limiter is in-process; a shared one
 * makes the quota the fleet's rather than each instance's.
 *
 * `acquire` must be atomic: deciding and consuming in two steps lets two
 * instances both see the last slot. It must also never reject — a quota
 * backend that is down should degrade to enforcing the limit locally, not
 * take the caller down with it.
 */
export interface RateLimitStore {
  acquire: (name: string, quota: RateLimitQuota) => RateLimitDecision | Promise<RateLimitDecision>
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
export interface Limiter {
  tryAcquire: (now: number) => number
  remaining: (now: number) => number
}

const ADMITTED = 0

export function tokenBucket (limit: number, interval: number, capacity: number): Limiter {
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

export function slidingWindow (limit: number, interval: number): Limiter {
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

      // No verification loop here, unlike the token bucket: this window only
      // adds and subtracts timestamps, so rounding the difference up is
      // already sufficient — there is no division to accumulate error.
      return Math.max(1, Math.ceil(oldestAt + interval - now))
    },
    remaining (rawNow) {
      const now = clamp(rawNow)
      const cutoff = now - interval
      // The ring is logically sorted (the clamp keeps admissions monotonic),
      // so the first entry still inside the window is found by binary search
      // instead of an O(limit) scan — remaining() runs on every rejection,
      // which is exactly when load peaks.
      let lo = 0
      let hi = filled
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if ((ring[(oldest + mid) % limit] as number) > cutoff) hi = mid
        else lo = mid + 1
      }
      return limit - (filled - lo)
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
  assertOneOf('strategy', strategy, ['token-bucket', 'sliding-window'])
  const burst = options.burst ?? limit
  assertPositiveInt('burst', burst)

  const store = options.store
  const name = options.name
  if (store !== undefined && (name === undefined || name.length === 0)) {
    throw new RangeError('a shared rate limit needs a stable name — that is the key the quota lives under')
  }
  const quota: RateLimitQuota = { limit, interval, strategy, burst }

  // Not built at all when the quota is shared: the sliding window allocates
  // a ring the size of the limit, and nothing would ever read it.
  const limiter = store !== undefined
    ? undefined
    : strategy === 'token-bucket'
      ? tokenBucket(limit, interval, burst)
      : slidingWindow(limit, interval)

  const emitter = createEmitter<RateLimitEvents>()

  // Last-known remaining, for a shared store: `stats()` stays synchronous
  // whether the quota lives in this process or across the fleet.
  let lastRemaining = strategy === 'token-bucket' ? burst : limit
  let acquireSeq = 0

  const stats = (): RateLimitStats => ({
    remaining: limiter === undefined ? lastRemaining : limiter.remaining(Date.now()),
    limit,
    interval,
    strategy
  })

  const base = basePolicy(async (fn, ctx) => {
    ctx.signal.throwIfAborted()

    let retryAfterMs: number
    if (limiter !== undefined) {
      retryAfterMs = limiter.tryAcquire(Date.now())
    } else {
      const seq = ++acquireSeq
      const decision = await (store as RateLimitStore).acquire(name as string, quota)
      // The same discipline every other mirror here has: a slow older read
      // must not overwrite what a newer one already reported.
      if (seq === acquireSeq) lastRemaining = decision.remaining
      retryAfterMs = decision.admitted ? ADMITTED : Math.max(1, decision.retryAfterMs)
    }

    if (retryAfterMs !== ADMITTED) {
      // One snapshot for both the event and the error: stats() walks the
      // limiter state, and the rejection path is the storm path.
      const snapshot = stats()
      emitter.emit('reject', { stats: snapshot, retryAfterMs, correlationId: ctx.correlationId })
      throw new RateLimitedError(snapshot, retryAfterMs)
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
