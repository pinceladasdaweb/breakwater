export {
  BreakwaterError,
  TimeoutError,
  CircuitOpenError,
  IsolatedError,
  RetryExhaustedError,
  FallbackFailedError,
  isBreakwaterError,
  isTimeoutError,
  isCircuitOpenError,
  isIsolatedError,
  isRetryExhaustedError,
  isFallbackFailedError
} from './errors'

export { createContext, basePolicy } from './policy'
export type { Policy, ExecutionContext, ExecuteOptions, Execution, Invoker } from './policy'

export { createEmitter } from './events'
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
export type { StateStore, BreakerState, WindowCounters, MemoryStoreOptions } from './circuit-breaker/state-store'

export { fallback } from './fallback/fallback'
export type { FallbackHandler, FallbackOptions, FallbackEvents, FallbackPolicy } from './fallback/fallback'

export { compose } from './compose/compose'

export { resilience } from './compose/resilience'
export type { ResilienceOptions } from './compose/resilience'

export type { MetricsCollector } from './metrics/collector'
