import { basePolicy, type Execution, type ExecutionContext, type Policy } from '../policy'

export interface ComposedStatsEntry {
  /** The inner policy's kind ('circuitBreaker', 'bulkhead', ...). */
  kind: string
  /** That policy's stats() snapshot. */
  stats: unknown
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
      if (policy.kind === 'compose') return source.stats() as ComposedStatsEntry[]
      return [{ kind: policy.kind ?? 'custom', stats: source.stats() }]
    })

  return { ...base, kind: 'compose' as const, policies, stats }
}
