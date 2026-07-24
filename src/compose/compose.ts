import { basePolicy, type Execution, type ExecutionContext, type Policy } from '../policy'

/**
 * Combines policies into a single policy, outermost first: compose(a, b, c)
 * runs as a(b(c(fn))) — read it exactly like the nested calls.
 *
 * The result implements Policy, so compositions compose again. Any object
 * implementing the Policy contract (execute/wrap/invoke) can participate.
 */
export function compose (...policies: Policy[]): Policy {
  if (policies.length === 0) {
    throw new RangeError('compose() requires at least one policy')
  }

  return basePolicy(async <T>(fn: Execution<T>, ctx: ExecutionContext) => {
    const run = policies.reduceRight<Execution<T>>(
      (inner, policy) => async (c) => await policy.invoke(inner, c),
      fn
    )
    return await run(ctx)
  })
}
