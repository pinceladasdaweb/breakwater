# Prometheus

`breakwater/prometheus` turns every breakwater signal into ready-made
[prom-client](https://github.com/siimon/prom-client) metrics. It is a
[`MetricsCollector`](observability.md) — wire it once, scrape forever.

```bash
npm install breakwater prom-client
```

`prom-client` is an optional peer dependency: only this entry point needs it,
and importing plain `breakwater` never loads either.

## Quick start

```ts
import express from 'express'
import { register } from 'prom-client'
import { resilience } from 'breakwater'
import { prometheusCollector } from 'breakwater/prometheus'

const metrics = prometheusCollector() // registers in prom-client's global registry

const payments = resilience({
  name: 'payments-api',
  retry: { attempts: 3 },
  circuitBreaker: { consecutiveFailures: 5 },
  timeout: 2_000,
  metrics
})

const app = express()
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType)
  res.send(await register.metrics())
})
```

Create **one collector per registry** and share it across pipelines — metric
names are unique per registry, and the `name` label is what tells your
policies apart. A second `prometheusCollector()` on the same registry throws
prom-client's duplicate-registration error.

```ts
const metrics = prometheusCollector()
const orders = resilience({ name: 'orders-api', metrics, /* ... */ })
const catalog = resilience({ name: 'catalog-api', metrics, /* ... */ })
```

## Options

```ts
prometheusCollector({
  registry,                  // prom-client Registry; default: the global one
  prefix: 'acme_resilience_', // default: 'breakwater_'
  buckets: [0.05, 0.1, 0.5, 1, 5] // duration histogram, in SECONDS
})
```

The prefix must be a valid metric-name start (`[a-zA-Z_:][a-zA-Z0-9_:]*`);
an invalid one throws at construction, not on the first scrape.

## The metrics

| Metric | Type | Labels | Fed by |
|---|---|---|---|
| `breakwater_executions_total` | counter | `policy`, `name`, `outcome` | every completed pipeline execution |
| `breakwater_execution_duration_seconds` | histogram | `policy`, `name`, `outcome` | total pipeline time, retries and delays included |
| `breakwater_retries_total` | counter | `name` | each scheduled retry |
| `breakwater_timeouts_total` | counter | `name` | executions aborted by the timeout policy |
| `breakwater_fallbacks_total` | counter | `name` | failures replaced by a fallback handler |
| `breakwater_stale_rescues_total` | counter | `name` | failures rescued by the staleCache policy with a cached value |
| `breakwater_rejections_total` | counter | `policy`, `name`, `reason` | fast rejections: `circuit_open`, `isolated`, `bulkhead_full`, `rate_limited` |
| `breakwater_circuit_state` | gauge | `name`, `state` | enum pattern: the current state's series is 1, the other three are 0 |
| `breakwater_circuit_transitions_total` | counter | `name`, `from`, `to` | every breaker state change |

Durations follow the Prometheus convention and are in **seconds**.

One behavior to know: the collector is event-driven, so the `circuit_state`
series **appear on the breaker's first transition**. A circuit that has never
left `closed` exports no state series yet — in queries and dashboards, treat
the absence of an `open` series as healthy, not as missing instrumentation.

Label sets are deliberately low-cardinality: correlation IDs and attempt
numbers never become labels. Unnamed policies report under an empty `name`
label — [name your policies](named-policies.md) and the series come out
identified.

## PromQL you will actually use

```promql
# Failure rate per pipeline, last 5 minutes
sum by (name) (rate(breakwater_executions_total{outcome="failure"}[5m]))
/
sum by (name) (rate(breakwater_executions_total[5m]))

# p95 pipeline duration
histogram_quantile(0.95,
  sum by (le, name) (rate(breakwater_execution_duration_seconds_bucket[5m])))

# Which circuits are open RIGHT NOW
breakwater_circuit_state{state="open"} == 1

# What is rejecting requests, and why
sum by (name, reason) (rate(breakwater_rejections_total[5m]))

# Alert: a circuit is open — fires as long as it stays open. Alert on the
# state gauge, not on increase() of the transitions counter: a counter
# series born by the first-ever transition needs two samples before
# increase() sees anything.
breakwater_circuit_state{state="open"} == 1
```

## Grafana

A ready-to-import dashboard covering the core metrics lives at
[`examples/grafana/breakwater-dashboard.json`](../examples/grafana/breakwater-dashboard.json):
circuit states, execution and failure rates, p50/p95 latency, rejections by
reason and retry/fallback activity, all split by policy `name`.

To see it moving before wiring your own service, the
[`examples/prometheus-grafana`](../examples/prometheus-grafana) demo is one
`docker compose up` away: a breakwater-protected app with a scripted outage
every 90 seconds, Prometheus scraping it, and Grafana provisioned with this
exact dashboard.

## Composing with your own collector

`prometheusCollector()` returns a plain `MetricsCollector`, so anything that
accepts one accepts it: `resilience({ metrics })`, `attachMetrics()` for
hand-built [`compose()`](composition.md) pipelines, or side by side with a
custom collector of your own.

OTel-native stack instead? [`breakwater/otel`](otel.md) emits the same nine
signals as OpenTelemetry instruments — and adds spans.
