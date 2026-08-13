import { isCircuitOpenError, isIsolatedError } from '../errors'
import { createEmitter, withObservable, type Observable } from '../events'
import { basePolicy, type Execution, type ExecutionContext, type Policy } from '../policy'
import { assertNonNegative } from '../validate'
import { memoryCache, type CacheEntry, type CacheStore } from './cache-store'

export interface StaleCacheOptions<T = unknown> {
  /**
   * Decides which errors are rescued with a stale value. Default: only
   * fast rejections from an open or isolated circuit — the literal
   * stale-while-open. Pass `() => true` to serve stale on ANY failure.
   */
  staleIf?: (error: unknown) => boolean
  /**
   * Derives the cache key from the execution context (usually from
   * `ctx.metadata`). Default: a single shared slot — the policy remembers
   * exactly one last good response, which fits the one-policy-per-endpoint
   * layout. A throwing key extractor is contained like a throwing store.
   */
  key?: (ctx: ExecutionContext) => string
  /**
   * Upper bound on how old a served value may be, in ms. An entry past it
   * is left alone but never served. Default: no bound — by opting into
   * stale you declared that an old answer beats no answer.
   */
  maxAge?: number
  /** The storage behind the cache. Default: a fresh memoryCache(). */
  store?: CacheStore<T>
}

export interface StaleCacheEvents extends Record<string, unknown> {
  /** A failure was rescued with a cached value. */
  stale: { key: string, ageMs: number, error: unknown, correlationId: string }
  /** A failure qualified for rescue but nothing servable was cached. */
  miss: { key: string, error: unknown, correlationId: string }
}

export interface StaleCachePolicy extends Policy, Observable<StaleCacheEvents> {
  readonly kind: 'staleCache'
  /**
   * Drops every cached value: delegates to the store's optional clear()
   * and lets its errors propagate. A store without clear() is left
   * untouched — implement it to make this call mean something.
   */
  clear: () => Promise<void>
}

/** The default staleIf: rescue only what an open circuit refused to run. */
const circuitRejection = (error: unknown): boolean =>
  isCircuitOpenError(error) || isIsolatedError(error)

/**
 * Remembers the last good response and serves it when the pipeline cannot
 * produce a fresh one — by default, while the circuit breaker is open
 * (stale-while-open). Place it OUTSIDE the breaker, and outside the retry,
 * so a rescue only happens once retrying has given up — resilience() wires
 * exactly that order.
 *
 * Every execution still runs: this is not a read-through cache and never
 * short-circuits a healthy call. On success the result is stored; on a
 * qualifying failure the stored value is served instead of the error.
 *
 * Three things never activate a rescue: cancellation (the caller aborting
 * is not the dependency failing), errors the `staleIf` rejects, and
 * entries older than `maxAge`.
 *
 * Errors are contained by role and by moment: a store (or key extractor)
 * that throws is reported to `console.error` and contained — while
 * storing, the success stands; while rescuing, the ORIGINAL error
 * propagates. Only `clear()`, a manual control call, lets store errors
 * reach the caller.
 *
 * Values are cached and served by reference: cache what you are happy to
 * hand to several callers, or clone before returning it. Concurrent
 * successes resolve last-write-wins by completion order — both candidates
 * are genuine recent successes, so no fencing is needed.
 *
 * The type parameter is advisory, like fallback's: it types the store and
 * documents intent, but the compiler cannot connect cached values to each
 * `execute<T>()` call — one policy instance serves one response shape.
 */
export function staleCache<T = unknown> (options: StaleCacheOptions<T> = {}): StaleCachePolicy {
  const staleIf = options.staleIf ?? circuitRejection
  const keyOf = options.key ?? (() => '')
  const maxAge = options.maxAge ?? Infinity
  // Explicit Infinity is the documented default spelled out — valid, like
  // the exponential backoff's max.
  if (options.maxAge !== undefined && options.maxAge !== Infinity) assertNonNegative('maxAge', options.maxAge)
  const store: CacheStore<T> = options.store ?? memoryCache<T>()

  const emitter = createEmitter<StaleCacheEvents>()

  const base = basePolicy(async <R>(fn: Execution<R>, ctx: ExecutionContext): Promise<R> => {
    let result: R
    try {
      result = await fn(ctx)
    } catch (error) {
      if (ctx.signal.aborted) throw error
      if (!staleIf(error)) throw error

      // The rescue attempt: any throw in here (store, key extractor) is
      // contained and the original failure propagates — a broken cache
      // must never replace the real error with its own.
      let rescued: { value: R } | undefined
      try {
        const key = keyOf(ctx)
        const entry = await store.get(key)
        const ageMs = entry === undefined ? 0 : ageOf(entry)
        if (entry !== undefined && ageMs <= maxAge) {
          emitter.emit('stale', { key, ageMs, error, correlationId: ctx.correlationId })
          // The policy contract is generic per call while the store is
          // typed at the factory; the caller guarantees they line up.
          rescued = { value: entry.value as unknown as R }
        } else {
          emitter.emit('miss', { key, error, correlationId: ctx.correlationId })
        }
      } catch (storeError) {
        console.error('breakwater: stale cache store threw', storeError)
      }
      if (rescued !== undefined) return rescued.value
      throw error
    }

    // Success bookkeeping: contained — a throwing store may cost a future
    // rescue, never this execution's outcome.
    try {
      const hints = maxAge === Infinity ? undefined : { maxAgeMs: maxAge }
      await store.set(keyOf(ctx), { value: result as unknown as T, storedAt: Date.now() }, hints)
    } catch (storeError) {
      console.error('breakwater: stale cache store threw', storeError)
    }
    return result
  })

  return withObservable({
    ...base,
    kind: 'staleCache' as const,
    async clear () {
      await store.clear?.()
    }
  }, emitter)
}

const ageOf = (entry: CacheEntry): number => Math.max(0, Date.now() - entry.storedAt)
