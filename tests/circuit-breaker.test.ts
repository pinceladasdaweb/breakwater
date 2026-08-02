import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { circuitBreaker } from '../src/circuit-breaker/circuit-breaker'
import { memoryStore, type StateStore } from '../src/circuit-breaker/state-store'
import { countWindow, timeWindow } from '../src/circuit-breaker/window'
import { isCircuitOpenError, isIsolatedError } from '../src/errors'

import { drain, gated, rejectsOnAbort } from './helpers'

const boom = (): never => { throw new Error('downstream failure') }

/** A memory store whose every method answers asynchronously, like a remote one. */
function asyncStore (): StateStore {
  const inner = memoryStore({ window: countWindow(10) })
  return {
    getState: async (name) => inner.getState(name),
    transition: async (name, from, to) => inner.transition(name, from, to),
    recordSuccess: async (name, ms) => { inner.recordSuccess(name, ms) },
    recordFailure: async (name, ms) => { inner.recordFailure(name, ms) },
    getCounters: async (name) => inner.getCounters(name),
    resetCounters: async (name) => { inner.resetCounters(name) },
    acquireProbe: async () => true
  }
}

async function failTimes (policy: { execute: (fn: () => unknown) => Promise<unknown> }, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await assert.rejects(policy.execute(boom))
  }
}

describe('window validation', () => {
  test('windows describe their own kind and size', () => {
    assert.deepEqual(countWindow(20), { kind: 'count', size: 20 })
    assert.deepEqual(timeWindow(500), { kind: 'time', size: 500 })
  })

  test('rejects invalid windows, naming the offending one', () => {
    assert.throws(() => countWindow(0), { name: 'RangeError', message: /countWindow size/ })
    assert.throws(() => countWindow(1.5), { name: 'RangeError', message: /countWindow size/ })
    assert.throws(() => timeWindow(0), { name: 'RangeError', message: /timeWindow ms/ })
    assert.throws(() => timeWindow(-100), { name: 'RangeError', message: /timeWindow ms/ })
  })
})

describe('circuitBreaker() options', () => {
  test('rejects invalid options, naming the offending one', () => {
    assert.throws(() => circuitBreaker({ failureThreshold: 0 }), { name: 'RangeError', message: /failureThreshold/ })
    assert.throws(() => circuitBreaker({ failureThreshold: 1.5 }), { name: 'RangeError', message: /failureThreshold/ })
    assert.throws(() => circuitBreaker({ minimumCalls: 0 }), { name: 'RangeError', message: /minimumCalls/ })
    assert.throws(() => circuitBreaker({ consecutiveFailures: 0 }), { name: 'RangeError', message: /consecutiveFailures/ })
    assert.throws(() => circuitBreaker({ halfOpenAfter: 0 }), { name: 'RangeError', message: /halfOpenAfter/ })
    assert.throws(() => circuitBreaker({ halfOpenCalls: 0 }), { name: 'RangeError', message: /halfOpenCalls/ })
  })

  test('a threshold of exactly 1 is valid — open only at a 100% failure rate', () => {
    assert.doesNotThrow(() => circuitBreaker({ failureThreshold: 1 }))
  })

  test('a fresh breaker is closed, with empty counters and no open timing', () => {
    const breaker = circuitBreaker({ consecutiveFailures: 1 })
    const stats = breaker.stats()

    assert.equal(breaker.state, 'closed')
    assert.equal(stats.state, 'closed')
    assert.equal(stats.totalCalls, 0)
    assert.equal(stats.failureRate, 0)
    assert.equal(stats.openedAt, undefined)
    assert.equal(stats.nextAttemptAt, undefined)
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

  test('a rate landing exactly on the threshold opens the circuit', async () => {
    const breaker = circuitBreaker({
      failureThreshold: 0.5,
      minimumCalls: 4,
      window: countWindow(10)
    })

    await breaker.execute(() => 'ok')
    await breaker.execute(() => 'ok')
    await failTimes(breaker, 2) // exactly 2/4 = 0.5

    assert.equal(breaker.state, 'open')
  })

  test('a count window only weighs the last N calls', async () => {
    const breaker = circuitBreaker({
      failureThreshold: 1,
      minimumCalls: 2,
      window: countWindow(2)
    })

    for (let i = 0; i < 4; i++) await breaker.execute(() => 'ok')
    await failTimes(breaker, 2)

    // The four successes have fallen out: the window holds two calls, both failed.
    assert.equal(breaker.stats().totalCalls, 2)
    assert.equal(breaker.state, 'open')
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

    const g = gated('slow probe')
    const rejections: string[] = []
    breaker.on('reject', ({ reason }) => rejections.push(reason))

    const probe = breaker.execute(g.fn)
    await drain() // let the probe fully enter the half-open slot
    await assert.rejects(breaker.execute(() => 'extra'), isCircuitOpenError)
    assert.deepEqual(rejections, ['circuit_open'])

    g.release()
    assert.equal(await probe, 'slow probe')
  })

  test('a finished probe hands its slot back to the same half-open period', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    // Two slots, and a majority of two successes to close: the period only
    // completes if the first probe releases the slot it held.
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 2 })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    await breaker.execute(() => 'probe 1')
    assert.equal(breaker.state, 'half-open')
    await breaker.execute(() => 'probe 2')
    assert.equal(breaker.state, 'closed')
  })

  test('a cancelled probe returns its slot — being cancelled is not probing', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 2 })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    const controller = new AbortController()
    const cancelled = breaker.execute(rejectsOnAbort(), { signal: controller.signal })
    await drain()
    controller.abort(new Error('caller went away'))
    await assert.rejects(cancelled, /caller went away/)

    // The period is still entitled to its two probes.
    await breaker.execute(() => 'probe 1')
    await breaker.execute(() => 'probe 2')
    assert.equal(breaker.state, 'closed')
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
    const a = gated('stale success')
    const probeA = breaker.execute(a.fn)
    await drain()
    await assert.rejects(breaker.execute(boom))
    assert.equal(breaker.state, 'open')

    // Period 2 begins.
    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'fresh probe 1')
    assert.equal(breaker.state, 'half-open')

    // Stale probe A completes now: its success must NOT count towards the
    // current period's majority (2 of 3).
    a.release()
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

    const a = gated()
    const probeA = breaker.execute(a.fn).catch((e: unknown) => e)
    await drain()
    await assert.rejects(breaker.execute(boom)) // reopens (period 1 ends)

    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'fresh probe 1') // period 2, 1 success
    assert.equal(breaker.state, 'half-open')

    a.fail(new Error('stale failure'))
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

  test('isolating twice is a no-op — only the first transition is announced', async () => {
    const breaker = circuitBreaker({})
    const changes: string[] = []
    const stateEvents: string[] = []
    breaker
      .on('stateChange', ({ from, to }) => changes.push(`${from}->${to}`))
      .on('open', () => stateEvents.push('open'))
      .on('close', () => stateEvents.push('close'))
      .on('halfOpen', () => stateEvents.push('halfOpen'))

    await breaker.isolate()
    await breaker.isolate()

    assert.equal(breaker.state, 'isolated')
    assert.deepEqual(changes, ['closed->isolated'])
    // Isolation is its own state: it borrows no other state's event.
    assert.deepEqual(stateEvents, [])
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

  test('open, close and halfOpen fire alongside stateChange, each with the new snapshot', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 1 })
    const seen: string[] = []
    breaker
      .on('open', ({ stats, correlationId }) => seen.push(`open:${stats.state}:${correlationId ?? ''}`))
      .on('halfOpen', ({ stats, correlationId }) => seen.push(`halfOpen:${stats.state}:${correlationId ?? ''}`))
      .on('close', ({ stats, correlationId }) => seen.push(`close:${stats.state}:${correlationId ?? ''}`))

    await assert.rejects(breaker.execute(boom, { correlationId: 'c1' }))
    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'probe', { correlationId: 'c2' })

    // One dedicated event per state, never more than one per transition.
    assert.deepEqual(seen, ['open:open:c1', 'halfOpen:half-open:c2', 'close:closed:c2'])
  })

  test('success and failure events report how long the call took', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const breaker = circuitBreaker({ consecutiveFailures: 5 })
    const durations: number[] = []
    breaker
      .on('success', ({ durationMs }) => durations.push(durationMs))
      .on('failure', ({ durationMs }) => durations.push(durationMs))

    await breaker.execute(() => { t.mock.timers.tick(120); return 'slow' })
    await assert.rejects(breaker.execute(() => { t.mock.timers.tick(30); throw new Error('down') }))

    assert.deepEqual(durations, [120, 30])
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

  test('an async store keeps stats() synchronous and coherent', async () => {
    const breaker = circuitBreaker({ consecutiveFailures: 2, name: 'remote', stateStore: asyncStore() })

    // Nothing has been read from the store yet: the mirror starts empty
    // rather than exposing a pending promise.
    assert.equal(breaker.stats().totalCalls, 0)

    await failTimes(breaker, 1)
    const stats = breaker.stats()
    assert.equal(stats.state, 'closed')
    assert.equal(stats.failures, 1)
    assert.equal(stats.totalCalls, 1)

    await failTimes(breaker, 1)
    assert.equal(breaker.state, 'open')
  })

  test('losing the trip race adopts the peer state instead of announcing our own', async () => {
    const inner = memoryStore({ window: countWindow(10) })
    let lostTheRace = false
    // Another instance tripped the shared circuit microseconds earlier.
    const store: StateStore = {
      ...inner,
      getState: () => lostTheRace ? 'open' : 'closed',
      transition: () => { lostTheRace = true; return false }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, name: 'shared', stateStore: store })
    const changes: string[] = []
    breaker.on('stateChange', ({ to }) => changes.push(to))

    await failTimes(breaker, 1)

    assert.equal(breaker.state, 'open')
    assert.deepEqual(changes, []) // the transition was the peer's to announce
    assert.equal(breaker.stats().openedAt, undefined)
  })

  test('a store that elects another instance to probe rejects without leaking the slot', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const inner = memoryStore({ window: countWindow(10) })
    let electedElsewhere = true
    const store: StateStore = { ...inner, acquireProbe: () => !electedElsewhere }
    const breaker = circuitBreaker({
      consecutiveFailures: 1,
      halfOpenAfter: 1_000,
      halfOpenCalls: 1,
      name: 'shared',
      stateStore: store
    })
    const rejections: string[] = []
    breaker.on('reject', ({ reason }) => rejections.push(reason))

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    let ran = false
    await assert.rejects(breaker.execute(() => { ran = true; return 'probe' }), isCircuitOpenError)
    assert.equal(ran, false)
    assert.deepEqual(rejections, ['circuit_open'])

    // The refused attempt must not have consumed the single local probe slot.
    electedElsewhere = false
    assert.equal(await breaker.execute(() => 'probe'), 'probe')
    assert.equal(breaker.state, 'closed')
  })

  test('isolate retries the compare-and-set while peers keep changing the state', async () => {
    const inner = memoryStore({ window: countWindow(10) })
    let losses = 2
    const store: StateStore = {
      ...inner,
      transition: (name, from, to) => {
        if (losses > 0) { losses--; return false }
        return inner.transition(name, from, to)
      }
    }
    const breaker = circuitBreaker({ name: 'contended', stateStore: store })

    await breaker.isolate()

    assert.equal(losses, 0)
    assert.equal(breaker.state, 'isolated')
  })

  test('isolate gives up when the state never settles', async () => {
    const store: StateStore = { ...memoryStore(), transition: () => false }
    const breaker = circuitBreaker({ name: 'thrashing', stateStore: store })

    await assert.rejects(breaker.isolate(), /state kept changing/)
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
