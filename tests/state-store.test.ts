import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { memoryStore, type LatencyStats, type StateStore } from '../src/circuit-breaker/state-store'
import { countWindow, timeWindow } from '../src/circuit-breaker/window'

/** memoryStore answers synchronously; the interface allows a promise. */
const latencyOf = (store: StateStore, name: string): LatencyStats =>
  store.getLatency?.(name) as LatencyStats

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

describe('memoryStore latency', () => {
  test('a count window summarises exactly the calls it holds', () => {
    const store = memoryStore({ window: countWindow(4) })

    for (const ms of [10, 20, 30, 40]) store.recordSuccess('b', ms)

    assert.deepEqual(latencyOf(store, 'b'), {
      count: 4,
      min: 10,
      max: 40,
      mean: 25,
      p50: 20, // nearest-rank: ceil(0.5 * 4) = 2nd value
      p95: 40,
      p99: 40
    })
  })

  test('durations age out with the outcomes they belong to', () => {
    const store = memoryStore({ window: countWindow(2) })

    store.recordSuccess('b', 1_000)
    store.recordSuccess('b', 1_000)
    assert.equal(latencyOf(store, 'b').max, 1_000)

    // Two fast calls push the slow ones out of the window.
    store.recordSuccess('b', 5)
    store.recordFailure('b', 7)
    assert.deepEqual(latencyOf(store, 'b'), { count: 2, min: 5, max: 7, mean: 6, p50: 5, p95: 7, p99: 7 })
  })

  test('failures count towards latency too — a slow failure is still slow', () => {
    const store = memoryStore({ window: countWindow(2) })

    store.recordSuccess('b', 10)
    store.recordFailure('b', 90)

    assert.equal(latencyOf(store, 'b').count, 2)
    assert.equal(latencyOf(store, 'b').max, 90)
  })

  test('a time window drops the latency of expired buckets', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const store = memoryStore({ window: timeWindow(1_000) })

    store.recordSuccess('b', 900)
    t.mock.timers.tick(900)
    store.recordSuccess('b', 5)

    // Both still in the window.
    assert.equal(latencyOf(store, 'b').count, 2)

    // The slow call's bucket ages out while the fast one's is still inside
    // the window: the summary must forget only the first.
    t.mock.timers.setTime(1_001_500)
    assert.deepEqual(latencyOf(store, 'b'), { count: 1, min: 5, max: 5, mean: 5, p50: 5, p95: 5, p99: 5 })
  })

  test('a time window keeps its sample bounded under load', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const store = memoryStore({ window: timeWindow(1_000) }) // buckets of 100ms

    // 5_000 calls inside a single bucket: memory must not grow with traffic.
    for (let i = 0; i < 5_000; i++) store.recordSuccess('b', i)

    const latency = latencyOf(store, 'b')
    assert.ok(latency.count <= 128, `sampled ${latency?.count ?? 0}, expected at most 128`)
    // Sampling keeps the most recent calls, so the tail of the run is what shows.
    assert.equal(latency.max, 4_999)
  })

  test('an untouched window reports zeroes rather than nothing', () => {
    const store = memoryStore({ window: countWindow(4) })

    assert.deepEqual(latencyOf(store, 'b'), { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 })
  })

  test('resetCounters clears the latency with the counters', () => {
    const store = memoryStore({ window: countWindow(4) })
    store.recordSuccess('b', 42)

    store.resetCounters('b')

    assert.equal(latencyOf(store, 'b').count, 0)
  })
})

describe('memoryStore lifecycle and clock', () => {
  test('delete drops everything stored under a name', async () => {
    const store = memoryStore({ window: countWindow(4) })
    store.recordFailure('b', 10)
    store.compareAndSet('b', 'closed', 'open', 0)

    store.delete?.('b')

    // The name starts over: closed, empty counters, empty latency.
    assert.equal(store.readState('b').state, 'closed')
    assert.equal((await store.getCounters('b')).totalCalls, 0)
    assert.equal(latencyOf(store, 'b').count, 0)
  })

  test('a backwards clock step lands records in the newest bucket, never behind it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const store = memoryStore({ window: timeWindow(1_000) })

    store.recordFailure('b', 1)
    t.mock.timers.tick(900)
    t.mock.timers.setTime(1_000_100) // clock steps back 800ms

    // The record must not create an out-of-order bucket that the
    // front-only expiry could never remove.
    store.recordSuccess('b', 1)
    assert.equal((await store.getCounters('b')).totalCalls, 2)

    // Both age out with their (ordered) buckets — nothing immortal remains.
    t.mock.timers.setTime(1_002_200)
    assert.equal((await store.getCounters('b')).totalCalls, 0)
  })
})

describe('memoryStore state transitions', () => {
  test('compareAndSet swaps only from the expected state', () => {
    const store = memoryStore()
    assert.equal(store.readState('b').state, 'closed')
    assert.equal(store.compareAndSet('b', 'closed', 'open', 0).ok, true)
    // The state moved on: the same swap no longer applies.
    assert.equal(store.compareAndSet('b', 'closed', 'open', 1).ok, false)
    assert.equal(store.readState('b').state, 'open')
  })

  test('compareAndSet refuses a swap carrying a stale fence', () => {
    const store = memoryStore()
    const stale = store.readState('b').fence

    assert.equal(store.compareAndSet('b', 'closed', 'open', stale).ok, true)
    assert.equal(store.compareAndSet('b', 'open', 'half-open', stale + 1).ok, true)
    // Back to a state this caller's fence once matched — the ABA case a
    // fence exists for: the state name lines up, the period does not.
    assert.equal(store.compareAndSet('b', 'half-open', 'open', stale + 2).ok, true)
    assert.equal(store.compareAndSet('b', 'open', 'closed', stale).ok, false)
    assert.equal(store.readState('b').state, 'open')
  })

  test('every successful swap mints a new fence, and the period timing follows the state', () => {
    const store = memoryStore()
    const first = store.readState('b')
    assert.equal(first.openedAt, undefined)

    const opened = store.compareAndSet('b', 'closed', 'open', first.fence)
    assert.notEqual(opened.snapshot.fence, first.fence)
    assert.equal(typeof opened.snapshot.openedAt, 'number')

    // half-open belongs to the same open period: the timing carries over.
    const probing = store.compareAndSet('b', 'open', 'half-open', opened.snapshot.fence)
    assert.equal(probing.snapshot.openedAt, opened.snapshot.openedAt)

    // Closing leaves the period behind entirely.
    const closed = store.compareAndSet('b', 'half-open', 'closed', probing.snapshot.fence)
    assert.equal(closed.snapshot.openedAt, undefined)
  })

  test('a deleted name never gets a fence it already used', () => {
    const store = memoryStore()

    store.compareAndSet('b', 'closed', 'open', store.readState('b').fence)
    store.compareAndSet('b', 'open', 'half-open', store.readState('b').fence)
    const before = store.readState('b').fence

    store.delete?.('b')

    // Restarting the count would let a swap still in flight across the delete
    // land on a period several generations later — the very ambiguity the
    // fence exists to remove.
    assert.ok(store.readState('b').fence >= before, 'fences must never rewind')
    assert.equal(store.compareAndSet('b', 'closed', 'open', 0).ok, false)
  })

  test('a lost swap reports where the circuit actually is', () => {
    const store = memoryStore()
    const start = store.readState('b')
    store.compareAndSet('b', 'closed', 'open', start.fence)

    const lost = store.compareAndSet('b', 'closed', 'open', start.fence)
    assert.equal(lost.ok, false)
    assert.equal(lost.snapshot.state, 'open')
  })
})
