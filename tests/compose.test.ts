import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { compose } from '../src/compose/compose'
import { fallback } from '../src/fallback/fallback'
import { retry } from '../src/retry/retry'
import { fixed } from '../src/retry/backoff'
import { circuitBreaker } from '../src/circuit-breaker/circuit-breaker'
import { timeout } from '../src/timeout/timeout'
import { basePolicy, type Policy } from '../src/policy'
import { isCircuitOpenError } from '../src/errors'

/** A policy that records enter/leave order under a label. */
function probe (label: string, log: string[]): Policy {
  return basePolicy(async (fn, ctx) => {
    log.push(`${label}:enter`)
    try {
      return await fn(ctx)
    } finally {
      log.push(`${label}:leave`)
    }
  })
}

describe('compose()', () => {
  test('requires at least one policy', () => {
    assert.throws(() => compose(), { name: 'RangeError', message: /at least one policy/ })
  })

  test('runs policies outermost-first, exactly like nested calls', async () => {
    const log: string[] = []
    const policy = compose(probe('a', log), probe('b', log), probe('c', log))

    await policy.execute(() => { log.push('fn'); return null })

    assert.deepEqual(log, ['a:enter', 'b:enter', 'c:enter', 'fn', 'c:leave', 'b:leave', 'a:leave'])
  })

  test('the same context (correlationId) crosses the whole pipeline', async () => {
    const seen: string[] = []
    const spy = basePolicy(async (fn, ctx) => {
      seen.push(ctx.correlationId)
      return await fn(ctx)
    })

    const policy = compose(spy, spy, spy)
    await policy.execute((ctx) => seen.push(ctx.correlationId), { correlationId: 'trace-1' })

    assert.deepEqual(seen, ['trace-1', 'trace-1', 'trace-1', 'trace-1'])
  })

  test('a composition is a policy: compositions compose again', async () => {
    const log: string[] = []
    const inner = compose(probe('b', log), probe('c', log))
    const policy = compose(probe('a', log), inner)

    await policy.execute(() => null)

    assert.deepEqual(log, ['a:enter', 'b:enter', 'c:enter', 'c:leave', 'b:leave', 'a:leave'])
  })

  test('retry outside the breaker: attempts feed the breaker and CircuitOpenError stops retrying', async () => {
    const breaker = circuitBreaker({ consecutiveFailures: 2, name: 'compose-test' })
    const policy = compose(retry({ attempts: 5, backoff: fixed(0) }), breaker)
    let calls = 0

    // Two real failures open the circuit; the third attempt hits the open
    // breaker and the default retryIf refuses to keep going.
    await assert.rejects(
      policy.execute(() => { calls++; throw new Error('down') }),
      isCircuitOpenError
    )
    assert.equal(calls, 2)
    assert.equal(breaker.state, 'open')
  })

  test('full pipeline: fallback catches what retry gave up on', async () => {
    const policy = compose(
      fallback('stale response'),
      retry({ attempts: 2, backoff: fixed(0) }),
      timeout(1_000)
    )
    let calls = 0

    const result = await policy.execute(() => { calls++; throw new Error('down') })

    assert.equal(result, 'stale response')
    assert.equal(calls, 2)
  })
})
