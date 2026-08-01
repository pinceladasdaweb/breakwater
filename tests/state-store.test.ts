import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { memoryStore } from '../src/circuit-breaker/state-store'
import { countWindow, timeWindow } from '../src/circuit-breaker/window'

describe('memoryStore count window', () => {
  test('keeps exact counters through ring wrap-around', () => {
    const store = memoryStore({ window: countWindow(3) })

    store.recordFailure('b', 1)
    store.recordFailure('b', 1)
    store.recordFailure('b', 1)
    assert.deepEqual(store.getCounters('b'), { successes: 0, failures: 3, totalCalls: 3, failureRate: 1 })

    store.recordSuccess('b', 1) // evicts the oldest failure
    assert.deepEqual(store.getCounters('b'), { successes: 1, failures: 2, totalCalls: 3, failureRate: 2 / 3 })

    store.recordSuccess('b', 1)
    store.recordSuccess('b', 1)
    assert.deepEqual(store.getCounters('b'), { successes: 3, failures: 0, totalCalls: 3, failureRate: 0 })
  })

  test('evicting a success leaves the running failure total intact', () => {
    const store = memoryStore({ window: countWindow(2) })

    store.recordFailure('b', 1)
    store.recordSuccess('b', 1) // the ring is now full

    store.recordFailure('b', 1) // evicts the failure: the total holds at 1
    assert.deepEqual(store.getCounters('b'), { successes: 1, failures: 1, totalCalls: 2, failureRate: 0.5 })

    // Evicting the success must not discount a failure that is still in the
    // window — the running total is what the breaker trips on.
    store.recordFailure('b', 1)
    assert.deepEqual(store.getCounters('b'), { successes: 0, failures: 2, totalCalls: 2, failureRate: 1 })
  })
})

describe('memoryStore time window', () => {
  test('expires old outcomes after the window plus bucket granularity', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const store = memoryStore({ window: timeWindow(500) })

    store.recordFailure('b', 1)
    assert.equal((await store.getCounters('b')).failures, 1)

    // Within the window: still counted.
    t.mock.timers.tick(400)
    assert.equal((await store.getCounters('b')).failures, 1)

    // Beyond window + bucket size (500 + 50): fully expired.
    t.mock.timers.tick(200)
    assert.deepEqual(await store.getCounters('b'), { successes: 0, failures: 0, totalCalls: 0, failureRate: 0 })
  })

  test('aggregates across buckets inside the window', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(2_000_000)
    const store = memoryStore({ window: timeWindow(1_000) })

    store.recordFailure('b', 1)
    t.mock.timers.tick(300)
    store.recordSuccess('b', 1)
    t.mock.timers.tick(300)
    store.recordFailure('b', 1)

    const counters = await store.getCounters('b')
    assert.equal(counters.totalCalls, 3)
    assert.equal(counters.failures, 2)
  })

  test('outcomes leave the window one bucket at a time', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    // Deliberately not a multiple of the bucket size: buckets are aligned to
    // absolute time, not to the first call.
    t.mock.timers.setTime(1_000_050)
    const store = memoryStore({ window: timeWindow(1_000) }) // 10 buckets of 100ms

    store.recordFailure('b', 1)
    t.mock.timers.tick(900)
    store.recordSuccess('b', 1)

    // Walking the clock across both bucket edges. At 1_001_060 the failure is
    // already past the nominal window, but the bucket it landed in (starting
    // at 1_000_000) has not fully aged out — the edge has bucket granularity.
    t.mock.timers.setTime(1_001_060)
    assert.equal((await store.getCounters('b')).failures, 1)

    // At 1_001_100 that bucket ends exactly on the edge, which counts as
    // past — while the success's bucket stays: expiry is per bucket, not
    // all-or-nothing.
    t.mock.timers.setTime(1_001_100)
    assert.deepEqual(await store.getCounters('b'), { successes: 1, failures: 0, totalCalls: 1, failureRate: 0 })

    t.mock.timers.setTime(1_001_950)
    assert.equal((await store.getCounters('b')).totalCalls, 1)
    t.mock.timers.setTime(1_002_100)
    assert.equal((await store.getCounters('b')).totalCalls, 0)
  })

  test('resetCounters clears the window', async () => {
    const store = memoryStore({ window: timeWindow(1_000) })
    store.recordFailure('b', 1)
    store.resetCounters('b')
    assert.equal((await store.getCounters('b')).totalCalls, 0)
  })
})

describe('memoryStore state transitions', () => {
  test('transition is compare-and-set', () => {
    const store = memoryStore()
    assert.equal(store.getState('b'), 'closed')
    assert.equal(store.transition('b', 'closed', 'open'), true)
    assert.equal(store.transition('b', 'closed', 'open'), false)
    assert.equal(store.getState('b'), 'open')
  })
})
