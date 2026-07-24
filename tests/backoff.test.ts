import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { fixed, linear, exponential } from '../src/retry/backoff'

describe('fixed()', () => {
  test('returns the same delay for every attempt', () => {
    const backoff = fixed(200)
    assert.equal(backoff(1), 200)
    assert.equal(backoff(5), 200)
  })

  test('rejects negative delays', () => {
    assert.throws(() => fixed(-1), RangeError)
  })
})

describe('linear()', () => {
  test('grows by the increment and honors max', () => {
    const backoff = linear({ initial: 100, increment: 50, max: 220 })
    assert.equal(backoff(1), 100)
    assert.equal(backoff(2), 150)
    assert.equal(backoff(3), 200)
    assert.equal(backoff(4), 220)
  })
})

describe('exponential()', () => {
  test('jitter none: doubles each attempt and caps at max', () => {
    const backoff = exponential({ initial: 100, jitter: 'none', max: 500 })
    assert.equal(backoff(1), 100)
    assert.equal(backoff(2), 200)
    assert.equal(backoff(3), 400)
    assert.equal(backoff(4), 500)
    assert.equal(backoff(10), 500)
  })

  test('honors a custom factor', () => {
    const backoff = exponential({ initial: 100, factor: 3, jitter: 'none', max: 10_000 })
    assert.equal(backoff(2), 300)
    assert.equal(backoff(3), 900)
  })

  test('full jitter stays within [0, delay]', () => {
    const backoff = exponential({ initial: 100, jitter: 'full' })
    for (let i = 0; i < 100; i++) {
      const delay = backoff(3) // deterministic base: 400
      assert.ok(delay >= 0 && delay <= 400, `delay ${delay} out of range`)
    }
  })

  test('equal jitter stays within [delay/2, delay]', () => {
    const backoff = exponential({ initial: 100, jitter: 'equal' })
    for (let i = 0; i < 100; i++) {
      const delay = backoff(3) // deterministic base: 400
      assert.ok(delay >= 200 && delay <= 400, `delay ${delay} out of range`)
    }
  })

  test('defaults are sane: initial 100, factor 2, max 30s, full jitter', () => {
    const backoff = exponential()
    for (let i = 0; i < 50; i++) {
      assert.ok(backoff(1) <= 100)
      assert.ok(backoff(20) <= 30_000)
    }
  })

  test('rejects a non-positive factor', () => {
    assert.throws(() => exponential({ factor: 0 }), RangeError)
  })
})
