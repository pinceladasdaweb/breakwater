# breakwater + OpenTelemetry: traces in Jaeger, metrics in Prometheus

A runnable demo of [`breakwater/otel`](../../docs/otel.md): a service protected
by a breakwater pipeline, exporting **spans** to Jaeger over OTLP and
**metrics** to Prometheus — with a scripted outage every 90 seconds so both
tell a story without you touching anything.

```bash
docker compose up --build
```

| Where | What |
|---|---|
| http://localhost:16686 | Jaeger — pick the `breakwater-demo` service and find traces |
| http://localhost:9090 | Prometheus — query the `breakwater_*` series |
| http://localhost:8080 | the app's aggregated `stats()` as JSON |
| http://localhost:9464/metrics | the raw OTel metrics endpoint Prometheus scrapes |

## The trace story

Each checkout produces one trace with three levels, straight from the
pipeline's composition order:

```
checkout pipeline            ← spanPolicy, outermost: the whole execution
└─ checkout attempt (0..n)   ← spanPolicy INSIDE the retry: one span per attempt
   └─ charge downstream      ← the app's own span, nested automatically
```

During the outage (20 s out of every 90) the interesting traces appear:
attempt spans turn red one by one as the timeout converts a hung dependency
into countable failures, the circuit opens (attempts start failing fast with
`CircuitOpenError`), and the **pipeline span stays green** — the fallback
answered, and that is exactly the story the trace tells: degraded, not down.

Worth noticing in Jaeger:

- The `breakwater.attempt` attribute on attempt spans (0, 1, 2...) and the
  shared `breakwater.correlation_id` tying a trace to breakwater's own events.
- Fast-fail attempts while the circuit is open: microseconds instead of the
  500 ms timeout — that is the breaker doing its job.
- After ~15 s of open circuit, a lone half-open probe attempt, then recovery.

## The metrics story

Same eight signals as the [Prometheus adapter](../../docs/prometheus.md),
exported through the OTel pipeline — the exporter renders them as
`breakwater_executions_total`, `breakwater_execution_duration_bucket` and
friends, with the namespaced attributes sanitized into labels
(`breakwater_name`). Try:

```promql
# Failure rate per pipeline
sum by (breakwater_name) (rate(breakwater_executions_total{breakwater_outcome="failure"}[1m]))

# Which circuits are open right now
breakwater_circuit_state{breakwater_state="open"} == 1

# Rejections by reason (the partner-quota pipeline keeps rate_limited moving)
sum by (breakwater_name, breakwater_reason) (rate(breakwater_rejections_total[1m]))
```

## How the app is wired

The one ordering rule of the OTel metrics API, visible in
[`app/server.mjs`](app/server.mjs): `sdk.start()` runs **before**
`otelCollector()` — the metrics API has no late-binding proxy, so a collector
created earlier would be no-op forever. Spans do not have this problem.

Prefer dashboards over raw PromQL? The
[prometheus-grafana example](../prometheus-grafana) ships a provisioned
Grafana with the same signals on panels.
