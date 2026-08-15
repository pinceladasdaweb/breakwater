export {
  BreakwaterError,
  TimeoutError,
  CircuitOpenError,
  IsolatedError,
  BulkheadRejectedError,
  RateLimitedError,
  RetryExhaustedError,
  FallbackFailedError,
  isBreakwaterError,
  isTimeoutError,
  isCircuitOpenError,
  isIsolatedError,
  isBulkheadRejectedError,
  isRateLimitedError,
  isRetryExhaustedError,
  isFallbackFailedError
} from './errors'

export { createContext, basePolicy } from './policy'
export type { Policy, ExecutionContext, ExecuteOptions, Execution, Invoker } from './policy'

export { createEmitter, withObservable } from './events'
export type { TypedEmitter, Observable, EventMap, Listener } from './events'

export { timeout } from './timeout/timeout'
export type { TimeoutOptions, TimeoutEvents, TimeoutPolicy } from './timeout/timeout'

export { retry } from './retry/retry'
export type { RetryOptions, RetryEvents, RetryPolicy } from './retry/retry'

export { fixed, linear, exponential } from './retry/backoff'
export type { Backoff, LinearBackoffOptions, ExponentialBackoffOptions } from './retry/backoff'

export { circuitBreaker } from './circuit-breaker/circuit-breaker'
export type {
  CircuitBreakerOptions,
  CircuitBreakerEvents,
  CircuitBreakerPolicy,
  CircuitBreakerStats
} from './circuit-breaker/circuit-breaker'

export { countWindow, timeWindow } from './circuit-breaker/window'
export type { Window } from './circuit-breaker/window'

export { memoryStore } from './circuit-breaker/state-store'
export type { StateStore, StateSnapshot, CasOutcome, BreakerState, WindowCounters, LatencyStats, MemoryStore, MemoryStoreOptions } from './circuit-breaker/state-store'

export { bulkhead } from './bulkhead/bulkhead'
export type { BulkheadOptions, BulkheadEvents, BulkheadPolicy, BulkheadStats } from './bulkhead/bulkhead'

export { rateLimit } from './rate-limit/rate-limit'
export type { RateLimitOptions, RateLimitEvents, RateLimitPolicy, RateLimitStats, RateLimitStore, RateLimitQuota, RateLimitDecision } from './rate-limit/rate-limit'

export { fallback } from './fallback/fallback'
export type { FallbackHandler, FallbackOptions, FallbackEvents, FallbackPolicy } from './fallback/fallback'

export { staleCache } from './stale-cache/stale-cache'
export type { StaleCacheOptions, StaleCacheEvents, StaleCachePolicy } from './stale-cache/stale-cache'

export { memoryCache } from './stale-cache/cache-store'
export type { CacheStore, CacheEntry, CacheSetHints, MemoryCacheOptions } from './stale-cache/cache-store'

export { compose } from './compose/compose'
export type { ComposedPolicy, ComposedStatsEntry } from './compose/compose'

export { resilience } from './compose/resilience'
export type { ResilienceOptions } from './compose/resilience'

export { createPolicyRegistry, policies } from './registry/registry'
export type { PolicyRegistry } from './registry/registry'

export type { MetricsCollector } from './metrics/collector'

export { attachMetrics, metricsPolicy } from './metrics/attach'
export type { AttachMetricsOptions, MetricsPolicy, MetricsPolicyOptions } from './metrics/attach'
