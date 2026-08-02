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
 * Pluggable backend for the circuit breaker state. The in-memory
 * implementation below is the default; a Redis-backed one shares the state
 * across instances.
 *
 * Every method may return synchronously or a promise — the breaker awaits
 * unconditionally. Rules for distributed adapters:
 * - `transition` must be atomic (compare-and-set).
 * - Graceful degradation is the adapter's job: if the backend is down, the
 *   adapter answers from its local cache. The breaker never needs to know.
 */
export interface StateStore {
  getState: (name: string) => BreakerState | Promise<BreakerState>
  /** Atomic compare-and-set; returns false when the current state is not `from`. */
  transition: (name: string, from: BreakerState, to: BreakerState) => boolean | Promise<boolean>
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
  /** Distributed only: push state changes to other instances. */
  subscribe?: (name: string, onChange: (state: BreakerState) => void) => () => void
}

export interface MemoryStoreOptions {
  /** Window used to aggregate counters. Default: timeWindow(30_000). */
  window?: Window
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
const quantile = (sorted: number[], q: number): number =>
  sorted[Math.max(1, Math.ceil(q * sorted.length)) - 1] as number

const summarise = (values: number[]): LatencyStats => {
  if (values.length === 0) return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 }

  values.sort((a, b) => a - b)
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

export function memoryStore (options: MemoryStoreOptions = {}): StateStore {
  const window = options.window ?? timeWindow(30_000)
  const entries = new Map<string, Entry>()

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
      found = { state: 'closed', window: freshWindow() }
      entries.set(name, found)
    }
    return found
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

    const now = Date.now()
    const start = now - (now % data.bucketMs)
    let current = data.buckets[data.buckets.length - 1]
    if (current === undefined || current.start !== start) {
      current = { start, successes: 0, failures: 0, durations: freshDurations(BUCKET_SAMPLES) }
      data.buckets.push(current)
      expireBuckets(data, now)
    }
    if (ok) current.successes++
    else current.failures++
    sample(current.durations, durationMs)
  }

  return {
    getState: (name) => entry(name).state,

    transition (name, from, to) {
      const e = entry(name)
      if (e.state !== from) return false
      e.state = to
      return true
    },

    recordSuccess: (name, durationMs) => record(name, true, durationMs),
    recordFailure: (name, durationMs) => record(name, false, durationMs),

    getLatency (name) {
      const data = entry(name).window
      const values: number[] = []

      if (data.kind === 'count') {
        for (let i = 0; i < data.filled; i++) values.push(data.durations[i] as number)
      } else {
        expireBuckets(data, Date.now())
        for (const bucket of data.buckets) {
          const { ring, filled } = bucket.durations
          for (let i = 0; i < filled; i++) values.push(ring[i] as number)
        }
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

    acquireProbe: () => true
  }
}
