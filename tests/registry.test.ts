import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { createPolicyRegistry, policies } from '../src/registry/registry'
import { compose } from '../src/compose/compose'
import { retry } from '../src/retry/retry'
import { timeout } from '../src/timeout/timeout'
import { fixed } from '../src/retry/backoff'
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
})

describe('naming rules', () => {
  test('defining the same name twice throws', () => {
    const registry = createPolicyRegistry()
    registry.define('api', {})
    assert.throws(() => registry.define('api', {}), /already defined/)
  })

  test('rejects empty names', () => {
    const registry = createPolicyRegistry()
    assert.throws(() => registry.define('', {}), RangeError)
  })

  test('get of an unknown name throws listing the known names', () => {
    const registry = createPolicyRegistry()
    registry.define('payments', {})
    registry.define('catalog', {})

    assert.throws(() => registry.get('paymnets'), /unknown policy "paymnets".*payments, catalog/)
  })

  test('get on an empty registry says none are defined', () => {
    const registry = createPolicyRegistry()
    assert.throws(() => registry.get('anything'), /\(none defined\)/)
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
      /policy "bad".*attempts/
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
})

describe('default shared registry', () => {
  test('policies is a working registry instance', async (t) => {
    t.after(() => policies.clear())

    policies.define('shared-test', {})
    assert.equal(await policies.get('shared-test').execute(() => 'ok'), 'ok')
  })
})
