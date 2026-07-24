import type { CircuitBreakerStats } from './circuit-breaker/circuit-breaker'

/**
 * Base class for every error thrown by breakwater.
 *
 * Consumers must branch on the stable `code` property (or use the exported
 * type guards), never on error messages.
 */
export class BreakwaterError extends Error {
  readonly code: string
  /**
   * Whether a retry policy should consider retrying this error. Errors that
   * describe a deliberate fast rejection (open circuit, isolation) set this
   * to false at their definition site; user retryIf predicates can read it.
   */
  readonly retryable: boolean

  constructor (message: string, code: string, options?: ErrorOptions & { retryable?: boolean }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
    this.retryable = options?.retryable ?? true
  }
}

/** Thrown by the timeout policy when an execution exceeds its time budget. */
export class TimeoutError extends BreakwaterError {
  /** Configured timeout, in milliseconds. */
  readonly ms: number
  /** Timeout mode in effect when the execution was aborted. */
  readonly mode: 'cooperative' | 'aggressive'

  constructor (ms: number, mode: 'cooperative' | 'aggressive', options?: ErrorOptions) {
    super(`Execution timed out after ${ms}ms (${mode} mode)`, 'TIMEOUT', options)
    this.ms = ms
    this.mode = mode
  }
}

/**
 * Thrown by the circuit breaker, without executing the function, while the
 * circuit is open (fail-fast). Carries a snapshot of the breaker stats at
 * rejection time.
 */
export class CircuitOpenError extends BreakwaterError {
  readonly stats: CircuitBreakerStats

  constructor (stats: CircuitBreakerStats) {
    super('Circuit breaker is open — request rejected without execution', 'CIRCUIT_OPEN', { retryable: false })
    this.stats = stats
  }
}

/**
 * Thrown by the circuit breaker while manually isolated via isolate().
 * Unlike the open state, isolation never expires on its own.
 */
export class IsolatedError extends BreakwaterError {
  constructor () {
    super('Circuit breaker is manually isolated — request rejected without execution', 'CIRCUIT_ISOLATED', { retryable: false })
  }
}

/**
 * Thrown by the retry policy when every attempt failed (or the deadline
 * would be exceeded). The last underlying error is available as `cause`.
 */
export class RetryExhaustedError extends BreakwaterError {
  /** Number of attempts actually performed. */
  readonly attempts: number

  constructor (attempts: number, cause: unknown) {
    super(`Retry exhausted after ${attempts} attempt${attempts === 1 ? '' : 's'}`, 'RETRY_EXHAUSTED', { cause })
    this.attempts = attempts
  }
}

/**
 * Thrown by the fallback policy when the operation failed and every fallback
 * handler in the chain failed too. The operation's error is `originalError`;
 * the last handler's error is `cause`.
 */
export class FallbackFailedError extends BreakwaterError {
  /** The error thrown by the protected operation itself. */
  readonly originalError: unknown

  constructor (originalError: unknown, cause: unknown) {
    super('Operation failed and every fallback handler failed', 'FALLBACK_FAILED', { cause })
    this.originalError = originalError
  }
}

export function isBreakwaterError (error: unknown): error is BreakwaterError {
  return error instanceof BreakwaterError
}

export function isTimeoutError (error: unknown): error is TimeoutError {
  return error instanceof TimeoutError
}

export function isCircuitOpenError (error: unknown): error is CircuitOpenError {
  return error instanceof CircuitOpenError
}

export function isIsolatedError (error: unknown): error is IsolatedError {
  return error instanceof IsolatedError
}

export function isRetryExhaustedError (error: unknown): error is RetryExhaustedError {
  return error instanceof RetryExhaustedError
}

export function isFallbackFailedError (error: unknown): error is FallbackFailedError {
  return error instanceof FallbackFailedError
}
