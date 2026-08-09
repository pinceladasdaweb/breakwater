# Retry & backoff

Retries transient failures with a configurable delay strategy, a total time
budget, and full `AbortSignal` support.

```ts
import { retry, exponential } from 'breakwater'

const policy = retry({
  attempts: 4,
  backoff: exponential({ initial: 200, max: 5_000 }),
  retryIf: (error) => error instanceof FetchError && error.status >= 500
})

const data = await policy.execute(({ signal }) => fetch(url, { signal }))
```

## Signature

```ts
retry(options?: RetryOptions): RetryPolicy
```

| Option | Type | Default | Description |
|---|---|---|---|
| `attempts` | `number` | `3` | **Total** executions, including the first. `1` means no retry |
| `deadline` | `number` | — | Time budget in ms for all attempts and delays combined |
| `backoff` | `Backoff` | `exponential()` | Delay strategy between attempts (below) |
| `retryIf` | `(error) => boolean` | retries everything except `retryable: false` errors | Which errors are worth retrying |
| `signal` | `AbortSignal` | — | Factory-level cancellation, combined with the per-call signal |

Semantics worth knowing:

- `attempts: 3` = 1 original call + up to 2 retries.
- The context's `attempt` field is 0-based: your function sees `0`, `1`, `2`…
- **Deadline wins over attempts**: when the *next* delay would exceed the
  deadline, the policy gives up immediately with `RetryExhaustedError` instead
  of sleeping. The deadline does not cut short an attempt already running —
  pair with [`timeout`](timeout.md) to bound individual attempts.
- When every attempt fails, the call rejects with
  [`RetryExhaustedError`](errors.md) (`code: 'RETRY_EXHAUSTED'`) carrying the
  last error as `cause` and the attempt count in `attempts`.
- When `retryIf` returns `false`, the **original error** propagates untouched —
  no envelope.
- **Cancellation stops everything**: abort during a delay rejects with your
  abort reason; abort during an attempt is never retried.

## Backoff strategies

All strategies are pure functions `(attempt: number) => delayMs`, exported and
testable on their own. `attempt` is 1-based (the attempt that just failed).

```ts
import { fixed, linear, exponential } from 'breakwater'

fixed(200)                                        // 200, 200, 200, ...
linear({ initial: 100, increment: 200, max: 2_000 }) // 100, 300, 500, ..., 2000
exponential({ initial: 100, factor: 2, max: 30_000, jitter: 'full' })
```

### `exponential(options?)`

| Option | Default | Description |
|---|---|---|
| `initial` | `100` | Delay before the second attempt, in ms |
| `factor` | `2` | Multiplier applied after each attempt |
| `max` | `30_000` | Upper bound for the computed delay |
| `jitter` | `'full'` | Randomization: `'full'`, `'equal'` or `'none'` |

Jitter matters: when a dependency blips, every client retries at the same
moment and the synchronized wave can knock it down again (*thundering herd*).

- `'full'` (default, AWS-style): uniform in `[0, delay]` — best herd protection.
- `'equal'`: uniform in `[delay/2, delay]` — keeps a minimum wait.
- `'none'`: the exact computed delay — only for tests or when you know better.

## Which errors should be retried?

By default, everything **except** errors that declare themselves not worth
retrying via the `retryable: false` flag on `BreakwaterError` — today that is
`CircuitOpenError` and `IsolatedError`, because retrying against an open
circuit is wasted work. This is what makes `retry` and `circuitBreaker`
compose correctly out of the box (see [composition](composition.md)).

For everything else, tell the policy what is *transient*:

```ts
const policy = retry({
  attempts: 5,
  retryIf: (error) => {
    if (error instanceof pg.DatabaseError) return error.code === '40001' // serialization failure
    if (error instanceof HttpError) return error.status === 429 || error.status >= 500
    return false // 4xx, validation errors, bugs: retrying will not help
  }
})
```

## Events

| Event | Payload | When |
|---|---|---|
| `retry` | `{ attempt, error, delay, correlationId }` | Before sleeping for the next attempt |
| `giveUp` | `{ attempts, error, correlationId }` | No more attempts (count or deadline exhausted) |

```ts
policy.on('retry', ({ attempt, delay, error }) => {
  log.info({ attempt, delay, err: error }, 'retrying')
})
```

## Real-world examples

### Queue consumer (RabbitMQ)

Retry the processing, not the delivery — and only for transient errors, so a
poison message goes straight to the DLQ instead of being retried forever:

```ts
const processing = retry({
  attempts: 3,
  backoff: exponential({ initial: 500 }),
  retryIf: (e) => !(e instanceof ValidationError)
})

channel.consume('orders', (msg) => {
  processing.execute(() => handleOrder(JSON.parse(msg.content.toString())))
    .then(() => channel.ack(msg))
    .catch(() => channel.nack(msg, false, false)) // exhausted or poison → DLQ
})
```

### Graceful shutdown

```ts
const shutdown = new AbortController()
process.on('SIGTERM', () => shutdown.abort(new Error('shutting down')))

const policy = retry({ attempts: 10, backoff: exponential(), signal: shutdown.signal })
// SIGTERM cancels pending delays immediately; in-flight work is not retried
```

## Migrating from a hand-rolled retry

Two differences tend to surprise code that previously rolled its own loop:

**1. Exhaustion throws an envelope, not the last error.** A typical
hand-rolled loop rethrows the last failure; breakwater throws
[`RetryExhaustedError`](errors.md) with the last error in `cause`. If your
callers branch on the original error type, unwrap at the boundary:

```ts
import { isRetryExhaustedError } from 'breakwater'

try {
  return await policy.execute(operation)
} catch (error) {
  // Callers keep receiving the last real error, as before the migration.
  throw isRetryExhaustedError(error) ? error.cause : error
}
```

**2. Delays are jittered by default.** Hand-rolled loops usually compute
exact exponential delays; breakwater's default backoff applies full jitter
(a good thing in production — see above). For delay-for-delay parity during
a migration, use `exponential({ initial, jitter: 'none' })`, then consider
turning jitter back on once the behavior is validated.

## Gotchas

- **Retry without a budget is a latency bug**: 5 attempts with exponential
  backoff can take minutes. Use `deadline`, or compose with `timeout` per
  attempt, or both.
- **Retry is for transient failures.** Retrying a `400 Bad Request` five times
  produces five identical failures, slower. Write a `retryIf`.
- **Idempotency**: a timeout does not mean the operation did not happen. Only
  retry writes that are idempotent (or carry an idempotency key).
- **Delays are clamped to setTimeout's ceiling (2³¹−1 ms ≈ 24.8 days)** —
  past it, the platform would fire after ~1ms, inverting your largest
  backoffs into your fastest retries. A custom backoff returning `NaN`,
  `Infinity` or a negative delay throws a `RangeError` instead of looping hot.
- **`ctx.metadata` is one shared object across attempts** — deliberately, so
  attempts can accumulate context. Do not treat it as per-attempt state.
