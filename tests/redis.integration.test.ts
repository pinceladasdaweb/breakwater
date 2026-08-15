import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import Redis from 'ioredis'

import { circuitBreaker } from '../src/circuit-breaker/circuit-breaker'
import { rateLimit } from '../src/rate-limit/rate-limit'
import { timeWindow } from '../src/circuit-breaker/window'
import { isCircuitOpenError } from '../src/errors'
import { fromIoredis, redisRateLimit, redisStore } from '../src/redis/index'

/**
 * Runs against a real Redis, because the whole point of this store is the
 * Lua: the atomicity of the fenced swap, the server clock every instance
 * shares, and the probe election cannot be proven against a fake.
 *
 * Gated on REDIS_URL so the normal suite stays hermetic:
 *   docker run --rm -p 6399:6379 redis:7-alpine
 *   REDIS_URL=redis://127.0.0.1:6399 npm test
 */
const REDIS_URL = process.env.REDIS_URL

// Skipping keeps the suite hermetic for anyone without a Redis around — and
// for any workflow that does not provide one. Where a workflow DOES provide
// it, REDIS_REQUIRED says so, and then a missing REDIS_URL is a failure
// rather than a skip: a service container that never came up must not report
// a green build with none of this verified.
const skip = REDIS_URL !== undefined || process.env.REDIS_REQUIRED !== undefined
  ? false
  : 'REDIS_URL is not set'

describe('redisStore against a real Redis', { skip }, () => {
  let client: Redis

  before(async () => {
    client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 2 })
  })

  after(async () => {
    await client.quit()
  })

  beforeEach(async () => {
    await client.flushall()
  })

  const store = (options: { probeTtlMs?: number, window?: ReturnType<typeof timeWindow> } = {}): ReturnType<typeof redisStore> =>
    redisStore({ client: fromIoredis(client), window: options.window ?? timeWindow(1_000), ...options })

  test('a fresh circuit reads as closed without writing anything', async () => {
    const shared = store()

    const snapshot = await shared.readState('fresh')
    assert.deepEqual(snapshot, { state: 'closed', fence: 0 })
    // A read must not create the key: an untouched circuit costs nothing.
    assert.equal(await client.exists('bw:{fresh}'), 0)
  })

  test('the swap mints a fence and stamps the period from the SERVER clock', async () => {
    const shared = store()

    const opened = await shared.compareAndSet('api', 'closed', 'open', 0)
    assert.equal(opened.ok, true)
    assert.equal(opened.snapshot.state, 'open')
    assert.equal(opened.snapshot.fence, 1)

    const serverNow = Number((await client.time())[0]) * 1000
    assert.ok(Math.abs((opened.snapshot.openedAt as number) - serverNow) < 5_000)

    // half-open belongs to the same period, so the timing carries over.
    const probing = await shared.compareAndSet('api', 'open', 'half-open', 1)
    assert.equal(probing.ok, true)
    assert.equal(probing.snapshot.openedAt, opened.snapshot.openedAt)

    // Closing leaves the period behind entirely.
    const closed = await shared.compareAndSet('api', 'half-open', 'closed', 2)
    assert.equal(closed.snapshot.openedAt, undefined)
  })

  test('a swap carrying a stale fence is refused, ABA included', async () => {
    const shared = store()
    const start = await shared.readState('aba')

    await shared.compareAndSet('aba', 'closed', 'open', start.fence)
    await shared.compareAndSet('aba', 'open', 'half-open', start.fence + 1)
    await shared.compareAndSet('aba', 'half-open', 'open', start.fence + 2)

    // The state spells 'open' again, and this caller's `from` matches — only
    // the fence knows the period it belonged to is gone.
    const stale = await shared.compareAndSet('aba', 'open', 'closed', start.fence + 1)
    assert.equal(stale.ok, false)
    assert.equal(stale.snapshot.state, 'open')
    assert.equal(stale.snapshot.fence, start.fence + 3)
  })

  test('a lost swap reports where the circuit actually is, without a second round trip', async () => {
    const shared = store()
    const peer = store()
    const start = await shared.readState('race')

    assert.equal((await peer.compareAndSet('race', 'closed', 'open', start.fence)).ok, true)

    const lost = await shared.compareAndSet('race', 'closed', 'open', start.fence)
    assert.equal(lost.ok, false)
    assert.equal(lost.snapshot.state, 'open')
    assert.equal(typeof lost.snapshot.openedAt, 'number')
  })

  test('counters aggregate across instances and age out with the window', async () => {
    const a = store({ window: timeWindow(1_000) })
    const b = store({ window: timeWindow(1_000) })

    await a.recordFailure('counted', 5)
    await b.recordFailure('counted', 5)
    await b.recordSuccess('counted', 5)

    // Each instance sees the whole fleet's calls, not just its own.
    const counters = await a.getCounters('counted')
    assert.equal(counters.totalCalls, 3)
    assert.equal(counters.failures, 2)
    assert.equal(counters.failureRate, 2 / 3)

    await new Promise((resolve) => setTimeout(resolve, 1_400))
    assert.equal((await a.getCounters('counted')).totalCalls, 0)
  })

  test('only one instance is elected to probe, and it keeps the election', async () => {
    const a = store({ probeTtlMs: 5_000 })
    const b = store({ probeTtlMs: 5_000 })

    assert.equal(await a.acquireProbe('elect'), true)
    // The holder needs several probes to reach a majority.
    assert.equal(await a.acquireProbe('elect'), true)
    // Everyone else keeps failing fast instead of piling onto a sick service.
    assert.equal(await b.acquireProbe('elect'), false)
  })

  test('leaving half-open frees the election for the next period', async () => {
    const a = store()
    const b = store()

    await a.compareAndSet('freed', 'closed', 'open', 0)
    await a.compareAndSet('freed', 'open', 'half-open', 1)
    assert.equal(await a.acquireProbe('freed'), true)
    assert.equal(await b.acquireProbe('freed'), false)

    // The probe failed and the circuit reopened: the next period elects afresh.
    await a.compareAndSet('freed', 'half-open', 'open', 2)
    assert.equal(await b.acquireProbe('freed'), true)
  })

  test('an isolated circuit outlives the key lease — only unisolate leaves it', async () => {
    const shared = redisStore({ client: fromIoredis(client), window: timeWindow(1_000), ttlMs: 1_000 })

    await shared.compareAndSet('kill-switch', 'closed', 'isolated', 0)
    assert.equal(await client.pttl('bw:{kill-switch}'), -1, 'an isolated circuit has no expiry at all')

    await new Promise((resolve) => setTimeout(resolve, 1_300))

    // A maintenance window that lifted itself would put a dependency back in
    // traffic that somebody deliberately took out.
    assert.equal((await shared.readState('kill-switch')).state, 'isolated')
  })

  test('traffic renews the lease, so an open circuit never expires out from under it', async () => {
    const shared = redisStore({ client: fromIoredis(client), window: timeWindow(1_000), ttlMs: 1_000 })

    const opened = await shared.compareAndSet('busy', 'closed', 'open', 0)
    assert.equal(opened.ok, true)

    // Reads keep coming in, as they would from a circuit that is failing fast.
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.equal((await shared.readState('busy')).state, 'open')
    }

    // Well past the ttl, and still open: `ttlMs` measures idleness, not time
    // since the last transition. Expiring here would drop the whole fleet's
    // open period and stampede a dependency that is still sick.
    assert.equal((await shared.readState('busy')).fence, opened.snapshot.fence)
    assert.equal((await shared.readState('busy')).openedAt, opened.snapshot.openedAt)
  })

  test('a circuit nobody touches is collected by its lease', async () => {
    const shared = redisStore({ client: fromIoredis(client), window: timeWindow(1_000), ttlMs: 800 })

    await shared.compareAndSet('retired', 'closed', 'open', 0)
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    // The other half of the bargain: a dynamic name that stops being used
    // must not sit in Redis forever.
    assert.equal(await client.exists('bw:{retired}'), 0)
  })

  test('a peer hears about a transition without waiting for its next read', async () => {
    const subscriber = client.duplicate()
    const pushed: Array<{ state: string, fence: number }> = []
    const listening = redisStore({ client: fromIoredis(client, subscriber), window: timeWindow(1_000) })

    const release = await listening.subscribe?.('pushed', (snapshot) => {
      pushed.push({ state: snapshot.state, fence: snapshot.fence })
    })

    // A different instance moves the shared circuit.
    const peer = store()
    await peer.compareAndSet('pushed', 'closed', 'open', 0)
    await peer.compareAndSet('pushed', 'open', 'half-open', 1)

    await new Promise((resolve) => setTimeout(resolve, 150))

    assert.deepEqual(pushed, [
      { state: 'open', fence: 1 },
      { state: 'half-open', fence: 2 }
    ])

    // And the announcement carries the period's timing, not just its name.
    release?.()
    await subscriber.quit()
  })

  test('a breaker learns a peer opened the circuit before its own next call', async () => {
    const subscriber = client.duplicate()
    const options = { consecutiveFailures: 1, halfOpenAfter: 60_000, name: 'live' } as const
    const watcher = circuitBreaker({ ...options, stateStore: redisStore({ client: fromIoredis(client, subscriber), window: timeWindow(1_000) }) })
    const peer = circuitBreaker({ ...options, stateStore: store() })

    // The watcher has seen the circuit closed, and makes no further calls.
    assert.equal(await watcher.execute(() => 'ok'), 'ok')
    assert.equal(watcher.state, 'closed')

    await assert.rejects(peer.execute(() => { throw new Error('down') }), /down/)
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Without a push it would still believe the circuit is closed: nothing
    // has asked Redis on this side since the peer tripped it.
    assert.equal(watcher.state, 'open')

    watcher.dispose()
    await subscriber.quit()
  })

  test('the quota is the fleet\'s, not each instance\'s', async () => {
    const quota = { limit: 5, interval: 10_000, strategy: 'sliding-window' as const, name: 'shared-quota' }
    const a = rateLimit({ ...quota, store: redisRateLimit({ client: fromIoredis(client) }) })
    const b = rateLimit({ ...quota, store: redisRateLimit({ client: fromIoredis(client) }) })

    // Five admissions total, split across two instances — not five each.
    const outcomes = []
    for (let i = 0; i < 4; i++) {
      outcomes.push(await a.execute(() => 'ok').then(() => 'ok', () => 'rejected'))
      outcomes.push(await b.execute(() => 'ok').then(() => 'ok', () => 'rejected'))
    }

    assert.equal(outcomes.filter((o) => o === 'ok').length, 5)
    assert.equal(outcomes.filter((o) => o === 'rejected').length, 3)
  })

  test('a rejection says how long until a slot frees, from the shared window', async () => {
    const limiter = rateLimit({
      limit: 1,
      interval: 1_000,
      strategy: 'sliding-window',
      name: 'retry-after',
      store: redisRateLimit({ client: fromIoredis(client) })
    })

    await limiter.execute(() => 'ok')
    await assert.rejects(limiter.execute(() => 'ok'), (error: unknown) => {
      const rejected = error as { code: string, retryAfterMs: number }
      assert.equal(rejected.code, 'RATE_LIMITED')
      assert.ok(rejected.retryAfterMs > 0 && rejected.retryAfterMs <= 1_000, `retryAfterMs was ${rejected.retryAfterMs}`)
      return true
    })

    // And the window really is a window: the slot frees on its own.
    await new Promise((resolve) => setTimeout(resolve, 1_050))
    assert.equal(await limiter.execute(() => 'ok'), 'ok')
  })

  test('the token bucket refills continuously across instances', async () => {
    const quota = { limit: 10, interval: 1_000, strategy: 'token-bucket' as const, burst: 2, name: 'bucket' }
    const a = rateLimit({ ...quota, store: redisRateLimit({ client: fromIoredis(client) }) })
    const b = rateLimit({ ...quota, store: redisRateLimit({ client: fromIoredis(client) }) })

    // The burst is shared: two admissions, then the third waits.
    assert.equal(await a.execute(() => 'ok'), 'ok')
    assert.equal(await b.execute(() => 'ok'), 'ok')
    await assert.rejects(a.execute(() => 'ok'))

    // 10/second means a token roughly every 100ms, minted for whoever asks.
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(await b.execute(() => 'ok'), 'ok')
  })

  test('delete drops every key the name owns', async () => {
    const shared = store()
    await shared.compareAndSet('gone', 'closed', 'open', 0)
    await shared.recordFailure('gone', 1)
    await shared.acquireProbe('gone')
    assert.equal(await client.exists('bw:{gone}', 'bw:{gone}:w', 'bw:{gone}:p'), 3)

    await shared.delete?.('gone')

    assert.equal(await client.exists('bw:{gone}', 'bw:{gone}:w', 'bw:{gone}:p'), 0)
  })

  test('two breakers on one Redis agree on the outage and on when to probe', async () => {
    const options = { consecutiveFailures: 2, halfOpenAfter: 700, halfOpenCalls: 1, name: 'shared-api' } as const
    const first = circuitBreaker({ ...options, stateStore: store() })
    const second = circuitBreaker({ ...options, stateStore: store() })
    const boom = (): never => { throw new Error('downstream failure') }

    // The first instance sees the outage and trips the SHARED circuit...
    await assert.rejects(first.execute(boom))
    await assert.rejects(first.execute(boom))
    assert.equal(first.state, 'open')

    // ...and the second one fails fast without ever touching the dependency,
    // inheriting the very period the first one opened.
    let ran = false
    await assert.rejects(second.execute(() => { ran = true; return 'x' }), isCircuitOpenError)
    assert.equal(ran, false)
    assert.equal(second.stats().openedAt, first.stats().openedAt)

    // After the shared cooldown, exactly one of them is allowed to probe.
    await new Promise((resolve) => setTimeout(resolve, 750))
    const outcomes = await Promise.allSettled([
      first.execute(() => 'probe'),
      second.execute(() => 'probe')
    ])
    const admitted = outcomes.filter((o) => o.status === 'fulfilled')
    assert.equal(admitted.length, 1, 'exactly one instance may probe a recovering dependency')
  })
})
