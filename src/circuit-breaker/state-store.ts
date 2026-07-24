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
  | { kind: 'count', ring: Uint8Array, index: number, filled: number, failures: number }
  | { kind: 'time', bucketMs: number, windowMs: number, buckets: Bucket[] }

interface Bucket {
  start: number
  successes: number
  failures: number
}

interface Entry {
  state: BreakerState
  window: WindowData
}

const TIME_BUCKETS = 10

export function memoryStore (options: MemoryStoreOptions = {}): StateStore {
  const window = options.window ?? timeWindow(30_000)
  const entries = new Map<string, Entry>()

  const freshWindow = (): WindowData => {
    if (window.kind === 'count') {
      return { kind: 'count', ring: new Uint8Array(window.size), index: 0, filled: 0, failures: 0 }
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

  const record = (name: string, ok: boolean): void => {
    const data = entry(name).window

    if (data.kind === 'count') {
      if (data.filled === data.ring.length) {
        // Overwrite the oldest slot, keeping the running failure total exact.
        if (data.ring[data.index] === 0) data.failures--
      } else {
        data.filled++
      }
      data.ring[data.index] = ok ? 1 : 0
      if (!ok) data.failures++
      data.index = (data.index + 1) % data.ring.length
      return
    }

    const now = Date.now()
    const start = now - (now % data.bucketMs)
    let current = data.buckets[data.buckets.length - 1]
    if (current === undefined || current.start !== start) {
      current = { start, successes: 0, failures: 0 }
      data.buckets.push(current)
      expireBuckets(data, now)
    }
    if (ok) current.successes++
    else current.failures++
  }

  return {
    getState: (name) => entry(name).state,

    transition (name, from, to) {
      const e = entry(name)
      if (e.state !== from) return false
      e.state = to
      return true
    },

    recordSuccess: (name) => record(name, true),
    recordFailure: (name) => record(name, false),

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
