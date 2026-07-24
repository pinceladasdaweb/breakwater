import { assertPositiveFinite, assertPositiveInt } from '../validate'

/**
 * Sliding window over which the circuit breaker computes its failure rate.
 * `count` keeps the last N calls; `time` keeps the calls of the last N ms.
 */
export interface Window {
  readonly kind: 'count' | 'time'
  readonly size: number
}

/** Sliding window over the last `size` calls. */
export function countWindow (size: number): Window {
  assertPositiveInt('countWindow size', size)
  return { kind: 'count', size }
}

/** Sliding window over the last `ms` milliseconds. */
export function timeWindow (ms: number): Window {
  assertPositiveFinite('timeWindow ms', ms)
  return { kind: 'time', size: ms }
}
