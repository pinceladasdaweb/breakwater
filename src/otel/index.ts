import {
  context,
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Gauge,
  type MeterProvider,
  type Span,
  type TracerProvider
} from '@opentelemetry/api'
import { basePolicy, type Policy } from '../policy'
import { type MetricsCollector } from '../metrics/collector'

/** The instrumentation scope every breakwater signal reports under. */
const SCOPE = 'breakwater'

/** Every state the enum gauge tracks; exactly the breaker's state set. */
const CIRCUIT_STATES = ['closed', 'open', 'half-open', 'isolated'] as const

/**
 * The OTel SDK's default histogram boundaries are calibrated for
 * milliseconds; this histogram records SECONDS, so without advice nearly
 * every execution would land in the first bucket. Same shape as
 * prom-client's defaults: 5ms to 10s.
 */
const DEFAULT_DURATION_BOUNDARIES = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export interface OtelCollectorOptions {
  /**
   * The MeterProvider the instruments are created from. Default: the API's
   * global provider. The metrics API has no late-binding proxy — a collector
   * created before `metrics.setGlobalMeterProvider()` (or before your SDK
   * starts) is silently no-op forever. Start the SDK first, or pass the
   * provider explicitly.
   */
  meterProvider?: MeterProvider
  /**
   * Bucket boundaries for the execution duration histogram, in seconds,
   * advised to the SDK (a View on the instrument still wins). Default:
   * 5ms to 10s in the same steps as the Prometheus adapter.
   */
  boundaries?: number[]
}

/**
 * What `otelCollector()` returns: today exactly a MetricsCollector, as its
 * own name so later additions never change the signature.
 */
export interface OtelCollector extends MetricsCollector {}

/**
 * Ready-made OpenTelemetry instruments for every breakwater signal — the
 * OTel counterpart of `breakwater/prometheus`, implementing the same
 * MetricsCollector interface with the same nine signals.
 *
 * Attribute sets are deliberately low-cardinality: policy kinds, outcomes,
 * rejection reasons and the policy `name` — never correlation IDs or
 * attempt numbers. Attributes are namespaced (`breakwater.name`, ...) per
 * OTel conventions. Unnamed policies report under an empty `breakwater.name`
 * attribute; name your policies and the series come out identified.
 */
export function otelCollector (options: OtelCollectorOptions = {}): OtelCollector {
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(SCOPE)

  const executions = meter.createCounter('breakwater.executions', {
    description: 'Completed executions through a breakwater pipeline, by outcome.',
    unit: '{execution}'
  })
  const duration = meter.createHistogram('breakwater.execution.duration', {
    description: 'Total pipeline execution time, including retries and delays.',
    unit: 's',
    advice: { explicitBucketBoundaries: options.boundaries ?? DEFAULT_DURATION_BOUNDARIES }
  })
  const retries = meter.createCounter('breakwater.retries', {
    description: 'Retry attempts scheduled after a failed execution.',
    unit: '{retry}'
  })
  const timeouts = meter.createCounter('breakwater.timeouts', {
    description: 'Executions aborted by the timeout policy.',
    unit: '{timeout}'
  })
  const fallbacks = meter.createCounter('breakwater.fallbacks', {
    description: 'Failed executions replaced by a fallback handler.',
    unit: '{fallback}'
  })
  const stale = meter.createCounter('breakwater.stale.rescues', {
    description: 'Failures rescued by the staleCache policy with a cached value.',
    unit: '{rescue}'
  })
  const rejections = meter.createCounter('breakwater.rejections', {
    description: 'Executions rejected without running: open or isolated circuit, full bulkhead or exhausted rate limit.',
    unit: '{rejection}'
  })
  // The synchronous Gauge is in the api since 1.9, but the METER comes from
  // the SDK, which the peer range cannot constrain — an SDK predating
  // sync gauges must cost one instrument, not the whole collector.
  const circuitState: Gauge | undefined = typeof meter.createGauge === 'function'
    ? meter.createGauge('breakwater.circuit.state', {
      description: 'Circuit breaker state as an enum: 1 on the current state\'s series, 0 elsewhere. Series appear on the first transition — a circuit that never left closed exports none.'
    })
    : undefined
  if (circuitState === undefined) {
    console.error('breakwater: this OpenTelemetry SDK has no synchronous Gauge (needs @opentelemetry/sdk-metrics >= 1.24); breakwater.circuit.state will not be exported')
  }
  const transitions = meter.createCounter('breakwater.circuit.transitions', {
    description: 'Circuit breaker state transitions.',
    unit: '{transition}'
  })

  // Documented behavior, not just syntax: unnamed policies share the empty
  // name attribute instead of being dropped or crashing the attribute set.
  const nameAttribute = (event: { name?: string }): string => event.name ?? ''

  return {
    onExecution (event) {
      const attributes: Attributes = {
        'breakwater.policy': event.policy,
        'breakwater.name': nameAttribute(event),
        'breakwater.outcome': event.outcome
      }
      executions.add(1, attributes)
      duration.record(event.durationMs / 1_000, attributes)
    },

    onRetry (event) {
      retries.add(1, { 'breakwater.name': nameAttribute(event) })
    },

    onTimeout (event) {
      timeouts.add(1, { 'breakwater.name': nameAttribute(event) })
    },

    onFallback (event) {
      fallbacks.add(1, { 'breakwater.name': nameAttribute(event) })
    },

    onStale (event) {
      stale.add(1, { 'breakwater.name': nameAttribute(event) })
    },

    onReject (event) {
      rejections.add(1, {
        'breakwater.policy': event.policy,
        'breakwater.name': nameAttribute(event),
        'breakwater.reason': event.reason
      })
    },

    onStateChange (event) {
      const name = nameAttribute(event)
      // Enum pattern: one series per state, exactly one of them at 1. A
      // dashboard reads the current state without decoding magic numbers.
      for (const state of CIRCUIT_STATES) {
        circuitState?.record(state === event.to ? 1 : 0, { 'breakwater.name': name, 'breakwater.state': state })
      }
      transitions.add(1, { 'breakwater.name': name, 'breakwater.from': event.from, 'breakwater.to': event.to })
    }
  }
}

export interface SpanPolicyOptions {
  /** The policy name, reported as the `breakwater.name` span attribute. */
  name?: string
  /**
   * The span's name. Spans are aggregated by name, so keep it
   * low-cardinality — a policy name, never a URL or an argument.
   * Must not be empty (throws RangeError at construction).
   * Default: `name`, or 'breakwater' when the policy is unnamed or its
   * name is empty.
   */
  spanName?: string
  /**
   * The TracerProvider the span comes from. Default: the API's global
   * provider, which late-binds — a span policy created before the SDK
   * starts picks it up once registered.
   */
  tracerProvider?: TracerProvider
}

export interface SpanPolicy extends Policy {
  readonly kind: 'span'
}

/**
 * A policy that wraps every execution flowing through it in an
 * OpenTelemetry span, active while the protected function runs — spans
 * your function creates (an instrumented fetch, a database client) nest
 * under it automatically.
 *
 * Where you place it decides what it measures: outermost in a compose()
 * it spans the whole pipeline, retries and delays included; inside the
 * retry policy it spans each attempt, with the attempt number as the
 * `breakwater.attempt` attribute.
 *
 * Failures are recorded as an exception event plus ERROR status.
 * Cancellation is neither: a cancelled execution gets a `cancelled` span
 * event and keeps its status unset, consistent with cancellation counting
 * nowhere else in breakwater.
 *
 * A tracer, span or context manager that throws is reported and ignored:
 * tracing must never change an execution's outcome.
 */
export function spanPolicy (options: SpanPolicyOptions = {}): SpanPolicy {
  const { name } = options
  // An empty name falls back like an absent one: '' is the "unnamed" bucket
  // on the metrics side, but a span with an empty NAME would be unqueryable.
  const spanName = options.spanName ?? (name === undefined || name === '' ? 'breakwater' : name)
  if (spanName === '') throw new RangeError('spanName must not be empty')
  const tracer = (options.tracerProvider ?? trace.getTracerProvider()).getTracer(SCOPE)

  // Span bookkeeping never rewrites the execution's outcome: SDK throws on
  // the span lifecycle are reported and swallowed, exactly like a throwing
  // MetricsCollector in metricsPolicy.
  const guarded = (op: () => void): void => {
    try {
      op()
    } catch (error) {
      console.error('breakwater: opentelemetry span threw', error)
    }
  }

  const base = basePolicy(async (fn, ctx) => {
    let span: Span | undefined
    let activeContext: Context | undefined
    try {
      const attributes: Attributes = {
        'breakwater.attempt': ctx.attempt,
        'breakwater.correlation_id': ctx.correlationId,
        ...(name !== undefined && { 'breakwater.name': name })
      }
      span = tracer.startSpan(spanName, { attributes }, context.active())
      activeContext = trace.setSpan(context.active(), span)
    } catch (error) {
      console.error('breakwater: opentelemetry tracer threw', error)
    }

    // The span must tell the truth about fn's outcome on EVERY path that
    // runs fn. Cancellation is not a failure here either: the span shows
    // the execution was cut short without polluting error-rate queries.
    const recordOutcome = (active: Span, error: unknown): void => {
      if (ctx.signal.aborted) {
        guarded(() => active.addEvent('cancelled'))
        return
      }
      // Two independent guards: a throwing recordException must not cost
      // the ERROR status too.
      guarded(() => active.recordException(error instanceof Error ? error : String(error)))
      guarded(() => active.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) }))
    }

    // Set synchronously the moment fn actually starts: a throw BEFORE that
    // is the SDK's (a broken context manager), not the execution's, and
    // must be contained.
    let entered = false
    try {
      if (span === undefined || activeContext === undefined) {
        entered = true
        return await fn(ctx)
      }
      return await context.with(activeContext, () => {
        entered = true
        return fn(ctx)
      })
    } catch (error) {
      if (!entered) {
        console.error('breakwater: opentelemetry context threw', error)
        try {
          return await fn(ctx)
        } catch (fnError) {
          if (span !== undefined) recordOutcome(span, fnError)
          throw fnError
        }
      }
      if (span !== undefined) recordOutcome(span, error)
      throw error
    } finally {
      if (span !== undefined) {
        const active = span
        guarded(() => active.end())
      }
    }
  })

  return { ...base, kind: 'span' as const }
}
