# Rate limit

Caps how *fast* executions happen. Where the [bulkhead](bulkhead.md) bounds
how many run *at once*, the rate limit bounds how many run *per interval* —
the client-side answer to "this API allows 100 requests per minute".

```ts
import { rateLimit } from 'breakwater'

const policy = rateLimit({ limit: 100, interval: 60_000 })

const data = await policy.execute(() => api.get('/search', params))
```

## Signature

```ts
rateLimit(options: RateLimitOptions): RateLimitPolicy
```

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | — (required) | Executions allowed per `interval` |
| `interval` | `number` | — (required) | The interval, in milliseconds |
| `strategy` | `'token-bucket' \| 'sliding-window'` | `'token-bucket'` | Admission strategy (below) |
| `burst` | `number` | `limit` | Token bucket only: bucket capacity |
| `name` | `string` | — | Identifies this rate limit in metrics |

Beyond the quota, calls reject **immediately** with
[`RateLimitedError`](errors.md) (`code: 'RATE_LIMITED'`) carrying
`retryAfterMs` — exactly how long until an execution would be admitted again.
The error stays **`retryable: true`**: the quota replenishes on its own.

## The two strategies

### `token-bucket` (default) — smooth rate, absorbs bursts

Tokens refill continuously at `limit / interval`; each execution spends one.
The bucket holds up to `burst` tokens, so a quiet period buys you a burst —
but never more than the bucket:

```ts
// 10/s sustained; bursts of up to 50 after quiet periods.
const policy = rateLimit({ limit: 10, interval: 1_000, burst: 50 })
```

Pick it for: client-side throttling of outbound calls, where short bursts are
fine and the *average* rate is what matters.

### `sliding-window` — a hard ceiling, exact

Never more than `limit` executions in **any** window of `interval` ms —
implemented as an exact sliding log over a fixed ring (O(1) admission,
O(limit) memory). The window is half-open: an admission exactly `interval`
old no longer counts, so a server doing closed-interval accounting could
still see `limit + 1` across that single boundary instant. No burst
allowance beyond the window:

```ts
// A partner API cuts you off at 100 calls per minute, no forgiveness.
const policy = rateLimit({ limit: 100, interval: 60_000, strategy: 'sliding-window' })
```

Pick it for: matching a dependency's *enforced* quota where crossing the line
has consequences (429s, bans, billing).

## Where it sits in a composition

`resilience()` places the rate limit **outermost among the guards** — the
quota check is the cheapest rejection, so it runs before a bulkhead slot is
even considered:

```
fallback( retry( rateLimit( bulkhead( circuitBreaker( timeout( fn ) ) ) ) ) )
```

```ts
const policy = resilience({
  retry: { attempts: 3, backoff: exponential({ initial: 500 }) },
  rateLimit: { limit: 100, interval: 60_000, name: 'partner-quota' },
  circuitBreaker: { name: 'partner-api' },
  timeout: 2_000
})
```

The retry above it backs off through `RateLimitedError` like any transient
failure. For precision, `error.retryAfterMs` tells you the exact wait — a
custom backoff can use it.

## Observability

```ts
policy.stats()
// { remaining: 37, limit: 100, interval: 60000, strategy: 'token-bucket' }
```

| Event | Payload | When |
|---|---|---|
| `reject` | `{ stats, retryAfterMs, correlationId }` | Quota exhausted — rejected without executing |

With `resilience({ metrics })`, rejections reach your collector as
`onReject({ policy: 'rateLimit', reason: 'rate_limited', name })`.

## Real-world example: honoring a partner's quota with Retry-After

```ts
const partnerQuota = rateLimit({ limit: 100, interval: 60_000, strategy: 'sliding-window', name: 'partner' })

app.get('/quotes', async (req, res) => {
  try {
    res.json(await partnerQuota.execute(() => partnerApi.quotes(req.query)))
  } catch (error) {
    if (isRateLimitedError(error)) {
      return res
        .set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)))
        .status(429)
        .json({ error: 'quota exhausted' })
    }
    throw error
  }
})
```

## Gotchas

- **Rejections do not consume quota** — a storm of rejected calls does not
  push your next admission further away.
- **Failures do consume it** — the call was made; the dependency saw it.
- **Per-instance, in-memory.** Ten service instances each allowing 100/min
  add up to 1000/min against the dependency. Divide the quota by your
  instance count, or share the quota with
  [`redisRateLimit`](redis.md#sharing-the-rate-limit-too).
- **Rate limit ≠ bulkhead.** 100/min says nothing about concurrency: one
  slow endpoint can still pile up 100 concurrent calls. Use both when both
  dimensions matter.
- **Wall-clock steps backwards are clamped**: time stands still for the
  limiter until the clock catches up. A backstep never mints quota, never
  freezes admissions — and `retryAfterMs` is always sufficient to wait:
  sleeping exactly that long is guaranteed to be admitted.
