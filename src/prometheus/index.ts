import { Counter, Gauge, Histogram, register as globalRegistry, type Registry } from 'prom-client'

import { type MetricsCollector } from '../metrics/collector'

export interface PrometheusCollectorOptions {
  /**
   * The prom-client registry the metrics are registered in. Default:
   * prom-client's global registry. Metric names are unique per registry, so
   * create ONE collector per registry and share it across pipelines — the
   * `name` label is what tells them apart.
   */
  registry?: Registry
  /** Prepended to every metric name. Default: 'breakwater_'. */
  prefix?: string
  /**
   * Buckets for the execution duration histogram, in seconds. Default:
   * prom-client's defaults (5ms to 10s).
   */
  buckets?: number[]
}

/**
 * A MetricsCollector plus the registry it reports into — hand it to
 * `resilience({ metrics })` or `attachMetrics()`, and serve
 * `registry.metrics()` on your scrape endpoint.
 */
export interface PrometheusCollector extends MetricsCollector {
  readonly registry: Registry
}

/** Every state the enum gauge tracks; exactly the breaker's state set. */
const CIRCUIT_STATES = ['closed', 'open', 'half-open', 'isolated'] as const

// The prefix starts every metric name, so it must be a valid name by itself.
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/

/**
 * Ready-made Prometheus collectors for every breakwater signal.
 *
 * Label sets are deliberately low-cardinality: policy kinds, outcomes,
 * rejection reasons and the policy `name` — never correlation IDs or
 * attempt numbers. Unnamed policies report under an empty `name` label;
 * name your policies and the series come out identified.
 */
export function prometheusCollector (options: PrometheusCollectorOptions = {}): PrometheusCollector {
  const registry = options.registry ?? globalRegistry
  const prefix = options.prefix ?? 'breakwater_'
  if (!METRIC_NAME.test(prefix)) {
    throw new RangeError(`prefix must match ${METRIC_NAME}, got ${JSON.stringify(prefix)}`)
  }

  const registers = [registry]

  const executions = new Counter({
    name: `${prefix}executions_total`,
    help: 'Completed executions through a breakwater pipeline, by outcome.',
    labelNames: ['policy', 'name', 'outcome'],
    registers
  })
  const duration = new Histogram({
    name: `${prefix}execution_duration_seconds`,
    help: 'Total pipeline execution time, including retries and delays.',
    labelNames: ['policy', 'name', 'outcome'],
    ...(options.buckets !== undefined && { buckets: options.buckets }),
    registers
  })
  const retries = new Counter({
    name: `${prefix}retries_total`,
    help: 'Retry attempts scheduled after a failed execution.',
    labelNames: ['name'],
    registers
  })
  const timeouts = new Counter({
    name: `${prefix}timeouts_total`,
    help: 'Executions aborted by the timeout policy.',
    labelNames: ['name'],
    registers
  })
  const fallbacks = new Counter({
    name: `${prefix}fallbacks_total`,
    help: 'Failed executions replaced by a fallback handler.',
    labelNames: ['name'],
    registers
  })
  const stale = new Counter({
    name: `${prefix}stale_rescues_total`,
    help: 'Failures rescued by the staleCache policy with a cached value.',
    labelNames: ['name'],
    registers
  })
  const rejections = new Counter({
    name: `${prefix}rejections_total`,
    help: 'Executions rejected without running: open or isolated circuit, full bulkhead or exhausted rate limit.',
    labelNames: ['policy', 'name', 'reason'],
    registers
  })
  const circuitState = new Gauge({
    name: `${prefix}circuit_state`,
    help: 'Circuit breaker state as an enum: 1 on the current state\'s series, 0 elsewhere. Series appear on the first transition — a circuit that never left closed exports none.',
    labelNames: ['name', 'state'],
    registers
  })
  const transitions = new Counter({
    name: `${prefix}circuit_transitions_total`,
    help: 'Circuit breaker state transitions.',
    labelNames: ['name', 'from', 'to'],
    registers
  })

  // Documented behavior, not just syntax: unnamed policies share the empty
  // name label instead of being dropped or crashing the label set.
  const nameLabel = (event: { name?: string }): string => event.name ?? ''

  return {
    registry,

    onExecution (event) {
      const labels = { policy: event.policy, name: nameLabel(event), outcome: event.outcome }
      executions.inc(labels)
      duration.observe(labels, event.durationMs / 1_000)
    },

    onRetry (event) {
      retries.inc({ name: nameLabel(event) })
    },

    onTimeout (event) {
      timeouts.inc({ name: nameLabel(event) })
    },

    onFallback (event) {
      fallbacks.inc({ name: nameLabel(event) })
    },

    onStale (event) {
      stale.inc({ name: nameLabel(event) })
    },

    onReject (event) {
      rejections.inc({ policy: event.policy, name: nameLabel(event), reason: event.reason })
    },

    onStateChange (event) {
      const name = nameLabel(event)
      // Enum pattern: one series per state, exactly one of them at 1. A
      // dashboard reads the current state without decoding magic numbers.
      for (const state of CIRCUIT_STATES) {
        circuitState.set({ name, state }, state === event.to ? 1 : 0)
      }
      transitions.inc({ name, from: event.from, to: event.to })
    }
  }
}
