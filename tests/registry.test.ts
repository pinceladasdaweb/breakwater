import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { createPolicyRegistry, policies } from '../src/registry/registry'
import { compose } from '../src/compose/compose'
import { resilience } from '../src/compose/resilience'
import { retry } from '../src/retry/retry'
import { timeout } from '../src/timeout/timeout'
import { fixed } from '../src/retry/backoff'
import { countWindow } from '../src/circuit-breaker/window'
import { memoryStore, type StateStore } from '../src/circuit-breaker/state-store'
import { type MetricsCollector } from '../src/metrics/collector'

describe('define and get', () => {
  test('a defined policy is retrievable and works as a policy', async () => {
    const registry = createPolicyRegistry()
    registry.define('api', { retry: { attempts: 2, backoff: fixed(0) } })

    const policy = registry.get('api')
    let calls = 0
    const result = await policy.execute(() => {
      calls++
      if (calls < 2) throw new Error('flaky')
      return 'recovered'
    })

    assert.equal(result, 'recovered')
    assert.equal(calls, 2)
  })

  test('define returns the built policy directly', async () => {
    const registry = createPolicyRegistry()
    const policy = registry.define('api', {})

    assert.equal(await policy.execute(() => 'ok'), 'ok')
    assert.equal(registry.get('api'), policy)
  })

  test('get always returns the same instance — shared state by name', async () => {
    const registry = createPolicyRegistry()
    registry.define('api', { circuitBreaker: { consecutiveFailures: 1 } })

    // Module A trips the circuit...
    await assert.rejects(registry.get('api').execute(() => { throw new Error('down') }))
    // ...and module B sees it open: same instance, shared state.
    await assert.rejects(registry.get('api').execute(() => 'x'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CIRCUIT_OPEN')
      return true
    })
  })

  test('accepts a prebuilt policy (custom compose pipeline)', async () => {
    const registry = createPolicyRegistry()
    const custom = compose(retry({ attempts: 2, backoff: fixed(0) }), timeout(1_000))

    registry.define('custom', custom)
    assert.equal(registry.get('custom'), custom)
    assert.equal(await registry.get('custom').execute(() => 'ok'), 'ok')
  })

  test('configuration errors surface at define time, not on first use', () => {
    const registry = createPolicyRegistry()
    assert.throws(() => registry.define('bad', { retry: { attempts: 0 } }), RangeError)
    assert.equal(registry.has('bad'), false)
  })

  test('an object missing any part of the Policy contract is treated as configuration', async () => {
    const impostor = {
      execute: async () => 'from the impostor',
      wrap: () => async () => 'from the impostor',
      invoke: async () => 'from the impostor'
    }

    for (const missing of ['execute', 'wrap', 'invoke'] as const) {
      const registry = createPolicyRegistry()
      const partial = { ...impostor, [missing]: undefined }

      const built = registry.define('half', partial as never)
      assert.equal(
        await built.execute(() => 'real'),
        'real',
        `an object without ${missing} must not pass as a policy`
      )
    }
  })
})

describe('naming rules', () => {
  test('defining the same name twice throws', () => {
    const registry = createPolicyRegistry()
    registry.define('api', {})
    assert.throws(() => registry.define('api', {}), { name: 'RangeError', message: /already defined/ })
  })

  test('rejects names that are not usable strings', () => {
    const registry = createPolicyRegistry()
    assert.throws(() => registry.define('', {}), { name: 'RangeError', message: /policy name/ })
    // JavaScript callers get past the type system: guard the runtime too.
    assert.throws(() => registry.define(42 as never, {}), { name: 'RangeError', message: /policy name/ })
  })

  test('get of an unknown name throws listing the known names', () => {
    const registry = createPolicyRegistry()
    registry.define('payments', {})
    registry.define('catalog', {})

    assert.throws(() => registry.get('paymnets'), { name: 'RangeError', message: /unknown policy "paymnets".*payments, catalog/ })
  })

  test('get on an empty registry says none are defined', () => {
    const registry = createPolicyRegistry()
    assert.throws(() => registry.get('anything'), { name: 'RangeError', message: /\(none defined\)/ })
  })

  test('define never mutates the caller options object', () => {
    const registry = createPolicyRegistry()
    const options = { rateLimit: { limit: 1, interval: 1_000 } }
    const snapshot = structuredClone(options)

    registry.define('api', options)
    assert.deepEqual(options, snapshot)
  })

  test('the registry name becomes the default metrics name of inner policies', async () => {
    const registry = createPolicyRegistry()
    const rejections: Array<string | undefined> = []
    const metrics: MetricsCollector = { onReject: (e) => rejections.push(e.name) }

    registry.define('partner-quota', {
      rateLimit: { limit: 1, interval: 60_000 },
      metrics
    })

    await registry.get('partner-quota').execute(() => 'a')
    await assert.rejects(registry.get('partner-quota').execute(() => 'b'))

    assert.deepEqual(rejections, ['partner-quota'])
  })

  test('breaker-less entries still report the registry name in onExecution', async () => {
    const registry = createPolicyRegistry()
    const executions: Array<string | undefined> = []
    const metrics: MetricsCollector = { onExecution: (e) => executions.push(e.name) }

    registry.define('no-breaker', { timeout: 1_000, metrics })
    await registry.get('no-breaker').execute(() => 'ok')

    assert.deepEqual(executions, ['no-breaker'])
  })

  test('the registry name is the key the breaker uses in a shared state store', async () => {
    const registry = createPolicyRegistry()
    const inner = memoryStore({ window: countWindow(10) })
    const keys = new Set<string>()
    const store: StateStore = {
      ...inner,
      readState: (name) => { keys.add(name); return inner.readState(name) }
    }

    registry.define('orders-api', { circuitBreaker: { consecutiveFailures: 1, stateStore: store } })
    await registry.get('orders-api').execute(() => 'ok')

    // Without a stable key, a distributed store could never recognise this
    // circuit across instances or restarts.
    assert.deepEqual([...keys], ['orders-api'])
  })

  test('an explicit undefined name falls back to the registry key', async () => {
    const registry = createPolicyRegistry()
    const names: Array<string | undefined> = []
    const metrics: MetricsCollector = { onReject: (e) => names.push(e.name) }

    // What `{ name: config.displayName, ... }` produces when displayName is
    // not set: absent and explicitly undefined must behave the same.
    registry.define('orders', { name: undefined, rateLimit: { limit: 1, interval: 60_000 }, metrics })
    const policy = registry.get('orders')

    await policy.execute(() => 'a')
    await assert.rejects(policy.execute(() => 'b'))

    assert.deepEqual(names, ['orders'])
  })

  test('an explicit pipeline name identifies every policy, registry key included', async () => {
    const registry = createPolicyRegistry()
    const seen: string[] = []
    const metrics: MetricsCollector = {
      onExecution: (e) => seen.push(`execution:${e.name ?? ''}`),
      onReject: (e) => seen.push(`reject:${e.name ?? ''}`)
    }

    registry.define('registry-key', {
      name: 'explicit-pipeline',
      rateLimit: { limit: 1, interval: 60_000 },
      metrics
    })
    const policy = registry.get('registry-key')

    await policy.execute(() => 'a')
    await assert.rejects(policy.execute(() => 'b'))

    // One policy must never show up under two names in a dashboard.
    assert.deepEqual(seen, [
      'execution:explicit-pipeline',
      'reject:explicit-pipeline',
      'execution:explicit-pipeline'
    ])
  })

  test('an explicit inner name wins over the registry name', async () => {
    const registry = createPolicyRegistry()
    const rejections: Array<string | undefined> = []
    const metrics: MetricsCollector = { onReject: (e) => rejections.push(e.name) }

    registry.define('outer', {
      rateLimit: { limit: 1, interval: 60_000, name: 'inner-explicit' },
      metrics
    })

    await registry.get('outer').execute(() => 'a')
    await assert.rejects(registry.get('outer').execute(() => 'b'))

    assert.deepEqual(rejections, ['inner-explicit'])
  })
})

describe('central configuration', () => {
  test('defineAll and the factory initial record define everything at once', async () => {
    const registry = createPolicyRegistry({
      'api-a': { retry: { attempts: 1 } },
      'api-b': {}
    })
    registry.defineAll({ 'api-c': { timeout: 1_000 } })

    assert.deepEqual(registry.names().sort(), ['api-a', 'api-b', 'api-c'])
    assert.equal(await registry.get('api-c').execute(() => 'ok'), 'ok')
  })

  test('defineAll is not atomic: a bad entry names the key and keeps earlier entries', () => {
    const registry = createPolicyRegistry()

    assert.throws(
      () => registry.defineAll({ good: {}, bad: { retry: { attempts: 0 } }, never: {} }),
      (error: unknown) => {
        assert.match((error as Error).message, /policy "bad".*attempts/)
        // The key-prefixed message wraps the original, it does not replace it.
        assert.ok((error as Error).cause instanceof RangeError)
        return true
      }
    )
    assert.equal(registry.has('good'), true)
    assert.equal(registry.has('bad'), false)
    assert.equal(registry.has('never'), false)
  })

  test('has, delete and clear manage the lifecycle', () => {
    const registry = createPolicyRegistry({ api: {} })

    assert.equal(registry.has('api'), true)
    assert.equal(registry.delete('api'), true)
    assert.equal(registry.has('api'), false)
    assert.equal(registry.delete('missing'), false)

    registry.defineAll({ a: {}, b: {} })
    registry.clear()
    assert.deepEqual(registry.names(), [])
  })

  test('delete and clear release what the registry built', () => {
    const inner = memoryStore({ window: countWindow(10) })
    let released = 0
    const store: StateStore = { ...inner, subscribe: () => () => { released++ } }
    const registry = createPolicyRegistry()

    registry.define('api', { circuitBreaker: { name: 'api', stateStore: store } })
    // The registry is the only handle on that breaker, so dropping the entry
    // without releasing it would strand the subscription for good.
    registry.delete('api')
    assert.equal(released, 1)

    registry.defineAll({
      a: { circuitBreaker: { name: 'a', stateStore: store } },
      b: { circuitBreaker: { name: 'b', stateStore: store } }
    })
    registry.clear()
    assert.equal(released, 3)
  })

  test('a prebuilt policy is left alone — the caller still holds it', async () => {
    const inner = memoryStore({ window: countWindow(10) })
    let released = 0
    const store: StateStore = { ...inner, subscribe: () => () => { released++ } }
    const mine = resilience({ circuitBreaker: { name: 'mine', stateStore: store } })
    const registry = createPolicyRegistry()

    registry.define('api', mine)
    registry.delete('api')
    registry.define('again', mine)
    registry.clear()

    assert.equal(released, 0, 'tearing it down would break a caller still using it')
    assert.equal(await mine.execute(() => 'ok'), 'ok')
    mine.dispose()
    assert.equal(released, 1)
  })
})

describe('default shared registry', () => {
  test('policies is a working registry instance', async (t) => {
    t.after(() => policies.clear())

    policies.define('shared-test', {})
    assert.equal(await policies.get('shared-test').execute(() => 'ok'), 'ok')
  })
})
