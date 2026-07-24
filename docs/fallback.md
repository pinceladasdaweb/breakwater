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
  want a replacement value; the abort reason propagates.
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

## Real-world example: stale-while-open

The classic pairing with the circuit breaker — serve the last known good
response while the dependency is down:

```ts
import { compose, fallback, circuitBreaker, isCircuitOpenError } from 'breakwater'

const lastGood = new Map<string, unknown>()

const policy = compose(
  fallback((error, ctx) => {
    const stale = lastGood.get(String(ctx.metadata.key))
    if (stale === undefined) throw error // nothing cached: fail honestly
    return { ...stale, stale: true }
  }, { fallbackIf: isCircuitOpenError }), // only when the circuit is open
  circuitBreaker({ name: 'catalog' })
)

export async function getCatalog (key: string): Promise<unknown> {
  const result = await policy.execute(
    async () => await catalogApi.get(key),
    { metadata: { key } }
  )
  if (result !== undefined && !(result as { stale?: boolean }).stale) lastGood.set(key, result)
  return result
}
```

A built-in stale-response cache (with pluggable storage) is planned — today
the pattern above is a dozen lines.

## Gotchas

- **Fallback hides failures by design.** Always emit something (the `fallback`
  event, a log, a metric) so "we served defaults all afternoon" never comes as
  a surprise.
- **Rethrowing inside a handler is allowed** — a handler that decides it
  cannot help can `throw error` to pass the ball to the next handler in the
  chain.
- **Order matters in composition**: `fallback` must sit *outside* whatever it
  is supposed to rescue. See [composition](composition.md).
