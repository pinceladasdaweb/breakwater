import { basePolicy, type Policy } from '../policy'
import { type MetricsCollector } from './collector'

export interface MetricsPolicyOptions {
  /** The `name` reported in onExecution events. */
  name?: string
  /** The `policy` label reported in onExecution events. Default: 'pipeline'. */
  label?: string
}

/**
 * A policy that reports every execution flowing through it — outcome and
 * total duration — to the collector's onExecution. Place it outermost in a
 * compose() so it measures the whole pipeline.
 */
export function metricsPolicy (collector: MetricsCollector, options: MetricsPolicyOptions = {}): Policy {
  const { name, label = 'pipeline' } = options

  const base = basePolicy(async (fn, ctx) => {
    const started = Date.now()
    try {
      const result = await fn(ctx)
      collector.onExecution?.({
        policy: label,
        name,
        outcome: 'success',
        durationMs: Date.now() - started,
        correlationId: ctx.correlationId
      })
      return result
    } catch (error) {
      collector.onExecution?.({
        policy: label,
        name,
        outcome: 'failure',
        durationMs: Date.now() - started,
        correlationId: ctx.correlationId
      })
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
 * unsubscribes everything.
 *
 * Note: onExecution is not an event — for pipeline timing, compose a
 * metricsPolicy() as the outermost policy.
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
      (policy as { policies: readonly Policy[] }).policies.forEach(visit)
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
