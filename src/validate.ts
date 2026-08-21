export function assertNonEmptyString (name: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RangeError(`${name} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
}

export function assertPositiveFinite (name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}`)
  }
}

export function assertPositiveInt (name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be an integer >= 1, got ${value}`)
  }
}

export function assertNonNegativeInt (name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be an integer >= 0, got ${value}`)
  }
}

export function assertNonNegative (name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, got ${value}`)
  }
}

/**
 * An upper bound that may be Infinity, which is how the backoffs spell "no
 * bound" — so assertNonNegative, which rejects it as non-finite, cannot stand
 * in here. NaN and negatives still fail at construction rather than surfacing
 * later as a bogus delay, on the first retry, in production.
 */
export function assertNonNegativeBound (name: string, value: number): void {
  if (Number.isNaN(value) || !(value >= 0)) {
    throw new RangeError(`${name} must be a non-negative number or Infinity, got ${value}`)
  }
}

/**
 * Guards the string options TypeScript cannot guard for JavaScript callers:
 * a typo in a mode or strategy must fail at construction, not silently
 * select a different behavior.
 */
export function assertOneOf<T extends string> (name: string, value: T, allowed: readonly T[]): void {
  if (!allowed.includes(value)) {
    throw new RangeError(`${name} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`)
  }
}
