import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { circuitBreaker } from '../src/circuit-breaker/circuit-breaker'
import { memoryStore } from '../src/circuit-breaker/state-store'
import { countWindow, timeWindow } from '../src/circuit-breaker/window'
import { isCircuitOpenError, isIsolatedError } from '../src/errors'

import { drain } from './helpers'

const boom = (): never => { throw new Error('downstream failure') }

async function failTimes (policy: { execute: (fn: () => unknown) => Promise<unknown> }, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await assert.rejects(policy.execute(boom))
  }
}

describe('window validation', () => {
  test('rejects invalid windows', () => {
    assert.throws(() => countWindow(0), RangeError)
    assert.throws(() => countWindow(1.5), RangeError)
    assert.throws(() => timeWindow(0), RangeError)
    assert.throws(() => timeWindow(-100), RangeError)
  })
})

describe('circuitBreaker() options', () => {
  test('rejects invalid options', () => {
    assert.throws(() => circuitBreaker({ failureThreshold: 0 }), RangeError)
    assert.throws(() => circuitBreaker({ failureThreshold: 1.5 }), RangeError)
    assert.throws(() => circuitBreaker({ minimumCalls: 0 }), RangeError)
    assert.throws(() => circuitBreaker({ consecutiveFailures: 0 }), RangeError)
    assert.throws(() => circuitBreaker({ halfOpenAfter: 0 }), RangeError)
    assert.throws(() => circuitBreaker({ halfOpenCalls: 0 }), RangeError)
  })
})

describe('consecutive failures mode', () => {
  test('opens after N consecutive failures and rejects fast without executing', async () => {
    const breaker = circuitBreaker({ consecutiveFailures: 3, name: 'api' })
    let executions = 0

    await failTimes(breaker, 3)
    assert.equal(breaker.state, 'open')

    await assert.rejects(
      breaker.execute(() => { executions++; return 'never runs' }),
      (error: unknown) => {
        assert.ok(isCircuitOpenError(error))
        assert.equal(error.code, 'CIRCUIT_OPEN')
        assert.equal(error.stats.state, 'open')
        assert.equal(error.stats.failures, 3)
        return true
      }
    )
    assert.equal(executions, 0)
  })

  test('a success resets the consecutive counter', async () => {
    const breaker = circuitBreaker({ consecutiveFailures: 3 })

    await failTimes(breaker, 2)
    await breaker.execute(() => 'ok')
    await failTimes(breaker, 2)

    assert.equal(breaker.state, 'closed')
  })
})

describe('failure rate mode', () => {
  test('never opens before minimumCalls, then opens at the threshold', async () => {
    const breaker = circuitBreaker({
      failureThreshold: 0.5,
      minimumCalls: 4,
      window: countWindow(10)
    })

    await failTimes(breaker, 3) // 3 calls, 100% failure — still below minimumCalls
    assert.equal(breaker.state, 'closed')

    await assert.rejects(breaker.execute(boom)) // 4th call: rate 1.0 >= 0.5
    assert.equal(breaker.state, 'open')
  })

  test('successes keep the rate below the threshold', async () => {
    const breaker = circuitBreaker({
      failureThreshold: 0.6,
      minimumCalls: 5,
      window: countWindow(10)
    })

    for (let i = 0; i < 3; i++) await breaker.execute(() => 'ok')
    await failTimes(breaker, 2) // 2/5 = 0.4 < 0.6
    assert.equal(breaker.state, 'closed')
  })
})

describe('half-open', () => {
  test('after halfOpenAfter, a majority of probe successes closes the circuit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 3 })
    const states: string[] = []
    breaker.on('stateChange', ({ from, to }) => states.push(`${from}->${to}`))

    await failTimes(breaker, 1)
    assert.equal(breaker.state, 'open')

    t.mock.timers.tick(1_000)

    // majority = floor(3/2) + 1 = 2 successes
    await breaker.execute(() => 'probe 1')
    assert.equal(breaker.state, 'half-open')
    await breaker.execute(() => 'probe 2')
    assert.equal(breaker.state, 'closed')

    assert.deepEqual(states, ['closed->open', 'open->half-open', 'half-open->closed'])
  })

  test('any probe failure reopens the circuit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 3 })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    await breaker.execute(() => 'probe ok')
    await assert.rejects(breaker.execute(boom))
    assert.equal(breaker.state, 'open')

    // and the open period restarts
    await assert.rejects(breaker.execute(() => 'x'), isCircuitOpenError)
  })

  test('rejects calls beyond halfOpenCalls concurrent probes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 1 })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    const { promise: gate, resolve: release } = Promise.withResolvers<void>()

    const probe = breaker.execute(async () => { await gate; return 'slow probe' })
    await drain() // let the probe fully enter the half-open slot
    await assert.rejects(breaker.execute(() => 'extra'), isCircuitOpenError)

    release()
    assert.equal(await probe, 'slow probe')
  })

  test('concurrent arrivals cannot exceed halfOpenCalls probes (admission race)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 2 })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    let concurrent = 0
    let maxConcurrent = 0
    const probe = async (): Promise<string> => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await gate
      concurrent--
      return 'probe'
    }

    // Establish half-open with one slot taken by a slow probe...
    const first = breaker.execute(probe)
    await drain()
    assert.equal(breaker.state, 'half-open')

    // ...then fire 5 truly concurrent extras — no drain between them. Only
    // one free slot exists (halfOpenCalls: 2).
    const extras = Array.from({ length: 5 }, async () =>
      await breaker.execute(probe).catch((error: unknown) => error))

    await drain()
    release()
    const results = await Promise.all(extras)

    assert.equal(await first, 'probe')
    assert.ok(maxConcurrent <= 2, `expected at most 2 concurrent probes, saw ${maxConcurrent}`)
    assert.equal(results.filter((r) => isCircuitOpenError(r)).length, 4)
  })

  test('a stale probe from a previous half-open period neither closes nor reopens the current one', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 3 })
    const transitions: string[] = []
    breaker.on('stateChange', ({ from, to }) => transitions.push(`${from}->${to}`))

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    // Period 1: slow probe A starts, probe B fails and reopens the circuit.
    const { promise: gateA, resolve: releaseA } = Promise.withResolvers<void>()
    const probeA = breaker.execute(async () => { await gateA; return 'stale success' })
    await drain()
    await assert.rejects(breaker.execute(boom))
    assert.equal(breaker.state, 'open')

    // Period 2 begins.
    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'fresh probe 1')
    assert.equal(breaker.state, 'half-open')

    // Stale probe A completes now: its success must NOT count towards the
    // current period's majority (2 of 3).
    releaseA()
    assert.equal(await probeA, 'stale success')
    assert.equal(breaker.state, 'half-open')

    // A genuine second success closes it.
    await breaker.execute(() => 'fresh probe 2')
    assert.equal(breaker.state, 'closed')
  })

  test('a stale probe failure does not reopen a recovering circuit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 3 })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    const { promise: gateA, reject: rejectA } = Promise.withResolvers<never>()
    const probeA = breaker.execute(async () => await gateA).catch((e: unknown) => e)
    await drain()
    await assert.rejects(breaker.execute(boom)) // reopens (period 1 ends)

    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'fresh probe 1') // period 2, 1 success
    assert.equal(breaker.state, 'half-open')

    rejectA(new Error('stale failure'))
    await probeA
    // The stale failure must not have reopened the circuit.
    assert.equal(breaker.state, 'half-open')
  })

  test('stays open before halfOpenAfter elapses', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000 })

    await failTimes(breaker, 1)
    t.mock.timers.tick(999)
    await assert.rejects(breaker.execute(() => 'x'), isCircuitOpenError)
    assert.equal(breaker.state, 'open')
  })
})

describe('isolate / unisolate / reset', () => {
  test('isolate rejects with IsolatedError and never expires', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const breaker = circuitBreaker({ halfOpenAfter: 1_000 })

    await breaker.isolate()
    assert.equal(breaker.state, 'isolated')

    t.mock.timers.tick(60_000) // isolation must not expire like `open` does
    await assert.rejects(breaker.execute(() => 'x'), (error: unknown) => {
      assert.ok(isIsolatedError(error))
      assert.equal(error.code, 'CIRCUIT_ISOLATED')
      return true
    })
  })

  test('unisolate returns to closed and clears counters', async () => {
    const breaker = circuitBreaker({ consecutiveFailures: 5 })
    await failTimes(breaker, 2)
    await breaker.isolate()

    await breaker.unisolate()
    assert.equal(breaker.state, 'closed')
    assert.equal(breaker.stats().totalCalls, 0)
    assert.equal(await breaker.execute(() => 'works'), 'works')
  })

  test('reset returns an open circuit to closed with fresh counters', async () => {
    const breaker = circuitBreaker({ consecutiveFailures: 1 })
    await failTimes(breaker, 1)
    assert.equal(breaker.state, 'open')

    await breaker.reset()
    assert.equal(breaker.state, 'closed')
    assert.equal(breaker.stats().totalCalls, 0)
    assert.equal(await breaker.execute(() => 'works'), 'works')
  })
})

describe('failure classification', () => {
  test('errors rejected by failureIf count as neither failure nor success', async () => {
    const breaker = circuitBreaker({
      consecutiveFailures: 1,
      failureIf: (error) => !(error instanceof RangeError)
    })

    await assert.rejects(breaker.execute(() => { throw new RangeError('bad input') }))
    assert.equal(breaker.state, 'closed')
    assert.equal(breaker.stats().totalCalls, 0)
  })

  test('cancellation does not count as failure', async () => {
    const breaker = circuitBreaker({ consecutiveFailures: 1 })
    const controller = new AbortController()

    await assert.rejects(
      breaker.execute(({ signal }) => {
        controller.abort(new Error('cancelled'))
        assert.equal(signal.aborted, true)
        throw new Error('aborted work')
      }, { signal: controller.signal })
    )
    assert.equal(breaker.state, 'closed')
    assert.equal(breaker.stats().totalCalls, 0)
  })
})

describe('events and stats', () => {
  test('emits success, failure and reject with correlationId', async () => {
    const breaker = circuitBreaker({ consecutiveFailures: 2 })
    const events: string[] = []
    breaker
      .on('success', ({ correlationId }) => events.push(`success:${correlationId}`))
      .on('failure', ({ correlationId }) => events.push(`failure:${correlationId}`))
      .on('reject', ({ reason, correlationId }) => events.push(`reject:${reason}:${correlationId}`))

    await breaker.execute(() => 'ok', { correlationId: 'c1' })
    await assert.rejects(breaker.execute(boom, { correlationId: 'c2' }))
    await assert.rejects(breaker.execute(boom, { correlationId: 'c3' }))
    await assert.rejects(breaker.execute(() => 'x', { correlationId: 'c4' }))

    assert.deepEqual(events, [
      'success:c1',
      'failure:c2',
      'failure:c3',
      'reject:circuit_open:c4'
    ])
  })

  test('stats exposes counters, lastError and open timing', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(1_000_000)
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 5_000 })

    await failTimes(breaker, 1)
    const stats = breaker.stats()

    assert.equal(stats.state, 'open')
    assert.equal(stats.failures, 1)
    assert.match((stats.lastError as Error).message, /downstream failure/)
    assert.equal(stats.openedAt, 1_000_000)
    assert.equal(stats.nextAttemptAt, 1_005_000)
  })
})

describe('shared state store', () => {
  test('two breakers sharing a store and name share the circuit state', async () => {
    const store = memoryStore({ window: countWindow(10) })
    const a = circuitBreaker({ consecutiveFailures: 1, name: 'shared', stateStore: store })
    const b = circuitBreaker({ consecutiveFailures: 1, name: 'shared', stateStore: store })

    await failTimes(a, 1)
    await assert.rejects(b.execute(() => 'x'), isCircuitOpenError)
  })

  test('an instance that never saw the trip can still recover via half-open', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const store = memoryStore({ window: countWindow(10) })
    const a = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, name: 'shared', stateStore: store })
    const b = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, name: 'shared', stateStore: store })

    await failTimes(a, 1) // A trips the shared circuit; B never sees the trip

    // B observes 'open' now: its cooldown starts at first observation.
    await assert.rejects(b.execute(() => 'x'), isCircuitOpenError)

    t.mock.timers.tick(1_000)
    // Instance A is gone (no more traffic through it). B must not be locked
    // out forever: after the cooldown it probes and recovers the circuit.
    await b.execute(() => 'probe via B')
    assert.equal(await b.execute(() => 'works'), 'works')
  })

  test('reset never leaves the isolated state', async () => {
    const breaker = circuitBreaker({})
    await breaker.isolate()

    await breaker.reset()
    assert.equal(breaker.state, 'isolated')
    await assert.rejects(breaker.execute(() => 'x'), isIsolatedError)

    await breaker.unisolate()
    assert.equal(breaker.state, 'closed')
  })
})
