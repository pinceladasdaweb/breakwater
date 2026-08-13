import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { context, metrics, SpanStatusCode, type Tracer, type TracerProvider } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  DataPointType,
  MeterProvider,
  MetricReader,
  type CollectionResult,
  type MetricData
} from '@opentelemetry/sdk-metrics'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base'

import { otelCollector, spanPolicy } from '../src/otel/index'
import { compose } from '../src/compose/compose'
import { resilience } from '../src/compose/resilience'
import { fixed } from '../src/retry/backoff'
import { retry } from '../src/retry/retry'

/** A MetricReader that only exists to be collect()ed on demand. */
class TestReader extends MetricReader {
  protected async onShutdown (): Promise<void> {}
  protected async onForceFlush (): Promise<void> {}
}

function metricByName (result: CollectionResult, name: string): MetricData | undefined {
  return result.resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.descriptor.name === name)
}

function pointMatching (metric: MetricData | undefined, attributes: Record<string, string | number>): unknown {
  return metric?.dataPoints.find((point) =>
    Object.entries(attributes).every(([key, value]) => point.attributes[key] === value)
  )?.value
}

/** Counter/gauge data point value for the series matching `attributes`. */
async function pointValue (
  reader: TestReader,
  name: string,
  attributes: Record<string, string | number> = {}
): Promise<number | undefined> {
  const value = pointMatching(metricByName(await reader.collect(), name), attributes)
  return typeof value === 'number' ? value : undefined
}

/** Histogram data point (count/sum/...) for the series matching `attributes`. */
async function histogramPoint (
  reader: TestReader,
  name: string,
  attributes: Record<string, string | number> = {}
): Promise<{ count: number, sum?: number } | undefined> {
  const value = pointMatching(metricByName(await reader.collect(), name), attributes)
  return typeof value === 'object' && value !== null ? value as { count: number, sum?: number } : undefined
}

function meterSetup (): { reader: TestReader, meterProvider: MeterProvider } {
  const reader = new TestReader()
  return { reader, meterProvider: new MeterProvider({ readers: [reader] }) }
}

describe('otelCollector() event mapping', () => {
  test('executions count by outcome and record the duration in seconds', async () => {
    const { reader, meterProvider } = meterSetup()
    const collector = otelCollector({ meterProvider })

    collector.onExecution?.({ policy: 'resilience', name: 'api', outcome: 'success', durationMs: 75, correlationId: 'c1' })
    collector.onExecution?.({ policy: 'resilience', name: 'api', outcome: 'failure', durationMs: 25, correlationId: 'c2' })

    assert.equal(await pointValue(reader, 'breakwater.executions', { 'breakwater.policy': 'resilience', 'breakwater.outcome': 'success', 'breakwater.name': 'api' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.executions', { 'breakwater.policy': 'resilience', 'breakwater.outcome': 'failure', 'breakwater.name': 'api' }), 1)
    // OTel duration convention is seconds: 75ms must arrive as 0.075, not 75.
    const point = await histogramPoint(reader, 'breakwater.execution.duration', { 'breakwater.outcome': 'success' })
    assert.equal(point?.count, 1)
    assert.equal(point?.sum, 0.075)
  })

  test('the duration instrument is a histogram declared in seconds', async () => {
    const { reader, meterProvider } = meterSetup()
    const collector = otelCollector({ meterProvider })

    collector.onExecution?.({ policy: 'pipeline', name: 'api', outcome: 'success', durationMs: 100, correlationId: 'c' })

    const metric = metricByName(await reader.collect(), 'breakwater.execution.duration')
    assert.equal(metric?.dataPointType, DataPointType.HISTOGRAM)
    assert.equal(metric?.descriptor.unit, 's')
  })

  test('retries, timeouts and fallbacks count under the policy name', async () => {
    const { reader, meterProvider } = meterSetup()
    const collector = otelCollector({ meterProvider })

    collector.onRetry?.({ name: 'api', attempt: 1, delayMs: 10 })
    collector.onRetry?.({ name: 'api', attempt: 2, delayMs: 20 })
    collector.onTimeout?.({ name: 'api', ms: 50 })
    collector.onFallback?.({ name: 'api', handlerIndex: 0 })
    collector.onStale?.({ name: 'api', ageMs: 1_000 })

    assert.equal(await pointValue(reader, 'breakwater.retries', { 'breakwater.name': 'api' }), 2)
    assert.equal(await pointValue(reader, 'breakwater.timeouts', { 'breakwater.name': 'api' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.fallbacks', { 'breakwater.name': 'api' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.stale.rescues', { 'breakwater.name': 'api' }), 1)
  })

  test('rejections carry the rejecting policy and the reason', async () => {
    const { reader, meterProvider } = meterSetup()
    const collector = otelCollector({ meterProvider })

    collector.onReject?.({ policy: 'circuitBreaker', name: 'api', reason: 'circuit_open' })
    collector.onReject?.({ policy: 'bulkhead', name: 'api', reason: 'bulkhead_full' })
    collector.onReject?.({ policy: 'rateLimit', name: 'api', reason: 'rate_limited' })

    assert.equal(await pointValue(reader, 'breakwater.rejections', { 'breakwater.policy': 'circuitBreaker', 'breakwater.reason': 'circuit_open' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.rejections', { 'breakwater.policy': 'bulkhead', 'breakwater.reason': 'bulkhead_full' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.rejections', { 'breakwater.policy': 'rateLimit', 'breakwater.reason': 'rate_limited' }), 1)
  })

  test('the state gauge is an enum: exactly one series at 1, and transitions count', async () => {
    const { reader, meterProvider } = meterSetup()
    const collector = otelCollector({ meterProvider })

    collector.onStateChange?.({ name: 'api', from: 'closed', to: 'open' })

    assert.equal(await pointValue(reader, 'breakwater.circuit.state', { 'breakwater.name': 'api', 'breakwater.state': 'open' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.circuit.state', { 'breakwater.name': 'api', 'breakwater.state': 'closed' }), 0)
    assert.equal(await pointValue(reader, 'breakwater.circuit.state', { 'breakwater.name': 'api', 'breakwater.state': 'half-open' }), 0)
    assert.equal(await pointValue(reader, 'breakwater.circuit.state', { 'breakwater.name': 'api', 'breakwater.state': 'isolated' }), 0)

    collector.onStateChange?.({ name: 'api', from: 'open', to: 'half-open' })
    collector.onStateChange?.({ name: 'api', from: 'half-open', to: 'closed' })

    assert.equal(await pointValue(reader, 'breakwater.circuit.state', { 'breakwater.name': 'api', 'breakwater.state': 'closed' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.circuit.state', { 'breakwater.name': 'api', 'breakwater.state': 'open' }), 0)
    assert.equal(await pointValue(reader, 'breakwater.circuit.transitions', { 'breakwater.name': 'api', 'breakwater.from': 'closed', 'breakwater.to': 'open' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.circuit.transitions', { 'breakwater.name': 'api', 'breakwater.from': 'half-open', 'breakwater.to': 'closed' }), 1)
  })

  test('unnamed policies report under an empty name attribute', async () => {
    const { reader, meterProvider } = meterSetup()
    const collector = otelCollector({ meterProvider })

    collector.onRetry?.({ attempt: 1, delayMs: 0 })
    collector.onTimeout?.({ ms: 50 })
    collector.onFallback?.({ handlerIndex: 0 })
    collector.onReject?.({ policy: 'bulkhead', reason: 'bulkhead_full' })
    collector.onStateChange?.({ from: 'closed', to: 'open' })
    collector.onExecution?.({ policy: 'pipeline', outcome: 'success', durationMs: 1, correlationId: 'c' })

    assert.equal(await pointValue(reader, 'breakwater.retries', { 'breakwater.name': '' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.timeouts', { 'breakwater.name': '' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.fallbacks', { 'breakwater.name': '' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.rejections', { 'breakwater.name': '' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.circuit.state', { 'breakwater.name': '', 'breakwater.state': 'open' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.executions', { 'breakwater.name': '' }), 1)
  })

  test('instruments report under the breakwater scope with their declared units', async (t) => {
    // A modern SDK meter has sync gauges: construction must stay silent.
    const reported = t.mock.method(console, 'error', () => {})
    const { reader, meterProvider } = meterSetup()
    const collector = otelCollector({ meterProvider })
    assert.equal(reported.mock.callCount(), 0)

    collector.onExecution?.({ policy: 'pipeline', name: 'api', outcome: 'success', durationMs: 1, correlationId: 'c' })
    collector.onRetry?.({ name: 'api', attempt: 1, delayMs: 0 })
    collector.onTimeout?.({ name: 'api', ms: 50 })
    collector.onFallback?.({ name: 'api', handlerIndex: 0 })
    collector.onStale?.({ name: 'api', ageMs: 1_000 })
    collector.onReject?.({ policy: 'bulkhead', name: 'api', reason: 'bulkhead_full' })
    collector.onStateChange?.({ name: 'api', from: 'closed', to: 'open' })

    const result = await reader.collect()
    const scope = result.resourceMetrics.scopeMetrics.find((s) => s.scope.name === 'breakwater')
    assert.notEqual(scope, undefined)

    const units = Object.fromEntries(scope!.metrics.map((m) => [m.descriptor.name, m.descriptor.unit]))
    assert.deepEqual(units, {
      'breakwater.executions': '{execution}',
      'breakwater.execution.duration': 's',
      'breakwater.retries': '{retry}',
      'breakwater.timeouts': '{timeout}',
      'breakwater.fallbacks': '{fallback}',
      'breakwater.stale.rescues': '{rescue}',
      'breakwater.rejections': '{rejection}',
      'breakwater.circuit.state': '',
      'breakwater.circuit.transitions': '{transition}'
    })
  })

  test('the duration histogram advises sub-second boundaries by default', async () => {
    const { reader, meterProvider } = meterSetup()
    const collector = otelCollector({ meterProvider })

    collector.onExecution?.({ policy: 'pipeline', name: 'api', outcome: 'success', durationMs: 75, correlationId: 'c' })

    const metric = metricByName(await reader.collect(), 'breakwater.execution.duration')
    const point = metric?.dataPoints[0]?.value as { buckets: { boundaries: number[] } }
    // The SDK default boundaries are calibrated for milliseconds; recording
    // seconds against them would bury everything under 5s in one bucket.
    assert.deepEqual(point.buckets.boundaries, [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10])
  })

  test('custom boundaries shape the duration histogram', async () => {
    const { reader, meterProvider } = meterSetup()
    const collector = otelCollector({ meterProvider, boundaries: [0.1, 1] })

    collector.onExecution?.({ policy: 'pipeline', name: 'api', outcome: 'success', durationMs: 500, correlationId: 'c' })

    const metric = metricByName(await reader.collect(), 'breakwater.execution.duration')
    const point = metric?.dataPoints[0]?.value as { buckets: { boundaries: number[], counts: number[] } }
    assert.deepEqual(point.buckets.boundaries, [0.1, 1])
    assert.deepEqual(point.buckets.counts, [0, 1, 0])
  })

  test('an SDK meter without createGauge costs the state gauge, not the collector', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const { reader, meterProvider } = meterSetup()
    const realMeter = meterProvider.getMeter('breakwater')
    const gaugelessProvider = {
      getMeter: () => ({
        createCounter: realMeter.createCounter.bind(realMeter),
        createHistogram: realMeter.createHistogram.bind(realMeter)
        // no createGauge: the shape of @opentelemetry/sdk-metrics < 1.24
      })
    } as unknown as MeterProvider

    const collector = otelCollector({ meterProvider: gaugelessProvider })
    assert.equal(reported.mock.callCount(), 1)

    collector.onStateChange?.({ name: 'api', from: 'closed', to: 'open' })

    assert.equal(await pointValue(reader, 'breakwater.circuit.state', { 'breakwater.name': 'api', 'breakwater.state': 'open' }), undefined)
    assert.equal(await pointValue(reader, 'breakwater.circuit.transitions', { 'breakwater.name': 'api', 'breakwater.from': 'closed', 'breakwater.to': 'open' }), 1)
  })

  test('without a provider, instruments come from the global meter provider', async () => {
    const { reader, meterProvider } = meterSetup()
    metrics.setGlobalMeterProvider(meterProvider)
    try {
      const collector = otelCollector()
      collector.onTimeout?.({ name: 'api', ms: 50 })
      assert.equal(await pointValue(reader, 'breakwater.timeouts', { 'breakwater.name': 'api' }), 1)
    } finally {
      metrics.disable()
      await meterProvider.shutdown()
    }
  })
})

describe('otelCollector() wired into a pipeline', () => {
  test('resilience({ metrics }) feeds the collector end to end', async () => {
    const { reader, meterProvider } = meterSetup()
    const policy = resilience({
      name: 'payments',
      retry: { attempts: 2, backoff: fixed(0) },
      circuitBreaker: { consecutiveFailures: 2 },
      fallback: () => 'stale',
      metrics: otelCollector({ meterProvider })
    })

    assert.equal(await policy.execute(() => 'fresh'), 'fresh')
    // Fails twice (opening the circuit), retries into the open breaker, falls back.
    assert.equal(await policy.execute(() => { throw new Error('down') }), 'stale')

    assert.equal(await pointValue(reader, 'breakwater.executions', { 'breakwater.name': 'payments', 'breakwater.outcome': 'success' }), 2)
    assert.equal(await pointValue(reader, 'breakwater.retries', { 'breakwater.name': 'payments' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.fallbacks', { 'breakwater.name': 'payments' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.circuit.state', { 'breakwater.name': 'payments', 'breakwater.state': 'open' }), 1)
    assert.equal(await pointValue(reader, 'breakwater.circuit.transitions', { 'breakwater.from': 'closed', 'breakwater.to': 'open' }), 1)
  })
})

describe('spanPolicy()', () => {
  const exporter = new InMemorySpanExporter()
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const contextManager = new AsyncLocalStorageContextManager()

  before(() => {
    context.setGlobalContextManager(contextManager.enable())
  })

  beforeEach(() => { exporter.reset() })

  after(async () => {
    // The suite may share a process (mutation runs): global context state
    // must not leak into other test files.
    context.disable()
    contextManager.disable()
    await tracerProvider.shutdown()
  })

  const finishedSpan = (name: string): ReadableSpan => {
    const span = exporter.getFinishedSpans().find((s) => s.name === name)
    assert.notEqual(span, undefined, `expected a finished span named ${JSON.stringify(name)}`)
    return span as ReadableSpan
  }

  test('a successful execution ends its span with status unset', async () => {
    const policy = spanPolicy({ name: 'api', tracerProvider })

    assert.equal(policy.kind, 'span')
    assert.equal(await policy.execute(() => 'ok', { correlationId: 'c-1' }), 'ok')

    const span = finishedSpan('api')
    assert.equal(span.status.code, SpanStatusCode.UNSET)
    assert.equal(span.attributes['breakwater.name'], 'api')
    assert.equal(span.attributes['breakwater.attempt'], 0)
    assert.equal(span.attributes['breakwater.correlation_id'], 'c-1')
  })

  test('spanName overrides the default span name', async () => {
    const policy = spanPolicy({ name: 'api', spanName: 'charge card', tracerProvider })

    await policy.execute(() => 'ok')

    finishedSpan('charge card')
  })

  test('an unnamed policy spans as "breakwater" and omits the name attribute', async () => {
    const policy = spanPolicy({ tracerProvider })

    await policy.execute(() => 'ok')

    const span = finishedSpan('breakwater')
    assert.equal('breakwater.name' in span.attributes, false)
  })

  test('a failure records the exception, sets ERROR and rethrows', async () => {
    const policy = spanPolicy({ name: 'api', tracerProvider })

    await assert.rejects(policy.execute(() => { throw new Error('boom') }), { message: 'boom' })

    const span = finishedSpan('api')
    assert.equal(span.status.code, SpanStatusCode.ERROR)
    assert.equal(span.status.message, 'boom')
    const exception = span.events.find((event) => event.name === 'exception')
    assert.equal(exception?.attributes?.['exception.message'], 'boom')
  })

  test('a non-Error throw is stringified into the status', async () => {
    const policy = spanPolicy({ name: 'api', tracerProvider })

    // eslint-disable-next-line no-throw-literal
    await assert.rejects(policy.execute(() => { throw 'plain string' }))

    const span = finishedSpan('api')
    assert.equal(span.status.code, SpanStatusCode.ERROR)
    assert.equal(span.status.message, 'plain string')
  })

  test('cancellation is not a failure: a "cancelled" event, no ERROR status', async () => {
    const controller = new AbortController()
    const policy = spanPolicy({ name: 'api', tracerProvider })

    await assert.rejects(policy.execute(() => {
      controller.abort()
      throw new Error('cut short')
    }, { signal: controller.signal }))

    const span = finishedSpan('api')
    assert.equal(span.status.code, SpanStatusCode.UNSET)
    assert.notEqual(span.events.find((event) => event.name === 'cancelled'), undefined)
    assert.equal(span.events.find((event) => event.name === 'exception'), undefined)
  })

  test('spans created inside the execution nest under the pipeline span', async () => {
    const policy = spanPolicy({ name: 'api', tracerProvider })

    await policy.execute(() => {
      const child = tracerProvider.getTracer('user-code').startSpan('db query')
      child.end()
      return 'ok'
    })

    const parent = finishedSpan('api')
    const child = finishedSpan('db query')
    assert.equal(child.parentSpanContext?.spanId, parent.spanContext().spanId)
    assert.equal(child.spanContext().traceId, parent.spanContext().traceId)
  })

  test('inside a retry, each attempt gets its own span with its attempt number', async () => {
    let failures = 2
    const pipeline = compose(
      retry({ attempts: 3, backoff: fixed(0) }),
      spanPolicy({ name: 'api', tracerProvider })
    )

    assert.equal(await pipeline.execute(() => {
      if (failures-- > 0) throw new Error('flaky')
      return 'ok'
    }), 'ok')

    const attempts = exporter.getFinishedSpans()
      .filter((span) => span.name === 'api')
      .map((span) => span.attributes['breakwater.attempt'])
      .sort()
    assert.deepEqual(attempts, [0, 1, 2])
  })

  test('outermost in a compose, one span covers all attempts', async () => {
    let failures = 2
    const pipeline = compose(
      spanPolicy({ name: 'api', tracerProvider }),
      retry({ attempts: 3, backoff: fixed(0) })
    )

    assert.equal(await pipeline.execute(() => {
      if (failures-- > 0) throw new Error('flaky')
      return 'ok'
    }), 'ok')

    assert.equal(exporter.getFinishedSpans().filter((span) => span.name === 'api').length, 1)
  })

  test('a throwing tracer is reported and the execution still runs', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const exploding: TracerProvider = {
      getTracer: () => ({
        startSpan () { throw new Error('sdk exploded') }
      }) as unknown as Tracer
    }
    const policy = spanPolicy({ name: 'api', tracerProvider: exploding })

    assert.equal(await policy.execute(() => 'ok'), 'ok')
    assert.equal(reported.mock.callCount(), 1)
  })

  test('spans carry the breakwater instrumentation scope', async () => {
    const policy = spanPolicy({ name: 'api', tracerProvider })

    await policy.execute(() => 'ok')

    assert.equal(finishedSpan('api').instrumentationScope.name, 'breakwater')
  })

  test('a throwing tracer with a failing execution rethrows the real error untouched', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const exploding: TracerProvider = {
      getTracer: () => ({
        startSpan () { throw new Error('sdk exploded') }
      }) as unknown as Tracer
    }
    const policy = spanPolicy({ name: 'api', tracerProvider: exploding })

    await assert.rejects(policy.execute(() => { throw new Error('real failure') }), { message: 'real failure' })
    // Exactly the tracer report: with no span there is no lifecycle left to
    // fail, so nothing else may be reported on the failure path either.
    assert.equal(reported.mock.callCount(), 1)
  })

  test('an empty policy name falls back to the default span name', async () => {
    const policy = spanPolicy({ name: '', tracerProvider })

    await policy.execute(() => 'ok')

    // '' is the documented "unnamed" bucket for the ATTRIBUTE, but a span
    // NAMED '' would be unqueryable — the name falls back, the attribute stays.
    const span = finishedSpan('breakwater')
    assert.equal(span.attributes['breakwater.name'], '')
  })

  test('an empty spanName throws at construction', () => {
    assert.throws(() => spanPolicy({ spanName: '' }), { name: 'RangeError', message: /spanName/ })
  })

  test('a throwing context manager is contained and the execution still runs', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const broken = {
      active: () => contextManager.active(),
      with: () => { throw new Error('context manager exploded') },
      bind: <T>(_c: unknown, target: T) => target,
      enable () { return this },
      disable () { return this }
    }
    // A processor-less provider: SimpleSpanProcessor itself exports through
    // context.with, which would double-count the broken manager's throws.
    const bareProvider = new BasicTracerProvider()
    context.disable()
    context.setGlobalContextManager(broken)
    try {
      const policy = spanPolicy({ name: 'api', tracerProvider: bareProvider })

      assert.equal(await policy.execute(() => 'ok'), 'ok')
      assert.equal(reported.mock.callCount(), 1)
      // The failure path must still surface the REAL error, not the SDK's.
      await assert.rejects(policy.execute(() => { throw new Error('real failure') }), { message: 'real failure' })
      assert.equal(reported.mock.callCount(), 2)
    } finally {
      context.disable()
      context.setGlobalContextManager(contextManager)
      await bareProvider.shutdown()
    }
  })

  test('when the context manager breaks pre-entry, the span still tells the truth about a failure', async (t) => {
    t.mock.method(console, 'error', () => {})
    const calls: string[] = []
    const stubSpan = {
      addEvent: (event: string) => { calls.push(`event:${event}`) },
      recordException: () => { calls.push('exception') },
      setStatus: (status: { code: number }) => { calls.push(`status:${status.code}`) },
      end: () => { calls.push('end') }
    }
    const stubProvider = {
      getTracer: () => ({ startSpan: () => stubSpan })
    } as unknown as TracerProvider
    const broken = {
      active: () => contextManager.active(),
      with: () => { throw new Error('context manager exploded') },
      bind: <T>(_c: unknown, target: T) => target,
      enable () { return this },
      disable () { return this }
    }
    context.disable()
    context.setGlobalContextManager(broken)
    try {
      const policy = spanPolicy({ name: 'api', tracerProvider: stubProvider })

      await assert.rejects(policy.execute(() => { throw new Error('real failure') }), { message: 'real failure' })
      // fn ran and failed on the contained path: the span must not export
      // as a silent success.
      assert.deepEqual(calls, ['exception', `status:${SpanStatusCode.ERROR}`, 'end'])
    } finally {
      context.disable()
      context.setGlobalContextManager(contextManager)
    }
  })

  test('a span whose lifecycle methods throw never changes the outcome', async (t) => {
    const reported = t.mock.method(console, 'error', () => {})
    const brokenSpan = {
      addEvent () { throw new Error('addEvent exploded') },
      recordException () { throw new Error('recordException exploded') },
      setStatus () { throw new Error('setStatus exploded') },
      end () { throw new Error('end exploded') }
    }
    const broken: TracerProvider = {
      getTracer: () => ({
        startSpan: () => brokenSpan
      }) as unknown as Tracer
    }
    const policy = spanPolicy({ name: 'api', tracerProvider: broken })

    assert.equal(await policy.execute(() => 'ok'), 'ok')
    await assert.rejects(policy.execute(() => { throw new Error('real failure') }), { message: 'real failure' })
    // success: end throws (1); failure: recordException (1) + setStatus (1) + end (1).
    assert.equal(reported.mock.callCount(), 4)
  })
})
