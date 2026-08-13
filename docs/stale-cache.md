# Stale cache (stale-while-open)

Remembers the last good response and serves it when the pipeline cannot
produce a fresh one — by default, while the circuit breaker is **open**.
Your dependency is down, the breaker is failing fast, and your users see
slightly old data instead of an error page: degraded, not down.

```ts
import { compose, circuitBreaker, staleCache, timeout } from 'breakwater'

const catalog = compose(
  staleCache(),                                    // outside the breaker
  circuitBreaker({ name: 'catalog-api', consecutiveFailures: 5 }),
  timeout(2_000)
)

// While catalog-api is healthy: fresh answers, each one cached.
// While the circuit is open: the last good answer, served instantly.
const products = await catalog.execute(({ signal }) => api.get('/products', { signal }))
```

Every execution still runs — this is **not** a read-through cache and never
short-circuits a healthy call. It only changes what happens when the call
fails: instead of the error, you get the last value that succeeded.

## Signature

```ts
staleCache<T>(options?: StaleCacheOptions<T>): StaleCachePolicy
```

| Option | Type | Default | Description |
|---|---|---|---|
| `staleIf` | `(error) => boolean` | circuit rejections only | Which failures are rescued (below) |
| `key` | `(ctx) => string` | single shared slot | Splits the cache by execution context (below) |
| `maxAge` | `number` | unbounded | Entries older than this (ms) are never served |
| `store` | `CacheStore` | in-memory | Pluggable storage (below) |

The policy also exposes `clear()`, which drops every cached value.

## What gets rescued

By default, only **fast rejections from an open or isolated circuit** —
`CircuitOpenError` and `IsolatedError`. That is the literal
stale-while-open: while the breaker does its job, the cache does yours.
Every other failure propagates untouched.

To serve stale on *any* failure, widen the predicate:

```ts
staleCache({ staleIf: () => true })                       // any error
staleCache({ staleIf: (e) => isTimeoutError(e) || isCircuitOpenError(e) })
```

Three things never activate a rescue:

- **Cancellation** — the caller aborting is not the dependency failing.
- **Errors your `staleIf` rejects** — they propagate; no event is emitted.
- **Entries older than `maxAge`** — a too-old answer can be worse than an
  error; you decide where that line is. There is no default bound: by
  opting into stale you declared that an old answer beats no answer.

## One slot or many: `key`

The default is a single slot — the policy remembers exactly one last good
response. That fits the one-policy-per-endpoint layout, where the protected
call is always "the same question".

When one policy multiplexes several questions, derive a key from the
execution's [`metadata`](observability.md):

```ts
const products = staleCache({ key: (ctx) => String(ctx.metadata.productId) })

await products.execute(fetchProduct, { metadata: { productId: '42' } })
```

Keys are plain strings, and the in-memory store caps how many it keeps
(1024 by default, least-recently-written evicted first):

```ts
staleCache({ key: byProduct, store: memoryCache({ maxEntries: 10_000 }) })
```

## Placement in a composition

Outside the breaker — the rescue must see `CircuitOpenError` — and outside
the retry, so a stale answer only goes out once retrying has given up.
Inside the fallback: the rescue is the more specific answer, the fallback is
the last resort for when there is nothing cached yet.

```
fallback( staleCache( retry( circuitBreaker( timeout( fn )))))
```

`resilience()` wires exactly that order:

```ts
const payments = resilience({
  name: 'payments-api',
  staleCache: {},                     // the defaults; any StaleCacheOptions
  retry: { attempts: 3 },
  circuitBreaker: { consecutiveFailures: 5 },
  timeout: 2_000,
  fallback: () => ({ degraded: true }) // cold start: nothing cached yet
})
```

## Events and metrics

| Event | Payload | When |
|---|---|---|
| `stale` | `{ key, ageMs, error, correlationId }` | A failure was rescued with a cached value |
| `miss` | `{ key, error, correlationId }` | A failure qualified but nothing servable was cached |

`attachMetrics()` (and `resilience({ metrics })`) forward rescues to the
collector's `onStale`; the [Prometheus](prometheus.md) and [OTel](otel.md)
adapters count them as `breakwater_stale_rescues_total` /
`breakwater.stale.rescues`. A climbing stale rate with a healthy-looking
error rate is the signature of this policy doing its job — surface it on
the dashboard next to the circuit state.

## Pluggable storage: `CacheStore`

The cache lives behind an interface so the storage can be swapped — the
same shape that will let a shared store serve one cache to N instances
(planned):

```ts
interface CacheStore<T = unknown> {
  get(key: string): CacheEntry<T> | undefined | Promise<CacheEntry<T> | undefined>
  set(key: string, entry: CacheEntry<T>, hints?: CacheSetHints): void | Promise<void>
  delete?(key: string): void | Promise<void>
  clear?(): void | Promise<void>
}
```

Every method may be sync or async. `set` receives the policy's `maxAge` as
an advisory hint (`hints.maxAgeMs`) when it is bounded — a remote store can
turn it into a native expiry; `memoryCache` ignores it, since the policy
already enforces `maxAge` on the read side.

Two rules for stores beyond `memoryCache`:

- **Values crossing a process boundary must be plain serializable data.**
  A Date, a Map or a class instance will not survive the round trip — the
  by-reference behavior described in the gotchas is specific to memory
  storage.
- **A store shared between different policies needs disjoint keys** (a
  per-policy prefix, configured on the store adapter). The default key is
  `''`, so two policies on one bare store would silently serve each
  other's responses.

Errors are contained by role: a store (or `key` extractor) that throws is
reported to `console.error` and contained — while storing, the success
stands; while rescuing, the **original** error propagates. A broken cache
can cost the rescue, never the outcome. Only `clear()`, a manual control
call, lets store errors reach the caller (and a store without `clear()`
makes the policy's `clear()` a no-op).

## Gotchas

- **Values are cached and served by reference.** Two rescued callers get
  the same object. Cache what you are happy to share, or clone before
  returning it.
- **Cold starts have nothing to serve.** The first failure before any
  success propagates (with a `miss` event when it qualified for rescue) —
  pair with a [fallback](fallback.md) for a static answer on that path.
- **`maxAge` uses the wall clock.** A backwards clock jump clamps ages to
  zero rather than expiring everything.
- **The cache is per policy instance** (with the default store). Two
  `staleCache()` policies do not share entries unless you hand them the
  same `store` — and if you do, give them disjoint keys: with the default
  single slot they would silently serve each other's responses.
- **The type parameter is advisory.** Like the fallback's, it types the
  store and documents intent, but the compiler cannot connect cached
  values to each `execute<T>()` call — one policy instance serves one
  response shape, and you guarantee they line up.
