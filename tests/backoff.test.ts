import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { fixed, linear, exponential } from '../src/retry/backoff'

describe('fixed()', () => {
  test('returns the same delay for every attempt', () => {
    const backoff = fixed(200)
    assert.equal(backoff(1), 200)
    assert.equal(backoff(5), 200)
  })

  test('rejects negative delays, naming the option', () => {
    assert.throws(() => fixed(-1), { name: 'RangeError', message: /delay/ })
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

  test('rejects negative options, naming the offending one', () => {
    assert.throws(() => linear({ initial: -1, increment: 10 }), { name: 'RangeError', message: /initial/ })
    assert.throws(() => linear({ initial: 10, increment: -1 }), { name: 'RangeError', message: /increment/ })
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

  test('full jitter spreads across [0, delay]', () => {
    const backoff = exponential({ initial: 100, jitter: 'full' })
    const delays = Array.from({ length: 200 }, () => backoff(3)) // deterministic base: 400

    for (const delay of delays) assert.ok(delay >= 0 && delay <= 400, `delay ${delay} out of range`)
    // Spread, not just bounded: a jitter clustered at one end would still fit
    // the range while doing nothing about thundering herds.
    assert.ok(Math.max(...delays) > 200, 'jitter never reached the upper half')
    assert.ok(Math.min(...delays) < 200, 'jitter never reached the lower half')
  })

  test('equal jitter spreads across [delay/2, delay]', () => {
    const backoff = exponential({ initial: 100, jitter: 'equal' })
    const delays = Array.from({ length: 200 }, () => backoff(3)) // deterministic base: 400

    for (const delay of delays) assert.ok(delay >= 200 && delay <= 400, `delay ${delay} out of range`)
    assert.ok(Math.max(...delays) > 300, 'jitter never reached the upper half')
    assert.ok(Math.min(...delays) < 300, 'jitter never reached the lower half')
  })

  test('defaults are sane: initial 100, factor 2, max 30s, full jitter', () => {
    const backoff = exponential()
    for (let i = 0; i < 50; i++) {
      assert.ok(backoff(1) <= 100)
      assert.ok(backoff(20) <= 30_000)
    }
  })

  test('rejects invalid options, naming the offending one', () => {
    assert.throws(() => exponential({ factor: 0 }), { name: 'RangeError', message: /factor/ })
    assert.throws(() => exponential({ initial: -1 }), { name: 'RangeError', message: /initial/ })
    // A typo would otherwise make the switch return undefined delays.
    assert.throws(() => exponential({ jitter: 'ful' as never }), { name: 'RangeError', message: /jitter/ })
  })
})
