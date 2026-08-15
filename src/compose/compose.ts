import { basePolicy, type Execution, type ExecutionContext, type Policy } from '../policy'

export interface ComposedStatsEntry {
  /** The inner policy's kind ('circuitBreaker', 'bulkhead', ...). */
  kind: string
  /** That policy's stats() snapshot. */
  stats: unknown
}

/** A policy that holds something releasable — a subscription, a timer. */
interface Disposable {
  dispose?: () => void
}

export interface ComposedPolicy extends Policy {
  readonly kind: 'compose'
  /** The composed policies, outermost first. */
  readonly policies: readonly Policy[]
  /**
   * Aggregated snapshot: one entry per inner policy exposing stats(), with
   * nested compositions flattened. Policies without stats() are skipped.
   */
  stats: () => ComposedStatsEntry[]
  /**
   * Releases what the composed policies hold — a circuit breaker's state
   * store subscription, today. Reaches nested compositions, skips policies
   * with nothing to release, and is safe to call more than once.
   *
   * Without it the only handle on a breaker built through `resilience()` or
   * the registry would be the composition itself, and its subscription could
   * never be let go.
   */
  dispose: () => void
}

/**
 * Combines policies into a single policy, outermost first: compose(a, b, c)
 * runs as a(b(c(fn))) — read it exactly like the nested calls.
 *
 * The result implements Policy, so compositions compose again. Any object
 * implementing the Policy contract (execute/wrap/invoke) can participate.
 */
export function compose (...policies: Policy[]): ComposedPolicy {
  if (policies.length === 0) {
    throw new RangeError('compose() requires at least one policy')
  }

  const base = basePolicy(async <T>(fn: Execution<T>, ctx: ExecutionContext) => {
    const run = policies.reduceRight<Execution<T>>(
      (inner, policy) => async (c) => await policy.invoke(inner, c),
      fn
    )
    return await run(ctx)
  })

  const stats = (): ComposedStatsEntry[] =>
    policies.flatMap((policy) => {
      const source = policy as Policy & { stats?: () => unknown }
      if (typeof source.stats !== 'function') return []
      if (policy.kind === 'compose') {
        const nested = source.stats()
        return Array.isArray(nested) ? nested as ComposedStatsEntry[] : []
      }
      return [{ kind: policy.kind ?? 'custom', stats: source.stats() }]
    })

  // A frozen copy: the exposed list can never rewrite the invoke chain,
  // which closes over the private rest-parameter array.
  const dispose = (): void => {
    for (const policy of policies) {
      const releasable = policy as Disposable
      if (typeof releasable.dispose === 'function') releasable.dispose()
    }
  }

  return { ...base, kind: 'compose' as const, policies: Object.freeze([...policies]), stats, dispose }
}
