# Bulkhead

Limits how many executions run at once. Named after a ship's bulkheads — the
walls that keep one flooded compartment from sinking the whole vessel: a slow
dependency gets a bounded compartment of your process instead of every socket,
handle and event-loop tick you have.

```ts
import { bulkhead } from 'breakwater'

const policy = bulkhead({ concurrency: 20, queue: 50 })

const report = await policy.execute(() => generateHeavyReport(params))
```

## Signature

```ts
bulkhead(options?: BulkheadOptions): BulkheadPolicy
```

| Option | Type | Default | Description |
|---|---|---|---|
| `concurrency` | `number` | `10` | Maximum concurrent executions |
| `queue` | `number` | `0` | Maximum executions waiting for a slot (FIFO). `0` = saturation rejects immediately |
| `name` | `string` | — | Identifies this bulkhead in metrics |

## Semantics

- Below `concurrency`: the call runs immediately.
- At `concurrency` with queue room: the call **waits in FIFO order**; when an
  execution finishes, its slot is handed directly to the first waiter.
- Queue full: the call rejects immediately with
  [`BulkheadRejectedError`](errors.md) (`code: 'BULKHEAD_REJECTED'`) carrying a
  stats snapshot — no waiting, no partial work.
- **Cancellation while queued** frees the queue position for someone else and
  rejects with the abort reason; the function never runs.
- Failures release the slot like successes — a throwing execution cannot leak
  capacity.

Unlike an open circuit, a full bulkhead is usually a *transient* condition —
a burst that will drain in milliseconds. `BulkheadRejectedError` therefore
stays **`retryable: true`**: an outer retry backs off and re-enters, which is
exactly what you want under a burst.

## Where it sits in a composition

`resilience()` places the bulkhead **outside the circuit breaker**:

```
fallback( retry( bulkhead( circuitBreaker( timeout( fn ) ) ) ) )
```

Two reasons:

- **Local saturation is not a dependency failure.** If bulkhead rejections
  flowed through the breaker they would open the circuit — telling callers the
  dependency is down when the truth is *you* are busy.
- **Retry pairs naturally with it**: the (retryable) rejection reaches the
  outer retry, which backs off and tries again once the burst drains.

```ts
const policy = resilience({
  retry: { attempts: 3 },
  bulkhead: { concurrency: 20, queue: 50, name: 'reports' },
  circuitBreaker: { name: 'reports-api' },
  timeout: 5_000
})
```

## Observability

```ts
policy.stats()
// { active: 18, queued: 32, concurrency: 20, queueLimit: 50 }
```

| Event | Payload | When |
|---|---|---|
| `reject` | `{ stats, correlationId }` | Slots and queue full — rejected without executing |

With `resilience({ metrics })`, rejections reach your collector as
`onReject({ policy: 'bulkhead', reason: 'bulkhead_full', name })`.

## Real-world example: protecting the event loop from report bursts

```ts
// Only 2 heavy PDF renders at a time; 20 more may wait; beyond that the
// endpoint answers 429 instead of freezing every other request.
const rendering = bulkhead({ concurrency: 2, queue: 20, name: 'pdf-render' })

app.post('/reports', async (req, res) => {
  try {
    res.json(await rendering.execute(() => renderPdf(req.body)))
  } catch (error) {
    if (isBulkheadRejectedError(error)) {
      return res.status(429).json({ error: 'too many reports in flight', ...error.stats })
    }
    throw error
  }
})
```

## Gotchas

- **A queue is latency in disguise.** Every queued call waits for the ones
  ahead. Size the queue for the burst you accept, and pair with an outer
  `timeout` when queue wait must be bounded.
- **Per-instance, in-memory.** Ten service instances with `concurrency: 20`
  allow 200 concurrent calls overall. A distributed limit belongs to the
  planned Redis-backed tooling.
- **One bulkhead per resource, not per call site.** Sharing an instance is
  the whole point — create it once and reuse it.
