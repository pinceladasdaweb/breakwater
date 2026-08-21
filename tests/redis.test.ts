import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { circuitBreaker } from '../src/circuit-breaker/circuit-breaker'
import { rateLimit } from '../src/rate-limit/rate-limit'
import { drain } from './helpers'
import { countWindow, timeWindow } from '../src/circuit-breaker/window'
import { isCircuitOpenError } from '../src/errors'
import { fromIoredis, fromNodeRedis, redisRateLimit, redisStore, type RedisPort, type ScriptDefinition } from '../src/redis/index'

/** Records what the store asked Redis to do, and answers however a test wants. */
function fakePort (): RedisPort & {
  defined: Map<string, ScriptDefinition>
  calls: Array<{ script: string, keys: string[], args: Array<string | number> }>
  answer: (script: string, reply: unknown) => void
  fail: (error?: unknown) => void
  heal: () => void
} {
  const defined = new Map<string, ScriptDefinition>()
  const calls: Array<{ script: string, keys: string[], args: Array<string | number> }> = []
  const replies = new Map<string, unknown>()
  let failure: unknown

  return {
    defined,
    calls,
    answer: (script, reply) => replies.set(script, reply),
    fail: (error = new Error('redis is down')) => { failure = error },
    heal: () => { failure = undefined },

    defineScript (name, definition) { defined.set(name, definition) },
    async runScript (script, keys, args) {
      calls.push({ script, keys, args })
      if (failure !== undefined) throw failure
      return replies.get(script)
    }
  }
}

const readState = (state: string, fence: number, openedAt = ''): unknown => [state, String(fence), openedAt]

/** A port whose subscription can be driven by hand. */
function subscribablePort (): ReturnType<typeof fakePort> & {
  push: (channel: string, message: string) => void
  channels: string[]
  releases: () => number
} {
  const port = fakePort()
  const listeners = new Map<string, (message: string) => void>()
  const channels: string[] = []
  let released = 0

  return Object.assign(port, {
    channels,
    releases: () => released,
    push: (channel: string, message: string) => listeners.get(channel)?.(message),
    subscribe (channel: string, onMessage: (message: string) => void) {
      channels.push(channel)
      listeners.set(channel, onMessage)
      return () => { released++; listeners.delete(channel) }
    }
  })
}
const casReply = (ok: 0 | 1, state: string, fence: number, openedAt = ''): unknown => [ok, state, String(fence), openedAt]

describe('redisStore() options', () => {
  test('refuses a count window, which has no shared meaning', () => {
    assert.throws(
      () => redisStore({ client: fakePort(), window: countWindow(50) }),
      { name: 'RangeError', message: /time windows only/ }
    )
  })

  test('validates the rest of the knobs', () => {
    const client = fakePort()
    assert.throws(() => redisStore({ client, prefix: '' }), { name: 'RangeError', message: /prefix/ })
    // Redis Cluster hashes on the FIRST brace pair, so a prefix like
    // 'app:{prod}:' would slot every circuit together and leave the
    // multi-key scripts spanning nodes.
    assert.throws(() => redisStore({ client, prefix: 'app:{prod}:' }), { name: 'RangeError', message: /braces/ })
    // Either brace alone is enough to move the hash slot.
    assert.throws(() => redisStore({ client, prefix: 'app:{' }), { name: 'RangeError', message: /braces/ })
    assert.throws(() => redisStore({ client, prefix: 'app:}' }), { name: 'RangeError', message: /braces/ })
    assert.throws(() => redisStore({ client, ttlMs: 0 }), { name: 'RangeError', message: /ttlMs/ })
    // A float reaches PEXPIRE as a float: Lua aborts mid-script, leaving the
    // state written with no expiry at all and the store degraded for good.
    assert.throws(() => redisStore({ client, ttlMs: 60_000.5 }), { name: 'RangeError', message: /ttlMs/ })
    assert.throws(() => redisStore({ client, probeTtlMs: 1.5 }), { name: 'RangeError', message: /probeTtlMs/ })
    assert.throws(() => redisStore({ client, probeTtlMs: -1 }), { name: 'RangeError', message: /probeTtlMs/ })
    assert.throws(() => redisStore({ client, degradeForMs: Number.NaN }), { name: 'RangeError', message: /degradeForMs/ })
  })

  test('every script is registered up front, and each declares its key count', () => {
    const client = fakePort()
    redisStore({ client })

    assert.deepEqual([...client.defined.keys()].sort(), [
      'bwAcquireProbe', 'bwCompareAndSet', 'bwCounters', 'bwDelete',
      'bwReadState', 'bwRecord', 'bwResetCounters'
    ])
    for (const [name, definition] of client.defined) {
      assert.ok(definition.numberOfKeys >= 1, `${name} must declare its keys`)
      assert.ok(definition.lua.length > 0, `${name} must carry Lua`)
    }
  })

  test('a circuit keys itself under one hash tag, so a cluster keeps it on one node', async () => {
    const client = fakePort()
    client.answer('bwReadState', readState('closed', 0))
    client.answer('bwCompareAndSet', casReply(1, 'open', 1, '1000'))
    const store = redisStore({ client, prefix: 'acme:' })

    await store.readState('payments')
    await store.compareAndSet('payments', 'closed', 'open', 0)
    await store.delete?.('payments')

    const keys = client.calls.flatMap((call) => call.keys)
    assert.ok(keys.every((key) => key.startsWith('acme:{payments}')), keys.join(', '))
    // Every key of one circuit shares the tag, so multi-key scripts are safe.
    assert.deepEqual([...new Set(keys)].sort(), ['acme:{payments}', 'acme:{payments}:c', 'acme:{payments}:p', 'acme:{payments}:w'])
  })
})

describe('redisStore() wire contract', () => {
  /** The healthy path, pinned without a server: which script, which keys, which arguments. */
  const wired = (): { client: ReturnType<typeof fakePort>, store: ReturnType<typeof redisStore> } => {
    const client = fakePort()
    client.answer('bwReadState', readState('open', 4, '1000'))
    client.answer('bwCompareAndSet', casReply(1, 'half-open', 5, '1000'))
    client.answer('bwRecord', 1)
    client.answer('bwCounters', [3, 1])
    client.answer('bwAcquireProbe', 1)
    // 2s window => 200ms buckets, and a ttl of four windows floored at a minute.
    return { client, store: redisStore({ client, window: timeWindow(2_000) }) }
  }
  const call = (client: ReturnType<typeof fakePort>, script: string): { keys: string[], args: Array<string | number> } => {
    const found = client.calls.find((entry) => entry.script === script)
    assert.ok(found !== undefined, `${script} was never called`)
    return found
  }

  test('reading a circuit asks bwReadState for the state key alone', async () => {
    const { client, store } = wired()

    const snapshot = await store.readState('api')

    // The ttl travels with the read: a circuit under traffic renews its own
    // lease, so `ttlMs` measures idleness rather than time since a transition.
    assert.deepEqual(call(client, 'bwReadState'), { script: 'bwReadState', keys: ['bw:{api}'], args: [60_000] })
    // The three strings Lua returns become the snapshot the breaker reads.
    assert.deepEqual(snapshot, { state: 'open', fence: 4, openedAt: 1_000 })
  })

  test('a swap carries from, to, the fence and the ttl, over the state and probe keys', async () => {
    const { client, store } = wired()

    const outcome = await store.compareAndSet('api', 'open', 'half-open', 4)

    assert.deepEqual(call(client, 'bwCompareAndSet'), {
      script: 'bwCompareAndSet',
      // The announce channel travels with the swap: a peer hears about a
      // transition from the same script that committed it.
      keys: ['bw:{api}', 'bw:{api}:p', 'bw:{api}:c'],
      args: ['open', 'half-open', 4, 60_000]
    })
    assert.equal(outcome.ok, true)
    assert.deepEqual(outcome.snapshot, { state: 'half-open', fence: 5, openedAt: 1_000 })
  })

  test('a refused swap is read from the reply, not inferred', async () => {
    const client = fakePort()
    client.answer('bwCompareAndSet', casReply(0, 'closed', 9))
    const store = redisStore({ client })

    const outcome = await store.compareAndSet('api', 'open', 'closed', 2)

    assert.equal(outcome.ok, false)
    assert.deepEqual(outcome.snapshot, { state: 'closed', fence: 9 })
  })

  test('outcomes are recorded under the letter the Lua buckets by', async () => {
    const { client, store } = wired()

    await store.recordFailure('api', 12)
    assert.deepEqual(call(client, 'bwRecord'), {
      script: 'bwRecord',
      keys: ['bw:{api}:w'],
      args: ['f', 200, 60_000]
    })

    const fresh = wired()
    await fresh.store.recordSuccess('api', 12)
    assert.equal(call(fresh.client, 'bwRecord').args[0], 's')
  })

  test('counters are summed over the window the store was configured with', async () => {
    const { client, store } = wired()

    const counters = await store.getCounters('api')

    assert.deepEqual(call(client, 'bwCounters'), {
      script: 'bwCounters',
      keys: ['bw:{api}:w'],
      args: [200, 2_000]
    })
    assert.deepEqual(counters, { successes: 3, failures: 1, totalCalls: 4, failureRate: 0.25 })
  })

  test('the key ttl follows the window once the window is the bigger of the two', async () => {
    const client = fakePort()
    client.answer('bwCompareAndSet', casReply(1, 'open', 1, '1000'))
    const store = redisStore({ client, window: timeWindow(60_000) })

    await store.compareAndSet('api', 'closed', 'open', 0)

    // Four windows, so a quiet circuit outlives its own counters.
    assert.equal(call(client, 'bwCompareAndSet').args[3], 240_000)
  })

  test('an empty window is not a 100% failure rate', async () => {
    const client = fakePort()
    client.answer('bwCounters', [0, 0])
    const store = redisStore({ client })

    assert.deepEqual(await store.getCounters('api'), { successes: 0, failures: 0, totalCalls: 0, failureRate: 0 })
  })

  test('the probe election carries a stable instance id, and reads the answer literally', async () => {
    const { client, store } = wired()

    assert.equal(await store.acquireProbe('api'), true)
    const first = call(client, 'bwAcquireProbe')
    assert.deepEqual(first.keys, ['bw:{api}:p'])
    assert.equal(first.args[1], 10_000)

    // The same process keeps the same identity, or it could never re-acquire.
    await store.acquireProbe('api')
    const ids = client.calls.filter((entry) => entry.script === 'bwAcquireProbe').map((entry) => entry.args[0])
    assert.equal(ids[0], ids[1])
    // A different process is a different candidate.
    const other = fakePort()
    other.answer('bwAcquireProbe', 1)
    await redisStore({ client: other }).acquireProbe('api')
    assert.notEqual(call(other, 'bwAcquireProbe').args[0], ids[0])

    // Losing the election is a plain 0.
    const refused = fakePort()
    refused.answer('bwAcquireProbe', 0)
    assert.equal(await redisStore({ client: refused }).acquireProbe('api'), false)
  })

  test('clearing and dropping a circuit name their own keys', async () => {
    const { client, store } = wired()

    await store.resetCounters('api')
    assert.deepEqual(call(client, 'bwResetCounters'), { script: 'bwResetCounters', keys: ['bw:{api}:w'], args: [] })

    await store.delete?.('api')
    assert.deepEqual(call(client, 'bwDelete'), {
      script: 'bwDelete',
      keys: ['bw:{api}', 'bw:{api}:w', 'bw:{api}:p'],
      args: []
    })
  })

  test('a driver that registers asynchronously is awaited by nobody, and never unhandles', async () => {
    let rejected = false
    const client: RedisPort = {
      defineScript: async () => { rejected = true; throw new Error('registration failed') },
      runScript: async () => readState('closed', 0)
    }

    // Registration failures surface on first use as a normal degradation —
    // they must not crash the process as an unhandled rejection.
    const store = redisStore({ client })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(rejected, true)
    assert.deepEqual(await store.readState('api'), { state: 'closed', fence: 0 })
  })
})

describe('redisStore() when Redis is unreachable', () => {
  test('no method rejects — the resilience layer never becomes the outage', async () => {
    const client = fakePort()
    client.fail()
    const store = redisStore({ client, onDegraded: () => {} })

    // Every one of these is on the breaker's admission path, where a throw
    // would fail every call closed.
    assert.deepEqual(await store.readState('down'), { state: 'closed', fence: 0 })
    assert.deepEqual(await store.compareAndSet('down', 'closed', 'open', 0), {
      ok: true,
      snapshot: { state: 'open', fence: 1, openedAt: (await store.readState('down')).openedAt }
    })
    assert.equal(await store.acquireProbe('down'), true)
    await store.recordFailure('down', 5)
    await store.recordSuccess('down', 5)
    assert.equal((await store.getCounters('down')).totalCalls, 2)
    await store.resetCounters('down')
    await store.delete?.('down')
  })

  test('degrading keeps the last state everyone agreed on, instead of reopening the floodgates', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const client = fakePort()
    client.answer('bwReadState', readState('open', 7, '999000'))
    const store = redisStore({ client, onDegraded: () => {} })

    const shared = await store.readState('api')
    assert.equal(shared.state, 'open')

    // Redis disappears. The circuit was OPEN across the fleet, and a store
    // that answered 'closed' here would send the whole outage downstream.
    client.fail()
    const degradedRead = await store.readState('api')
    assert.deepEqual(degradedRead, { state: 'open', fence: 7, openedAt: 999_000 })
  })

  test('the local circuit keeps moving while Redis is away, fence and timing included', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const client = fakePort()
    client.fail()
    const store = redisStore({ client, onDegraded: () => {} })

    const opened = await store.compareAndSet('solo', 'closed', 'open', 0)
    assert.deepEqual(opened, { ok: true, snapshot: { state: 'open', fence: 1, openedAt: 1_000_000 } })

    // A stale swap loses locally too: the fence is the same contract.
    const stale = await store.compareAndSet('solo', 'closed', 'open', 0)
    assert.equal(stale.ok, false)
    assert.equal(stale.snapshot.fence, 1)

    // half-open carries the period's timing, closing drops it.
    const probing = await store.compareAndSet('solo', 'open', 'half-open', 1)
    assert.equal(probing.snapshot.openedAt, 1_000_000)
    const closed = await store.compareAndSet('solo', 'half-open', 'closed', 2)
    assert.equal(closed.snapshot.openedAt, undefined)
  })

  test('the degraded counters keep successes and failures apart', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const client = fakePort()
    client.fail()
    const store = redisStore({ client, onDegraded: () => {} })

    await store.recordSuccess('api', 5)
    await store.recordFailure('api', 5)
    await store.recordFailure('api', 5)

    // Recorded locally under their own outcome: a store that lumped them
    // together would have this instance opening its circuit on successes.
    assert.deepEqual(await store.getCounters('api'), {
      successes: 1, failures: 2, totalCalls: 3, failureRate: 2 / 3
    })
  })

  test('the local swap is fenced too, on the fence and not just the state name', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const client = fakePort()
    client.fail()
    const store = redisStore({ client, onDegraded: () => {} })

    await store.compareAndSet('solo', 'closed', 'open', 0)
    await store.compareAndSet('solo', 'open', 'half-open', 1)
    await store.compareAndSet('solo', 'half-open', 'open', 2)

    // The state spells 'open' again and `from` matches: only the fence knows
    // the period this caller belonged to is over.
    const stale = await store.compareAndSet('solo', 'open', 'closed', 1)
    assert.equal(stale.ok, false)
    assert.equal(stale.snapshot.state, 'open')
    assert.equal(stale.snapshot.fence, 3)

    // And the other half of the guard: the right fence is not enough if the
    // circuit is not in the state the caller thinks it is.
    const wrongState = await store.compareAndSet('solo', 'closed', 'half-open', 3)
    assert.equal(wrongState.ok, false)
    assert.equal(wrongState.snapshot.state, 'open')
  })

  test('a local half-open with no open period behind it invents no timing', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const client = fakePort()
    client.fail()
    const store = redisStore({ client, onDegraded: () => {} })

    const probing = await store.compareAndSet('odd', 'closed', 'half-open', 0)

    // Absent, not present-and-undefined: the snapshot crosses to the breaker
    // and on to stats(), where an invented key is an invented countdown.
    assert.deepEqual(probing, { ok: true, snapshot: { state: 'half-open', fence: 1 } })
  })

  test('Redis is left alone for the cooldown, then tried again', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const client = fakePort()
    client.fail()
    const store = redisStore({ client, degradeForMs: 5_000, onDegraded: () => {} })

    await store.readState('api')
    assert.equal(client.calls.length, 1)

    // A name nothing is known about is worth exactly one more attempt: the
    // fallback would otherwise answer "closed" for a circuit somebody may
    // have isolated fleet-wide.
    await store.readState('api')
    assert.equal(client.calls.length, 2)

    // After that, hammering a backend that is already down helps nobody.
    await store.readState('api')
    await store.readState('api')
    assert.equal(client.calls.length, 2)

    // A second unknown name gets its own single attempt, and no more.
    await store.readState('other')
    const spent = client.calls.length
    await store.readState('other')
    assert.equal(client.calls.length, spent)

    // Once the cooldown elapses, Redis is tried again — exactly once here,
    // and the answer comes from the server rather than the mirror.
    t.mock.timers.tick(5_000)
    client.heal()
    client.answer('bwReadState', readState('half-open', 3))
    assert.equal((await store.readState('api')).state, 'half-open')
    assert.equal(client.calls.length, spent + 1)
  })

  test('one report per outage, not one per call', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const reported: unknown[] = []
    const client = fakePort()
    client.fail(new Error('ECONNREFUSED'))
    const store = redisStore({ client, degradeForMs: 1_000, onDegraded: (error) => reported.push(error) })

    await store.readState('api')
    await store.readState('api')
    t.mock.timers.tick(1_000)
    await store.readState('api')
    assert.equal(reported.length, 1)

    // Recovered, then down again: a second outage is worth saying out loud.
    client.heal()
    client.answer('bwReadState', readState('closed', 0))
    t.mock.timers.tick(1_000)
    await store.readState('api')
    client.fail()
    t.mock.timers.tick(1_000)
    await store.readState('api')
    assert.equal(reported.length, 2)
  })

  test('the default report goes to console.error, once', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const client = fakePort()
    client.fail()
    const store = redisStore({ client })

    await store.readState('api')
    await store.readState('api')

    assert.equal(reported.mock.callCount(), 1)
  })
})

describe('redisStore() when Redis stops answering at all', () => {
  test('a command that never settles degrades instead of stalling the caller', async () => {
    // ioredis queues commands while disconnected by default, so a dead Redis
    // does not reject — it goes quiet. A store that waited would make every
    // protected call wait with it, which is worse than an error.
    const client: RedisPort = {
      defineScript: () => {},
      runScript: async () => await new Promise(() => {})
    }
    const reported: unknown[] = []
    const store = redisStore({ client, commandTimeoutMs: 30, onDegraded: (error) => reported.push(error) })

    const started = Date.now()
    assert.deepEqual(await store.readState('api'), { state: 'closed', fence: 0 })
    assert.ok(Date.now() - started < 1_000, 'the admission path must not wait on a silent backend')
    assert.equal(reported.length, 1)
    assert.match(String(reported[0]), /exceeded 30ms/)
  })

  test('a slow failure never takes a store that is provably healthy local', async () => {
    let hold: Promise<void> | undefined
    const inner = fakePort()
    inner.answer('bwReadState', readState('closed', 0))
    const client: RedisPort = {
      defineScript: () => {},
      async runScript (script, keys, args) {
        if (hold !== undefined) {
          const held = hold
          hold = undefined
          await held
          throw new Error('ETIMEDOUT — one slow command')
        }
        return await inner.runScript(script, keys, args)
      }
    }
    const reported: unknown[] = []
    const store = redisStore({ client, onDegraded: (error) => reported.push(error) })

    // A command starts and stalls...
    const { promise: held, resolve: release } = Promise.withResolvers<void>()
    hold = held
    const slow = store.readState('api')

    // ...a newer one completes fine, proving Redis is up...
    assert.equal((await store.readState('api')).state, 'closed')

    // ...and only then does the old one fail. Health belongs to the newest
    // command that COMPLETED, or one latency spike takes the store local and
    // hands every instance a probe it should not have.
    release()
    await slow
    assert.deepEqual(reported, [])
    assert.equal(store.isDegraded(), false)
  })

  test('a fence invented while blind is never spent against Redis', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const client = fakePort()
    client.answer('bwReadState', readState('open', 3, '1000'))
    const store = redisStore({ client, degradeForMs: 1_000, onDegraded: () => {} })
    await store.readState('api')

    // Blind: the instance drives its own period forward.
    client.fail()
    const blind = await store.compareAndSet('api', 'open', 'half-open', 3)
    assert.equal(blind.ok, true)
    assert.equal(blind.snapshot.fence, 4)

    // Redis is back, and the fleet independently reached fence 4 too. Sending
    // a locally-invented fence would let this instance move a period it never
    // saw, on numbers that only coincide.
    client.heal()
    client.answer('bwCompareAndSet', casReply(1, 'closed', 5))
    t.mock.timers.tick(1_000)
    const spent = client.calls.length

    const refused = await store.compareAndSet('api', 'half-open', 'closed', 4)
    assert.equal(refused.ok, false)
    assert.equal(client.calls.length, spent, 'the swap must not reach Redis at all')
  })

  test('a state Redis should never hold is refused rather than obeyed', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const client = fakePort()
    client.answer('bwReadState', ['Isolated', '7', ''])
    const store = redisStore({ client })

    // An unrecognised state matches none of the breaker's branches, so every
    // call would be admitted and no trip could ever swap away from it.
    assert.deepEqual(await store.readState('api'), { state: 'closed', fence: 0 })
    assert.equal(reported.mock.callCount(), 1)
  })
})

describe('redisStore() and the fleet-wide kill switch', () => {
  test('a cold mirror is not evidence that a circuit is closed', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const client = fakePort()
    const store = redisStore({ client, degradeForMs: 5_000, onDegraded: () => {} })

    // Something unrelated degrades the store...
    client.fail()
    await store.readState('unrelated')
    client.heal()
    client.answer('bwReadState', readState('isolated', 4))

    // ...and now a name this process has never seen is asked about. Serving
    // the fallback here would report 'closed' and walk a fresh instance
    // straight past a circuit somebody isolated across the whole fleet.
    assert.equal((await store.readState('payments')).state, 'isolated')
  })

  test('the blind attempt is spent once per name, not once per call', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const client = fakePort()
    client.fail()
    const store = redisStore({ client, degradeForMs: 5_000, onDegraded: () => {} })

    await store.readState('a')
    await store.readState('a')
    await store.readState('a')
    await store.readState('b')
    await store.readState('b')

    // Two names, and each got its own single attempt on top of the first.
    assert.equal(client.calls.length, 3)
  })
})

describe('redisStore() health signals', () => {
  test('isDegraded answers what onDegraded only ever pushed once', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const client = fakePort()
    client.answer('bwReadState', readState('closed', 0))
    const store = redisStore({ client, degradeForMs: 1_000, onDegraded: () => {} })

    assert.equal(store.isDegraded(), false)

    client.fail()
    await store.readState('api')
    assert.equal(store.isDegraded(), true, 'a health endpoint has to be able to ask')

    client.heal()
    t.mock.timers.tick(1_000)
    await store.readState('api')
    assert.equal(store.isDegraded(), false)
  })

  test('recovery is announced once, so an incident gets its closing line', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const events: string[] = []
    const client = fakePort()
    client.answer('bwReadState', readState('closed', 0))
    const store = redisStore({
      client,
      degradeForMs: 1_000,
      onDegraded: () => events.push('degraded'),
      onRecovered: () => events.push('recovered')
    })

    client.fail()
    await store.readState('api')
    client.heal()
    t.mock.timers.tick(1_000)
    await store.readState('api')
    await store.readState('api')

    assert.deepEqual(events, ['degraded', 'recovered'])
  })

  test('a reporter that throws does not become the outage it was reporting', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const client = fakePort()
    client.fail()
    const store = redisStore({
      client,
      onDegraded: () => { throw new Error('my logger blew up') }
    })

    // This is the admission path: rejecting here would fail every call closed.
    assert.deepEqual(await store.readState('api'), { state: 'closed', fence: 0 })
    assert.equal(reported.mock.callCount(), 1)
  })

  test('a recovery reporter that throws is contained too', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const reported = t.mock.method(console, 'error', () => {})
    const client = fakePort()
    client.answer('bwReadState', readState('closed', 0))
    const store = redisStore({
      client,
      degradeForMs: 1_000,
      onDegraded: () => {},
      onRecovered: () => { throw new Error('my logger blew up again') }
    })

    client.fail()
    await store.readState('api')
    client.heal()
    t.mock.timers.tick(1_000)

    assert.deepEqual(await store.readState('api'), { state: 'closed', fence: 0 })
    assert.equal(reported.mock.callCount(), 1)
  })

  test('close drops the in-process bookkeeping without touching the client', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const client = fakePort()
    client.answer('bwReadState', readState('open', 3, '1000'))
    client.answer('bwRecord', 1)
    const store = redisStore({ client, onDegraded: () => {} })

    await store.readState('api')
    await store.recordFailure('api', 5)
    const callsBefore = client.calls.length

    store.close()

    // The mirror and the local counters are gone; the client was not asked
    // to do anything, because the connection is the caller's to manage.
    assert.equal(client.calls.length, callsBefore)
    client.fail()
    assert.deepEqual(await store.readState('api'), { state: 'closed', fence: 0 })
    assert.equal((await store.getCounters('api')).totalCalls, 0)
  })
})

describe('redisStore() latency', () => {
  test('summarises the calls this instance made, whatever Redis is doing', async () => {
    const client = fakePort()
    client.answer('bwRecord', 1)
    const store = redisStore({ client, window: timeWindow(10_000) })

    await store.recordSuccess('api', 10)
    await store.recordFailure('api', 30)

    const latency = await store.getLatency?.('api')
    assert.equal(latency?.count, 2)
    assert.equal(latency?.min, 10)
    assert.equal(latency?.max, 30)
  })
})

describe('redisStore() driving a breaker', () => {
  test('the breaker trips on the counters Redis reports, from calls it never saw', async () => {
    const client = fakePort()
    let fence = 0
    client.answer('bwReadState', readState('closed', 0))
    client.answer('bwRecord', 1)
    // The fleet has already failed 8 of 10 calls; this instance made one.
    client.answer('bwCounters', [2, 8])
    client.answer('bwCompareAndSet', casReply(1, 'open', ++fence, '1000'))

    const breaker = circuitBreaker({
      name: 'fleet',
      failureThreshold: 0.5,
      minimumCalls: 10,
      stateStore: redisStore({ client })
    })

    await assert.rejects(breaker.execute(() => { throw new Error('down') }), /down/)

    // One local failure was enough, because the decision is the fleet's.
    assert.equal(breaker.state, 'open')
  })

  test('a peer holding the probe election keeps this instance failing fast', async () => {
    const client = fakePort()
    client.answer('bwReadState', readState('open', 4, String(Date.now() - 60_000)))
    client.answer('bwCompareAndSet', casReply(1, 'half-open', 5, String(Date.now() - 60_000)))
    client.answer('bwAcquireProbe', 0) // elected elsewhere
    client.answer('bwCounters', [0, 0])

    const breaker = circuitBreaker({ name: 'elected', halfOpenAfter: 1_000, stateStore: redisStore({ client }) })

    let ran = false
    await assert.rejects(breaker.execute(() => { ran = true; return 'x' }), isCircuitOpenError)
    assert.equal(ran, false, 'a recovering dependency is probed by one instance, not by the fleet')
  })
})

describe('client adapters', () => {
  test('ioredis: scripts become commands, and keys stay ahead of arguments', async () => {
    const installed: Array<{ name: string, numberOfKeys: number }> = []
    let received: unknown[] = []
    const client = {
      defineCommand (name: string, definition: { numberOfKeys: number, lua: string }) {
        installed.push({ name, numberOfKeys: definition.numberOfKeys })
        ;(client as unknown as Record<string, unknown>)[name] = async (...argv: unknown[]) => {
          received = argv
          return 'ok'
        }
      }
    }
    const port = fromIoredis(client)

    port.defineScript('bwThing', { numberOfKeys: 2, lua: 'return 1' })
    assert.deepEqual(installed, [{ name: 'bwThing', numberOfKeys: 2 }])
    assert.equal(await port.runScript('bwThing', ['k1', 'k2'], ['a', 1]), 'ok')
    // The spread happens at the driver boundary and nowhere else.
    assert.deepEqual(received, ['k1', 'k2', 'a', 1])
  })

  test('ioredis: calling a script that was never defined says so', async () => {
    const port = fromIoredis({ defineCommand: () => {} })
    await assert.rejects(port.runScript('bwMissing', [], []), { name: 'TypeError', message: /defineScript/ })
  })

  test('node-redis: loads on first use and reloads when the server forgot the script', async () => {
    const loads: string[] = []
    let forgotten = true
    const client = {
      async scriptLoad (lua: string) { loads.push(lua); return `sha-${loads.length}` },
      async evalSha (sha: string, options: { keys: string[], arguments: string[] }) {
        if (forgotten) {
          forgotten = false
          throw new Error('NOSCRIPT No matching script')
        }
        return { sha, ...options }
      }
    }
    const port = fromNodeRedis(client)
    port.defineScript('bwThing', { numberOfKeys: 1, lua: 'return 1' })

    // A restart or failover drops the script; the adapter reloads and retries.
    const result = await port.runScript('bwThing', ['k'], ['a', 2])
    assert.equal(loads.length, 2)
    assert.deepEqual(result, { sha: 'sha-2', keys: ['k'], arguments: ['a', '2'] })

    // Afterwards the SHA is reused: no reload on every call.
    await port.runScript('bwThing', ['k'], [])
    assert.equal(loads.length, 2)
    // And what was loaded is the script that was registered.
    assert.deepEqual(loads, ['return 1', 'return 1'])
  })

  test('node-redis: calling a script that was never defined says so', async () => {
    const port = fromNodeRedis({
      scriptLoad: async () => 'sha',
      evalSha: async () => 'never'
    })

    await assert.rejects(port.runScript('bwMissing', [], []), { name: 'TypeError', message: /defineScript/ })
  })

  test('node-redis: a real error is not mistaken for a missing script', async () => {
    const loads: string[] = []
    const client = {
      async scriptLoad () { loads.push('load'); return 'sha' },
      async evalSha () { throw new Error('WRONGTYPE Operation against a key') }
    }
    const port = fromNodeRedis(client)
    port.defineScript('bwThing', { numberOfKeys: 1, lua: 'return 1' })

    await assert.rejects(port.runScript('bwThing', ['k'], []), /WRONGTYPE/)
    // Reloading on an error that is not NOSCRIPT would hide a real problem
    // behind a pointless retry against a server that is answering fine.
    assert.equal(loads.length, 1)
  })
})

describe('redisRateLimit()', () => {
  const quota = { limit: 10, interval: 1_000, strategy: 'token-bucket' as const, burst: 4 }

  test('a shared quota needs a name — it is the key it lives under', () => {
    const store = redisRateLimit({ client: fakePort() })
    assert.throws(
      () => rateLimit({ limit: 5, interval: 1_000, store }),
      { name: 'RangeError', message: /stable name/ }
    )
    assert.doesNotThrow(() => rateLimit({ limit: 5, interval: 1_000, name: 'api', store }))
  })

  test('each strategy calls its own script, with the quota the policy owns', async () => {
    const client = fakePort()
    client.answer('bwTokenBucket', [1, 0, 3])
    client.answer('bwSlidingWindow', [1, 0, 9])
    const store = redisRateLimit({ client })

    await store.acquire('api', quota)
    assert.deepEqual(client.calls[0], {
      script: 'bwTokenBucket',
      keys: ['bwrl:{api}'],
      // limit, interval, capacity, ttl
      args: [10, 1_000, 4, 2_000]
    })

    await store.acquire('api', { ...quota, strategy: 'sliding-window' })
    const window = client.calls[1]
    assert.equal(window?.script, 'bwSlidingWindow')
    assert.deepEqual(window?.keys, ['bwrl:{api}'])
    assert.deepEqual(window?.args.slice(0, 3), [10, 1_000, 2_000])
    // The member must be unique per admission, or the sorted set would
    // collapse two calls into one slot.
    assert.match(String(window?.args[3]), /^[0-9a-f-]{36}:\d+$/)
  })

  test('the decision is read from the reply, not inferred', async () => {
    const client = fakePort()
    client.answer('bwTokenBucket', [0, 137, 0])
    const store = redisRateLimit({ client })

    assert.deepEqual(await store.acquire('api', quota), { admitted: false, retryAfterMs: 137, remaining: 0 })
  })

  test('a shared quota keyed under one hash tag, and a prefix that cannot steal it', () => {
    assert.throws(() => redisRateLimit({ client: fakePort(), prefix: 'app:{prod}:' }), { name: 'RangeError', message: /braces/ })
    assert.throws(() => redisRateLimit({ client: fakePort(), prefix: '' }), { name: 'RangeError', message: /prefix/ })
  })

  test('when Redis is unreachable the quota becomes local, and still holds', async () => {
    const client = fakePort()
    client.fail()
    const store = redisRateLimit({ client, onDegraded: () => {} })

    // Same numbers, enforced by this instance alone: the burst is spent and
    // then callers are told to wait, rather than everything being admitted.
    const outcomes = []
    for (let i = 0; i < 6; i++) outcomes.push(await store.acquire('api', quota))

    assert.equal(outcomes.filter((o) => o.admitted).length, 4, 'the burst, and no more')
    assert.ok(outcomes.slice(4).every((o) => !o.admitted && o.retryAfterMs > 0))
    assert.equal(store.isDegraded(), true)
  })

  test('the degraded sliding window stays exact, instead of behaving like a bucket', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const client = fakePort()
    client.fail()
    const store = redisRateLimit({ client, onDegraded: () => {} })
    const exact = { limit: 10, interval: 1_000, strategy: 'sliding-window' as const, burst: 10 }

    // Hammered for exactly one interval. A token bucket wearing the sliding
    // window's name would admit roughly twice the limit here.
    let admitted = 0
    for (let tick = 0; tick < 100; tick++) {
      for (let i = 0; i < 3; i++) {
        if ((await store.acquire('api', exact)).admitted) admitted++
      }
      t.mock.timers.tick(10)
    }

    assert.equal(admitted, 10, 'never more than the limit in any window')
  })

  test('a quota that changes rebuilds the local limiter rather than freezing the first', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    const client = fakePort()
    client.fail()
    const store = redisRateLimit({ client, onDegraded: () => {} })

    const generous = { limit: 100, interval: 60_000, strategy: 'token-bucket' as const, burst: 100 }
    const tight = { limit: 1, interval: 60_000, strategy: 'token-bucket' as const, burst: 1 }

    assert.equal((await store.acquire('api', generous)).admitted, true)

    // The quota travels with the call — a tightened limit must bind here too.
    assert.equal((await store.acquire('api', tight)).admitted, true)
    assert.equal((await store.acquire('api', tight)).admitted, false)
  })

  test('the degraded quota refills over time, like the shared one would', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const client = fakePort()
    client.fail()
    const store = redisRateLimit({ client, onDegraded: () => {} })
    const slow = { limit: 10, interval: 1_000, strategy: 'token-bucket' as const, burst: 1 }

    assert.equal((await store.acquire('api', slow)).admitted, true)
    assert.equal((await store.acquire('api', slow)).admitted, false)

    // 10 per second is a token every 100ms: a local fallback that did not
    // refill would reject for the whole outage instead of holding the rate.
    t.mock.timers.tick(120)
    assert.equal((await store.acquire('api', slow)).admitted, true)

    // And it stays capped at the burst rather than banking the whole outage.
    t.mock.timers.tick(10_000)
    assert.equal((await store.acquire('api', slow)).admitted, true)
    assert.equal((await store.acquire('api', slow)).admitted, false)
  })

  test('each name gets its own local quota while degraded', async () => {
    const client = fakePort()
    client.fail()
    const store = redisRateLimit({ client, onDegraded: () => {} })
    const one = { limit: 1, interval: 60_000, strategy: 'token-bucket' as const, burst: 1 }

    assert.equal((await store.acquire('a', one)).admitted, true)
    assert.equal((await store.acquire('a', one)).admitted, false)
    // A different circuit's quota is not spent by the first one's traffic.
    assert.equal((await store.acquire('b', one)).admitted, true)
  })

  test('a degraded quota never rejects the caller', async () => {
    const client: RedisPort = {
      defineScript: () => {},
      runScript: async () => await new Promise(() => {})   // never settles
    }
    const store = redisRateLimit({ client, commandTimeoutMs: 30, onDegraded: () => {} })
    const limiter = rateLimit({ limit: 2, interval: 1_000, name: 'quiet', store })

    // A silent backend must not stall the call path either.
    const started = Date.now()
    assert.equal(await limiter.execute(() => 'ok'), 'ok')
    assert.ok(Date.now() - started < 1_000)
  })

  test('a reply the store cannot read is contained, not obeyed', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const client = fakePort()
    client.answer('bwTokenBucket', 'nonsense')
    const store = redisRateLimit({ client })

    // Falls back to the local quota rather than admitting on a shrug.
    const decision = await store.acquire('api', quota)
    assert.equal(decision.admitted, true)
    assert.equal(reported.mock.callCount(), 1)
  })

  test('stats() reports the remaining the shared quota last returned', async () => {
    const client = fakePort()
    client.answer('bwTokenBucket', [1, 0, 2])
    const limiter = rateLimit({ limit: 10, interval: 1_000, burst: 4, name: 'api', store: redisRateLimit({ client }) })

    assert.equal(limiter.stats().remaining, 4, 'the burst, before anything is known')
    await limiter.execute(() => 'ok')
    assert.equal(limiter.stats().remaining, 2, 'what the fleet says is left')
  })
})

describe('redisStore() pushed state changes', () => {
  test('an announcement becomes a snapshot on the circuit it names', async () => {
    const client = subscribablePort()
    const store = redisStore({ client })
    const seen: unknown[] = []

    await store.subscribe?.('api', (snapshot) => seen.push(snapshot))

    assert.deepEqual(client.channels, ['bw:{api}:c'])
    client.push('bw:{api}:c', 'open 7 1786800000000')
    client.push('bw:{api}:c', 'closed 8 ')

    assert.deepEqual(seen, [
      { state: 'open', fence: 7, openedAt: 1_786_800_000_000 },
      { state: 'closed', fence: 8 }
    ])
  })

  test('an announcement it cannot read is dropped, not guessed at', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const client = subscribablePort()
    const store = redisStore({ client })
    const seen: unknown[] = []

    await store.subscribe?.('api', (snapshot) => seen.push(snapshot))

    client.push('bw:{api}:c', 'garbage')                 // no fence at all
    client.push('bw:{api}:c', 'Isolated 3 ')             // not a state this store knows
    assert.deepEqual(seen, [], 'the next read is authoritative anyway')
    assert.equal(reported.mock.callCount(), 1, 'only the unreadable state is worth reporting')
  })

  test('an unreadable timing costs the stamp, not the whole read', async () => {
    const client = fakePort()
    // The state and the fence are readable; only the timing is not — a stray
    // HSET, another tenant on the prefix, a hand edit.
    client.answer('bwReadState', readState('open', 4, 'nonsense'))
    const store = redisStore({ client })

    const snapshot = await store.readState('api')
    // Dropped rather than adopted as NaN: the breaker then counts the cooldown
    // from first observation, instead of comparing against NaN forever and
    // never reaching half-open again.
    assert.deepEqual(snapshot, { state: 'open', fence: 4 })
    assert.equal(Object.hasOwn(snapshot, 'openedAt'), false)
  })

  test('a fence that is not a number is refused, empty string included', async () => {
    const client = fakePort()
    // Number('') is 0, which is finite — so an empty fence would otherwise
    // read as a legitimate period zero.
    client.answer('bwReadState', readState('open', '' as unknown as number, '1000'))
    const store = redisStore({ client })

    assert.deepEqual(await store.readState('api'), { state: 'closed', fence: 0 })
  })

  test('releasing the subscription stops the pushes', async () => {
    const client = subscribablePort()
    const store = redisStore({ client })
    const seen: unknown[] = []

    const release = await store.subscribe?.('api', (snapshot) => seen.push(snapshot))
    release?.()

    client.push('bw:{api}:c', 'open 1 1000')
    assert.deepEqual(seen, [])
    assert.equal(client.releases(), 1)
  })

  test('a breaker subscribes once and dispose releases it, idempotently', async () => {
    const client = subscribablePort()
    client.answer('bwReadState', readState('closed', 0))
    const breaker = circuitBreaker({ name: 'watched', stateStore: redisStore({ client }) })
    await drain()

    assert.deepEqual(client.channels, ['bw:{watched}:c'])

    // A peer opens the circuit; this instance has made no calls at all.
    client.push('bw:{watched}:c', 'open 4 1000')
    assert.equal(breaker.state, 'open')

    // A push describing a period already left is a hint about the past.
    client.push('bw:{watched}:c', 'closed 2 ')
    assert.equal(breaker.state, 'open')

    breaker.dispose()
    breaker.dispose()
    assert.equal(client.releases(), 1)
    client.push('bw:{watched}:c', 'closed 9 ')
    assert.equal(breaker.state, 'open')
  })

  test('the blind attempt budget is per outage, not per process', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const client = fakePort()
    client.answer('bwReadState', readState('closed', 0))
    const store = redisStore({ client, degradeForMs: 5_000, onDegraded: () => {} })

    // First outage: the unknown name spends its one attempt.
    client.fail()
    await store.readState('rare')
    await store.readState('rare')
    const spentInFirst = client.calls.length

    // Recovered.
    client.heal()
    t.mock.timers.tick(5_000)
    await store.readState('other')

    // A second outage must give that name a fresh attempt: otherwise a
    // circuit somebody isolated fleet-wide reads as 'closed' from here on.
    client.fail()
    await store.readState('other')
    const before = client.calls.length
    await store.readState('rare')
    assert.ok(client.calls.length > before, 'a new outage restores the budget')
    assert.ok(spentInFirst > 0)
  })

  test('a store that cannot subscribe costs freshness and nothing else', async () => {
    const client = fakePort()
    client.answer('bwReadState', readState('closed', 0))
    const store = redisStore({ client })
    // A port with no subscription capability must not advertise one, or the
    // breaker would wire a listener that can never fire.
    assert.equal(store.subscribe, undefined)
    const breaker = circuitBreaker({ name: 'unwatched', stateStore: store })

    assert.equal(await breaker.execute(() => 'ok'), 'ok')
    assert.doesNotThrow(() => breaker.dispose())
  })
})

describe('fromIoredis() subscriptions', () => {
  const subscriberDouble = (): {
    subscribed: string[]
    unsubscribed: string[]
    listeners: Array<(channel: string, message: string) => void>
    subscribe: (channel: string) => Promise<unknown>
    unsubscribe: (channel: string) => Promise<unknown>
    on: (event: 'message', listener: (channel: string, message: string) => void) => unknown
    off: (event: 'message', listener: (channel: string, message: string) => void) => unknown
  } => {
    const state = {
      subscribed: [] as string[],
      unsubscribed: [] as string[],
      listeners: [] as Array<(channel: string, message: string) => void>
    }
    return {
      ...state,
      subscribe: async (channel: string) => { state.subscribed.push(channel); return 1 },
      unsubscribe: async (channel: string) => { state.unsubscribed.push(channel); return 1 },
      on: (_event, listener) => state.listeners.push(listener),
      off: (_event, listener) => {
        const at = state.listeners.indexOf(listener)
        if (at >= 0) state.listeners.splice(at, 1)
        return undefined
      }
    }
  }

  test('only messages for the subscribed channel reach the handler', async () => {
    const subscriber = subscriberDouble()
    const port = fromIoredis({ defineCommand: () => {} }, subscriber)
    const seen: string[] = []

    const release = await port.subscribe?.('bw:{api}:c', (message) => seen.push(message))
    assert.deepEqual(subscriber.subscribed, ['bw:{api}:c'])

    for (const listener of subscriber.listeners) {
      listener('bw:{api}:c', 'open 1 1000')
      listener('bw:{other}:c', 'open 9 9000')   // a different circuit on the same connection
    }
    assert.deepEqual(seen, ['open 1 1000'])

    // Releasing detaches the listener AND leaves the channel.
    release?.()
    assert.deepEqual(subscriber.unsubscribed, ['bw:{api}:c'])
    assert.equal(subscriber.listeners.length, 0)
  })

  test('a subscribe that fails leaves no listener behind', async () => {
    const subscriber = subscriberDouble()
    subscriber.subscribe = async () => { throw new Error('redis is down') }
    const port = fromIoredis({ defineCommand: () => {} }, subscriber)

    await assert.rejects(port.subscribe?.('bw:{api}:c', () => {}) as Promise<unknown>, /redis is down/)
    // The caller never got a release function, so this was the only chance.
    assert.equal(subscriber.listeners.length, 0)
  })

  test('leaving a channel waits for the last listener on it', async () => {
    const subscriber = subscriberDouble()
    const port = fromIoredis({ defineCommand: () => {} }, subscriber)

    const first = await port.subscribe?.('bw:{api}:c', () => {})
    const second = await port.subscribe?.('bw:{api}:c', () => {})

    first?.()
    assert.deepEqual(subscriber.unsubscribed, [], 'somebody is still listening on that channel')

    second?.()
    assert.deepEqual(subscriber.unsubscribed, ['bw:{api}:c'])

    // And releasing twice does not decrement somebody else's count.
    second?.()
    assert.deepEqual(subscriber.unsubscribed, ['bw:{api}:c'])
  })

  test('without a second connection the port simply does not subscribe', () => {
    const port = fromIoredis({ defineCommand: () => {} })
    assert.equal(port.subscribe, undefined)
  })
})
