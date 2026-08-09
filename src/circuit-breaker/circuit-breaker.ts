import { type Window } from './window'

const randomUUID = (): string => globalThis.crypto.randomUUID()
import { basePolicy, type Policy } from '../policy'
import { CircuitOpenError, IsolatedError } from '../errors'
import { assertPositiveFinite, assertPositiveInt } from '../validate'
import { createEmitter, withObservable, type Observable } from '../events'
import { memoryStore, type BreakerState, type LatencyStats, type StateStore, type WindowCounters } from './state-store'

export interface CircuitBreakerStats {
  state: BreakerState
  successes: number
  failures: number
  totalCalls: number
  failureRate: number
  /**
   * How long the calls in the window took. Absent when the state store does
   * not track durations, and on the snapshot carried by CircuitOpenError —
   * a rejected call has no latency of its own, and summarising percentiles
   * on every fast rejection would put real work on the rejection path.
   */
  latency?: LatencyStats
  lastError?: unknown
  /**
   * Epoch ms of the moment the circuit opened. Present while the state is
   * `open` or `half-open`; absent otherwise — a closed or isolated circuit
   * has no open period to report.
   */
  openedAt?: number
  /** Epoch ms of the moment half-open probing becomes allowed. Present only while `open`. */
  nextAttemptAt?: number
}

export interface CircuitBreakerOptions {
  /**
   * Failure rate (0..1] over the window that opens the circuit.
   * Default: 0.5. Ignored when `consecutiveFailures` is set.
   */
  failureThreshold?: number
  /**
   * Sliding window used by the default in-memory store to aggregate
   * counters. Default: timeWindow(30_000). Ignored when a custom
   * `stateStore` is provided — the store owns the aggregation.
   */
  window?: Window
  /**
   * The circuit never opens before this many calls in the window.
   * Default: 10. Ignored when `consecutiveFailures` is set.
   */
  minimumCalls?: number
  /** Simple mode: open after N consecutive failures, ignoring the window. */
  consecutiveFailures?: number
  /** Time in ms the circuit stays open before allowing probes. Default: 30_000. */
  halfOpenAfter?: number
  /**
   * Number of probe calls allowed in half-open. A majority of successes
   * (floor(n/2) + 1) closes the circuit; any failure reopens it. Default: 3.
   */
  halfOpenCalls?: number
  /** Decides what counts as a failure. Default: every error. */
  failureIf?: (error: unknown) => boolean
  /**
   * Pluggable state backend. Default: in-memory. A distributed store shares
   * the circuit state across instances. Custom stores require a
   * stable `name`.
   */
  stateStore?: StateStore
  /** Identifies this breaker in metrics, stats and shared state stores. */
  name?: string
}

export interface CircuitBreakerEvents extends Record<string, unknown> {
  /** correlationId is present when an execution triggered the transition. */
  open: { stats: CircuitBreakerStats, correlationId?: string }
  close: { stats: CircuitBreakerStats, correlationId?: string }
  halfOpen: { stats: CircuitBreakerStats, correlationId?: string }
  reject: { reason: 'circuit_open' | 'isolated', correlationId: string }
  success: { durationMs: number, correlationId: string }
  failure: { error: unknown, durationMs: number, correlationId: string }
  stateChange: { from: BreakerState, to: BreakerState, stats: CircuitBreakerStats, correlationId?: string }
}

export interface CircuitBreakerPolicy extends Policy, Observable<CircuitBreakerEvents> {
  readonly kind: 'circuitBreaker'
  /** Last locally-known state (exact with the in-memory store). */
  readonly state: BreakerState
  stats: () => CircuitBreakerStats
  /**
   * Opens the circuit manually (feature flag / maintenance). Unlike `open`,
   * the `isolated` state never expires — only unisolate() leaves it.
   */
  isolate: () => Promise<void>
  unisolate: () => Promise<void>
  /** Clears counters and returns to closed (e.g. after a reconnection). */
  reset: () => Promise<void>
}

const EMPTY_COUNTERS: WindowCounters = { successes: 0, failures: 0, totalCalls: 0, failureRate: 0 }

export function circuitBreaker (options: CircuitBreakerOptions = {}): CircuitBreakerPolicy {
  const failureThreshold = options.failureThreshold ?? 0.5
  if (!(failureThreshold > 0 && failureThreshold <= 1)) {
    throw new RangeError(`failureThreshold must be in (0, 1], got ${failureThreshold}`)
  }
  const minimumCalls = options.minimumCalls ?? 10
  assertPositiveInt('minimumCalls', minimumCalls)
  const consecutiveFailures = options.consecutiveFailures
  if (consecutiveFailures !== undefined) assertPositiveInt('consecutiveFailures', consecutiveFailures)
  const halfOpenAfter = options.halfOpenAfter ?? 30_000
  assertPositiveFinite('halfOpenAfter', halfOpenAfter)
  const halfOpenCalls = options.halfOpenCalls ?? 3
  assertPositiveInt('halfOpenCalls', halfOpenCalls)
  const failureIf = options.failureIf ?? (() => true)
  const name = options.name ?? `breaker-${randomUUID()}`
  const store = options.stateStore ?? memoryStore({ window: options.window })
  const successesToClose = Math.floor(halfOpenCalls / 2) + 1

  const emitter = createEmitter<CircuitBreakerEvents>()

  // Local mirrors: exact with the in-memory store; last-known with an async
  // (distributed) store, which keeps stats() and .state synchronous.
  let localState: BreakerState = 'closed'
  let lastCounters: WindowCounters = EMPTY_COUNTERS
  let lastLatency: LatencyStats | undefined
  let lastError: unknown
  let openedAt: number | undefined
  let consecutive = 0
  let probeSuccesses = 0
  let probesInFlight = 0
  // Incremented on every entry into half-open. Probes carry the generation
  // they were admitted under; results and slot releases from a previous
  // generation (a probe still in flight when the circuit re-opened) are
  // ignored so they cannot close, reopen or unblock the current period.
  let probeGeneration = 0

  // Bookkeeping must never change an execution's outcome or crash the
  // process: a store that fails to RECORD degrades to last-known values,
  // unlike the admission decisions (getState/transition/acquireProbe),
  // whose errors do propagate — a breaker that cannot decide must not admit.
  const reportStoreError = (error: unknown): void => {
    console.error('breakwater: circuit breaker state store threw', error)
  }

  // nextAttemptAt is always openedAt + halfOpenAfter; derived, never stored.
  const nextAttemptAt = (): number | undefined =>
    openedAt === undefined ? undefined : openedAt + halfOpenAfter

  /**
   * The open timing is only meaningful while the circuit is actually open
   * (openedAt also during half-open, as the moment the period started).
   * Gating here keeps a mirror that went stale — e.g. a peer closed the
   * shared circuit — from showing a countdown on a closed breaker.
   */
  const timing = (): Pick<CircuitBreakerStats, 'openedAt' | 'nextAttemptAt'> => {
    if (localState === 'open') return { openedAt, nextAttemptAt: nextAttemptAt() }
    if (localState === 'half-open') return { openedAt }
    return {}
  }

  // Monotonic read tokens: async reads land in dispatch order only by luck,
  // and a slow old read must not overwrite the mirror a newer one just fed.
  let countersReadSeq = 0
  let latencyReadSeq = 0

  const syncCounters = (): void => {
    try {
      const counters = store.getCounters(name)
      // An async store feeds the mirror when the read lands; stats() answers
      // synchronously from last-known values either way.
      if (counters instanceof Promise) {
        const seq = ++countersReadSeq
        counters.then((value) => { if (seq === countersReadSeq) lastCounters = value }, reportStoreError)
      } else {
        lastCounters = counters
      }
    } catch (error) {
      reportStoreError(error)
    }
  }

  const syncLatency = (): void => {
    if (store.getLatency === undefined) return
    try {
      const latency = store.getLatency(name)
      if (latency instanceof Promise) {
        const seq = ++latencyReadSeq
        latency.then((value) => { if (seq === latencyReadSeq) lastLatency = value }, reportStoreError)
      } else {
        lastLatency = latency
      }
    } catch (error) {
      reportStoreError(error)
    }
  }

  /** Counters only — cheap enough for the rejection path. */
  const snapshot = (): CircuitBreakerStats => {
    syncCounters()
    return { state: localState, ...lastCounters, lastError, ...timing() }
  }

  const stats = (): CircuitBreakerStats => {
    syncLatency()
    const current = snapshot()
    return lastLatency === undefined ? current : { ...current, latency: lastLatency }
  }

  const changeState = (from: BreakerState, to: BreakerState, correlationId?: string): void => {
    localState = to
    const snapshot = stats()
    if (to === 'open') emitter.emit('open', { stats: snapshot, correlationId })
    else if (to === 'closed') emitter.emit('close', { stats: snapshot, correlationId })
    else if (to === 'half-open') emitter.emit('halfOpen', { stats: snapshot, correlationId })
    emitter.emit('stateChange', { from, to, stats: snapshot, correlationId })
  }

  const trip = async (from: BreakerState, correlationId?: string, guardGen?: number): Promise<void> => {
    if (await store.transition(name, from, 'open')) {
      if (guardGen !== undefined && guardGen !== probeGeneration) {
        // The half-open period this failure belonged to ended while the CAS
        // travelled: the trip landed on a FRESH period. Hand the state back
        // — best effort until stores can fence the CAS with a generation.
        await store.transition(name, 'open', from)
        return
      }
      openedAt = Date.now()
      consecutive = 0
      changeState(from, 'open', correlationId)
    } else {
      localState = await store.getState(name)
    }
  }

  const rejectFast = (reason: 'circuit_open' | 'isolated', correlationId: string): never => {
    emitter.emit('reject', { reason, correlationId })
    throw reason === 'isolated' ? new IsolatedError() : new CircuitOpenError(snapshot())
  }

  const onSuccess = async (wasProbe: boolean, probeGen: number, durationMs: number, correlationId: string): Promise<void> => {
    try {
      await store.recordSuccess(name, durationMs)
    } catch (error) {
      reportStoreError(error)
    }
    consecutive = 0
    syncCounters()
    emitter.emit('success', { durationMs, correlationId })

    // The generation is re-checked HERE, after the store write: with an
    // async store the write can outlive the half-open period it belongs to,
    // and a stale success must not count towards the current one's majority.
    if (wasProbe && probeGen === probeGeneration) {
      probeSuccesses++
      if (probeSuccesses >= successesToClose) {
        try {
          if (await store.transition(name, 'half-open', 'closed')) {
            if (probeGen !== probeGeneration) {
              // The period flipped while the CAS travelled: this close
              // belongs to a dead period and just closed a fresh one. Hand
              // the state back — best effort until stores can fence the CAS.
              await store.transition(name, 'closed', 'half-open')
              return
            }
            // The close is committed: announce it no matter what the
            // bookkeeping below does.
            try {
              await store.resetCounters(name)
            } catch (error) {
              reportStoreError(error)
            }
            openedAt = undefined
            changeState('half-open', 'closed', correlationId)
          }
        } catch (error) {
          // Closing is retried by the next probe; staying half-open is the
          // safe degradation when the store cannot answer.
          reportStoreError(error)
        }
      }
    }
  }

  const onFailure = async (stateAtEntry: BreakerState, probeGen: number, error: unknown, durationMs: number, correlationId: string): Promise<void> => {
    try {
      await store.recordFailure(name, durationMs)
      lastError = error
      lastCounters = await store.getCounters(name)
    } catch (storeError) {
      lastError = error
      reportStoreError(storeError)
    }
    emitter.emit('failure', { error, durationMs, correlationId })

    try {
      if (stateAtEntry === 'half-open') {
        // Re-checked after the awaits: a failure from a stale probe belongs
        // to an aborted period and must not reopen the circuit the current
        // period is recovering. The guardGen covers the remaining window —
        // the CAS itself travelling while the period flips.
        if (probeGen === probeGeneration) await trip('half-open', correlationId, probeGen)
        return
      }

      if (consecutiveFailures !== undefined) {
        consecutive++
        if (consecutive >= consecutiveFailures) await trip('closed', correlationId)
        return
      }

      if (lastCounters.totalCalls >= minimumCalls && lastCounters.failureRate >= failureThreshold) {
        await trip('closed', correlationId)
      }
    } catch (storeError) {
      // A store that cannot execute the trip leaves the local mirror as-is;
      // the next failure retries. The caller still gets the original error.
      reportStoreError(storeError)
    }
  }

  const base = basePolicy(async (fn, ctx) => {
    ctx.signal.throwIfAborted()

    let state = await store.getState(name)
    localState = state

    if (state === 'isolated') rejectFast('isolated', ctx.correlationId)

    if (state === 'open' && openedAt === undefined) {
      // Another instance sharing the store tripped the circuit; we never saw
      // the trip, so start the cooldown from first observation. A distributed
      // store may later own openedAt to share the exact timing.
      openedAt = Date.now()
    }

    if (state === 'open') {
      const probeAt = nextAttemptAt()
      const probeAllowed = probeAt !== undefined && Date.now() >= probeAt
      if (probeAllowed && await store.transition(name, 'open', 'half-open')) {
        probeGeneration++
        probeSuccesses = 0
        probesInFlight = 0
        changeState('open', 'half-open', ctx.correlationId)
        state = 'half-open'
      } else {
        rejectFast('circuit_open', ctx.correlationId)
      }
    }

    let probeGen = 0
    if (state === 'half-open') {
      // Check and reserve the slot synchronously — an await between the two
      // would let N concurrent callers all read the same stale count.
      if (probesInFlight >= halfOpenCalls) {
        rejectFast('circuit_open', ctx.correlationId)
      }
      probesInFlight++
      probeGen = probeGeneration

      let admitted = false
      try {
        admitted = await store.acquireProbe(name)
      } finally {
        if (!admitted && probeGen === probeGeneration) probesInFlight--
      }
      if (!admitted) rejectFast('circuit_open', ctx.correlationId)
    }

    const started = Date.now()

    try {
      const result = await fn(ctx)
      await onSuccess(state === 'half-open', probeGen, Date.now() - started, ctx.correlationId)
      return result
    } catch (error) {
      // Cancellations and ignored errors count as neither success nor failure.
      if (!ctx.signal.aborted && failureIf(error)) {
        await onFailure(state, probeGen, error, Date.now() - started, ctx.correlationId)
      }
      throw error
    } finally {
      // A stale probe's slot belongs to a period that no longer exists.
      if (state === 'half-open' && probeGen === probeGeneration) probesInFlight--
    }
  })

  const policy = {
    ...base,
    kind: 'circuitBreaker' as const,
    get state () {
      return localState
    },
    stats,

    async isolate () {
      for (let i = 0; i < 4; i++) {
        const current = await store.getState(name)
        if (current === 'isolated') {
          localState = 'isolated'
          return
        }
        if (await store.transition(name, current, 'isolated')) {
          changeState(current, 'isolated')
          return
        }
      }
      throw new Error(`could not isolate breaker "${name}": state kept changing`)
    },

    async unisolate () {
      if (await store.transition(name, 'isolated', 'closed')) {
        // The transition is committed: the caller must see it announced even
        // if the counter cleanup fails (contained like any bookkeeping).
        try {
          await store.resetCounters(name)
        } catch (error) {
          reportStoreError(error)
        }
        consecutive = 0
        openedAt = undefined
        lastError = undefined
        changeState('isolated', 'closed')
      }
    },

    async reset () {
      try {
        await store.resetCounters(name)
      } catch (error) {
        reportStoreError(error)
      }
      consecutive = 0
      probeSuccesses = 0
      lastError = undefined
      const current = await store.getState(name)
      localState = current
      // Isolation is deliberate and only unisolate() leaves it: reset clears
      // the counters but never un-isolates.
      if (current !== 'closed' && current !== 'isolated' && await store.transition(name, current, 'closed')) {
        openedAt = undefined
        changeState(current, 'closed')
      }
      syncCounters()
    }
  }
  return withObservable(policy, emitter)
}
