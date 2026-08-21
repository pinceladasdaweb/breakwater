# breakwater

> **Resilience toolkit for Node.js** — retry, circuit breaker, timeout, fallback, and policy composition with first-class observability.

[![CI](https://github.com/pinceladasdaweb/breakwater/actions/workflows/ci.yml/badge.svg)](https://github.com/pinceladasdaweb/breakwater/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/breakwater.svg)](https://www.npmjs.com/package/breakwater)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

When waves of failure hit, the breakwater keeps your service standing. It brings the design of [resilience4j](https://resilience4j.readme.io/) (Java) and [Polly](https://github.com/App-vNext/Polly) (.NET) to Node.js: composable resilience policies with explicit ordering, typed events, and metrics — no third-party plugins required.

```ts
import { resilience, exponential } from 'breakwater'

const payments = resilience({
  retry: { attempts: 3, backoff: exponential({ initial: 200 }) },
  circuitBreaker: { name: 'payments-api', failureThreshold: 0.5 },
  timeout: 2_000,
  fallback: () => ({ status: 'pending', queued: true })
})

const charge = await payments.execute(({ signal }) => api.post('/charge', body, { signal }))
```

## Table of contents

- [Why another resilience library?](#why-another-resilience-library)
- [Install](#install)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [The policies](#the-policies)
- [Composing policies](#composing-policies)
- [Observability](#observability)
- [Errors](#errors)
- [Documentation](#documentation)
- [Requirements](#requirements)

## Why another resilience library?

| | breakwater | [opossum](https://github.com/nodeshift/opossum) | [cockatiel](https://github.com/connor4312/cockatiel) |
|---|---|---|---|
| Circuit breaker | ✅ | ✅ | ✅ |
| Retry with backoff strategies | ✅ | ➖ rudimentary | ✅ |
| Timeout / fallback | ✅ | ➖ fallback only | ✅ |
| Bulkhead | ✅ | ❌ | ✅ |
| Rate limiter (token bucket / sliding window) | ✅ | ❌ | ❌ |
| Stale-while-open cache (last good response) | ✅ [`staleCache`](docs/stale-cache.md) | ❌ | ❌ |
| Policy composition with explicit ordering | ✅ first-class | ❌ | ✅ |
| Named policy registry (central config) | ✅ | ❌ | ❌ |
| Typed events + pluggable metrics collector | ✅ native | ➖ via plugin | ❌ |
| Prometheus / OpenTelemetry adapters | ✅ [`/prometheus`](docs/prometheus.md) · [`/otel`](docs/otel.md) | ➖ via plugin | ❌ |
| Distributed circuit breaker state (Redis) | ✅ [`/redis`](docs/redis.md) | ❌ | ❌ |
| TypeScript | ✅ native | ➖ via `@types` | ✅ native |
| Runtime dependencies | **0** | 0 | 0 |

Design principles:

- **TypeScript first** — strict types, no `@types` package
- **Zero dependencies in the core** — integrations ship as optional entry points (Prometheus, OpenTelemetry and Redis)
- **Declarative composition** — policies combine into pipelines with explicit, documented ordering
- **Native observability** — typed events and a pluggable `MetricsCollector` in the core

## Install

```bash
npm install breakwater
```

Works with both module systems:

```ts
import { retry, timeout, circuitBreaker } from 'breakwater' // ESM
const { retry, timeout, circuitBreaker } = require('breakwater') // CJS
```

## Quick start

Protect a flaky HTTP call in three lines:

```ts
import { retry } from 'breakwater'

const policy = retry({ attempts: 3 })
const user = await policy.execute(() => fetchUser(id))
```

Add a time budget and a circuit breaker, composed in an explicit order:

```ts
import { compose, retry, circuitBreaker, timeout } from 'breakwater'

const policy = compose(
  retry({ attempts: 3 }),                      // outermost
  circuitBreaker({ name: 'user-service' }),
  timeout(2_000)                               // innermost, hugs the function
)

const user = await policy.execute(({ signal }) => fetchUser(id, { signal }))
```

Or let `resilience()` pick the battle-tested default order for you:

```ts
import { resilience } from 'breakwater'

const policy = resilience({
  retry: { attempts: 3 },
  circuitBreaker: { name: 'user-service' },
  timeout: 2_000,
  fallback: cachedUser
})
```

## Core concepts

### Every policy speaks the same contract

A policy — and the result of composing policies — is an object with:

```ts
policy.execute(fn, options?)  // run fn under the policy's protection
policy.wrap(fn)               // decorate: same signature in, protected function out
policy.invoke(fn, ctx)        // composition primitive (used by compose())
```

Two everyday shapes:

```ts
// 1. execute — fn receives the execution context (with the combined signal)
const data = await policy.execute(({ signal }) => fetch(url, { signal }))

// 2. wrap — decorate once, call everywhere
const safeFetchUser = policy.wrap(fetchUser)
const user = await safeFetchUser(id)
```

> `wrap` keeps the function signature untouched, so the wrapped function does not
> receive the context. Use `execute` when you need the inner signal. Also note
> `this` is not forwarded — bind methods first: `policy.wrap(svc.method.bind(svc))`.

### The execution context

One context travels through the whole pipeline:

```ts
interface ExecutionContext {
  signal: AbortSignal    // external cancellation + timeouts, combined into ONE signal
  attempt: number        // 0 on the first execution; incremented by retry
  correlationId: string  // generated if not provided; present in every event payload
  metadata: Record<string, unknown>  // yours, crosses every policy
}
```

Your function only ever needs to observe **one** `AbortSignal` — the policies
combine external cancellation, timeouts and retry cancellation into it:

```ts
await policy.execute(
  ({ signal }) => fetch(url, { signal }),
  { signal: request.signal, correlationId: request.id }
)
```

### Cancellation is not failure

Aborting via `AbortSignal` is treated as *cancellation* everywhere: retry does not
retry it, the circuit breaker does not count it, and fallback does not replace it.
The abort reason propagates to the caller untouched.

## The policies

| Policy | One-liner | Docs |
|---|---|---|
| [`timeout(ms, options?)`](docs/timeout.md) | Bound the time of each execution, cooperatively or aggressively | [docs/timeout.md](docs/timeout.md) |
| [`retry(options?)`](docs/retry.md) | Retry transient failures with configurable backoff and a total deadline | [docs/retry.md](docs/retry.md) |
| [`circuitBreaker(options?)`](docs/circuit-breaker.md) | Fail fast while a dependency is down; probe and recover automatically | [docs/circuit-breaker.md](docs/circuit-breaker.md) |
| [`bulkhead(options?)`](docs/bulkhead.md) | Bound concurrent executions, with an optional FIFO wait queue | [docs/bulkhead.md](docs/bulkhead.md) |
| [`rateLimit(options)`](docs/rate-limit.md) | Cap the execution rate — token bucket or exact sliding window | [docs/rate-limit.md](docs/rate-limit.md) |
| [`fallback(handler, options?)`](docs/fallback.md) | Replace a failure with a value, a function result, or a chain of them | [docs/fallback.md](docs/fallback.md) |
| [`staleCache(options?)`](docs/stale-cache.md) | Serve the last good response while the circuit is open | [docs/stale-cache.md](docs/stale-cache.md) |
| [`compose(...policies)`](docs/composition.md) | Combine policies with explicit ordering; compositions compose again | [docs/composition.md](docs/composition.md) |
| [`resilience(options)`](docs/composition.md#resilience-the-batteries-included-order) | The batteries-included pipeline with a sane default order | [docs/composition.md](docs/composition.md) |

## Composing policies

`compose(a, b, c)` runs exactly like the nested calls `a(b(c(fn)))` — the first
policy is the outermost. **Order changes behavior**: retry outside the circuit
breaker behaves very differently from retry inside it. This is the part most
libraries leave undocumented; we document it with diagrams in
[docs/composition.md](docs/composition.md).

The default order used by `resilience()`:

```
fallback( retry( rateLimit( bulkhead( circuitBreaker( timeout( fn ) ) ) ) ) )
```

Every attempt flows through the breaker (feeding its stats individually), and once
the circuit opens, retry sees `CircuitOpenError` — which is not retryable — and
gives up immediately instead of hammering an open circuit.

## Named policies

Define your resilience configuration once, at startup; ask for policies by
name everywhere else — same name, same instance, genuinely shared state:

```ts
import { policies } from 'breakwater'

// config/resilience.ts
policies.define('payments-api', {
  retry: { attempts: 3 },
  circuitBreaker: { failureThreshold: 0.5 },
  timeout: 2_000
})

// anywhere else
await policies.get('payments-api').execute(({ signal }) => api.post('/charge', body, { signal }))
```

Typos fail fast (`get` throws listing the defined names), duplicates throw,
and the registry name flows into metrics automatically. See
[docs/named-policies.md](docs/named-policies.md).

## Observability

Every policy emits **typed events** — no plugin required:

```ts
const breaker = circuitBreaker({ name: 'payments-api' })

breaker
  .on('stateChange', ({ from, to, stats }) => log.warn({ from, to, stats }, 'circuit state changed'))
  .on('reject', ({ correlationId }) => log.debug({ correlationId }, 'request rejected fast'))

breaker.stats()
// { state, successes, failures, totalCalls, failureRate, latency, lastError, openedAt, nextAttemptAt }
// latency: { count, min, max, mean, p50, p95, p99 } over the same window
```

For metrics pipelines, implement the `MetricsCollector` interface once and plug it
into `resilience()` — it wires every policy for you:

```ts
const policy = resilience({
  retry: { attempts: 3 },
  circuitBreaker: { name: 'payments-api' },
  timeout: 2_000,
  metrics: myCollector // onExecution, onRetry, onTimeout, onStateChange, onFallback, onReject
})
```

Building with `compose()` instead? `attachMetrics(pipeline, collector)` wires
a whole composition in one call, and `metricsPolicy(collector)` measures the
pipeline as a regular outermost policy. Compositions also expose an
aggregated `stats()` of their inner policies.

Don't want to write a collector? Two ready-made adapters ship as optional
entry points. **`breakwater/prometheus`** emits prom-client metrics —
executions, durations, rejections and circuit states — plus a Grafana
dashboard to import:

```ts
import { prometheusCollector } from 'breakwater/prometheus' // prom-client is a peer dependency

const policy = resilience({ name: 'payments-api', metrics: prometheusCollector() })
```

**`breakwater/otel`** emits the same signals as OpenTelemetry metrics, and
adds `spanPolicy()` — a composable policy that wraps each execution in an
active span, so instrumented HTTP clients and database drivers nest under it
in the trace:

```ts
import { otelCollector, spanPolicy } from 'breakwater/otel' // @opentelemetry/api is a peer dependency

const policy = resilience({ name: 'payments-api', metrics: otelCollector() })
```

See [docs/prometheus.md](docs/prometheus.md) and [docs/otel.md](docs/otel.md).

## Errors

Every error breakwater throws extends `BreakwaterError` and carries a stable
`code` — branch on the code or the type guards, never on messages:

| Error | `code` | Thrown by |
|---|---|---|
| `TimeoutError` | `TIMEOUT` | timeout |
| `RetryExhaustedError` | `RETRY_EXHAUSTED` | retry (last error in `cause`) |
| `CircuitOpenError` | `CIRCUIT_OPEN` | circuit breaker (carries `stats`) |
| `IsolatedError` | `CIRCUIT_ISOLATED` | circuit breaker (manual isolation) |
| `BulkheadRejectedError` | `BULKHEAD_REJECTED` | bulkhead (carries `stats`; stays retryable) |
| `RateLimitedError` | `RATE_LIMITED` | rate limit (carries `stats` and `retryAfterMs`; stays retryable) |
| `FallbackFailedError` | `FALLBACK_FAILED` | fallback (operation error in `originalError`) |

```ts
import { isCircuitOpenError, isTimeoutError } from 'breakwater'

try {
  await policy.execute(chargeCard)
} catch (error) {
  if (isCircuitOpenError(error)) return res.status(503).json({ retryAfter: error.stats.nextAttemptAt })
  if (isTimeoutError(error)) return res.status(504).end()
  throw error
}
```

See [docs/errors.md](docs/errors.md).

## Documentation

- [Timeout](docs/timeout.md)
- [Retry & backoff](docs/retry.md)
- [Circuit breaker](docs/circuit-breaker.md)
- [Bulkhead](docs/bulkhead.md)
- [Rate limit](docs/rate-limit.md)
- [Fallback](docs/fallback.md)
- [Stale cache (stale-while-open)](docs/stale-cache.md)
- [Composition & ordering](docs/composition.md) — read this one; ordering is where resilience goes right or wrong
- [Named policies](docs/named-policies.md)
- [Observability: events, stats & metrics](docs/observability.md)
- [Prometheus adapter](docs/prometheus.md) — ready-made prom-client collectors + a Grafana dashboard
- [OpenTelemetry adapter](docs/otel.md) — OTel metrics + spans as a composable policy
- [Redis: distributed state](docs/redis.md) — one circuit, and one rate limit quota, shared across every instance
- [Errors](docs/errors.md)
- [Versioning policy](docs/versioning.md) — what the semver promise covers, and what it deliberately does not

## Requirements

- Node.js >= 22

## License

[MIT](LICENSE)
