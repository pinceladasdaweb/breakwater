# OpenTelemetry

`breakwater/otel` turns every breakwater signal into OpenTelemetry metrics —
and adds the one thing a metrics interface cannot express: **spans**. It ships
two pieces:

- `otelCollector()` — a [`MetricsCollector`](observability.md) emitting the
  same eight signals as [`breakwater/prometheus`](prometheus.md), as OTel
  instruments.
- `spanPolicy()` — a composable policy that wraps each execution in an active
  span, so whatever your function calls (an instrumented `fetch`, a database
  client) nests under it in the trace.

```bash
npm install breakwater @opentelemetry/api
```

`@opentelemetry/api` is an optional peer dependency: only this entry point
needs it, and importing plain `breakwater` never loads it. Your application
brings its own SDK (`@opentelemetry/sdk-node` or the individual SDK packages)
— the adapter only ever talks to the API, as a library should.

## Quick start

```ts
import { NodeSDK } from '@opentelemetry/sdk-node'
import { resilience } from 'breakwater'
import { otelCollector } from 'breakwater/otel'

// 1. Start your SDK first — see the initialization-order note below.
const sdk = new NodeSDK({ /* your exporters */ })
sdk.start()

// 2. Then create the collector and wire it like any other.
const payments = resilience({
  name: 'payments-api',
  retry: { attempts: 3 },
  circuitBreaker: { consecutiveFailures: 5 },
  timeout: 2_000,
  metrics: otelCollector()
})
```

## Initialization order matters (metrics only)

The OTel **metrics** API has no late-binding proxy: instruments created while
no global `MeterProvider` is registered are silently no-op **forever**. Start
your SDK (or call `metrics.setGlobalMeterProvider()`) *before* creating the
collector, or pass the provider explicitly and be independent of ordering:

```ts
import { MeterProvider } from '@opentelemetry/sdk-metrics'

const meterProvider = new MeterProvider({ readers: [/* ... */] })
const collector = otelCollector({ meterProvider })
```

Spans do not have this problem — the tracing API late-binds, so a
`spanPolicy()` created before the SDK starts picks up the real tracer once it
registers.

## Options

```ts
otelCollector({
  meterProvider,                     // default: the API's global provider (ordering note above)
  boundaries: [0.05, 0.1, 0.5, 1, 5] // duration histogram buckets, in SECONDS
})
```

The default duration boundaries run 5 ms to 10 s in the same steps as the
Prometheus adapter — *advised* to the SDK, so a View on the instrument still
wins. Without the advice, the SDK's default buckets (calibrated for
milliseconds) would bury every sub-5-second execution in one bucket.

One compatibility note: the state gauge needs an SDK with synchronous gauges
(`@opentelemetry/sdk-metrics` >= 1.24). An older SDK costs exactly that one
instrument — reported once to `console.error` — never the whole collector.

## The metrics

All instruments report under the `breakwater` instrumentation scope.
Attributes are namespaced per OTel conventions (`breakwater.name`,
`breakwater.outcome`, ...).

| Instrument | Type | Attributes (`breakwater.*`) | Fed by |
|---|---|---|---|
| `breakwater.executions` | counter | `policy`, `name`, `outcome` | every completed pipeline execution |
| `breakwater.execution.duration` | histogram (unit `s`) | `policy`, `name`, `outcome` | total pipeline time, retries and delays included |
| `breakwater.retries` | counter | `name` | each scheduled retry |
| `breakwater.timeouts` | counter | `name` | executions aborted by the timeout policy |
| `breakwater.fallbacks` | counter | `name` | failures replaced by a fallback handler |
| `breakwater.rejections` | counter | `policy`, `name`, `reason` | fast rejections: `circuit_open`, `isolated`, `bulkhead_full`, `rate_limited` |
| `breakwater.circuit.state` | gauge | `name`, `state` | enum pattern: the current state's series is 1, the other three are 0 |
| `breakwater.circuit.transitions` | counter | `name`, `from`, `to` | every breaker state change |

Durations follow the OTel convention and are in **seconds**. Exporting through
the OTel Prometheus exporter yields familiar counter names
(`breakwater_executions_total`, ...) with the attribute keys sanitized into
labels (`breakwater_name`) — close to, but not byte-for-byte the same as, the
native [`breakwater/prometheus`](prometheus.md) adapter's output.

Two behaviors carried over from the Prometheus adapter, because they are
properties of the event flow, not of the client library:

- The collector is event-driven, so the `circuit.state` series **appear on
  the breaker's first transition**. A circuit that has never left `closed`
  exports no state series yet — treat the absence of an `open` series as
  healthy, not as missing instrumentation.
- Attribute sets are deliberately low-cardinality: correlation IDs and attempt
  numbers never become metric attributes. Unnamed policies report under an
  empty `breakwater.name` — [name your policies](named-policies.md) and the
  series come out identified.

## Spans: `spanPolicy()`

`otelCollector()` covers the numbers; `spanPolicy()` covers the *shape* of an
execution. It is a regular policy — compose it wherever you want the span
boundary to be:

```ts
import { compose, retry, circuitBreaker, timeout } from 'breakwater'
import { spanPolicy } from 'breakwater/otel'

const pipeline = compose(
  spanPolicy({ name: 'payments-api' }), // one span per pipeline execution
  retry({ attempts: 3 }),
  circuitBreaker({ name: 'payments-api', consecutiveFailures: 5 }),
  timeout(2_000)
)
```

The span is **active** while your function runs: spans created inside it —
by auto-instrumented HTTP clients, database drivers, or your own tracer —
become its children automatically.

**Placement decides the story the trace tells.** Outermost (as above), one
span covers the whole execution, retries and backoff delays included. Placed
*inside* the retry instead, each attempt gets its own span, with the attempt
number in `breakwater.attempt`:

```ts
const pipeline = compose(
  retry({ attempts: 3 }),
  spanPolicy({ name: 'payments-api' }), // one span PER ATTEMPT
  timeout(2_000)
)
```

Span attributes: `breakwater.attempt`, `breakwater.correlation_id` (the same
correlation ID that travels through breakwater's own [events](observability.md)
— spans are per-execution, so a high-cardinality attribute is fine here where
it never would be on a metric), and `breakwater.name` when the policy is
named.

### Options

```ts
spanPolicy({
  name: 'payments-api',    // → breakwater.name attribute; default span name
  spanName: 'charge card', // override; keep it low-cardinality — never a URL
  tracerProvider           // default: the API's global (late-binding) provider
})
```

### Outcome semantics

- **Success** — the span ends with its status unset, per OTel conventions for
  instrumentation libraries.
- **Failure** — the error is recorded as an `exception` span event and the
  status is set to `ERROR`; the error itself rethrows untouched.
- **Cancellation** — neither: a `cancelled` span event, status left unset.
  Cancellation is not an outcome anywhere in breakwater, and a deploy's worth
  of client disconnects should not paint your traces red.

And the containment rule that holds across the library: **tracing must never
change an execution's outcome**. A tracer or span that throws is reported to
`console.error` and ignored; your function still runs, its result still comes
back.

## Metrics and spans together

The two pieces are independent — use either or both. A typical full setup
with a hand-built pipeline needs both wirings — `attachMetrics()` covers the
six event-driven signals, and a [`metricsPolicy()`](observability.md)
outermost feeds `executions` and `execution.duration`, which are
measurements, not events:

```ts
import { compose, retry, circuitBreaker, timeout, attachMetrics, metricsPolicy } from 'breakwater'
import { otelCollector, spanPolicy } from 'breakwater/otel'

const collector = otelCollector()
const pipeline = compose(
  metricsPolicy(collector, { name: 'payments-api' }), // executions + duration
  spanPolicy({ name: 'payments-api' }),
  retry({ attempts: 3 }),
  circuitBreaker({ name: 'payments-api', consecutiveFailures: 5 }),
  timeout(2_000)
)
attachMetrics(pipeline, collector, { name: 'payments-api' }) // the other six signals
```

With `resilience()`, pass the collector as `metrics` and wrap the result if
you also want spans:

```ts
const guarded = resilience({ name: 'payments-api', retry: { attempts: 3 }, metrics: otelCollector() })
const traced = compose(spanPolicy({ name: 'payments-api' }), guarded)
```

## See it running

The [`examples/otel-jaeger`](../examples/otel-jaeger) demo is one
`docker compose up` away: a breakwater-protected app with a scripted outage,
its traces in Jaeger (pipeline span → per-attempt spans → the dependency's
own span) and its metrics in Prometheus.

## Choosing between the adapters

Same signals either way. If your observability stack is OTel-native
(collector, OTLP, vendor backends), use `breakwater/otel` and get spans in
the bargain. If you scrape with Prometheus directly,
[`breakwater/prometheus`](prometheus.md) speaks prom-client natively and
pairs with the ready-made [Grafana dashboard](../examples/grafana). Running
both at once works — they share nothing but the events feeding them.
