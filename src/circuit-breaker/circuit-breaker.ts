import { type Window } from './window'

const randomUUID = (): string => globalThis.crypto.randomUUID()
import { basePolicy, type Policy } from '../policy'
import { CircuitOpenError, IsolatedError } from '../errors'
import { assertPositiveFinite, assertPositiveInt } from '../validate'
import { createEmitter, withObservable, type Observable } from '../events'
import { memoryStore, type BreakerState, type LatencyStats, type StateSnapshot, type StateStore, type WindowCounters } from './state-store'

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
  // Guarded here rather than at the first execution: a store missing the
  // fenced pair is a wiring mistake, and finding out mid-request — in
  // production, inside a policy — is the worst possible moment. TypeScript
  // cannot guard it for JavaScript callers, nor for anyone upgrading a
  // store written against the previous getState/transition contract.
  const required = ['readState', 'compareAndSet', 'recordSuccess', 'recordFailure', 'getCounters', 'resetCounters', 'acquireProbe'] as const
  const missing = required.filter((method) => typeof store[method] !== 'function')
  if (missing.length > 0) {
    throw new TypeError(`stateStore for breaker "${name}" is missing ${missing.join(', ')} — a store written against the previous getState/transition contract needs updating to readState and compareAndSet`)
  }
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
  // The period the mirrors above describe. Probes carry the fence they were
  // admitted under; results and slot releases from a period that has since
  // ended are ignored so they cannot close, reopen or unblock the current
  // one — and the same fence goes into every swap, so the store rejects a
  // stale decision even when it was this process that fell behind.
  let currentFence = 0

  // Bookkeeping must never change an execution's outcome or crash the
  // process: a store that fails to RECORD degrades to last-known values,
  // unlike the admission decisions (readState/compareAndSet/acquireProbe),
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
  // The same guard for the state mirror. A compare-and-set outcome needs no
  // token: it reports the store as of the moment it ran, so it always wins.
  let observeSeq = 0
  let adoptedSeq = 0

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

  /**
   * Refreshes the mirrors from a snapshot the store just handed us — the
   * single place the local view of the circuit moves.
   *
   * Two rules earn their keep with a shared store. The probe bookkeeping is
   * scoped to a period, so an unseen fence starts it over: the period may
   * have been opened by a peer we never watched transition, and counters
   * from the previous one would block or close the new one. And a store
   * that does not report the period's timing leaves ours alone: the
   * cooldown is then counted from first observation, and clobbering it on
   * every read would push the probe moment forever out of reach.
   */
  const adopt = (snapshot: StateSnapshot, seq: number = ++observeSeq): void => {
    // A snapshot read before another one can still land after it. Adopting it
    // would rewind the mirror to a period we already left — zeroing the probe
    // bookkeeping of the CURRENT period, whose in-flight probes then release
    // a slot nobody was holding. The token is taken at dispatch, so age is
    // decided by when the read started, not by when it happened to return.
    if (seq < adoptedSeq) return
    adoptedSeq = seq

    if (snapshot.fence !== currentFence) {
      currentFence = snapshot.fence
      probeSuccesses = 0
      probesInFlight = 0
    }
    localState = snapshot.state
    if (snapshot.openedAt !== undefined) openedAt = snapshot.openedAt
    else if (snapshot.state !== 'open' && snapshot.state !== 'half-open') openedAt = undefined
  }

  /** Reads the circuit and refreshes the mirrors, ageing the read honestly. */
  const observe = async (): Promise<StateSnapshot> => {
    const seq = ++observeSeq
    const snapshot = await store.readState(name)
    adopt(snapshot, seq)
    return snapshot
  }

  /** Announces a transition that has already been committed and adopted. */
  const changeState = (from: BreakerState, to: BreakerState, correlationId?: string): void => {
    const snapshot = stats()
    if (to === 'open') emitter.emit('open', { stats: snapshot, correlationId })
    else if (to === 'closed') emitter.emit('close', { stats: snapshot, correlationId })
    else if (to === 'half-open') emitter.emit('halfOpen', { stats: snapshot, correlationId })
    emitter.emit('stateChange', { from, to, stats: snapshot, correlationId })
  }

  /**
   * Opens the circuit against the period `fence` identifies. A swap that
   * travelled while the world moved on simply loses — the store rejects it,
   * so a failure from a dead period can no longer reopen a fresh one.
   */
  const trip = async (from: BreakerState, fence: number, correlationId?: string): Promise<void> => {
    const outcome = await store.compareAndSet(name, from, 'open', fence)
    // The outcome carries where the circuit is now either way, so a lost
    // race refreshes the mirror without a second round trip.
    adopt(outcome.snapshot)
    if (!outcome.ok) return
    // A store that does not report the period's timing leaves adopt() holding
    // the PREVIOUS open period's stamp — which would put nextAttemptAt in the
    // past and admit every later call as a probe, forever. This period began
    // now.
    if (outcome.snapshot.openedAt === undefined) openedAt = Date.now()
    consecutive = 0
    changeState(from, 'open', correlationId)
  }

  const rejectFast = (reason: 'circuit_open' | 'isolated', correlationId: string): never => {
    emitter.emit('reject', { reason, correlationId })
    throw reason === 'isolated' ? new IsolatedError() : new CircuitOpenError(snapshot())
  }

  const onSuccess = async (wasProbe: boolean, probeFence: number, durationMs: number, correlationId: string): Promise<void> => {
    try {
      await store.recordSuccess(name, durationMs)
    } catch (error) {
      reportStoreError(error)
    }
    consecutive = 0
    syncCounters()
    emitter.emit('success', { durationMs, correlationId })

    // The fence is re-checked HERE, after the store write: with an async
    // store the write can outlive the half-open period it belongs to, and a
    // stale success must not count towards the current one's majority.
    if (!wasProbe || probeFence !== currentFence) return

    probeSuccesses++
    if (probeSuccesses < successesToClose) return

    try {
      const outcome = await store.compareAndSet(name, 'half-open', 'closed', probeFence)
      adopt(outcome.snapshot)
      if (!outcome.ok) return
      // The close is committed: announce it no matter what the bookkeeping
      // below does.
      try {
        await store.resetCounters(name)
      } catch (error) {
        reportStoreError(error)
      }
      changeState('half-open', 'closed', correlationId)
    } catch (error) {
      // Closing is retried by the next probe; staying half-open is the
      // safe degradation when the store cannot answer.
      reportStoreError(error)
    }
  }

  const onFailure = async (stateAtEntry: BreakerState, probeFence: number, error: unknown, durationMs: number, correlationId: string): Promise<void> => {
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
        // period is recovering. Carrying the same fence into the swap closes
        // the remaining window — the CAS itself travelling while the period
        // flips — because the store refuses it outright.
        if (probeFence === currentFence) await trip('half-open', probeFence, correlationId)
        return
      }

      if (consecutiveFailures !== undefined) {
        consecutive++
        if (consecutive >= consecutiveFailures) await trip('closed', currentFence, correlationId)
        return
      }

      if (lastCounters.totalCalls >= minimumCalls && lastCounters.failureRate >= failureThreshold) {
        await trip('closed', currentFence, correlationId)
      }
    } catch (storeError) {
      // A store that cannot execute the trip leaves the local mirror as-is;
      // the next failure retries. The caller still gets the original error.
      reportStoreError(storeError)
    }
  }

  const base = basePolicy(async (fn, ctx) => {
    ctx.signal.throwIfAborted()

    const entry = await observe()
    let state = entry.state

    if (state === 'isolated') rejectFast('isolated', ctx.correlationId)

    if (state === 'open' && openedAt === undefined) {
      // A peer sharing the store tripped the circuit and the store does not
      // report the period's timing: start the cooldown from first
      // observation. A store that owns `openedAt` shares the exact moment,
      // and then every instance agrees on when probing may start.
      openedAt = Date.now()
    }

    if (state === 'open') {
      const probeAt = nextAttemptAt()
      const probeAllowed = probeAt !== undefined && Date.now() >= probeAt
      if (!probeAllowed) rejectFast('circuit_open', ctx.correlationId)

      const outcome = await store.compareAndSet(name, 'open', 'half-open', entry.fence)
      adopt(outcome.snapshot)
      if (!outcome.ok) rejectFast('circuit_open', ctx.correlationId)
      state = 'half-open'
      changeState('open', 'half-open', ctx.correlationId)
    }

    // The period this execution belongs to: results arriving after it ended
    // are ignored rather than credited to whatever period is current.
    const probeFence = currentFence

    if (state === 'half-open') {
      // Check and reserve the slot synchronously — an await between the two
      // would let N concurrent callers all read the same stale count.
      if (probesInFlight >= halfOpenCalls) {
        rejectFast('circuit_open', ctx.correlationId)
      }
      probesInFlight++

      let admitted = false
      try {
        admitted = await store.acquireProbe(name)
      } finally {
        if (!admitted && probeFence === currentFence) probesInFlight--
      }
      if (!admitted) rejectFast('circuit_open', ctx.correlationId)
    }

    const started = Date.now()

    try {
      const result = await fn(ctx)
      await onSuccess(state === 'half-open', probeFence, Date.now() - started, ctx.correlationId)
      return result
    } catch (error) {
      // Cancellations and ignored errors count as neither success nor failure.
      if (!ctx.signal.aborted && failureIf(error)) {
        await onFailure(state, probeFence, error, Date.now() - started, ctx.correlationId)
      }
      throw error
    } finally {
      // A stale probe's slot belongs to a period that no longer exists.
      if (state === 'half-open' && probeFence === currentFence) probesInFlight--
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
        const current = await observe()
        if (current.state === 'isolated') return

        const outcome = await store.compareAndSet(name, current.state, 'isolated', current.fence)
        adopt(outcome.snapshot)
        if (outcome.ok) {
          changeState(current.state, 'isolated')
          return
        }
      }
      throw new Error(`could not isolate breaker "${name}": state kept changing`)
    },

    async unisolate () {
      const current = await observe()
      if (current.state !== 'isolated') return

      const outcome = await store.compareAndSet(name, 'isolated', 'closed', current.fence)
      adopt(outcome.snapshot)
      if (!outcome.ok) return

      // The transition is committed: the caller must see it announced even
      // if the counter cleanup fails (contained like any bookkeeping).
      try {
        await store.resetCounters(name)
      } catch (error) {
        reportStoreError(error)
      }
      consecutive = 0
      lastError = undefined
      changeState('isolated', 'closed')
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

      const current = await observe()
      // Isolation is deliberate and only unisolate() leaves it: reset clears
      // the counters but never un-isolates.
      if (current.state !== 'closed' && current.state !== 'isolated') {
        const outcome = await store.compareAndSet(name, current.state, 'closed', current.fence)
        adopt(outcome.snapshot)
        if (outcome.ok) changeState(current.state, 'closed')
      }
      syncCounters()
    }
  }
  return withObservable(policy, emitter)
}
