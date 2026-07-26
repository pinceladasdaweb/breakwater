import { basePolicy, type Policy } from '../policy'
import { type MetricsCollector } from './collector'

export interface MetricsPolicyOptions {
  /** The `name` reported in onExecution events. */
  name?: string
  /**
   * Arrives as the `policy` field of onExecution events. Default:
   * 'pipeline' ('resilience' when wired by resilience()).
   */
  label?: string
}

export interface MetricsPolicy extends Policy {
  readonly kind: 'metrics'
}

/**
 * A policy that reports every execution flowing through it — outcome and
 * total duration — to the collector's onExecution. Place it outermost in a
 * compose() so it measures the whole pipeline.
 *
 * A collector that throws is reported and ignored: monitoring must never
 * change an execution's outcome.
 */
export function metricsPolicy (collector: MetricsCollector, options: MetricsPolicyOptions = {}): MetricsPolicy {
  const { name, label = 'pipeline' } = options

  const report = (outcome: 'success' | 'failure', started: number, correlationId: string): void => {
    try {
      collector.onExecution?.({
        policy: label,
        name,
        outcome,
        durationMs: Date.now() - started,
        correlationId
      })
    } catch (error) {
      console.error('breakwater: metrics collector threw', error)
    }
  }

  const base = basePolicy(async (fn, ctx) => {
    const started = Date.now()
    try {
      const result = await fn(ctx)
      report('success', started, ctx.correlationId)
      return result
    } catch (error) {
      report('failure', started, ctx.correlationId)
      throw error
    }
  })

  return { ...base, kind: 'metrics' as const }
}

export interface AttachMetricsOptions {
  /** The `name` reported in every wired event. */
  name?: string
}

type LooseObservable = Policy & {
  on?: (event: string, listener: (payload: unknown) => void) => unknown
  off?: (event: string, listener: (payload: unknown) => void) => unknown
}

/**
 * Wires a MetricsCollector to a policy — or an array of policies, or a
 * whole composition (inner policies are discovered through `kind` and
 * `policies`). This is what resilience() uses internally; call it directly
 * when you build pipelines with compose(). Returns a detach function that
 * unsubscribes everything (calling it more than once is safe).
 *
 * Notes:
 * - onExecution is not an event — for pipeline timing, compose a
 *   metricsPolicy() as the outermost policy.
 * - Attaching twice duplicates events, and a resilience({ metrics }) result
 *   is ALREADY wired — attaching the same collector to it double-reports.
 */
export function attachMetrics (
  target: Policy | readonly Policy[],
  collector: MetricsCollector,
  options: AttachMetricsOptions = {}
): () => void {
  const { name } = options
  const detachers: Array<() => void> = []

  const subscribe = (policy: LooseObservable, event: string, handler: (payload: unknown) => void): void => {
    if (typeof policy.on !== 'function' || typeof policy.off !== 'function') return
    policy.on(event, handler)
    const off = policy.off
    detachers.push(() => { off.call(policy, event, handler) })
  }

  const visit = (policy: Policy): void => {
    if (policy.kind === 'compose' && 'policies' in policy) {
      const inner = (policy as { policies: unknown }).policies
      if (Array.isArray(inner)) (inner as Policy[]).forEach(visit)
      return
    }

    const observable = policy as LooseObservable
    switch (policy.kind) {
      case 'retry':
        subscribe(observable, 'retry', (payload) => {
          const { attempt, delay } = payload as { attempt: number, delay: number }
          collector.onRetry?.({ name, attempt, delayMs: delay })
        })
        break
      case 'timeout':
        subscribe(observable, 'timeout', (payload) => {
          const { ms } = payload as { ms: number }
          collector.onTimeout?.({ name, ms })
        })
        break
      case 'circuitBreaker':
        subscribe(observable, 'stateChange', (payload) => {
          const { from, to } = payload as { from: string, to: string }
          collector.onStateChange?.({ name, from, to })
        })
        subscribe(observable, 'reject', (payload) => {
          const { reason } = payload as { reason: 'circuit_open' | 'isolated' }
          collector.onReject?.({ policy: 'circuitBreaker', name, reason })
        })
        break
      case 'bulkhead':
        subscribe(observable, 'reject', () => {
          collector.onReject?.({ policy: 'bulkhead', name, reason: 'bulkhead_full' })
        })
        break
      case 'rateLimit':
        subscribe(observable, 'reject', () => {
          collector.onReject?.({ policy: 'rateLimit', name, reason: 'rate_limited' })
        })
        break
      case 'fallback':
        subscribe(observable, 'fallback', (payload) => {
          const { handlerIndex } = payload as { handlerIndex: number }
          collector.onFallback?.({ name, handlerIndex })
        })
        break
    }
  }

  const targets: readonly Policy[] = Array.isArray(target) ? target : [target as Policy]
  targets.forEach(visit)

  return () => {
    for (const detach of detachers) detach()
    detachers.length = 0
  }
}
