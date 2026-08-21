import { SCRIPTS } from './scripts'
import { createRunner } from './runner'
import { type RedisPort } from './port'
import { timeWindow, type Window } from '../circuit-breaker/window'
import { assertNonEmptyString, assertPositiveInt } from '../validate'
import { memoryStore, type BreakerState, type CasOutcome, type LatencyStats, type StateSnapshot, type StateStore, type WindowCounters } from '../circuit-breaker/state-store'

export { fromIoredis, fromNodeRedis } from './port'
export type { RedisPort, ScriptDefinition } from './port'

export { redisRateLimit } from './rate-limit'
export type { RedisRateLimitOptions, RedisRateLimitStore } from './rate-limit'

export interface RedisStoreOptions {
  /**
   * Anything that can register a Lua script and run it by name — see
   * `RedisPort`, and the `fromIoredis` / `fromNodeRedis` adapters.
   */
  client: RedisPort
  /**
   * Prepended to every key. The breaker name is wrapped in a hash tag, so
   * one circuit's keys always land on the same cluster node. Default: 'bw:'.
   */
  prefix?: string
  /**
   * Sliding window used to aggregate counters across instances. Time
   * windows only — "the last N calls" has no shared meaning once several
   * instances are making them. Default: timeWindow(30_000).
   */
  window?: Window
  /**
   * How long an IDLE circuit's keys survive in Redis. Reading a circuit
   * renews the lease, so this measures inactivity rather than time since the
   * last transition — a circuit sitting open under traffic must not expire
   * out from under the fleet. An `isolated` circuit carries no expiry at
   * all. Default: four windows (at least a minute).
   */
  ttlMs?: number
  /**
   * How long a probe election lasts. The elected instance keeps extending
   * it while it probes; if that instance dies, the next one takes over
   * after this long. Default: 10_000.
   */
  probeTtlMs?: number
  /**
   * How long to stay local after Redis fails, before trying it again.
   * Default: 5_000.
   */
  degradeForMs?: number
  /**
   * How long to wait for one Redis command before treating it as a failure.
   * This bound belongs here rather than to your client: a driver that queues
   * commands while disconnected (ioredis does, by default) never rejects, so
   * without it a dead Redis would not degrade — it would stall the admission
   * path of every protected call. Default: 500.
   */
  commandTimeoutMs?: number
  /**
   * Called when Redis becomes unreachable and the circuit goes local.
   * Called once per outage, not once per call. Default: reports to
   * console.error.
   */
  onDegraded?: (error: unknown) => void
  /**
   * Called when Redis answers again and the circuit is shared once more.
   * Default: nothing — but wire it, or an incident that started with
   * "the circuit went local" never gets its closing line.
   */
  onRecovered?: () => void
}

/**
 * What `redisStore()` returns: a StateStore plus the two things an operator
 * needs from a backend that is allowed to fail.
 */
export interface RedisStore extends StateStore {
  /**
   * Whether the circuit is currently answering from this instance alone
   * because Redis is unreachable. Pull-style companion to `onDegraded`, for
   * a health endpoint or a gauge.
   */
  isDegraded: () => boolean
  /**
   * Drops this store's in-process bookkeeping — the mirrored state and the
   * local counters. The Redis client is yours and is left untouched.
   */
  close: () => void
}

const CLOSED: StateSnapshot = { state: 'closed', fence: 0 }
const KNOWN_STATES = new Set<string>(['closed', 'open', 'half-open', 'isolated'])

/**
 * A reply field that really is a number, judged as a STRING before coercion.
 * Number() maps '' and any whitespace-only field to 0, which is finite — so a
 * check on the coerced value cannot tell the epoch from nothing at all, and
 * would read a blank timing as a stamp decades in the past.
 */
const isNumeric = (value: string | undefined): boolean =>
  value !== undefined && value.trim() !== '' && Number.isFinite(Number(value))

/**
 * A circuit breaker state store shared through Redis: N instances of a
 * service agree that a dependency is down, and only one of them probes it
 * while the rest keep failing fast.
 *
 * Every operation is a single Lua script, so a transition is atomic across
 * the fleet — including the fenced compare-and-set that lets a decision
 * taken before a round trip be refused when it arrives after the circuit
 * has moved on.
 *
 * **Redis is never allowed to become the outage.** A resilience library
 * that fails when its own backend fails has the problem backwards, so no
 * method here rejects: when Redis is unreachable the store answers from
 * this instance's own view and the circuit simply becomes local until it
 * comes back. What that costs while degraded is agreement between
 * instances, not the protection itself.
 *
 * Two properties are per-instance by design: `getLatency` summarises the
 * calls THIS process made (percentiles are a triage signal, and shipping
 * every duration to Redis would not be one), and while degraded the
 * counters are this process's too.
 */
export function redisStore (options: RedisStoreOptions): RedisStore {
  const { client } = options
  const prefix = options.prefix ?? 'bw:'
  const window = options.window ?? timeWindow(30_000)
  if (window.kind !== 'time') {
    throw new RangeError('redisStore supports time windows only — a count window has no shared meaning across instances')
  }
  const windowMs = window.size
  const bucketMs = Math.max(1, Math.ceil(windowMs / 10))
  const ttlMs = options.ttlMs ?? Math.max(windowMs * 4, 60_000)
  const probeTtlMs = options.probeTtlMs ?? 10_000
  assertNonEmptyString('prefix', prefix)
  if (prefix.includes('{') || prefix.includes('}')) {
    // Redis Cluster hashes on the FIRST brace pair, so a prefix like
    // 'app:{prod}:' would slot every circuit under "prod" and leave the
    // multi-key scripts spanning nodes. Namespacing belongs in the plain
    // part of the prefix.
    throw new RangeError(`prefix must not contain braces, got ${JSON.stringify(prefix)} — the hash tag is reserved for the breaker name`)
  }
  assertPositiveInt('ttlMs', ttlMs)
  assertPositiveInt('probeTtlMs', probeTtlMs)

  // Names already given their one blind attempt this outage. Declared before
  // the runner so recovery can clear it: the budget is per OUTAGE, and a set
  // that only emptied on close() would spend it once per process.
  const askedWhileBlind = new Set<string>()

  const { run, isDegraded, isSkipping } = createRunner({
    client,
    ...(options.commandTimeoutMs !== undefined && { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.degradeForMs !== undefined && { degradeForMs: options.degradeForMs }),
    onDegraded: options.onDegraded ?? ((error: unknown) => {
      console.error('breakwater: redis state store unreachable — the circuit is local until it recovers', error)
    }),
    onRecovered: () => {
      askedWhileBlind.clear()
      options.onRecovered?.()
    }
  })

  // Identifies this store instance in the probe election. A majority has to
  // come from somewhere, so the holder is re-elected for the rest of the
  // period.
  const instanceId = globalThis.crypto.randomUUID()

  // Registration is lazy on every supported driver: no connection needed
  // here, and a failure surfaces on first use as a normal degradation.
  for (const [name, definition] of Object.entries(SCRIPTS)) {
    try {
      // Duck-typed rather than `instanceof Promise`: a driver may hand back a
      // thenable from another realm or library, and an unwatched rejection
      // there is the unhandled rejection this guard exists to prevent.
      const registered = client.defineScript(name, definition) as { then?: unknown } | undefined
      if (typeof registered?.then === 'function') Promise.resolve(registered).catch(() => {})
    } catch {
      // Same treatment: the first call degrades and reports.
    }
  }

  // One circuit's keys share a hash tag, so a multi-key script never spans
  // two cluster nodes.
  const tag = (name: string): string => `${prefix}{${name}}`
  const stateKey = (name: string): string => tag(name)
  const windowKey = (name: string): string => `${tag(name)}:w`
  const probeKey = (name: string): string => `${tag(name)}:p`
  const channelKey = (name: string): string => `${tag(name)}:c`

  // What this instance knows: fed by every Redis answer, and the authority
  // while Redis is unreachable.
  const mirror = new Map<string, StateSnapshot>()
  // Counters and durations for THIS instance — the degraded fallback, and
  // the source of the latency percentiles either way.
  let local = memoryStore({ window })

  const remember = (name: string, snapshot: StateSnapshot): StateSnapshot => {
    mirror.set(name, snapshot)
    return snapshot
  }

  const known = (name: string): StateSnapshot => mirror.get(name) ?? CLOSED

  // Fences minted while blind share Redis's numeric space, and both sides
  // advance for the same reason — the dependency failing — so they drift into
  // step. Spending one upstream would let an instance that saw nothing close
  // a period it never observed.
  const mintedBlind = new Map<string, number>()

  const asSnapshot = (raw: unknown): StateSnapshot => {
    const [state, fence, openedAt] = raw as [string, string, string]
    // Redis is a trust boundary like any other. An unrecognised state would
    // match none of the breaker's branches, so every call would be admitted
    // and no trip could ever swap away from it — the circuit would never
    // open again. Refuse to read it instead, and answer from what we know.
    if (!KNOWN_STATES.has(state) || !isNumeric(fence)) {
      throw new TypeError(`unreadable circuit state from redis: ${JSON.stringify(state)} / ${JSON.stringify(fence)}`)
    }
    // The timing is advisory where the state and the fence are not, so an
    // unreadable one is dropped rather than failing the whole read: the
    // breaker then counts the cooldown from first observation, which is the
    // documented behaviour for a store that reports no timing. Adopting a
    // number we cannot compare against would strand the circuit open with no
    // route back to half-open.
    return {
      state: state as BreakerState,
      fence: Number(fence),
      ...(isNumeric(openedAt) && { openedAt: Number(openedAt) })
    }
  }

  /**
   * The same compare-and-set, applied to this instance's own view. It runs
   * only while Redis is unreachable, and it keeps the local circuit moving
   * from the last state everyone agreed on rather than from scratch.
   */
  const localCas = (name: string, from: BreakerState, to: BreakerState, fence: number): CasOutcome => {
    const current = known(name)
    if (current.state !== from || current.fence !== fence) return { ok: false, snapshot: current }
    const next: StateSnapshot = {
      state: to,
      fence: current.fence + 1,
      ...(to === 'open' && { openedAt: Date.now() }),
      ...(to === 'half-open' && current.openedAt !== undefined && { openedAt: current.openedAt })
    }
    mintedBlind.set(name, next.fence)
    return { ok: true, snapshot: remember(name, next) }
  }

  const countersOf = (successes: number, failures: number): WindowCounters => {
    const totalCalls = successes + failures
    return { successes, failures, totalCalls, failureRate: totalCalls === 0 ? 0 : failures / totalCalls }
  }

  const record = async (name: string, outcome: 's' | 'f', durationMs: number): Promise<void> => {
    // Recorded locally either way: it is what keeps the latency percentiles
    // and the degraded counters meaningful.
    if (outcome === 's') local.recordSuccess(name, durationMs)
    else local.recordFailure(name, durationMs)

    await run('bwRecord', [windowKey(name)], [outcome, bucketMs, ttlMs], () => undefined, () => undefined)
  }

  return {
    readState: async (name) => {
      // A name this process has never read is UNKNOWN, not closed — and
      // answering "closed" would walk a fresh instance straight past a
      // circuit somebody isolated fleet-wide. So an unknown name is worth
      // one real attempt even inside the cooldown; the command is bounded,
      // and it is tried once per name per outage, not once per call.
      const blindGuess = !mirror.has(name) && isSkipping()
      const force = blindGuess && !askedWhileBlind.has(name)
      if (force) askedWhileBlind.add(name)

      return await run(
        'bwReadState',
        [stateKey(name)],
        [ttlMs],
        (raw) => {
          // A real answer supersedes anything invented while blind.
          mintedBlind.delete(name)
          return remember(name, asSnapshot(raw))
        },
        () => known(name),
        force
      )
    },

    compareAndSet: async (name, from, to, fence) => {
      if (!isSkipping() && mintedBlind.get(name) === fence) {
        // Redis is back but this fence was invented while it was away: refuse
        // rather than gamble on the numbers coinciding. The breaker re-reads
        // the real state on its next call.
        return { ok: false, snapshot: known(name) }
      }
      return await run(
        'bwCompareAndSet',
        [stateKey(name), probeKey(name), channelKey(name)],
        [from, to, fence, ttlMs],
        (raw) => {
          const [ok, state, nextFence, openedAt] = raw as [number, string, string, string]
          mintedBlind.delete(name)
          return { ok: ok === 1, snapshot: remember(name, asSnapshot([state, nextFence, openedAt])) }
        },
        () => localCas(name, from, to, fence)
      )
    },

    recordSuccess: async (name, durationMs) => { await record(name, 's', durationMs) },
    recordFailure: async (name, durationMs) => { await record(name, 'f', durationMs) },

    // Always a real read. Serving the counters this instance's own write
    // just computed would save a round trip and lose every call a peer made
    // in between — and a fleet-wide outage is exactly when every instance is
    // writing at once, so each would undercount the others and open late.
    getCounters: async (name) => await run(
      'bwCounters',
      [windowKey(name)],
      [bucketMs, windowMs],
      (raw) => {
        const [successes, failures] = raw as [number, number]
        return countersOf(successes, failures)
      },
      () => local.getCounters(name)
    ),

    // This instance's own durations: percentiles are a triage signal, and
    // shipping every duration to Redis would stop being one.
    getLatency: (name) => local.getLatency?.(name) as LatencyStats,

    resetCounters: async (name) => {
      local.resetCounters(name)
      await run('bwResetCounters', [windowKey(name)], [], () => undefined, () => undefined)
    },

    acquireProbe: async (name) => await run(
      'bwAcquireProbe',
      [probeKey(name)],
      [instanceId, probeTtlMs],
      (raw) => raw === 1,
      // Degraded: the circuit is this instance's own, so it probes it.
      () => true
    ),

    delete: async (name) => {
      local.delete?.(name)
      mirror.delete(name)
      mintedBlind.delete(name)
      await run('bwDelete', [stateKey(name), windowKey(name), probeKey(name)], [], () => undefined, () => undefined)
    },

    ...(client.subscribe !== undefined && {
      subscribe: async (name: string, onChange: (snapshot: StateSnapshot) => void) => {
        // Announced by the swap itself: `state fence openedAt`, with the
        // timing empty when the period ended. A message we cannot read is
        // dropped rather than guessed at — the next read is authoritative
        // anyway, which is what makes pushes safe to treat as a hint.
        return await client.subscribe!(channelKey(name), (message) => {
          const [state, fence, openedAt] = message.split(' ')
          if (state === undefined || fence === undefined) return
          try {
            onChange(asSnapshot([state, fence, openedAt ?? '']))
          } catch (error) {
            console.error('breakwater: unreadable state change pushed from redis', error)
          }
        })
      }
    }),

    isDegraded,

    close () {
      mirror.clear()
      mintedBlind.clear()
      askedWhileBlind.clear()
      local = memoryStore({ window })
    }
  }
}
