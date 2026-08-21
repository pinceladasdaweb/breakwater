# Versioning policy

breakwater follows [semantic versioning](https://semver.org/). From `1.0.0`
on, that is a promise about what may change and when — this page says exactly
what the promise covers, because "semver" on its own means different things
to different libraries.

## What is public

The public API is everything reachable from the package's entry points:

| Entry point | Contains |
|---|---|
| `breakwater` | the policies, `compose`/`resilience`, the registry, errors and type guards, events, `memoryStore`, the collector interface |
| `breakwater/prometheus` | `prometheusCollector` |
| `breakwater/otel` | `otelCollector`, `spanPolicy` |
| `breakwater/redis` | `redisStore`, `fromIoredis`, `fromNodeRedis` |

Covered by the promise:

- every exported function, its parameters and its return shape;
- every exported type and interface;
- **documented behavior** — what these pages say a policy does, including
  ordering rules, what counts as a failure, and the containment contracts;
- error `code` values and the type guards that read them;
- event names and their payload fields;
- the Node.js versions in `engines`.

## What is not public

These may change in any release, so do not build on them:

- anything reached by a deep path (`breakwater/dist/...`, `src/...`) — only
  the entry points above are supported;
- the **text** of error messages and of anything written to `console.error`.
  Branch on `error.code` or the type guards, never on prose;
- the shape of files inside `dist/` beyond what the `exports` map resolves;
- timing and performance characteristics that no page states as a rule —
  a policy may get faster, allocate differently, or make fewer round trips;
- anything a page explicitly calls internal.

## Interfaces you implement are a special case

Most types here are ones you *consume*: `CircuitBreakerStats`,
`CircuitBreakerOptions`, the event payloads. Adding a field to those is a
**minor** — your code keeps compiling.

But five interfaces exist for you to *implement*:

- `StateStore` (circuit breaker state)
- `CacheStore` (the stale cache)
- `RateLimitStore` (a shared rate limit quota)
- `MetricsCollector` (metrics adapters)
- `RedisPort` (the Redis client boundary)

For these the direction reverses: **adding a required member is a breaking
change**, because your implementation suddenly no longer satisfies the
interface. So on those five, after 1.0:

- new capabilities arrive as **optional** members, and the library keeps
  working when they are absent;
- a member only becomes required in a **major**;
- an optional member is never added just to reserve a name — if it is in the
  interface, something calls it.

That last rule cost `StateStore.subscribe` its place before 1.0: it was
declared for a push-based invalidation that nothing called yet, so it was
removed rather than shipped as a name with no behaviour behind it. It came
back in `1.1.0` as an optional member, in a minor, once
[pushed state changes](redis.md#pushed-state-changes) existed — which is the
rule working exactly as written, in both directions.

## What counts as breaking

- removing or renaming an export;
- making an optional option required, or removing an option;
- changing an error `code`, an event name, or a payload field's meaning;
- changing documented behavior in a way that could surprise correct code —
  a different default, a different composition order, a stricter validation
  that rejects input previously accepted;
- adding a required member to one of the four implementable interfaces above;
- raising the minimum Node.js version.

Fixing a defect so behavior finally matches the documentation is a **patch**,
even when code that depended on the defect notices.

## Deprecations

Anything on its way out is deprecated for at least one minor before it goes:
marked `@deprecated` in the types with the replacement named, and listed in
the CHANGELOG. A deprecated export keeps working until the next major.

## Node.js support

`engines` states the floor. breakwater supports Node.js versions that are in
Active LTS or Maintenance, and dropping one is a major. New Node versions are
added to CI as they are released.

## Optional peer dependencies

`prom-client`, `@opentelemetry/api` and any Redis client are optional peers:
they are needed only by the entry point that uses them, and importing plain
`breakwater` never loads any of them. Widening a supported peer range is a
minor; narrowing one is a major.

## Pre-1.0 history

Everything before `1.0.0` was published under the "may change without notice"
banner, and the store contract did change more than once as the distributed
design took shape. That is over: `1.0.0` is where the API freezes and this
policy starts applying.
