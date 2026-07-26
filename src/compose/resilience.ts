import { compose } from './compose'
import { basePolicy, type Policy } from '../policy'
import { retry, type RetryOptions } from '../retry/retry'
import { type MetricsCollector } from '../metrics/collector'
import { timeout, type TimeoutOptions } from '../timeout/timeout'
import { bulkhead, type BulkheadOptions } from '../bulkhead/bulkhead'
import { circuitBreaker, type CircuitBreakerOptions } from '../circuit-breaker/circuit-breaker'
import { fallback as fallbackPolicy, type FallbackHandler, type FallbackOptions } from '../fallback/fallback'

export interface ResilienceOptions {
  retry?: RetryOptions
  /**
   * Sits outside the circuit breaker: local saturation never pollutes the
   * dependency's failure stats, and the (retryable) rejection lets the
   * outer retry back off and try again.
   */
  bulkhead?: BulkheadOptions
  circuitBreaker?: CircuitBreakerOptions
  /** A number is a shortcut for `{ ms }` with the default mode. */
  timeout?: number | ({ ms: number } & TimeoutOptions)
  /** A single handler, or a chain tried in order. */
  fallback?: FallbackHandler<unknown> | Array<FallbackHandler<unknown>>
  /** Options for the fallback policy (e.g. fallbackIf). */
  fallbackOptions?: FallbackOptions
  /** Receives the pipeline's metrics without any per-policy wiring. */
  metrics?: MetricsCollector
}

/**
 * The batteries-included composition for those who do not want to pick an
 * order: fallback(retry(bulkhead(circuitBreaker(timeout(fn))))).
 *
 * Retry sits outside the breaker on purpose: every attempt goes through the
 * breaker (feeding its stats individually), and once the circuit opens the
 * retry sees CircuitOpenError and gives up fast (default retryIf).
 * For a different order, compose() the policies yourself.
 */
export function resilience (options: ResilienceOptions = {}): Policy {
  const name = options.circuitBreaker?.name

  const fb = options.fallback !== undefined
    ? fallbackPolicy(options.fallback, options.fallbackOptions)
    : undefined
  const rt = options.retry !== undefined ? retry(options.retry) : undefined
  const bh = options.bulkhead !== undefined ? bulkhead(options.bulkhead) : undefined
  const cb = options.circuitBreaker !== undefined ? circuitBreaker(options.circuitBreaker) : undefined
  const to = options.timeout !== undefined
    ? typeof options.timeout === 'number'
      ? timeout(options.timeout)
      : timeout(options.timeout.ms, options.timeout)
    : undefined

  // Assembly order is the documented default:
  // fallback(retry(bulkhead(breaker(timeout(fn))))).
  const slots: Array<Policy | undefined> = [fb, rt, bh, cb, to]
  const policies = slots.filter((p): p is Policy => p !== undefined)

  const composed = policies.length > 0
    ? compose(...policies)
    : basePolicy(async (fn, ctx) => await fn(ctx))

  const metrics = options.metrics
  if (metrics === undefined) return composed

  // Wiring follows the slot order: fallback, retry, bulkhead, breaker, timeout.
  fb?.on('fallback', ({ handlerIndex }) => metrics.onFallback?.({ name, handlerIndex }))
  rt?.on('retry', ({ attempt, delay }) => metrics.onRetry?.({ name, attempt, delayMs: delay }))
  bh?.on('reject', () => metrics.onReject?.({ policy: 'bulkhead', name: options.bulkhead?.name ?? name, reason: 'bulkhead_full' }))
  cb?.on('stateChange', ({ from, to: toState }) => metrics.onStateChange?.({ name, from, to: toState }))
  cb?.on('reject', ({ reason }) => metrics.onReject?.({ policy: 'circuitBreaker', name, reason }))
  to?.on('timeout', ({ ms }) => metrics.onTimeout?.({ name, ms }))

  return basePolicy(async (fn, ctx) => {
    const started = Date.now()
    try {
      const result = await composed.invoke(fn, ctx)
      metrics.onExecution?.({
        policy: 'resilience',
        name,
        outcome: 'success',
        durationMs: Date.now() - started,
        correlationId: ctx.correlationId
      })
      return result
    } catch (error) {
      metrics.onExecution?.({
        policy: 'resilience',
        name,
        outcome: 'failure',
        durationMs: Date.now() - started,
        correlationId: ctx.correlationId
      })
      throw error
    }
  })
}
