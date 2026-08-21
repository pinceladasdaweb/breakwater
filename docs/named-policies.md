# Named policies

Resilience configuration wants to live in **one place**. When every module
builds its own `resilience({ ... })`, the payment API's timeout is 2s in one
file, 5s in another, and nobody notices until the incident review. A policy
registry centralizes the definitions; modules ask for policies **by name**.

```ts
// config/resilience.ts — the single source of truth, runs at startup
import { policies, exponential } from 'breakwater'

policies.defineAll({
  'payments-api': {
    retry: { attempts: 3, backoff: exponential({ initial: 200 }) },
    circuitBreaker: { failureThreshold: 0.5 },
    timeout: 2_000
  },
  'partner-quota': {
    rateLimit: { limit: 100, interval: 60_000, strategy: 'sliding-window' },
    timeout: 5_000
  }
})
```

```ts
// anywhere else — no configuration, no loose instances
import { policies } from 'breakwater'

const receipt = await policies.get('payments-api').execute(({ signal }) => api.post('/charge', body, { signal }))
```

## API

```ts
policies.define(name, config)   // config: resilience() options OR any prebuilt Policy
policies.defineAll(record)      // central config in one call
policies.get(name)              // throws listing known names when absent
policies.has(name)
policies.names()
policies.delete(name)           // mostly for tests
policies.clear()                // mostly for tests
```

Semantics that keep configuration honest:

- **Eager building** — `define` builds the policy immediately, so a typo in
  the options explodes at startup, not on the first request at 2 a.m.
- **Duplicates throw** — a second `define('payments-api', ...)` would
  silently diverge from the first; the registry refuses.
- **`get` of an unknown name throws listing what IS defined** — the typo
  `paymnets` fails at wiring time with the fix in the message.
- **Same name, same instance** — every `get('payments-api')` returns the
  same policy, so the circuit breaker state is genuinely shared across
  modules. That is the point.
- **`delete` and `clear` release what the registry built** — they call
  [`dispose()`](composition.md#releasing-a-pipeline-with-dispose)
  on the pipelines they created from options, because the registry is their
  only holder: dropping the entry without releasing would leave a breaker's
  subscription alive with nothing left to let go of it. A **prebuilt** policy
  you handed to `define()` is left alone — you built it and still hold it, so
  tearing it down here would break code that is still using it.

## Names flow into metrics automatically

The registry name becomes the default `name` of the pipeline — executions,
retries, timeouts, rejections and state changes come out of your
[`MetricsCollector`](observability.md) identified without per-policy wiring:

```ts
policies.define('partner-quota', {
  rateLimit: { limit: 100, interval: 60_000 },
  metrics: collector
})
// collector.onReject receives { policy: 'rateLimit', name: 'partner-quota', ... }
```

Explicit names always win, from the outside in: a top-level `name` relabels
the whole pipeline, and an inner `name` relabels just that policy.

```ts
policies.define('partner-quota', {
  name: 'Partner API',                                  // every metric says 'Partner API'
  rateLimit: { limit: 100, interval: 60_000, name: 'quota' } // except this one: 'quota'
})
```

The circuit breaker is the one exception: whatever it reports to metrics, its
state is keyed by the registry name (unless you set `circuitBreaker.name`
yourself — explicit wins there too), so a
[shared state store](circuit-breaker.md#pluggable-state-statestore) recognises the same
circuit across instances and restarts even if you rename the pipeline.

Entries built from `resilience()` options also expose the
[aggregated `stats()`](observability.md#aggregated-stats-on-compositions) —
a health endpoint over every named policy is a few lines.

## Custom pipelines register too

Anything implementing the `Policy` contract can be defined — including a
hand-built [`compose()`](composition.md) pipeline:

```ts
import { createPolicyRegistry, compose, retry, circuitBreaker, timeout } from 'breakwater'

const registry = createPolicyRegistry()
registry.define('reports', compose(
  circuitBreaker({ name: 'reports', consecutiveFailures: 3 }),
  retry({ attempts: 2 }),   // deliberate: retry INSIDE the breaker
  timeout(30_000)
))
```

## One registry or many?

`policies` is a shared default — perfect for an application with a single
resilience configuration. **Libraries and multi-tenant setups should create
their own** with `createPolicyRegistry()` instead of touching the shared one:
a library writing to the global registry can collide with its host
application's names.

Two sharing hazards worth knowing about the default registry:

- **Mixed module systems**: the ESM and CJS builds are separate module
  instances, so a codebase mixing `import` and `require` of breakwater gets
  *two* `policies` registries — and silently unshared circuit state. Pick one
  module system for breakwater, or pass your own registry around.
- **Duplicated installs**: two copies of breakwater in `node_modules` (a
  transitive dependency pinning a different version range) also means two
  registries. `npm ls breakwater` tells you.

In tests, prefer a fresh `createPolicyRegistry()` per suite; if you must use
the shared `policies`, clean up with `policies.clear()` in an `after` hook.
