import { basePolicy, type Policy } from '../policy'
import { compose, type ComposedPolicy } from './compose'
import { retry, type RetryOptions } from '../retry/retry'
import { type MetricsCollector } from '../metrics/collector'
import { attachMetrics, metricsPolicy } from '../metrics/attach'
import { timeout, type TimeoutOptions } from '../timeout/timeout'
import { bulkhead, type BulkheadOptions } from '../bulkhead/bulkhead'
import { rateLimit, type RateLimitOptions } from '../rate-limit/rate-limit'
import { circuitBreaker, type CircuitBreakerOptions } from '../circuit-breaker/circuit-breaker'
import { fallback as fallbackPolicy, type FallbackHandler, type FallbackOptions } from '../fallback/fallback'

export interface ResilienceOptions {
  /**
   * Identifies the whole pipeline in every metric event. Falls back to the
   * circuit breaker's name.
   */
  name?: string
  retry?: RetryOptions
  /**
   * Sits outside the bulkhead: the quota check is the cheapest rejection,
   * so it runs before a slot is even considered. Retryable — the quota
   * replenishes on its own, and the outer retry backs off through it.
   */
  rateLimit?: RateLimitOptions
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
 * order: fallback(retry(rateLimit(bulkhead(circuitBreaker(timeout(fn)))))).
 *
 * Retry sits outside the breaker on purpose: every attempt goes through the
 * breaker (feeding its stats individually), and once the circuit opens the
 * retry sees CircuitOpenError and gives up fast (default retryIf).
 * For a different order, compose() the policies yourself.
 */
export function resilience (options: ResilienceOptions = {}): ComposedPolicy {
  const name = options.name ?? options.circuitBreaker?.name
  const metrics = options.metrics

  const fb = options.fallback !== undefined
    ? fallbackPolicy(options.fallback, options.fallbackOptions)
    : undefined
  const rt = options.retry !== undefined ? retry(options.retry) : undefined
  const rl = options.rateLimit !== undefined ? rateLimit(options.rateLimit) : undefined
  const bh = options.bulkhead !== undefined ? bulkhead(options.bulkhead) : undefined
  const cb = options.circuitBreaker !== undefined ? circuitBreaker(options.circuitBreaker) : undefined
  const to = options.timeout !== undefined
    ? typeof options.timeout === 'number'
      ? timeout(options.timeout)
      : timeout(options.timeout.ms, options.timeout)
    : undefined

  if (metrics !== undefined) {
    // Same generic wiring compose() users get from attachMetrics — the only
    // extra here is honoring each guard's own metrics name.
    if (fb !== undefined) attachMetrics(fb, metrics, { name })
    if (rt !== undefined) attachMetrics(rt, metrics, { name })
    if (rl !== undefined) attachMetrics(rl, metrics, { name: options.rateLimit?.name ?? name })
    if (bh !== undefined) attachMetrics(bh, metrics, { name: options.bulkhead?.name ?? name })
    if (cb !== undefined) attachMetrics(cb, metrics, { name })
    if (to !== undefined) attachMetrics(to, metrics, { name })
  }

  // Assembly order is the documented default, with the pipeline-level
  // execution meter outermost when metrics are wired:
  // metrics(fallback(retry(rateLimit(bulkhead(breaker(timeout(fn))))))).
  const mp = metrics !== undefined ? metricsPolicy(metrics, { name, label: 'resilience' }) : undefined
  const slots: Array<Policy | undefined> = [mp, fb, rt, rl, bh, cb, to]
  const policies = slots.filter((p): p is Policy => p !== undefined)

  if (policies.length === 0) {
    policies.push(basePolicy(async (fn, ctx) => await fn(ctx)))
  }

  return compose(...policies)
}
