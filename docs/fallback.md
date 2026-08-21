# Fallback

Replaces a failed execution with a value, the result of a function, or a chain
of handlers tried in order. It is the outermost line of defense: when retry
gave up and the circuit is open, fallback decides what the caller sees instead
of an exception.

```ts
import { fallback } from 'breakwater'

const policy = fallback((error, ctx) => cache.get(cacheKey) ?? DEFAULT_RESPONSE)

const products = await policy.execute(() => catalogApi.list())
```

## Signature

```ts
fallback<T>(handler: FallbackHandler<T> | Array<FallbackHandler<T>>, options?: FallbackOptions): FallbackPolicy

type FallbackHandler<T> = T | ((error: unknown, ctx: ExecutionContext) => T | Promise<T>)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `handler` | value, function, or array | — (required) | What replaces the failure |
| `fallbackIf` | `(error) => boolean` | every error | Which errors activate the fallback |

## The three shapes

```ts
// 1. Plain value
fallback({ items: [], degraded: true })

// 2. Function — receives the error and the execution context
fallback((error, ctx) => {
  log.warn({ err: error, correlationId: ctx.correlationId }, 'serving fallback')
  return cache.get(key)
})

// 3. Chain — tries A; if A throws, tries B; then C...
fallback([
  () => redisCache.get(key),        // best: recent cached copy
  () => diskSnapshot.read(key),     // older but local
  { items: [], degraded: true }     // last resort: static default
])
```

When the operation **and every handler** fail, the call rejects with
[`FallbackFailedError`](errors.md): the operation's error in `originalError`,
the last handler's error in `cause`.

> **Functions are always treated as handlers.** To fall back *to* a function
> value, wrap it: `fallback(() => myFunction)`.

## What activates the fallback

- Any error, by default.
- **Cancellation never does** — if the caller aborted, the caller does not
  want a replacement value; the failure propagates unchanged (for a function
  that honours the signal, that failure *is* the abort reason). This is
  re-checked between handlers too, so a caller that gives up while handler A
  is running does not pay for B and C — each of which may be a network call
  of its own.
- `fallbackIf` narrows it further:

```ts
// Programming errors should crash loudly, not hide behind a default value
const policy = fallback(DEFAULT, {
  fallbackIf: (error) => !(error instanceof TypeError || error instanceof RangeError)
})
```

## Events

| Event | Payload | When |
|---|---|---|
| `fallback` | `{ error, handlerIndex, correlationId }` | Before each handler in the chain runs |

A chain that succeeds on the second handler emits the event twice
(`handlerIndex: 0`, then `1`) — you can see exactly how degraded you are.

## Serving stale data instead: `staleCache`

The classic pairing with the circuit breaker — serve the last known good
response while the dependency is down — used to be a hand-rolled fallback
handler. It is a built-in policy now:
[`staleCache()`](stale-cache.md), with pluggable storage, keyed entries and
its own metrics. Reach for a fallback when the replacement is *computed* (a
default value, a secondary provider); reach for the stale cache when the
replacement is *whatever the last success returned*. They compose —
`fallback(staleCache(...))` — so the fallback catches what the cache cannot
rescue, like a cold start with nothing cached yet.

## Gotchas

- **Fallback hides failures by design.** Always emit something (the `fallback`
  event, a log, a metric) so "we served defaults all afternoon" never comes as
  a surprise.
- **Rethrowing inside a handler is allowed** — a handler that decides it
  cannot help can `throw error` to pass the ball to the next handler in the
  chain.
- **Order matters in composition**: `fallback` must sit *outside* whatever it
  is supposed to rescue. See [composition](composition.md).
- **The compiler does not connect the handler's type to `execute<T>()`.**
  `fallback('DEFAULT')` composed into a pipeline executed as
  `execute<number>` compiles clean and hands your code a string at runtime —
  the policy contract is generic per call, while handlers are typed at the
  factory. Keep the fallback value's shape next to the calls it rescues, and
  let integration tests cover the pipeline's real return type.
