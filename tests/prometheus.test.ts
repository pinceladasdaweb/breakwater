import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { Registry, register as globalRegistry } from 'prom-client'

import { prometheusCollector } from '../src/prometheus/index'
import { resilience } from '../src/compose/resilience'
import { fixed } from '../src/retry/backoff'
import { drain } from './helpers'

/**
 * The numeric value of the series matching `labels`, or undefined. Counters
 * and gauges carry no per-value metricName; histogram sub-series (_sum,
 * _count, _bucket) do — pass `subSeries` to pick one of those instead.
 */
async function seriesValue (
  registry: Registry,
  metric: string,
  labels: Record<string, string> = {},
  subSeries?: string
): Promise<number | undefined> {
  const found = registry.getSingleMetric(metric)
  if (found === undefined) return undefined
  const { values } = await found.get()
  const wanted = subSeries === undefined ? undefined : `${metric}_${subSeries}`
  const match = values.find((v) =>
    (v as { metricName?: string }).metricName === wanted &&
    Object.entries(labels).every(([key, value]) => (v.labels as Record<string, unknown>)[key] === value)
  )
  return match?.value
}

const histogramValue = async (
  registry: Registry,
  metric: string,
  subSeries: string,
  labels: Record<string, string> = {}
): Promise<number | undefined> => await seriesValue(registry, metric, labels, subSeries)

describe('prometheusCollector() options', () => {
  test('rejects a prefix that is not a valid metric name start', () => {
    assert.throws(() => prometheusCollector({ prefix: '9starts_with_digit' }), { name: 'RangeError', message: /prefix/ })
    assert.throws(() => prometheusCollector({ prefix: 'has-dashes_' }), { name: 'RangeError', message: /prefix/ })
    assert.throws(() => prometheusCollector({ prefix: '' }), { name: 'RangeError', message: /prefix/ })
  })

  test('a custom prefix names every metric', async () => {
    const registry = new Registry()
    const collector = prometheusCollector({ registry, prefix: 'acme_resilience_' })

    collector.onRetry?.({ name: 'api', attempt: 1, delayMs: 0 })

    assert.equal(await seriesValue(registry, 'acme_resilience_retries_total', { name: 'api' }), 1)
    assert.equal(registry.getSingleMetric('breakwater_retries_total'), undefined)
  })

  test('without a registry, metrics land in the prom-client global registry', async () => {
    // A unique prefix so this test never collides with the others (the suite
    // may share one process) and can clean up precisely after itself.
    const prefix = 'bw_default_registry_test_'
    const collector = prometheusCollector({ prefix })

    try {
      assert.equal(collector.registry, globalRegistry)
      collector.onTimeout?.({ name: 'api', ms: 50 })
      assert.equal(await seriesValue(globalRegistry, `${prefix}timeouts_total`, { name: 'api' }), 1)
    } finally {
      // By prefix, not by a hardcoded list: a metric added to the collector
      // later must not silently start leaking into the global registry here.
      for (const metric of globalRegistry.getMetricsAsArray()) {
        if (metric.name.startsWith(prefix)) globalRegistry.removeSingleMetric(metric.name)
      }
    }
  })

  test('custom buckets shape the duration histogram', async () => {
    const registry = new Registry()
    const collector = prometheusCollector({ registry, buckets: [0.1, 1] })

    collector.onExecution?.({ policy: 'pipeline', name: 'api', outcome: 'success', durationMs: 500, correlationId: 'c1' })

    const { values } = await registry.getSingleMetric('breakwater_execution_duration_seconds')!.get()
    const les = values
      .filter((v) => (v as { metricName?: string }).metricName === 'breakwater_execution_duration_seconds_bucket')
      .map((v) => (v.labels as { le: number | string }).le)
    assert.deepEqual(les, [0.1, 1, '+Inf'])
  })
})

describe('event mapping', () => {
  test('executions count by outcome and observe the duration in seconds', async () => {
    const registry = new Registry()
    const collector = prometheusCollector({ registry })

    collector.onExecution?.({ policy: 'resilience', name: 'api', outcome: 'success', durationMs: 75, correlationId: 'c1' })
    collector.onExecution?.({ policy: 'resilience', name: 'api', outcome: 'failure', durationMs: 25, correlationId: 'c2' })

    assert.equal(await seriesValue(registry, 'breakwater_executions_total', { outcome: 'success', name: 'api' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_executions_total', { outcome: 'failure', name: 'api' }), 1)
    // Prometheus convention is seconds: 75ms must arrive as 0.075, not 75.
    assert.equal(await histogramValue(registry, 'breakwater_execution_duration_seconds', 'sum', { outcome: 'success' }), 0.075)
    assert.equal(await histogramValue(registry, 'breakwater_execution_duration_seconds', 'count', { outcome: 'success' }), 1)
  })

  test('retries, timeouts and fallbacks count under the policy name', async () => {
    const registry = new Registry()
    const collector = prometheusCollector({ registry })

    collector.onRetry?.({ name: 'api', attempt: 1, delayMs: 10 })
    collector.onRetry?.({ name: 'api', attempt: 2, delayMs: 20 })
    collector.onTimeout?.({ name: 'api', ms: 50 })
    collector.onFallback?.({ name: 'api', handlerIndex: 0 })

    assert.equal(await seriesValue(registry, 'breakwater_retries_total', { name: 'api' }), 2)
    assert.equal(await seriesValue(registry, 'breakwater_timeouts_total', { name: 'api' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_fallbacks_total', { name: 'api' }), 1)
  })

  test('rejections carry the rejecting policy and the reason', async () => {
    const registry = new Registry()
    const collector = prometheusCollector({ registry })

    collector.onReject?.({ policy: 'circuitBreaker', name: 'api', reason: 'circuit_open' })
    collector.onReject?.({ policy: 'bulkhead', name: 'api', reason: 'bulkhead_full' })
    collector.onReject?.({ policy: 'rateLimit', name: 'api', reason: 'rate_limited' })

    assert.equal(await seriesValue(registry, 'breakwater_rejections_total', { policy: 'circuitBreaker', reason: 'circuit_open' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_rejections_total', { policy: 'bulkhead', reason: 'bulkhead_full' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_rejections_total', { policy: 'rateLimit', reason: 'rate_limited' }), 1)
  })

  test('the state gauge is an enum: exactly one series at 1, and transitions count', async () => {
    const registry = new Registry()
    const collector = prometheusCollector({ registry })

    collector.onStateChange?.({ name: 'api', from: 'closed', to: 'open' })

    assert.equal(await seriesValue(registry, 'breakwater_circuit_state', { name: 'api', state: 'open' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_circuit_state', { name: 'api', state: 'closed' }), 0)
    assert.equal(await seriesValue(registry, 'breakwater_circuit_state', { name: 'api', state: 'half-open' }), 0)
    assert.equal(await seriesValue(registry, 'breakwater_circuit_state', { name: 'api', state: 'isolated' }), 0)

    collector.onStateChange?.({ name: 'api', from: 'open', to: 'half-open' })
    collector.onStateChange?.({ name: 'api', from: 'half-open', to: 'closed' })

    assert.equal(await seriesValue(registry, 'breakwater_circuit_state', { name: 'api', state: 'closed' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_circuit_state', { name: 'api', state: 'open' }), 0)
    assert.equal(await seriesValue(registry, 'breakwater_circuit_transitions_total', { from: 'closed', to: 'open' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_circuit_transitions_total', { from: 'half-open', to: 'closed' }), 1)
  })

  test('unnamed policies report under an empty name label', async () => {
    const registry = new Registry()
    const collector = prometheusCollector({ registry })

    collector.onRetry?.({ attempt: 1, delayMs: 0 })
    collector.onTimeout?.({ ms: 50 })
    collector.onFallback?.({ handlerIndex: 0 })
    collector.onReject?.({ policy: 'bulkhead', reason: 'bulkhead_full' })
    collector.onStateChange?.({ from: 'closed', to: 'open' })
    collector.onExecution?.({ policy: 'pipeline', outcome: 'success', durationMs: 1, correlationId: 'c' })

    assert.equal(await seriesValue(registry, 'breakwater_retries_total', { name: '' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_timeouts_total', { name: '' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_fallbacks_total', { name: '' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_rejections_total', { name: '' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_circuit_state', { name: '', state: 'open' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_executions_total', { name: '' }), 1)
  })
})

describe('wired into a pipeline', () => {
  test('resilience({ metrics }) feeds the collector end to end', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const registry = new Registry()
    const policy = resilience({
      name: 'payments',
      retry: { attempts: 2, backoff: fixed(0) },
      circuitBreaker: { consecutiveFailures: 2 },
      fallback: () => 'stale',
      metrics: prometheusCollector({ registry })
    })

    assert.equal(await policy.execute(() => { t.mock.timers.tick(75); return 'fresh' }), 'fresh')
    // Fails twice (opening the circuit), retries into the open breaker, falls back.
    assert.equal(await policy.execute(() => { throw new Error('down') }), 'stale')

    assert.equal(await seriesValue(registry, 'breakwater_executions_total', { name: 'payments', outcome: 'success' }), 2)
    assert.equal(await histogramValue(registry, 'breakwater_execution_duration_seconds', 'sum', { outcome: 'success' }), 0.075)
    assert.equal(await seriesValue(registry, 'breakwater_retries_total', { name: 'payments' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_fallbacks_total', { name: 'payments' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_circuit_state', { name: 'payments', state: 'open' }), 1)
    assert.equal(await seriesValue(registry, 'breakwater_circuit_transitions_total', { from: 'closed', to: 'open' }), 1)
  })

  test('two pipelines share one collector and split by the name label', async () => {
    const registry = new Registry()
    const collector = prometheusCollector({ registry })
    const orders = resilience({ name: 'orders', metrics: collector })
    const catalog = resilience({ name: 'catalog', metrics: collector })

    await orders.execute(() => 'a')
    await orders.execute(() => 'b')
    await catalog.execute(() => 'c')
    await drain()

    assert.equal(await seriesValue(registry, 'breakwater_executions_total', { name: 'orders' }), 2)
    assert.equal(await seriesValue(registry, 'breakwater_executions_total', { name: 'catalog' }), 1)
  })

  test('the scrape output is real Prometheus exposition text', async () => {
    const registry = new Registry()
    const collector = prometheusCollector({ registry })
    collector.onReject?.({ policy: 'rateLimit', name: 'quota', reason: 'rate_limited' })

    const text = await registry.metrics()

    assert.match(text, /# TYPE breakwater_rejections_total counter/)
    assert.match(text, /breakwater_rejections_total\{policy="rateLimit",name="quota",reason="rate_limited"\} 1/)
  })
})
