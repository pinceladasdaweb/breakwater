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
