# Redis: the distributed circuit breaker

`breakwater/redis` shares one circuit across every instance of your service.
Instance A sees the outage and trips the breaker; instances B and C fail fast
immediately, without each having to discover the same outage on their own
users. When the cooldown elapses, **exactly one** of them probes the
recovering dependency while the rest keep waiting.

```bash
npm install breakwater ioredis   # or node-redis, or any client you already have
```

```ts
import Redis from 'ioredis'
import { circuitBreaker } from 'breakwater'
import { redisStore, fromIoredis } from 'breakwater/redis'

const client = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379')
const store = redisStore({ client: fromIoredis(client) })

const payments = circuitBreaker({
  name: 'payments-api',      // the key the circuit is shared under — required
  stateStore: store,
  failureThreshold: 0.5,
  minimumCalls: 20,
  halfOpenAfter: 30_000
})
```

That is the whole integration. Everything else — [composition](composition.md),
[events](observability.md), the [metrics adapters](prometheus.md) — works
exactly as before; only where the state lives has changed.

## Redis is never allowed to become the outage

A resilience library that stops working when its own backend does has the
problem backwards. So **no method of this store ever rejects**. When Redis is
unreachable, the store answers from what this instance already knows and the
circuit simply becomes local until Redis comes back:

- the last state everyone agreed on is kept — a circuit that was open across
  the fleet does not spring closed and send the outage downstream;
- transitions, counters and probes carry on with this instance's own view;
- the failure is reported **once per outage**, not once per call
  (`onDegraded`, defaulting to `console.error`);
- Redis is left alone for `degradeForMs` before being tried again, instead of
  being hammered while it is down;
- the probe election cannot be held, so each instance probes on its own
  schedule — a fleet of N will probe a recovering dependency N times per
  cooldown until Redis returns. Worth knowing, because a Redis outage tends
  to be *correlated* with the stress that made the dependency sick.

What you lose while degraded is *agreement between instances*, not the
protection itself. Each instance behaves like a well-configured local breaker
until the shared view returns.

## The fence, and why a shared circuit needs one

Every transition is a single Lua script, so it is atomic across the fleet.
But atomic is not enough on its own: a decision is made *before* a round trip
and lands *after* it, and in between the circuit may have moved on.

The store mints a **fence** on every successful transition, and
`compareAndSet` swaps only if the state still matches **and** the fence has
not moved. So a probe that fails, waits on a slow round trip, and only then
tries to reopen the circuit is refused — instead of killing the recovery
period that started meanwhile. The state name alone could not catch that:
`half-open → closed → open → half-open` spells "half-open" again, but it is a
different period. See the [store contract](circuit-breaker.md#the-fenced-pair).

The period's timing lives in Redis too, stamped from the **server clock**.
That is what makes every instance agree on when probing may start — including
one that joined after the trip and never saw it happen.

## Pushed state changes

By default an instance learns that a peer opened the circuit on its **next
read**, which is the next call it makes. Give the store a subscription and it
learns immediately instead:

```ts
import Redis from 'ioredis'
import { fromIoredis, redisStore } from 'breakwater/redis'

const client = new Redis(url)
// A subscribed connection cannot run commands, so pushes need their own.
const store = redisStore({ client: fromIoredis(client, client.duplicate()) })
```

The announcement is published by the same Lua script that commits the swap,
so nobody hears about a transition that did not happen. A push refreshes the
mirror and **emits no events** — learning it from a push is the same thing as
learning it from a read, and emitting would count one fleet-wide transition
once per instance that heard it.

Pushes are a hint, never an authority: delivery is best effort, a message
that describes a period the instance has already left is dropped, and every
execution still reads the state it decides on. Losing one costs freshness,
not correctness.

That is not a theoretical loss. Redis pub/sub has no delivery guarantee and
no replay, so anything published while a subscriber is reconnecting is gone
— and a dropped connection is exactly when a dependency is having trouble
and peers are tripping. An instance that misses the announcement learns the
circuit is open on its very next call, because the subscription accelerates
agreement rather than standing in for it. Which is why the read is never
skipped just because a subscription is live: invert those two and a lost
message becomes a fleet that quietly disagrees about whether a dependency
is down.

Call `breaker.dispose()` to release the subscription when the policy goes
away; it is safe to call more than once, and the breaker keeps working
afterwards by going back to reading.

## Options

```ts
redisStore({
  client,                    // a RedisPort — see the adapters below
  prefix: 'bw:',             // key prefix
  window: timeWindow(30_000), // counter window, time windows only
  ttlMs: 120_000,            // how long an IDLE circuit's keys survive
  probeTtlMs: 10_000,        // how long a probe election lasts
  degradeForMs: 5_000,       // how long to stay local after Redis fails
  onDegraded: (error) => log.warn({ err: error }, 'circuit went local'),
  onRecovered: () => log.info('circuit is shared again')
})
```

The store also answers two questions an operator will have:

```ts
store.isDegraded()  // is this instance deciding on its own right now?
store.close()       // drop the in-process mirror and local counters
```

`close()` does not touch your client — the connection is yours to manage.
Both `onDegraded` and `onRecovered` fire once per episode, not once per call,
and a callback that throws is contained: the reporter is not allowed to
become the outage either.

**Time windows only.** "The last 100 calls" has no shared meaning once
several instances are making them; a count window is refused at construction.

**Keys.** One circuit owns `bw:{name}` (state), `bw:{name}:w` (counters) and
`bw:{name}:p` (the probe election). The name sits inside a hash tag, so all
three always land on the same node of a Redis Cluster and a multi-key script
never spans two.

**The lease measures idleness.** Reading a circuit renews `ttlMs`, so a
circuit under traffic never expires out from under the fleet — the states
that must stay put, `open` and `isolated`, are exactly the ones that would
have suffered otherwise. `isolated` goes further and carries no expiry at
all: a maintenance window that lifted itself after two minutes would put a
dependency back in traffic that somebody deliberately took out. A name that
genuinely goes quiet is still collected.

**Names must be stable, shared, and brace-free.** The name *is* the key: two services
protecting the same dependency should use the same one, and a breaker created
without a `name` gets a random one — useless here. Retiring a dynamic name?
Call `store.delete(name)`. `ttlMs` reclaims the Redis keys on its own, but
the in-process mirror and local counters are only pruned by `delete()` (or
`close()`), so a per-tenant or per-host naming scheme needs it.

## What a shared circuit cannot promise

Three limits worth knowing before you rely on this in an incident:

- **A kill switch is only as reachable as Redis.** An instance that has never
  read a given circuit and cannot reach Redis has no way to know it was
  isolated. It gets one bounded attempt to ask, and if that fails it admits
  traffic rather than rejecting everything it knows nothing about. If an
  isolation must hold through a Redis outage, pair it with a deploy-time flag.
- **The cooldown compares two clocks.** `openedAt` comes from the Redis
  server so every instance agrees on it, but whether it has elapsed is judged
  against each instance's own clock. Large skew shifts when probing starts —
  keep NTP honest, as you would for anything else that reasons about time.
- **Every instance sharing a name must share its `window`.** The counter
  sweep uses the window of whoever is asking, so a peer configured with a
  shorter one will discard buckets the others were still counting. Change it
  fleet-wide, not per rollout.
- **Write access to Redis is control of the circuit.** Whoever can write
  these keys can hold a dependency open for the whole fleet, or force it
  closed while it is failing — and can announce a transition on the channel
  that never happened. Replies are validated, so a malformed one is refused
  rather than believed, and a forged push is corrected by the next read; none
  of that substitutes for the obvious. Require auth, keep the instance off
  public networks, and treat it as the shared control plane it is.

## Sharing the rate limit too

The same idea, for quota: `limit` per `interval` for the **fleet** rather than
per process.

```ts
import { rateLimit } from 'breakwater'
import { redisRateLimit, fromIoredis } from 'breakwater/redis'

const partner = rateLimit({
  name: 'partner-api',      // the key the quota lives under — required
  limit: 100,
  interval: 60_000,
  strategy: 'sliding-window',
  store: redisRateLimit({ client: fromIoredis(client) })
})
```

Both strategies keep the semantics of their in-process counterparts —
continuous refill for the token bucket, exactness for the sliding window —
and every decision is a single atomic script, because deciding and consuming
in two steps is how two instances both spend the last slot.

The degraded behavior is the one worth reading twice. **When Redis is
unreachable the quota becomes local**, enforced by this instance alone with
the same numbers. A fleet of N then allows up to N times the rate for the
length of the outage. That is deliberate: the alternative is a rate limiter
that rejects everything the moment its bookkeeping is unreachable, and a
client-side quota exists to be polite to a dependency, not to be the reason
your service stops. If the limit is a hard contractual ceiling rather than
courtesy, keep the numbers well under it, or let the dependency's own
enforcement be the authority it already is.

`redisRateLimit` takes the same operational options as the state store —
`prefix` (default `bwrl:`), `commandTimeoutMs`, `degradeForMs`, `onDegraded`,
`onRecovered` — and answers `isDegraded()` the same way.

## What stays per-instance, on purpose

- **Latency percentiles** summarise the calls *this* process made. Shipping
  every duration to Redis to compute a p99 would cost more than the signal is
  worth; a per-instance p95 is still exactly what you want during triage.
- **Counters while degraded** are this process's own, for as long as the
  outage lasts.

## Client adapters

The store needs two things from a client: register a Lua script, and run it
by name. Keys and arguments travel as two arrays — never as a variadic tail,
which is how a misplaced key ends up read on a node nobody meant to reach.

```ts
interface RedisPort {
  defineScript (name: string, definition: { lua: string, numberOfKeys: number }): void | Promise<void>
  runScript (name: string, keys: string[], args: Array<string | number>): Promise<unknown>
}
```

| Client | How |
|---|---|
| ioredis (incl. Cluster) | `fromIoredis(client)` — scripts become client commands, called by SHA and reloaded on `NOSCRIPT` |
| node-redis v4+ | `fromNodeRedis(client)` — `SCRIPT LOAD` on first use, then `EVALSHA`, reloading once if the server forgot it |
| [`@pinceladasdaweb/redis`](https://www.npmjs.com/package/@pinceladasdaweb/redis) 4.1+ | none — it already registers scripts by name, so the client **is** the port: `redisStore({ client })` |
| anything else | implement the two methods; a client that already registers scripts by name satisfies it directly |

```ts
// No adapter at all when the client speaks the port natively:
import { RedisClient } from '@pinceladasdaweb/redis'
import { redisStore } from 'breakwater/redis'

const redis = new RedisClient({ host, port })
await redis.connect()
const store = redisStore({ client: redis })
```

Registering by name rather than sending the script body matters here: a
circuit breaker evaluates state on **every request**, and `EVAL` ships the
whole program each time.

## Requirements and cost

Redis 5 or newer: the scripts read the server clock, and effect-based
replication — which makes that safe — has been the default since 5.0. CI
exercises Redis 7.

A protected call costs **three** round trips on the happy path: read the
state to decide on admission, record the outcome, then read the window the
next decision will be made on. A call that trips or closes the circuit adds
the swap, and even a fast rejection costs two — failing fast still reports
the counters it rejected on.

The counter read is the one that looks removable: the write could return the
window it just computed and save a trip. It would also lose every call a peer
made in between, and during a fleet-wide outage every instance is writing at
once — so each would undercount the others and open late, exactly when the
decision matters most. The extra trip buys a decision that is actually the
fleet's.

### What that costs, measured

Reproduce with [`benchmarks/redis-overhead.mjs`](../benchmarks/redis-overhead.mjs);
these are 2000 sequential calls per row against Redis 7 on loopback:

| path | ops/sec | p50 | p99 |
|---|---:|---:|---:|
| memory · healthy call | 389,279 | 0.002 ms | 0.012 ms |
| **redis · healthy call** | **3,904** | **0.244 ms** | 0.500 ms |
| memory · fast rejection | 85,589 | 0.011 ms | 0.026 ms |
| **redis · fast rejection** | **6,682** | **0.144 ms** | 0.255 ms |

Read those two numbers, not the ratio. The ratio (≈136×) is the kind of
figure that decides nothing; **+0.24 ms per protected call** is the number you
size against, and it is almost entirely round trips — which is why the fast
rejection, at two trips instead of three, is the *cheaper* path here.

Two caveats that matter more than the table:

- **Loopback is the floor.** There is no network in these numbers. Add your
  real RTT three times over for a healthy call: at 1 ms to your Redis, expect
  roughly 3 ms, and the in-process work stays lost in the noise.
- **The ops/sec column is latency, not capacity.** The benchmark is
  sequential, so it measures one call at a time. A service making these calls
  concurrently is bounded by its connection and its Redis, not by 3,904.

If that budget does not fit a given call path, the answer is not a faster
store — it is to keep that path on the in-memory store and share only the
circuits where the fleet agreeing is worth a couple of round trips. Both kinds
of breaker compose in the same pipeline.

## Gotchas

- **Give every breaker the same `name` across instances.** It is the key.
- **The probe election is a lease.** If the elected instance dies mid-probe,
  the next one takes over after `probeTtlMs`.
- **`reset()` and `isolate()` are fleet-wide.** They act on the shared state,
  so isolating a circuit from one instance isolates it for everyone — which
  is usually the point.
