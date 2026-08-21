import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { circuitBreaker } from '../src/circuit-breaker/circuit-breaker'
import { resilience } from '../src/compose/resilience'
import { fixed } from '../src/retry/backoff'
import { memoryStore, type LatencyStats, type StateSnapshot, type StateStore, type WindowCounters } from '../src/circuit-breaker/state-store'
import { countWindow, timeWindow } from '../src/circuit-breaker/window'
import { isCircuitOpenError, isIsolatedError } from '../src/errors'

import { drain, gated, rejectsOnAbort } from './helpers'

const boom = (): never => { throw new Error('downstream failure') }

/** A memory store whose every method answers asynchronously, like a remote one. */
function asyncStore (): StateStore {
  const inner = memoryStore({ window: countWindow(10) })
  return {
    readState: async (name) => inner.readState(name),
    compareAndSet: async (name, from, to, fence) => inner.compareAndSet(name, from, to, fence),
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
    // Probing belongs to the same open period, so the moment the outage
    // started is still on display while it runs.
    assert.equal(typeof breaker.stats().openedAt, 'number')
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

  test('stats reports how long the calls in the window took', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const breaker = circuitBreaker({ consecutiveFailures: 10, window: countWindow(4) })

    for (const ms of [10, 20, 30]) {
      await breaker.execute(() => { t.mock.timers.tick(ms) })
    }
    await assert.rejects(breaker.execute(() => { t.mock.timers.tick(40); return boom() }))

    // Failures count too: a slow failure is still a slow call.
    assert.deepEqual(breaker.stats().latency, {
      count: 4, min: 10, max: 40, mean: 25, p50: 20, p95: 40, p99: 40
    })
  })

  test('a fresh breaker reports an empty latency, not a missing one', () => {
    const breaker = circuitBreaker({ window: countWindow(4) })

    assert.deepEqual(breaker.stats().latency, {
      count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0
    })
  })

  test('a store without latency tracking simply reports none', async () => {
    const inner = memoryStore({ window: countWindow(4) })
    const { getLatency, ...withoutLatency } = inner
    const breaker = circuitBreaker({ name: 'basic', stateStore: withoutLatency })

    await breaker.execute(() => 'ok')

    assert.equal(breaker.stats().latency, undefined)
  })

  test('the rejection snapshot skips latency — no percentiles on the reject path', async () => {
    const store = memoryStore({ window: countWindow(4) })
    let latencyReads = 0
    const counted = {
      ...store,
      getLatency: (name: string) => { latencyReads++; return store.getLatency?.(name) as LatencyStats }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, name: 'counted', stateStore: counted })

    await assert.rejects(breaker.execute(boom))
    const before = latencyReads

    for (let i = 0; i < 5; i++) {
      await assert.rejects(breaker.execute(() => 'x'), (error: unknown) => {
        assert.ok(isCircuitOpenError(error))
        assert.equal(error.stats.latency, undefined)
        return true
      })
    }

    // Five fast rejections summarised nothing; only stats() pays for it.
    assert.equal(latencyReads, before)
    assert.ok((breaker.stats().latency?.count ?? 0) > 0)
    assert.equal(latencyReads, before + 1)
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
    // Another instance tripped the shared circuit microseconds earlier, so
    // our swap loses and the store hands back the period the peer minted.
    const peerPeriod = { state: 'open' as const, fence: 9 }
    const store: StateStore = {
      ...inner,
      readState: () => lostTheRace ? peerPeriod : { state: 'closed', fence: 0 },
      compareAndSet: () => { lostTheRace = true; return { ok: false, snapshot: peerPeriod } }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, name: 'shared', stateStore: store })
    const changes: string[] = []
    breaker.on('stateChange', ({ to }) => changes.push(to))

    await failTimes(breaker, 1)

    assert.equal(breaker.state, 'open')
    assert.deepEqual(changes, []) // the transition was the peer's to announce
    assert.equal(breaker.stats().openedAt, undefined)
  })

  test('a store missing the fenced pair is refused at construction, not mid-request', () => {
    // The shape a store written against the previous contract would have.
    const legacy = {
      getState: () => 'closed',
      transition: () => true,
      recordSuccess: () => {},
      recordFailure: () => {},
      getCounters: () => ({ successes: 0, failures: 0, totalCalls: 0, failureRate: 0 }),
      resetCounters: () => {},
      acquireProbe: () => true
    } as unknown as StateStore

    assert.throws(
      () => circuitBreaker({ name: 'legacy', stateStore: legacy }),
      { name: 'TypeError', message: /readState and compareAndSet/ }
    )

    // Half-migrated counts as missing: either method alone is refused.
    const complete = memoryStore()
    const withoutRead = { ...complete, readState: undefined } as unknown as StateStore
    const withoutCas = { ...complete, compareAndSet: undefined } as unknown as StateStore

    assert.throws(() => circuitBreaker({ name: 'half-a', stateStore: withoutRead }), { name: 'TypeError' })
    assert.throws(() => circuitBreaker({ name: 'half-b', stateStore: withoutCas }), { name: 'TypeError' })
    assert.doesNotThrow(() => circuitBreaker({ name: 'complete', stateStore: complete }))
  })

  test('the period timing comes from the store, so peers agree on the probe moment', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(1_000_000)
    const store = memoryStore({ window: countWindow(10) })
    const first = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, name: 'shared', stateStore: store })
    const second = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, name: 'shared', stateStore: store })

    // The first instance trips the shared circuit...
    await failTimes(first, 1)
    const openedAt = first.stats().openedAt
    assert.equal(openedAt, 1_000_000)

    // ...and the second one, which never saw the trip, inherits the very
    // same period instead of starting its own cooldown on first sight.
    t.mock.timers.tick(600)
    await assert.rejects(second.execute(() => 'x'), isCircuitOpenError)
    assert.equal(second.stats().openedAt, openedAt)
    assert.equal(second.stats().nextAttemptAt, 1_001_000)

    // The cooldown elapses once for both: no instance probes early, and
    // none waits an extra full window because it observed the circuit late.
    t.mock.timers.tick(400)
    assert.equal(await second.execute(() => 'probe'), 'probe')
  })

  test('a store without period timing keeps each cooldown counted from first sight', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(1_000_000)
    const inner = memoryStore({ window: countWindow(10) })
    // Shares the state but not the timing — the case where each instance
    // has to count the cooldown for itself.
    const timeless = (snapshot: StateSnapshot): StateSnapshot => ({ state: snapshot.state, fence: snapshot.fence })
    const store: StateStore = {
      ...inner,
      readState: (name) => timeless(inner.readState(name)),
      compareAndSet: (name, from, to, fence) => {
        const outcome = inner.compareAndSet(name, from, to, fence)
        return { ok: outcome.ok, snapshot: timeless(outcome.snapshot) }
      }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 1, name: 'timeless', stateStore: store })

    await failTimes(breaker, 1)
    await assert.rejects(breaker.execute(() => 'x'), isCircuitOpenError)
    assert.equal(breaker.stats().openedAt, 1_000_000)

    // Every later read must leave that moment alone: re-stamping it on each
    // observation would push the probe forever out of reach.
    t.mock.timers.tick(600)
    await assert.rejects(breaker.execute(() => 'x'), isCircuitOpenError)
    assert.equal(breaker.stats().openedAt, 1_000_000)

    t.mock.timers.tick(400)
    assert.equal(await breaker.execute(() => 'probe'), 'probe')
    assert.equal(breaker.state, 'closed')

    // A second outage is a NEW period: the timing of the previous one must
    // have been dropped, or its long-expired countdown would admit a probe
    // the instant the circuit reopens.
    await failTimes(breaker, 1)
    await assert.rejects(breaker.execute(() => 'x'), isCircuitOpenError)
    t.mock.timers.tick(999)
    await assert.rejects(breaker.execute(() => 'x'), isCircuitOpenError)
    t.mock.timers.tick(1)
    assert.equal(await breaker.execute(() => 'probe 2'), 'probe 2')
  })

  test('a success from a dead period never counts towards the fresh period majority', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const inner = memoryStore({ window: countWindow(10) })
    let holdSuccess: Promise<void> | undefined
    const store: StateStore = {
      ...inner,
      async recordSuccess (name, ms) {
        if (holdSuccess !== undefined) {
          const held = holdSuccess
          holdSuccess = undefined
          await held
        }
        inner.recordSuccess(name, ms)
      }
    }
    // Five probe slots, so a majority is three successes — enough room for
    // a ghost success to close the circuit early if it were ever counted.
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 5, name: 'stale-success', stateStore: store })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    // Period 1: a probe succeeds but its bookkeeping stalls in flight...
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    holdSuccess = held
    const stalled = breaker.execute(() => 'probe 1')
    await drain()

    // ...period 1 dies to a failing probe, and period 2 opens fresh.
    await assert.rejects(breaker.execute(boom), /downstream failure/)
    t.mock.timers.tick(1_000)
    assert.equal(await breaker.execute(() => 'fresh probe 1'), 'fresh probe 1')
    assert.equal(breaker.state, 'half-open')

    // The stale success lands now, and counting it would hand period 2 a
    // majority it never earned.
    release()
    assert.equal(await stalled, 'probe 1')
    assert.equal(breaker.state, 'half-open')

    // Two real successes are still one short of the majority: a circuit
    // that closes here is one counting a period that no longer exists.
    assert.equal(await breaker.execute(() => 'fresh probe 2'), 'fresh probe 2')
    assert.equal(breaker.state, 'half-open')

    // Period 2 closes on its own third success, not on the ghost of one.
    assert.equal(await breaker.execute(() => 'fresh probe 3'), 'fresh probe 3')
    assert.equal(breaker.state, 'closed')
  })

  test('a store without period timing still starts a fresh cooldown when a probe reopens it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(1_000_000)
    const inner = memoryStore({ window: countWindow(10) })
    const timeless = (snapshot: StateSnapshot): StateSnapshot => ({ state: snapshot.state, fence: snapshot.fence })
    const store: StateStore = {
      ...inner,
      readState: (name) => timeless(inner.readState(name)),
      compareAndSet: (name, from, to, fence) => {
        const outcome = inner.compareAndSet(name, from, to, fence)
        return { ok: outcome.ok, snapshot: timeless(outcome.snapshot) }
      }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 500, halfOpenCalls: 1, name: 'timeless-reopen', stateStore: store })

    await failTimes(breaker, 1)
    await assert.rejects(breaker.execute(() => 'x'), isCircuitOpenError) // stamps first sight
    t.mock.timers.tick(500)

    // The probe fails, so the circuit reopens: a NEW period, which must get a
    // new cooldown. Inheriting the previous period's stamp would leave
    // nextAttemptAt in the past and admit every later call as a probe — the
    // breaker would stop protecting anything, permanently.
    await assert.rejects(breaker.execute(boom), /downstream failure/)
    assert.equal(breaker.state, 'open')

    let ran = 0
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => { ran++; return 'x' }).catch(() => {})
    }
    assert.equal(ran, 0, 'the fresh open period must hold its own cooldown')

    t.mock.timers.tick(500)
    assert.equal(await breaker.execute(() => 'probe'), 'probe')
  })

  test('a state read that lands late never rewinds the mirror a newer one set', async () => {
    const inner = memoryStore({ window: countWindow(10) })
    let hold: Promise<void> | undefined
    const store: StateStore = {
      ...inner,
      async readState (name) {
        if (hold !== undefined) {
          const held = hold
          hold = undefined
          await held
        }
        return inner.readState(name)
      },
      compareAndSet: async (name, from, to, fence) => inner.compareAndSet(name, from, to, fence),
      recordSuccess: async (name, ms) => { inner.recordSuccess(name, ms) },
      recordFailure: async (name, ms) => { inner.recordFailure(name, ms) },
      getCounters: async (name) => inner.getCounters(name),
      resetCounters: async (name) => { inner.resetCounters(name) },
      acquireProbe: async () => true
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenCalls: 2, name: 'out-of-order', stateStore: store })

    // A read starts and stalls; the circuit moves on while it is in flight.
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    hold = held
    const stalled = breaker.execute(() => 'first')
    await drain()

    await assert.rejects(breaker.execute(boom), /downstream failure/)
    assert.equal(breaker.state, 'open')

    // The stale view lands now. Adopting it would rewind the mirror to a
    // period already gone and zero the probe bookkeeping of the live one.
    release()
    await stalled.catch(() => {})
    assert.equal(breaker.state, 'open', 'a stale read must not resurrect a dead period')
  })

  test('a pushed transition never overwrites a fresher read still in flight', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(1_000_000)
    const inner = memoryStore({ window: countWindow(10) })
    let push: ((snapshot: StateSnapshot) => void) | undefined
    let hold: Promise<void> | undefined
    const store: StateStore = {
      ...inner,
      async readState (name) {
        const snapshot = inner.readState(name)
        if (hold !== undefined) {
          const held = hold
          hold = undefined
          await held
        }
        return snapshot
      },
      compareAndSet: async (name, from, to, fence) => inner.compareAndSet(name, from, to, fence),
      recordSuccess: async (name, ms) => { inner.recordSuccess(name, ms) },
      recordFailure: async (name, ms) => { inner.recordFailure(name, ms) },
      getCounters: async (name) => inner.getCounters(name),
      resetCounters: async (name) => { inner.resetCounters(name) },
      acquireProbe: async () => true,
      subscribe: (_name, onChange) => { push = onChange; return () => { push = undefined } }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 30_000, name: 'pushed', stateStore: store })

    await failTimes(breaker, 1)
    const current = breaker.stats()
    assert.equal(breaker.state, 'open')

    // A read starts; while it is in flight, a stale announcement of an
    // EARLIER period arrives, carrying long-expired timing.
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    hold = held
    const pending = breaker.execute(() => 'never runs')
    await drain()
    push?.({ state: 'open', fence: 0, openedAt: 1_000_000 - 60_000 })
    release()

    // Adopting it would put nextAttemptAt in the past and admit this call as
    // a probe, 30 seconds early.
    await assert.rejects(pending, isCircuitOpenError)
    assert.equal(breaker.stats().openedAt, current.openedAt)

    breaker.dispose()
  })

  test('a timing it cannot compare against never strands the circuit open', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(1_000_000)
    const inner = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      ...inner,
      // A store handing back an unusable stamp: NaN would make
      // `now >= openedAt + halfOpenAfter` false for good, so the circuit
      // could never reach half-open again.
      readState: () => ({ state: 'open', fence: 1, openedAt: Number('nonsense') }),
      compareAndSet: (_name, _from, to) => ({ ok: true, snapshot: { state: to, fence: 2 } }),
      acquireProbe: () => true
    }
    const breaker = circuitBreaker({ halfOpenAfter: 1_000, name: 'unusable-timing', stateStore: store })

    // Rejected while the cooldown counted from first observation runs...
    await assert.rejects(breaker.execute(() => 'never runs'), isCircuitOpenError)
    t.mock.timers.tick(1_001)

    // ...and admitted once it elapses, instead of being refused forever.
    assert.equal(await breaker.execute(() => 'probe ran'), 'probe ran')
    breaker.dispose()
  })

  test('a new period never inherits the cooldown of the one before it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(1_000_000)
    let snapshot: StateSnapshot = { state: 'open', fence: 1, openedAt: 1_000_000 }
    const inner = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      ...inner,
      readState: () => snapshot,
      compareAndSet: (_name, _from, to) => ({ ok: true, snapshot: { state: to, fence: 99 } }),
      acquireProbe: () => true
    }
    const breaker = circuitBreaker({ halfOpenAfter: 300_000, name: 'fresh-period', stateStore: store })

    // Period 1's cooldown elapses and its probe is admitted.
    t.mock.timers.tick(300_001)
    assert.equal(await breaker.execute(() => 'probe of period 1'), 'probe of period 1')

    // A NEW period opens, and this time the store cannot report its timing.
    snapshot = { state: 'open', fence: 2, openedAt: Number('corrupt') }

    // Inheriting period 1's stamp would put the probe moment 5 minutes in the
    // past and admit every caller against a dependency that just failed.
    await assert.rejects(breaker.execute(() => 'never runs'), isCircuitOpenError)
    t.mock.timers.tick(300_001)
    assert.equal(await breaker.execute(() => 'probe of period 2'), 'probe of period 2')
    breaker.dispose()
  })

  test('counters arriving as a foreign thenable still reach stats()', async () => {
    const inner = memoryStore({ window: countWindow(10) })
    // Not a native Promise: another realm, a userland promise library, a
    // hand-rolled wrapper. `instanceof Promise` misses all of them.
    const thenable = <T>(value: T): PromiseLike<T> => ({
      then: <R1 = T, R2 = never>(
        onOk?: ((v: T) => R1 | PromiseLike<R1>) | null,
        _onErr?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
      ): PromiseLike<R1 | R2> => thenable<R1 | R2>(onOk?.(value) as R1)
    })
    const store: StateStore = {
      ...inner,
      getCounters: (name) => thenable(inner.getCounters(name)) as unknown as WindowCounters
    }
    const breaker = circuitBreaker({ minimumCalls: 4, name: 'thenable', stateStore: store })

    for (let i = 0; i < 3; i++) {
      await assert.rejects(breaker.execute(() => { throw new Error('down') }))
    }
    await drain()

    // Assigning the thenable itself would leave every counter undefined — and
    // stats() is what CircuitOpenError and any health endpoint report.
    assert.equal(breaker.stats().totalCalls, 3)
    assert.equal(breaker.stats().failures, 3)
    breaker.dispose()
  })

  test('an announcement never delivered costs freshness, not agreement', async () => {
    const shared = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      ...shared,
      readState: async (name) => shared.readState(name),
      compareAndSet: async (name, from, to, fence) => shared.compareAndSet(name, from, to, fence),
      recordSuccess: async (name, ms) => { shared.recordSuccess(name, ms) },
      recordFailure: async (name, ms) => { shared.recordFailure(name, ms) },
      getCounters: async (name) => shared.getCounters(name),
      resetCounters: async (name) => { shared.resetCounters(name) },
      acquireProbe: async () => true,
      // Subscribed, and nothing is ever delivered on it: whatever a peer
      // published while this connection was reconnecting is simply gone.
      subscribe: () => () => {}
    }
    const peer = circuitBreaker({ consecutiveFailures: 1, name: 'shared', stateStore: store })
    const deaf = circuitBreaker({ consecutiveFailures: 1, name: 'shared', stateStore: store })

    await failTimes(peer, 1)
    assert.equal(peer.state, 'open')
    assert.equal(deaf.state, 'closed', 'it never heard about the trip')

    // Holding a subscription must never become a reason to skip the read:
    // the push accelerates agreement, the store is what decides it.
    await assert.rejects(deaf.execute(() => 'never runs'), isCircuitOpenError)
    assert.equal(deaf.state, 'open', 'it converged on the read alone')

    peer.dispose()
    deaf.dispose()
  })

  test('dispose reaches a breaker built through a composition', async () => {
    const inner = memoryStore({ window: countWindow(10) })
    let released = 0
    const store: StateStore = {
      ...inner,
      subscribe: () => () => { released++ }
    }
    const pipeline = resilience({
      circuitBreaker: { name: 'composed', stateStore: store },
      retry: { attempts: 2, backoff: fixed(0) }
    })

    assert.equal(await pipeline.execute(() => 'ok'), 'ok')

    // The breaker is not a handle the caller ever received, so without this
    // its subscription could never be let go.
    pipeline.dispose()
    assert.equal(released, 1)
    pipeline.dispose()
    assert.equal(released, 1, 'and it is safe to call twice')
  })

  test('an unnamed breaker subscribes to nobody', () => {
    const inner = memoryStore({ window: countWindow(10) })
    let subscribed = 0
    const store: StateStore = {
      ...inner,
      subscribe: () => { subscribed++; return () => {} }
    }

    // Its generated name means a channel no peer will ever publish to.
    circuitBreaker({ stateStore: store })
    assert.equal(subscribed, 0)

    circuitBreaker({ name: 'real', stateStore: store })
    assert.equal(subscribed, 1)
  })

  test('a peer opening a new period resets this instance probe bookkeeping', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const store = memoryStore({ window: countWindow(10) })
    const options = { consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 1, name: 'shared' } as const
    const mine = circuitBreaker({ ...options, stateStore: store })
    const peer = circuitBreaker({ ...options, stateStore: store })

    await failTimes(mine, 1)
    t.mock.timers.tick(1_000)

    // I take the single probe slot of period 1 and my call fails, which
    // reopens the circuit — period 1 is over.
    await assert.rejects(mine.execute(boom), /downstream failure/)
    assert.equal(mine.state, 'open')

    // The peer opens period 2 and probes it successfully.
    t.mock.timers.tick(1_000)
    assert.equal(await peer.execute(() => 'peer probe'), 'peer probe')
    assert.equal(peer.state, 'closed')

    // My local slot count belonged to a period that no longer exists: the
    // new fence starts it over, so I am not locked out of the fresh circuit.
    assert.equal(await mine.execute(() => 'mine'), 'mine')
    assert.equal(mine.state, 'closed')
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
      compareAndSet: (name, from, to, fence) => {
        if (losses > 0) { losses--; return { ok: false, snapshot: inner.readState(name) } }
        return inner.compareAndSet(name, from, to, fence)
      }
    }
    const breaker = circuitBreaker({ name: 'contended', stateStore: store })

    await breaker.isolate()

    assert.equal(losses, 0)
    assert.equal(breaker.state, 'isolated')
  })

  test('isolate gives up when the state never settles', async () => {
    const inner = memoryStore()
    const store: StateStore = { ...inner, compareAndSet: (name) => ({ ok: false, snapshot: inner.readState(name) }) }
    const breaker = circuitBreaker({ name: 'thrashing', stateStore: store })

    await assert.rejects(breaker.isolate(), /state kept changing/)
  })

  test('reset announces nothing when its own swap loses the race', async () => {
    const inner = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      ...inner,
      compareAndSet: (name, from, to, fence) => to === 'closed'
        ? { ok: false, snapshot: inner.readState(name) }
        : inner.compareAndSet(name, from, to, fence)
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, name: 'reset-race', stateStore: store })
    await failTimes(breaker, 1)
    assert.equal(breaker.state, 'open')

    const changes: string[] = []
    breaker.on('stateChange', ({ to }) => changes.push(to))
    await breaker.reset()

    // A peer moved first: the circuit is still open, and announcing a close
    // that never happened would lie to every listener downstream.
    assert.equal(breaker.state, 'open')
    assert.deepEqual(changes, [])
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

describe('async store hardening', () => {
  test('a stale probe failure delayed inside the store cannot reopen the next period', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const inner = memoryStore({ window: countWindow(10) })
    let gate: Promise<void> | undefined
    const store: StateStore = {
      ...inner,
      async recordFailure (name, ms) {
        if (gate !== undefined) {
          const held = gate
          gate = undefined
          await held
        }
        inner.recordFailure(name, ms)
      }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 2, name: 'stale', stateStore: store })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    // Period 1: probe A fails but its store write stalls mid-flight...
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    gate = held
    const staleProbe = breaker.execute(boom).catch(() => {})
    await drain()
    // ...probe B fails fast and legitimately re-opens the circuit.
    await assert.rejects(breaker.execute(boom))
    assert.equal(breaker.state, 'open')

    // Period 2 begins and collects its first genuine success.
    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'fresh probe 1')
    assert.equal(breaker.state, 'half-open')

    // The stale write finally lands: the failure belongs to period 1 and
    // must not re-open the period that is busy recovering.
    release()
    await staleProbe
    assert.equal(breaker.state, 'half-open')

    await breaker.execute(() => 'fresh probe 2')
    assert.equal(breaker.state, 'closed')
  })

  test('a stale probe success delayed inside the store cannot help close the next period', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const inner = memoryStore({ window: countWindow(10) })
    let gate: Promise<void> | undefined
    const store: StateStore = {
      ...inner,
      async recordSuccess (name, ms) {
        if (gate !== undefined) {
          const held = gate
          gate = undefined
          await held
        }
        inner.recordSuccess(name, ms)
      }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 3, name: 'stale-ok', stateStore: store })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    gate = held
    const staleProbe = breaker.execute(() => 'stale success')
    await drain()
    await assert.rejects(breaker.execute(boom)) // period 1 ends re-open
    t.mock.timers.tick(1_000)

    await breaker.execute(() => 'fresh probe 1') // period 2: 1 of 2 needed
    assert.equal(breaker.state, 'half-open')

    // The stale success lands now: it must not become period 2's majority.
    release()
    await staleProbe
    assert.equal(breaker.state, 'half-open')

    await breaker.execute(() => 'fresh probe 2')
    assert.equal(breaker.state, 'closed')
  })

  test('a stale success landing before any fresh probe buys the new period nothing', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const inner = memoryStore({ window: countWindow(10) })
    let gate: Promise<void> | undefined
    const store: StateStore = {
      ...inner,
      async recordSuccess (name, ms) {
        if (gate !== undefined) {
          const held = gate
          gate = undefined
          await held
        }
        inner.recordSuccess(name, ms)
      }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 3, name: 'stale-first', stateStore: store })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    gate = held
    const staleProbe = breaker.execute(() => 'stale success')
    await drain()
    await assert.rejects(breaker.execute(boom)) // period 1 dies
    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'enter period 2') // period 2, 1 of 2 needed
    await assert.rejects(breaker.execute(boom)) // period 2 dies too
    t.mock.timers.tick(1_000)

    // Period 3 opens with zero successes; the stale gen-1 success lands
    // FIRST. It must not count as period 3's first success.
    await breaker.execute(() => 'enter period 3')
    assert.equal(breaker.state, 'half-open')
    release()
    await staleProbe
    assert.equal(breaker.state, 'half-open')

    // Only the second GENUINE success closes.
    await breaker.execute(() => 'fresh probe 2')
    assert.equal(breaker.state, 'closed')
  })

  test('a store that fails to record a success never turns it into a rejection', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const inner = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      ...inner,
      recordSuccess: async () => { throw new Error('redis down') }
    }
    const breaker = circuitBreaker({ name: 'flaky-store', stateStore: store })

    assert.equal(await breaker.execute(() => 'the result'), 'the result')

    assert.ok(reported.mock.callCount() >= 1)
    assert.match(String(reported.mock.calls[0]?.arguments[0]), /state store threw/)
  })

  test('a store that fails during failure bookkeeping never masks the domain error', async (t) => {
    t.mock.method(console, 'error', () => {})
    const inner = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      ...inner,
      getCounters: async () => { throw new Error('redis down') }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, name: 'flaky-store-2', stateStore: store })

    await assert.rejects(breaker.execute(boom), /downstream failure/)
    // The local mirrors kept working: the circuit still tripped.
    assert.equal(breaker.state, 'open')
    await drain()
  })

  test('stats() with a rejecting async store answers from last-known values', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const inner = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      ...inner,
      getCounters: async () => { throw new Error('redis down') },
      getLatency: async () => { throw new Error('redis down') }
    }
    const breaker = circuitBreaker({ name: 'dark-store', stateStore: store })

    const stats = breaker.stats()
    assert.equal(stats.state, 'closed')
    assert.equal(stats.totalCalls, 0)

    // The rejections must be contained and reported, never unhandled.
    await drain()
    assert.ok(reported.mock.callCount() >= 1)
  })

  test('losing the closing CAS to a peer is quietly accepted', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const inner = memoryStore({ window: countWindow(10) })
    let stealClose = true
    const store: StateStore = {
      ...inner,
      compareAndSet (name, from, to, fence) {
        if (to === 'closed' && from === 'half-open' && stealClose) {
          // A peer instance closed the shared circuit microseconds earlier.
          stealClose = false
          inner.compareAndSet(name, from, to, fence)
          return { ok: false, snapshot: inner.readState(name) }
        }
        return inner.compareAndSet(name, from, to, fence)
      }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 1, name: 'peer-close', stateStore: store })
    const changes: string[] = []
    breaker.on('stateChange', ({ from, to }) => changes.push(`${from}->${to}`))

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    // The probe succeeds; the close CAS was the peer's, so this instance
    // announces nothing — and the next call flows through the closed circuit.
    assert.equal(await breaker.execute(() => 'probe'), 'probe')
    assert.equal(await breaker.execute(() => 'works'), 'works')
    assert.ok(!changes.includes('half-open->closed'))
  })

  test('a store that fails the opening trip surfaces the domain error and retries later', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const inner = memoryStore({ window: countWindow(10) })
    let failTrip = true
    const store: StateStore = {
      ...inner,
      compareAndSet (name, from, to, fence) {
        if (to === 'open' && failTrip) {
          failTrip = false
          throw new Error('redis down')
        }
        return inner.compareAndSet(name, from, to, fence)
      }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, name: 'no-trip', stateStore: store })

    // The trip failed, but the caller still got the original error...
    await assert.rejects(breaker.execute(boom), /downstream failure/)
    assert.equal(breaker.state, 'closed')
    assert.ok(reported.mock.callCount() >= 1)

    // ...and the next failure retries the trip successfully.
    await assert.rejects(breaker.execute(boom), /downstream failure/)
    assert.equal(breaker.state, 'open')
  })

  test('a store that throws synchronously from reads is contained the same way', (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const inner = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      ...inner,
      getCounters: () => { throw new Error('corrupt cache') },
      getLatency: () => { throw new Error('corrupt cache') }
    }
    const breaker = circuitBreaker({ name: 'sync-throw', stateStore: store })

    const stats = breaker.stats()

    assert.equal(stats.state, 'closed')
    assert.equal(stats.totalCalls, 0)
    assert.equal(stats.latency, undefined)
    assert.equal(reported.mock.callCount(), 2)
  })

  test('an async store feeds counters and latency as reads land, on the success path too', async () => {
    const inner = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      readState: async (name) => inner.readState(name),
      compareAndSet: async (name, from, to, fence) => inner.compareAndSet(name, from, to, fence),
      recordSuccess: async (name, ms) => { inner.recordSuccess(name, ms) },
      recordFailure: async (name, ms) => { inner.recordFailure(name, ms) },
      getCounters: async (name) => inner.getCounters(name),
      getLatency: async (name) => inner.getLatency?.(name) as LatencyStats,
      resetCounters: async (name) => { inner.resetCounters(name) },
      acquireProbe: async () => true
    }
    const breaker = circuitBreaker({ name: 'remote-fresh', stateStore: store })

    await breaker.execute(() => 'a')
    await breaker.execute(() => 'b')

    breaker.stats() // kicks the async reads
    await drain()
    const stats = breaker.stats()

    assert.equal(stats.totalCalls, 2)
    assert.equal(stats.latency?.count, 2)
  })

  test('a slow old read landing after a fresh one cannot regress the stats mirror', async () => {
    const inner = memoryStore({ window: countWindow(10) })
    let holdFirst: Promise<void> | undefined
    const store: StateStore = {
      ...inner,
      async getCounters (name) {
        if (holdFirst !== undefined) {
          const held = holdFirst
          holdFirst = undefined
          await held
        }
        return inner.getCounters(name)
      }
    }
    const breaker = circuitBreaker({ name: 'ooo-reads', stateStore: store })

    // Read #1 dispatches against an empty window and stalls...
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    holdFirst = held
    breaker.stats()

    // ...a call lands and read #2 (fast) feeds the mirror with 1 call.
    await breaker.execute(() => 'ok')
    breaker.stats()
    await drain()
    assert.equal(breaker.stats().totalCalls, 1)

    // The stale empty read lands last: the mirror must not go back to 0.
    release()
    await drain()
    assert.equal(breaker.stats().totalCalls, 1)
  })

  test('a store that fails the closing transition leaves the circuit recoverable', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const reported = t.mock.method(console, 'error', () => {})
    const inner = memoryStore({ window: countWindow(10) })
    let failClose = true
    const store: StateStore = {
      ...inner,
      compareAndSet (name, from, to, fence) {
        if (to === 'closed' && from === 'half-open' && failClose) {
          failClose = false
          throw new Error('redis down')
        }
        return inner.compareAndSet(name, from, to, fence)
      }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 1, name: 'no-close', stateStore: store })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    // First probe succeeds but the close CAS fails: half-open is the safe
    // degradation, and the success still surfaced to the caller.
    assert.equal(await breaker.execute(() => 'probe 1'), 'probe 1')
    assert.equal(breaker.state, 'half-open')

    // The failed CAS was reported, not swallowed silently.
    assert.ok(reported.mock.callCount() >= 1)

    // The next probe retries the close and completes the recovery.
    assert.equal(await breaker.execute(() => 'probe 2'), 'probe 2')
    assert.equal(breaker.state, 'closed')
  })
})

describe('CAS in flight across period changes', () => {
  test('a close CAS that travels across a period flip cannot close the fresh period', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const inner = memoryStore({ window: countWindow(10) })
    let holdClose: Promise<void> | undefined
    const store: StateStore = {
      ...inner,
      async compareAndSet (name, from, to, fence) {
        if (from === 'half-open' && to === 'closed' && holdClose !== undefined) {
          const held = holdClose
          holdClose = undefined
          await held
        }
        return inner.compareAndSet(name, from, to, fence)
      }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 2, name: 'cas-close', stateStore: store })
    const changes: string[] = []
    breaker.on('stateChange', ({ from, to }) => changes.push(`${from}->${to}`))

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    // Period 1 earns its majority, but the closing CAS stalls in flight...
    await breaker.execute(() => 'probe 1')
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    holdClose = held
    const closing = breaker.execute(() => 'probe 2')
    await drain()

    // ...period 1 dies to a failure, and period 2 starts with one success.
    await assert.rejects(breaker.execute(boom))
    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'fresh probe 1')
    assert.equal(breaker.state, 'half-open')

    // The stale CAS lands now: it must not close period 2 with 1 success.
    release()
    assert.equal(await closing, 'probe 2')
    assert.equal(breaker.state, 'half-open')
    assert.ok(!changes.includes('half-open->closed'))

    // Period 2 completes its own majority normally.
    await breaker.execute(() => 'fresh probe 2')
    assert.equal(breaker.state, 'closed')
    assert.equal(changes.filter((c) => c === 'half-open->closed').length, 1)
  })

  test('a trip CAS that travels across a period flip cannot kill the fresh recovery', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const inner = memoryStore({ window: countWindow(10) })
    let holdTrip: Promise<void> | undefined
    const store: StateStore = {
      ...inner,
      async compareAndSet (name, from, to, fence) {
        if (from === 'half-open' && to === 'open' && holdTrip !== undefined) {
          const held = holdTrip
          holdTrip = undefined
          await held
        }
        return inner.compareAndSet(name, from, to, fence)
      }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 3, name: 'cas-trip', stateStore: store })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)

    // Period 1: probe A fails and its re-opening CAS stalls in flight...
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    holdTrip = held
    const staleTrip = breaker.execute(boom).catch(() => {})
    await drain()

    // ...probe B also fails and re-opens period 1 for real.
    await assert.rejects(breaker.execute(boom))
    assert.equal(breaker.state, 'open')

    // Period 2 starts recovering.
    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'fresh probe 1')
    assert.equal(breaker.state, 'half-open')

    // The stale trip lands now: period 2 must keep recovering.
    release()
    await staleTrip
    assert.equal(await breaker.execute(() => 'fresh probe 2'), 'fresh probe 2')
    assert.equal(breaker.state, 'closed')
  })

  test('unisolate and reset survive a failing counter cleanup', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const inner = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      ...inner,
      resetCounters: () => { throw new Error('redis down') }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, name: 'admin-ops', stateStore: store })
    const changes: string[] = []
    breaker.on('stateChange', ({ from, to }) => changes.push(`${from}->${to}`))

    // unisolate: the committed transition is announced despite the cleanup.
    await breaker.isolate()
    await breaker.unisolate()
    assert.equal(breaker.state, 'closed')
    assert.ok(changes.includes('isolated->closed'))

    // reset: an open circuit still returns to closed.
    await failTimes(breaker, 1)
    await breaker.reset()
    assert.equal(breaker.state, 'closed')
    assert.ok(reported.mock.callCount() >= 2)
  })

  test('a failing counter reset never swallows the close announcement', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const reported = t.mock.method(console, 'error', () => {})
    const inner = memoryStore({ window: countWindow(10) })
    const store: StateStore = {
      ...inner,
      resetCounters: () => { throw new Error('redis down') }
    }
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 1, name: 'no-reset', stateStore: store })
    const closes: string[] = []
    breaker.on('close', ({ stats }) => closes.push(stats.state))

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'probe')

    // The close CAS committed: state and event must both say so, with the
    // failed cleanup reported instead of silently eating the transition.
    assert.equal(breaker.state, 'closed')
    assert.deepEqual(closes, ['closed'])
    assert.ok(reported.mock.callCount() >= 1)
  })
})

describe('stats timing honesty', () => {
  test('a mirror that watched the circuit close elsewhere stops reporting open timing', async (t) => {
    // Mock timers rather than a one-millisecond cooldown against the wall
    // clock: the point here is what B reports, not whether B got scheduled
    // inside a millisecond.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const store = memoryStore({ window: countWindow(10) })
    const options = { consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 1, name: 'shared-timing', stateStore: store } as const
    const a = circuitBreaker(options)
    const b = circuitBreaker(options)

    await failTimes(a, 1)
    await assert.rejects(b.execute(() => 'x'), isCircuitOpenError) // B saw it open
    assert.notEqual(b.stats().openedAt, undefined)

    // A recovers the shared circuit; B observes closed on its next call.
    t.mock.timers.tick(1_000)
    await a.execute(() => 'probe 1')
    assert.equal(a.state, 'closed')

    await b.execute(() => 'ok')
    const stats = b.stats()
    assert.equal(stats.state, 'closed')
    assert.equal(stats.openedAt, undefined)
    assert.equal(stats.nextAttemptAt, undefined)
  })

  test('isolation reports no probing forecast — it never expires on its own', async () => {
    const breaker = circuitBreaker({ consecutiveFailures: 1 })
    await failTimes(breaker, 1)
    await breaker.isolate()

    const stats = breaker.stats()
    assert.equal(stats.state, 'isolated')
    assert.equal(stats.openedAt, undefined)
    assert.equal(stats.nextAttemptAt, undefined)
  })

  test('half-open keeps openedAt but drops the already-past nextAttemptAt', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    t.mock.timers.setTime(1_000_000)
    const breaker = circuitBreaker({ consecutiveFailures: 1, halfOpenAfter: 1_000, halfOpenCalls: 2 })

    await failTimes(breaker, 1)
    t.mock.timers.tick(1_000)
    await breaker.execute(() => 'probe 1')
    assert.equal(breaker.state, 'half-open')

    const stats = breaker.stats()
    assert.equal(stats.openedAt, 1_000_000)
    assert.equal(stats.nextAttemptAt, undefined)
  })

  test('unisolate clears lastError along with the counters', async () => {
    const breaker = circuitBreaker({ consecutiveFailures: 5 })
    await failTimes(breaker, 1)
    await breaker.isolate()

    await breaker.unisolate()

    assert.equal(breaker.stats().lastError, undefined)
  })
})
