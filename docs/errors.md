# Errors

Every error breakwater throws extends `BreakwaterError` and carries a stable,
machine-readable `code`. **Branch on the code or the type guards — never on
messages** (messages may change in any release; codes never do).

```ts
import {
  isBreakwaterError,
  isTimeoutError,
  isCircuitOpenError,
  isIsolatedError,
  isRetryExhaustedError,
  isFallbackFailedError
} from 'breakwater'
```

## The hierarchy

| Class | `code` | `retryable` | Extra fields |
|---|---|---|---|
| `BreakwaterError` (base) | — | `true` | `code`, `retryable` |
| `TimeoutError` | `TIMEOUT` | `true` | `ms`, `mode`; original error in `cause` when normalized |
| `RetryExhaustedError` | `RETRY_EXHAUSTED` | `true` | `attempts`; last underlying error in `cause` |
| `CircuitOpenError` | `CIRCUIT_OPEN` | **`false`** | `stats` — breaker snapshot at rejection time |
| `IsolatedError` | `CIRCUIT_ISOLATED` | **`false`** | — |
| `BulkheadRejectedError` | `BULKHEAD_REJECTED` | `true` | `stats` — bulkhead snapshot; saturation is transient, so retrying with backoff makes sense |
| `FallbackFailedError` | `FALLBACK_FAILED` | `true` | `originalError` (the operation's error); last handler's error in `cause` |

### The `retryable` flag

Errors that describe a *deliberate fast rejection* declare themselves not
worth retrying at their definition site. The retry policy's default `retryIf`
reads this flag — which is why `retry` and `circuitBreaker` compose correctly
out of the box: the moment the circuit opens, retrying stops.

Your own error classes can opt in to the same convention:

```ts
import { BreakwaterError } from 'breakwater'

class QuotaExceededError extends BreakwaterError {
  constructor () {
    super('Monthly quota exceeded', 'QUOTA_EXCEEDED', { retryable: false })
  }
}
```

### `cause` chains

breakwater uses the native `Error.cause` everywhere, so nothing is lost:

```ts
try {
  await policy.execute(callPayments)
} catch (error) {
  if (isRetryExhaustedError(error)) {
    // error.cause is the LAST real error — e.g. the TimeoutError of attempt 3,
    // whose own .cause may be the fetch AbortError it normalized.
    log.error({ err: error, rootCause: error.cause }, 'payments call failed after retries')
  }
}
```

## Handling patterns

### HTTP boundary

```ts
app.post('/charge', async (req, res) => {
  try {
    res.json(await payments.execute(({ signal }) => chargeCard(req.body, signal)))
  } catch (error) {
    if (isCircuitOpenError(error)) {
      const retryAfter = Math.ceil(((error.stats.nextAttemptAt ?? Date.now()) - Date.now()) / 1000)
      return res.set('Retry-After', String(Math.max(retryAfter, 1))).status(503).json({ error: 'payments unavailable' })
    }
    if (isTimeoutError(error)) return res.status(504).json({ error: 'payments timed out' })
    if (isRetryExhaustedError(error)) return res.status(502).json({ error: 'payments failing' })
    throw error // unknown: let your error middleware own it
  }
})
```

### Branching on `code`

When the error crossed a serialization boundary (worker threads, logs, IPC)
and `instanceof` no longer works:

```ts
switch ((error as { code?: string }).code) {
  case 'CIRCUIT_OPEN':
  case 'CIRCUIT_ISOLATED':
    return scheduleForLater(job)
  case 'TIMEOUT':
  case 'RETRY_EXHAUSTED':
    return deadLetter(job, error)
}
```

## Cancellation is not an error breakwater owns

When you abort via `AbortSignal`, the rejection is **your abort reason** (or
the default `AbortError`), not a breakwater error. Policies step aside on
cancellation: retry does not retry it, the breaker does not count it, fallback
does not replace it, and timeout does not reclassify it.
