import { timeWindow, type Window } from './window'

export type BreakerState = 'closed' | 'open' | 'half-open' | 'isolated'

export interface WindowCounters {
  successes: number
  failures: number
  totalCalls: number
  /** failures / totalCalls over the window; 0 when the window is empty. */
  failureRate: number
}

/**
 * How long the calls in the window took, successes and failures alike.
 *
 * `count` is how many durations the numbers are based on, which is not
 * always `totalCalls`: a time window keeps a bounded sample per bucket, so
 * under heavy traffic the percentiles come from a subset. Everything is 0
 * when nothing has been sampled yet.
 */
export interface LatencyStats {
  count: number
  min: number
  max: number
  mean: number
  p50: number
  p95: number
  p99: number
}

/**
 * The state of a circuit at one instant, with the token that identifies
 * the period it belongs to.
 */
export interface StateSnapshot {
  state: BreakerState
  /**
   * Monotonic token minted by every successful transition. It identifies
   * the current state PERIOD: a decision taken while the fence was `f` is
   * provably stale once the store's fence has moved past it, even if the
   * state name happens to look the same (half-open → closed → open →
   * half-open is a different period, not the same one).
   *
   * A store must never reuse a fence for a given name — including across a
   * `delete()`, or across a key expiring and being recreated. Reuse brings
   * back the very ambiguity the token exists to remove.
   */
  fence: number
  /**
   * Epoch ms the current open period began. Set when the circuit opens,
   * carried through half-open (the probing belongs to the same period),
   * absent while closed or isolated.
   */
  openedAt?: number
}

/** The result of a fenced compare-and-set: did it swap, and where is the world now. */
export interface CasOutcome {
  ok: boolean
  /**
   * The store's state after the attempt — the freshly minted period when
   * `ok`, the period that beat this caller when not. Either way the
   * breaker can refresh its mirror without a second round trip.
   */
  snapshot: StateSnapshot
}

/**
 * Pluggable backend for the circuit breaker state. The in-memory
 * implementation below is the default; a Redis-backed one shares the state
 * across instances.
 *
 * Every method may return synchronously or a promise — the breaker awaits
 * unconditionally. Rules for distributed adapters:
 * - Reading and swapping go through the fenced pair below, and there is no
 *   unfenced shortcut: a store cannot accidentally offer a weaker swap than
 *   the breaker relies on.
 * - Graceful degradation is the adapter's job: if the backend is down, the
 *   adapter answers from its local cache. The breaker never needs to know.
 * - Errors are contained by role and by moment. While the breaker is
 *   DECIDING an admission (`readState`, `compareAndSet`, `acquireProbe` on
 *   the way in) or serving a manual control call, a throw propagates to the
 *   caller — a breaker that cannot decide must not admit. Once an execution
 *   has SETTLED, every store error — bookkeeping writes, counter reads,
 *   even the trip/close transitions — is reported and contained: the
 *   caller's outcome is already decided and no store failure may rewrite it.
 */
export interface StateStore {
  /** State, fence and open timing in a single read. */
  readState: (name: string) => StateSnapshot | Promise<StateSnapshot>
  /**
   * Atomic compare-and-set on BOTH the state and the fence: it may swap
   * only if the circuit is still in `from` AND nothing has transitioned
   * since the caller read `fence`. This is what makes a decision taken
   * before an await unable to land after the world moved on.
   *
   * On success the store mints a new fence and stamps the period's
   * `openedAt` (set when entering `open`, carried into `half-open`, cleared
   * otherwise). Never throws to signal a lost race — that is `ok: false`.
   */
  compareAndSet: (name: string, from: BreakerState, to: BreakerState, fence: number) => CasOutcome | Promise<CasOutcome>
  recordSuccess: (name: string, durationMs: number) => void | Promise<void>
  recordFailure: (name: string, durationMs: number) => void | Promise<void>
  getCounters: (name: string) => WindowCounters | Promise<WindowCounters>
  /**
   * Latency distribution over the same window. Optional: a store that does
   * not track durations simply omits it and `stats()` reports no latency.
   *
   * Deliberately separate from `getCounters`, which the breaker calls on
   * every failure — summarising percentiles is a read for monitoring, not
   * work the hot path should pay for.
   */
  getLatency?: (name: string) => LatencyStats | Promise<LatencyStats>
  /** Clears the window counters (used when the breaker closes or resets). */
  resetCounters: (name: string) => void | Promise<void>
  /**
   * Elects who is allowed to run a half-open probe. In-memory: always true.
   * Distributed: a lock so only one instance probes.
   */
  acquireProbe: (name: string) => boolean | Promise<boolean>
  /**
   * Optional: drops everything stored under `name`. A shared store whose
   * breaker names are dynamic (per host, per tenant) accumulates one entry
   * per name and never forgets on its own — call this when a name retires.
   */
  delete?: (name: string) => void | Promise<void>
}

export interface MemoryStoreOptions {
  /** Window used to aggregate counters. Default: timeWindow(30_000). */
  window?: Window
}

/**
 * What `memoryStore()` returns: a StateStore whose reads and swaps answer
 * synchronously. Stated in the type so that decorating one — the usual way
 * to build a test double or add behavior — keeps working with plain values
 * instead of `T | Promise<T>` unions.
 */
export interface MemoryStore extends StateStore {
  readState: (name: string) => StateSnapshot
  compareAndSet: (name: string, from: BreakerState, to: BreakerState, fence: number) => CasOutcome
}

/**
 * O(1) counter structures — this sits on the hot path of every protected
 * call, so no per-call array scans or allocations are acceptable.
 *
 * `count` windows use a ring buffer with running totals. `time` windows use
 * a fixed number of rotating buckets (resilience4j-style): counters are
 * exact per bucket and the window edge has bucket-size granularity.
 */
type WindowData =
  | { kind: 'count', ring: Uint8Array, durations: Float64Array, index: number, filled: number, failures: number }
  | { kind: 'time', bucketMs: number, windowMs: number, buckets: Bucket[] }

interface Bucket {
  start: number
  successes: number
  failures: number
  durations: Durations
}

/** A bounded ring of the most recent call durations. */
interface Durations {
  ring: Float64Array
  index: number
  filled: number
}

interface Entry {
  state: BreakerState
  /** Bumped by every successful transition; see StateSnapshot.fence. */
  fence: number
  openedAt?: number
  window: WindowData
}

const TIME_BUCKETS = 10
/**
 * Durations kept per time bucket. A count window keeps one per call, exactly
 * matching its size; a time window has no call count to bound it, so it
 * samples — enough for stable percentiles without growing with traffic.
 */
const BUCKET_SAMPLES = 128

const freshDurations = (capacity: number): Durations =>
  ({ ring: new Float64Array(capacity), index: 0, filled: 0 })

const sample = (durations: Durations, ms: number): void => {
  durations.ring[durations.index] = ms
  durations.index = (durations.index + 1) % durations.ring.length
  if (durations.filled < durations.ring.length) durations.filled++
}

/** Nearest-rank quantile over an ascending array. */
const quantile = (sorted: Float64Array, q: number): number =>
  sorted[Math.max(1, Math.ceil(q * sorted.length)) - 1] as number

// Takes (and mutates) a typed array: numeric sort without comparator calls
// keeps a large count window's summary from stalling a health endpoint.
const summarise = (values: Float64Array): LatencyStats => {
  if (values.length === 0) return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 }

  values.sort()
  let total = 0
  for (const value of values) total += value

  return {
    count: values.length,
    min: values[0] as number,
    max: values[values.length - 1] as number,
    mean: total / values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99)
  }
}

export function memoryStore (options: MemoryStoreOptions = {}): MemoryStore {
  const window = options.window ?? timeWindow(30_000)
  const entries = new Map<string, Entry>()
  // Store-scoped so a fence is never reused, not even by a name that was
  // deleted and came back: a swap still in flight across the delete would
  // otherwise land on a period three generations later.
  let nextFence = 0

  const freshWindow = (): WindowData => {
    if (window.kind === 'count') {
      return {
        kind: 'count',
        ring: new Uint8Array(window.size),
        durations: new Float64Array(window.size),
        index: 0,
        filled: 0,
        failures: 0
      }
    }
    const bucketMs = Math.max(1, Math.ceil(window.size / TIME_BUCKETS))
    return { kind: 'time', bucketMs, windowMs: window.size, buckets: [] }
  }

  const entry = (name: string): Entry => {
    let found = entries.get(name)
    if (found === undefined) {
      found = { state: 'closed', fence: nextFence, window: freshWindow() }
      entries.set(name, found)
    }
    return found
  }

  const snapshotOf = (e: Entry): StateSnapshot => ({ state: e.state, fence: e.fence, openedAt: e.openedAt })

  /**
   * The period's timing, owned by the store so every instance sharing it
   * agrees on when probing may start: stamped on the way into `open`,
   * carried through `half-open` (same period, now probing), cleared when
   * the circuit leaves the period altogether.
   */
  const stampTiming = (e: Entry, to: BreakerState): void => {
    if (to === 'open') e.openedAt = Date.now()
    else if (to !== 'half-open') e.openedAt = undefined
  }

  const expireBuckets = (data: WindowData & { kind: 'time' }, now: number): void => {
    const oldestAllowed = now - data.windowMs
    while (data.buckets.length > 0 && (data.buckets[0] as Bucket).start + data.bucketMs <= oldestAllowed) {
      data.buckets.shift()
    }
  }

  const record = (name: string, ok: boolean, durationMs: number): void => {
    const data = entry(name).window

    if (data.kind === 'count') {
      if (data.filled === data.ring.length) {
        // Overwrite the oldest slot, keeping the running failure total exact.
        if (data.ring[data.index] === 0) data.failures--
      } else {
        data.filled++
      }
      data.ring[data.index] = ok ? 1 : 0
      // The duration shares the outcome's slot, so it ages out with it.
      data.durations[data.index] = durationMs
      if (!ok) data.failures++
      data.index = (data.index + 1) % data.ring.length
      return
    }

    let now = Date.now()
    const newest = data.buckets[data.buckets.length - 1]
    // Monotonic clamp, as in the rate limiter: after a backwards clock step
    // the record lands in the newest bucket instead of creating an
    // out-of-order one that the front-only expiry could never remove.
    if (newest !== undefined && now < newest.start) now = newest.start
    const start = now - (now % data.bucketMs)
    let current = newest
    if (current === undefined || current.start !== start) {
      current = { start, successes: 0, failures: 0, durations: freshDurations(BUCKET_SAMPLES) }
      data.buckets.push(current)
      expireBuckets(data, now)
    }
    if (ok) current.successes++
    else current.failures++
    sample(current.durations, durationMs)
  }

  const readState = (name: string): StateSnapshot => snapshotOf(entry(name))

  const compareAndSet = (name: string, from: BreakerState, to: BreakerState, fence: number): CasOutcome => {
    const e = entry(name)
    if (e.state !== from || e.fence !== fence) return { ok: false, snapshot: snapshotOf(e) }
    e.state = to
    e.fence = ++nextFence
    stampTiming(e, to)
    return { ok: true, snapshot: snapshotOf(e) }
  }

  return {
    readState,
    compareAndSet,

    recordSuccess: (name, durationMs) => record(name, true, durationMs),
    recordFailure: (name, durationMs) => record(name, false, durationMs),

    getLatency (name) {
      const data = entry(name).window

      if (data.kind === 'count') {
        return summarise(data.durations.slice(0, data.filled))
      }

      expireBuckets(data, Date.now())
      let total = 0
      for (const bucket of data.buckets) total += bucket.durations.filled
      const values = new Float64Array(total)
      let offset = 0
      for (const bucket of data.buckets) {
        const { ring, filled } = bucket.durations
        values.set(ring.subarray(0, filled), offset)
        offset += filled
      }
      return summarise(values)
    },

    getCounters (name) {
      const data = entry(name).window
      let failures = 0
      let totalCalls = 0

      if (data.kind === 'count') {
        failures = data.failures
        totalCalls = data.filled
      } else {
        expireBuckets(data, Date.now())
        for (const bucket of data.buckets) {
          failures += bucket.failures
          totalCalls += bucket.successes + bucket.failures
        }
      }

      return {
        successes: totalCalls - failures,
        failures,
        totalCalls,
        failureRate: totalCalls === 0 ? 0 : failures / totalCalls
      }
    },

    resetCounters (name) {
      entry(name).window = freshWindow()
    },

    acquireProbe: () => true,

    delete (name) {
      entries.delete(name)
    }
  }
}
