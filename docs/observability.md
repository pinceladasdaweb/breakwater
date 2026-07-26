# Observability: events, stats & metrics

A resilience layer you cannot see is a liability: it silently retries, opens
circuits and serves fallbacks — and you find out in a postmortem. breakwater
treats observability as core behavior, not a plugin.

Three complementary surfaces:

1. **Typed events** per policy — push, for logs and alerting
2. **`stats()`** on the circuit breaker — pull, for dashboards and debugging
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
`onExecution` with the total duration and outcome of the whole pipeline:

```ts
const policy = resilience({
  retry: { attempts: 3 },
  circuitBreaker: { name: 'payments-api' },
  timeout: 2_000,
  metrics: collector
})
```

Ready-made `breakwater/prometheus` and `/otel` entry points
implementing this interface are planned — the core will never import
`prom-client` or OpenTelemetry itself.

## Recipe: everything into one logger

```ts
function observe (name: string, policy: RetryPolicy | CircuitBreakerPolicy | TimeoutPolicy | FallbackPolicy, log: Logger): void {
  const anyPolicy = policy as { on: (event: string, fn: (payload: unknown) => void) => unknown }
  for (const event of ['retry', 'giveUp', 'timeout', 'stateChange', 'reject', 'fallback']) {
    try {
      anyPolicy.on(event, (payload) => log.info({ policy: name, event, ...payload as object }))
    } catch { /* policy does not emit this event */ }
  }
}
```

(A first-class `attachMetrics()` helper for manual `compose()` users is
planned.)
