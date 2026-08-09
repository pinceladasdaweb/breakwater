import { assertNonNegative, assertOneOf, assertPositiveFinite } from '../validate'

/**
 * A backoff strategy: given the attempt number (1-based, i.e. the number of
 * the attempt that just failed), returns the delay in milliseconds to wait
 * before the next attempt.
 */
export type Backoff = (attempt: number) => number

/** Same delay between every attempt. */
export function fixed (delay: number): Backoff {
  assertNonNegative('delay', delay)
  return () => delay
}

export interface LinearBackoffOptions {
  /** Delay before the second attempt, in ms. */
  initial: number
  /** How much the delay grows after each attempt, in ms. */
  increment: number
  /** Upper bound for the delay, in ms. Default: no bound. */
  max?: number
}

/** Delay grows by a fixed increment: initial, initial + increment, ... */
export function linear (options: LinearBackoffOptions): Backoff {
  const { initial, increment, max = Infinity } = options
  assertNonNegative('initial', initial)
  assertNonNegative('increment', increment)
  return (attempt) => Math.min(initial + increment * (attempt - 1), max)
}

export interface ExponentialBackoffOptions {
  /** Delay before the second attempt, in ms. Default: 100. */
  initial?: number
  /** Multiplier applied after each attempt. Default: 2. */
  factor?: number
  /** Upper bound for the delay, in ms. Default: 30_000. */
  max?: number
  /**
   * Randomization applied to the computed delay:
   * - `full` (default): uniform in [0, delay] — AWS-style full jitter,
   *   the best default to avoid thundering herds.
   * - `equal`: uniform in [delay/2, delay].
   * - `none`: the exact computed delay.
   */
  jitter?: 'none' | 'full' | 'equal'
}

/** Delay doubles (by default) after each attempt, with jitter. */
export function exponential (options: ExponentialBackoffOptions = {}): Backoff {
  const { initial = 100, factor = 2, max = 30_000, jitter = 'full' } = options
  assertNonNegative('initial', initial)
  assertPositiveFinite('factor', factor)
  assertOneOf('jitter', jitter, ['none', 'full', 'equal'])

  return (attempt) => {
    const delay = Math.min(initial * factor ** (attempt - 1), max)
    switch (jitter) {
      case 'none':
        return delay
      case 'equal':
        return delay / 2 + Math.random() * (delay / 2)
      case 'full':
        return Math.random() * delay
    }
  }
}
