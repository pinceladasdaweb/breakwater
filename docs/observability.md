# Observability: events, stats & metrics

A resilience layer you cannot see is a liability: it silently retries, opens
circuits and serves fallbacks — and you find out in a postmortem. breakwater
treats observability as core behavior, not a plugin.

Three complementary surfaces:

1. **Typed events** per policy — push, for logs and alerting
2. **`stats()`** on stateful policies and compositions — pull, for dashboards and debugging
3. **`MetricsCollector`** — one interface for your metrics pipeline

## Typed events

Every policy exposes `on`/`off` with payloads typed per event — your IDE
autocompletes the payload fields:

```ts
const policy = retry({ attempts: 5 })

policy
  .on('retry', ({ attempt, delay, error, correlationId }) => {
    log.info({ attempt, delay, err: error, correlationId }, 'retrying')
  })
  .on('giveUp', ({ attempts, error, correlationId }) => {
    log.error({ attempts, err: error, correlationId }, 'retry exhausted')
  })
```

The full event catalog:

| Policy | Event | Payload |
|---|---|---|
| retry | `retry` | `{ attempt, error, delay, correlationId }` |
| retry | `giveUp` | `{ attempts, error, correlationId }` |
| timeout | `timeout` | `{ ms, mode, correlationId }` |
| circuit breaker | `stateChange` | `{ from, to, stats, correlationId? }` |
| circuit breaker | `open` / `close` / `halfOpen` | `{ stats, correlationId? }` |
| circuit breaker | `reject` | `{ reason, correlationId }` |
| circuit breaker | `success` / `failure` | `{ durationMs, correlationId }` (+ `error` on failure) |
| bulkhead | `reject` | `{ stats, correlationId }` |
| rate limit | `reject` | `{ stats, retryAfterMs, correlationId }` |
| fallback | `fallback` | `{ error, handlerIndex, correlationId }` |

Guarantees:

- **A listener that throws never breaks the pipeline** — the error is reported
  to `console.error` and the execution continues unaffected.
- **The same `correlationId` appears in every event of one execution**, across
  all policies in a composition. Pass your request id in and every log line
  correlates:

```ts
await policy.execute(fn, { correlationId: req.id })
```

- Events fire on the policy that owns them. Compositions do not re-emit —
  subscribe on the policies you composed (or use `metrics`, below, which does
  the wiring for you).

## `stats()` — the pull side

```ts
const breaker = circuitBreaker({ name: 'payments-api' })

breaker.state    // 'closed' | 'open' | 'half-open' | 'isolated'
breaker.stats()
// {
//   state: 'open',
//   successes: 3, failures: 17, totalCalls: 20, failureRate: 0.85,
//   latency: { count: 20, min: 12, max: 3004, mean: 891, p50: 210, p95: 3001, p99: 3004 },
//   lastError: FetchError('ECONNREFUSED'),
//   openedAt: 1783206000000,
//   nextAttemptAt: 1783206030000
// }
```

Expose it on your health endpoint and half of your incident triage is done:

```ts
app.get('/health/circuits', (_req, res) => {
  const circuits = [...breakers.values()].map((breaker) => breaker.stats())
  const healthy = circuits.every((c) => c.state === 'closed')
  res.status(healthy ? 200 : 503).json(circuits)
})
```

## `MetricsCollector` — one interface for your pipeline

Implement only what you care about; every method is optional:

```ts
import type { MetricsCollector } from 'breakwater'

const collector: MetricsCollector = {
  onExecution ({ policy, name, outcome, durationMs }) {
    executionHistogram.labels(name ?? 'default', outcome).observe(durationMs)
  },
  onRetry ({ name, attempt }) { retryCounter.labels(name ?? 'default').inc() },
  onTimeout ({ name }) { timeoutCounter.labels(name ?? 'default').inc() },
  onStateChange ({ name, from, to }) { circuitState.labels(name ?? 'default').set(to === 'open' ? 1 : 0) },
  onFallback ({ name }) { fallbackCounter.labels(name ?? 'default').inc() },
  onReject ({ name, reason }) { rejectCounter.labels(name ?? 'default', reason).inc() }
}
```

Plug it into `resilience()` and every policy is wired at once — including
`onExecution` with the total duration and outcome of the whole pipeline.
Tip: with [named policies](named-policies.md) the registry name flows into
every metric automatically, so you never hand-wire `name` per policy:

```ts
const policy = resilience({
  retry: { attempts: 3 },
  circuitBreaker: { name: 'payments-api' },
  timeout: 2_000,
  metrics: collector
})
```

Don't want to write one? [`breakwater/prometheus`](prometheus.md) is a
ready-made implementation backed by prom-client. An OpenTelemetry entry point
is planned. Either way the core never imports `prom-client` or OpenTelemetry
itself — the adapters live behind their own entry points, with their client
libraries as optional peer dependencies.

## Manual pipelines: `attachMetrics()` and `metricsPolicy()`

Building with `compose()` instead of `resilience()`? The same wiring is one
call — `attachMetrics` walks the composition, discovers each policy by its
`kind` and subscribes the right events:

```ts
import { attachMetrics, metricsPolicy, compose, fallback, retry, circuitBreaker, timeout } from 'breakwater'

const pipeline = compose(
  metricsPolicy(collector, { name: 'payments-api' }), // outermost: onExecution with total duration
  fallback(stale),
  retry({ attempts: 3 }),
  circuitBreaker({ name: 'payments-api' }),
  timeout(2_000)
)

const detach = attachMetrics(pipeline, collector, { name: 'payments-api' })
// ...later, if the pipeline is short-lived:
detach()
```

- `attachMetrics` accepts a single policy, an array, or a whole composition,
  and returns a detach function that unsubscribes everything (idempotent).
- `onExecution` is not an event — it measures the pipeline as a whole, so it
  lives in `metricsPolicy()`, a regular policy you place outermost. Its
  `label` option (default `'pipeline'`; `resilience()` uses `'resilience'`)
  arrives as the `policy` field of `onExecution`, and a collector that
  throws is reported and ignored — monitoring never changes an outcome.
- What gets wired, by `kind`: `retry` → `onRetry`; `timeout` → `onTimeout`;
  `circuitBreaker` → `onStateChange` + `onReject`; `bulkhead` and
  `rateLimit` → `onReject`; `fallback` → `onFallback`. Compositions are
  recursed into; unknown kinds are skipped harmlessly — custom policies
  participate by declaring a matching `kind` and emitting those events.
- Two footguns: attaching the same collector twice duplicates events, and a
  `resilience({ metrics })` result is **already wired** — don't attach the
  same collector to it again.

## Aggregated `stats()` on compositions

Every `compose()` (and `resilience()`) result exposes the snapshots of its
inner policies — one entry per policy that has a `stats()`, nested
compositions flattened:

```ts
const pipeline = resilience({
  rateLimit: { limit: 100, interval: 60_000 },
  circuitBreaker: { name: 'payments-api' },
  timeout: 2_000
})

pipeline.stats()
// [
//   { kind: 'rateLimit',      stats: { remaining: 37, limit: 100, ... } },
//   { kind: 'circuitBreaker', stats: { state: 'closed', failureRate: 0, ... } }
// ]
```

Combined with [named policies](named-policies.md), a health endpoint over
every pipeline in the app is a few lines:

```ts
app.get('/health/policies', (_req, res) => {
  res.json(Object.fromEntries(policies.names().map((name) => {
    // Entries built from resilience() options always expose stats();
    // the fallback only fires for prebuilt custom policies without one.
    const policy = policies.get(name) as Policy & { stats?: () => unknown }
    return [name, policy.stats?.() ?? 'no stats']
  })))
})
```
