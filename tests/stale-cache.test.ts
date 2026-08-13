import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { CircuitOpenError, IsolatedError } from '../src/errors'
import { memoryCache, type CacheEntry, type CacheStore } from '../src/stale-cache/cache-store'
import { staleCache } from '../src/stale-cache/stale-cache'
import { circuitBreaker } from '../src/circuit-breaker/circuit-breaker'
import { compose } from '../src/compose/compose'
import { resilience } from '../src/compose/resilience'
import { retry } from '../src/retry/retry'
import { fixed } from '../src/retry/backoff'
import { attachMetrics } from '../src/metrics/attach'

const openError = (): CircuitOpenError =>
  new CircuitOpenError({ state: 'open', successes: 0, failures: 1, totalCalls: 1, failureRate: 1 })

describe('staleCache() basics', () => {
  test('kind discriminant', () => {
    assert.equal(staleCache().kind, 'staleCache')
  })

  test('success flows through untouched and gets cached', async () => {
    const policy = staleCache()

    assert.equal(await policy.execute(() => 'fresh'), 'fresh')
    assert.equal(await policy.execute(() => { throw openError() }), 'fresh')
  })

  test('by default only circuit rejections are rescued', async () => {
    const policy = staleCache()
    await policy.execute(() => 'good')

    assert.equal(await policy.execute(() => { throw openError() }), 'good')
    assert.equal(await policy.execute(() => { throw new IsolatedError() }), 'good')
    await assert.rejects(policy.execute(() => { throw new Error('plain failure') }), { message: 'plain failure' })
  })

  test('staleIf generalizes the rescue to any qualifying error', async () => {
    const policy = staleCache({ staleIf: () => true })
    await policy.execute(() => 'good')

    assert.equal(await policy.execute(() => { throw new Error('anything') }), 'good')
  })

  test('nothing cached: the original error propagates and miss is emitted', async () => {
    const policy = staleCache()
    const misses: Array<{ key: string, error: unknown, correlationId: string }> = []
    policy.on('miss', (event) => misses.push(event))

    const error = openError()
    await assert.rejects(policy.execute(() => { throw error }, { correlationId: 'c-miss' }), { name: 'CircuitOpenError' })
    assert.equal(misses.length, 1)
    assert.equal(misses[0]?.key, '')
    assert.equal(misses[0]?.error, error)
    assert.equal(misses[0]?.correlationId, 'c-miss')
  })

  test('a rescue emits stale with the key, age and original error', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = staleCache()
    const events: Array<{ key: string, ageMs: number, error: unknown }> = []
    policy.on('stale', (event) => events.push(event))

    await policy.execute(() => 'good')
    t.mock.timers.tick(5_000)
    const error = openError()
    assert.equal(await policy.execute(() => { throw error }), 'good')

    assert.equal(events.length, 1)
    assert.equal(events[0]?.key, '')
    assert.equal(events[0]?.ageMs, 5_000)
    assert.equal(events[0]?.error, error)
  })

  test('cancellation never serves stale', async () => {
    const policy = staleCache({ staleIf: () => true })
    await policy.execute(() => 'good')

    const controller = new AbortController()
    await assert.rejects(policy.execute(() => {
      controller.abort()
      throw new Error('cut short')
    }, { signal: controller.signal }), { message: 'cut short' })
  })

  test('undefined is a cacheable value, distinct from a miss', async () => {
    const policy = staleCache()
    await policy.execute(() => undefined)

    assert.equal(await policy.execute(() => { throw openError() }), undefined)
  })

  test('the freshest success wins', async () => {
    const policy = staleCache()
    await policy.execute(() => 'first')
    await policy.execute(() => 'second')

    assert.equal(await policy.execute(() => { throw openError() }), 'second')
  })
})

describe('staleCache() maxAge', () => {
  test('an entry older than maxAge is not served', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = staleCache({ maxAge: 60_000 })
    await policy.execute(() => 'good')

    t.mock.timers.tick(60_000)
    assert.equal(await policy.execute(() => { throw openError() }), 'good')

    t.mock.timers.tick(1)
    await assert.rejects(policy.execute(() => { throw openError() }), { name: 'CircuitOpenError' })
  })

  test('a fresh success renews the clock', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = staleCache({ maxAge: 60_000 })
    await policy.execute(() => 'old')
    t.mock.timers.tick(50_000)
    await policy.execute(() => 'renewed')
    t.mock.timers.tick(50_000)

    assert.equal(await policy.execute(() => { throw openError() }), 'renewed')
  })

  test('a negative maxAge throws at construction', () => {
    assert.throws(() => staleCache({ maxAge: -1 }), { name: 'RangeError', message: /maxAge/ })
    assert.throws(() => staleCache({ maxAge: Number.NaN }), { name: 'RangeError', message: /maxAge/ })
  })

  test('an explicit Infinity is the documented default spelled out', async () => {
    const policy = staleCache({ maxAge: Infinity })
    await policy.execute(() => 'good')
    assert.equal(await policy.execute(() => { throw openError() }), 'good')
  })

  test('a clock that jumps backwards clamps the age to zero', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const policy = staleCache({ maxAge: 0 })
    await policy.execute(() => 'good')

    t.mock.timers.setTime(999_000)
    assert.equal(await policy.execute(() => { throw openError() }), 'good')
  })
})

describe('staleCache() keyed entries', () => {
  test('key() splits the cache by metadata', async () => {
    const policy = staleCache({ key: (ctx) => String(ctx.metadata.host ?? '') })

    await policy.execute(() => 'answer-a', { metadata: { host: 'a' } })
    await policy.execute(() => 'answer-b', { metadata: { host: 'b' } })

    assert.equal(await policy.execute(() => { throw openError() }, { metadata: { host: 'a' } }), 'answer-a')
    assert.equal(await policy.execute(() => { throw openError() }, { metadata: { host: 'b' } }), 'answer-b')
    await assert.rejects(policy.execute(() => { throw openError() }, { metadata: { host: 'c' } }), { name: 'CircuitOpenError' })
  })

  test('a throwing key extractor is contained on both paths', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const policy = staleCache({ key: () => { throw new Error('key exploded') } })

    // Success path: the outcome stands, the bookkeeping is lost.
    assert.equal(await policy.execute(() => 'ok'), 'ok')
    // Failure path: the ORIGINAL error propagates, not the extractor's.
    await assert.rejects(policy.execute(() => { throw openError() }), { name: 'CircuitOpenError' })
    assert.equal(reported.mock.callCount(), 2)
  })
})

describe('staleCache() store contract', () => {
  test('a throwing store never rewrites the outcome on either path', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const broken: CacheStore = {
      get () { throw new Error('store get exploded') },
      set () { throw new Error('store set exploded') }
    }
    const policy = staleCache({ store: broken })

    assert.equal(await policy.execute(() => 'ok'), 'ok')
    await assert.rejects(policy.execute(() => { throw openError() }), { name: 'CircuitOpenError' })
    assert.equal(reported.mock.callCount(), 2)
  })

  test('an ASYNC store rejection never rewrites the outcome on either path', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const rejecting: CacheStore = {
      async get () { throw new Error('store get rejected') },
      async set () { throw new Error('store set rejected') }
    }
    const policy = staleCache({ store: rejecting })

    assert.equal(await policy.execute(() => 'ok'), 'ok')
    await assert.rejects(policy.execute(() => { throw openError() }), { name: 'CircuitOpenError' })
    assert.equal(reported.mock.callCount(), 2)
  })

  test('the write lands before execute() resolves', async () => {
    const entries = new Map<string, CacheEntry>()
    const slowStore: CacheStore = {
      get: (key) => entries.get(key),
      async set (key, entry) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        entries.set(key, entry)
      }
    }
    const policy = staleCache({ store: slowStore })

    await policy.execute(() => 'good')
    // The slow async set must have completed by now — a fire-and-forget
    // write would leave the very next rescue empty-handed.
    assert.equal(await policy.execute(() => { throw openError() }), 'good')
  })

  test('set receives the bounded maxAge as an advisory hint, and only then', async () => {
    const hints: unknown[] = []
    const recording = (): CacheStore => ({
      get: () => undefined,
      set (_key, _entry, hint) { hints.push(hint) }
    })

    await staleCache({ store: recording(), maxAge: 60_000 }).execute(() => 'ok')
    await staleCache({ store: recording() }).execute(() => 'ok')
    await staleCache({ store: recording(), maxAge: Infinity }).execute(() => 'ok')

    assert.deepEqual(hints, [{ maxAgeMs: 60_000 }, undefined, undefined])
  })

  test('an async store works end to end', async () => {
    const entries = new Map<string, CacheEntry>()
    const asyncStore: CacheStore = {
      async get (key) { return entries.get(key) },
      async set (key, entry) { entries.set(key, entry) }
    }
    const policy = staleCache({ store: asyncStore })

    await policy.execute(() => 'good')
    assert.equal(await policy.execute(() => { throw openError() }), 'good')
  })

  test('clear() drops the cache and store errors propagate', async () => {
    const policy = staleCache()
    await policy.execute(() => 'good')
    await policy.clear()
    await assert.rejects(policy.execute(() => { throw openError() }), { name: 'CircuitOpenError' })

    const broken = staleCache({
      store: {
        get: () => undefined,
        set: () => {},
        clear () { throw new Error('clear exploded') }
      }
    })
    await assert.rejects(broken.clear(), { message: 'clear exploded' })
  })

  test('clear() on a store without clear() is a no-op', async () => {
    const policy = staleCache({ store: { get: () => undefined, set: () => {} } })
    await policy.clear()
  })
})

describe('memoryCache()', () => {
  test('validates maxEntries', () => {
    assert.throws(() => memoryCache({ maxEntries: 0 }), { name: 'RangeError', message: /maxEntries/ })
    assert.throws(() => memoryCache({ maxEntries: 1.5 }), { name: 'RangeError', message: /maxEntries/ })
  })

  test('evicts the least-recently-written key first', () => {
    const store = memoryCache({ maxEntries: 2 })
    store.set('a', { value: 1, storedAt: 0 })
    store.set('b', { value: 2, storedAt: 0 })
    // Rewriting `a` refreshes it: `b` is now the stalest write.
    store.set('a', { value: 3, storedAt: 0 })
    store.set('c', { value: 4, storedAt: 0 })

    assert.equal(store.get('b'), undefined)
    assert.deepEqual(store.get('a'), { value: 3, storedAt: 0 })
    assert.deepEqual(store.get('c'), { value: 4, storedAt: 0 })
  })

  test('delete removes a single key', () => {
    const store = memoryCache()
    store.set('a', { value: 1, storedAt: 0 })
    store.delete?.('a')
    assert.equal(store.get('a'), undefined)
  })
})

describe('staleCache() in a pipeline', () => {
  test('stale-while-open, literally: rescues once the breaker opens', async () => {
    const pipeline = compose(
      staleCache(),
      circuitBreaker({ name: 'swo-pipeline', consecutiveFailures: 2 })
    )

    assert.equal(await pipeline.execute(() => 'good'), 'good')
    await assert.rejects(pipeline.execute(() => { throw new Error('down') }), { message: 'down' })
    await assert.rejects(pipeline.execute(() => { throw new Error('down') }), { message: 'down' })
    // Circuit is open: the call is rejected without running, and rescued.
    let ran = false
    assert.equal(await pipeline.execute(() => { ran = true; return 'never' }), 'good')
    assert.equal(ran, false)
  })

  test('outside the retry: the rescue only happens after retrying gives up', async () => {
    const attempts: number[] = []
    const pipeline = compose(
      staleCache({ staleIf: () => true }),
      retry({ attempts: 3, backoff: fixed(0) })
    )
    await pipeline.execute(() => 'good')

    assert.equal(await pipeline.execute(({ attempt }) => {
      attempts.push(attempt)
      throw new Error('down')
    }), 'good')
    assert.deepEqual(attempts, [0, 1, 2])
  })

  test('resilience({ staleCache }) wires it between fallback and retry', async () => {
    const policy = resilience({
      name: 'swo',
      staleCache: {},
      circuitBreaker: { name: 'swo', consecutiveFailures: 1 },
      fallback: () => 'last resort'
    })

    assert.equal(await policy.execute(() => 'good'), 'good')
    // Trips the breaker; the failure itself is NOT a circuit rejection, so
    // it falls through the stale cache to the fallback.
    assert.equal(await policy.execute(() => { throw new Error('down') }), 'last resort')
    // Open circuit: the stale cache answers before the fallback is asked.
    assert.equal(await policy.execute(() => 'never runs'), 'good')
  })

  test('in resilience(), every retry attempt burns before the rescue', async () => {
    const attempts: number[] = []
    const policy = resilience({
      staleCache: { staleIf: () => true },
      retry: { attempts: 3, backoff: fixed(0) }
    })
    assert.equal(await policy.execute(() => 'good'), 'good')

    // A stale cache INSIDE the retry would rescue attempt 0 and stop here.
    assert.equal(await policy.execute(({ attempt }) => {
      attempts.push(attempt)
      throw new Error('down')
    }), 'good')
    assert.deepEqual(attempts, [0, 1, 2])
  })

  test('resilience() without staleCache never rescues', async () => {
    const policy = resilience({
      circuitBreaker: { name: 'no-rescue', consecutiveFailures: 1 }
    })
    assert.equal(await policy.execute(() => 'good'), 'good')
    await assert.rejects(policy.execute(() => { throw new Error('down') }), { message: 'down' })
    // Open circuit and no staleCache configured: the rejection propagates.
    await assert.rejects(policy.execute(() => 'never runs'), { name: 'CircuitOpenError' })
  })

  test('resilience({ metrics }) reports rescues to onStale with the pipeline name', async () => {
    const served: Array<{ name?: string, ageMs: number }> = []
    const policy = resilience({
      name: 'swo-metrics',
      staleCache: {},
      circuitBreaker: { name: 'swo-metrics', consecutiveFailures: 1 },
      metrics: { onStale: (event) => served.push(event) }
    })

    assert.equal(await policy.execute(() => 'good'), 'good')
    await assert.rejects(policy.execute(() => { throw new Error('down') }))
    assert.equal(await policy.execute(() => 'never runs'), 'good')

    assert.equal(served.length, 1)
    assert.equal(served[0]?.name, 'swo-metrics')
  })

  test('attachMetrics reports rescues to onStale', async () => {
    const served: Array<{ name?: string, ageMs: number }> = []
    const policy = staleCache()
    const detach = attachMetrics(policy, { onStale: (event) => served.push(event) }, { name: 'api' })

    await policy.execute(() => 'good')
    await policy.execute(() => { throw openError() })

    assert.equal(served.length, 1)
    assert.equal(served[0]?.name, 'api')
    assert.equal(typeof served[0]?.ageMs, 'number')
    detach()
  })
})
