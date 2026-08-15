import { type Policy } from '../policy'
import { assertNonEmptyString } from '../validate'
import { resilience, type ResilienceOptions } from '../compose/resilience'

/**
 * Central, named policy configuration: define once (usually at startup),
 * reuse everywhere by name — instead of loose instances scattered across
 * modules drifting out of sync.
 */
export interface PolicyRegistry {
  /**
   * Builds and stores a policy under a unique name. Accepts a resilience()
   * options object or any prebuilt Policy (e.g. a custom compose()
   * pipeline). Building is eager: configuration errors surface here, at
   * startup, not on the first request. Defining a name twice throws.
   */
  define: (name: string, config: ResilienceOptions | Policy) => Policy
  /**
   * Defines every entry of the record — central config in one call. Not
   * atomic: a failing entry throws (naming the offending key) and leaves the
   * entries defined before it in place — acceptable for startup config,
   * where the process should die anyway.
   */
  defineAll: (configs: Record<string, ResilienceOptions | Policy>) => void
  /** Returns the named policy; throws listing the known names when absent. */
  get: (name: string) => Policy
  has: (name: string) => boolean
  /** The defined names, in definition order. */
  names: () => string[]
  /**
   * Removes one definition (mostly useful in tests), releasing it if the
   * registry built it — see `clear()` for why that condition matters.
   */
  delete: (name: string) => boolean
  /**
   * Removes every definition (mostly useful in tests), releasing the ones the
   * registry built.
   *
   * Only those: a prebuilt policy handed to `define()` is still held by
   * whoever built it, and tearing it down here would break a caller that is
   * still using it. What the registry built from options, though, it is the
   * sole owner of — dropping the entry would otherwise leave a breaker's
   * subscription alive with nothing left to release it.
   */
  clear: () => void
}

const isPolicy = (value: ResilienceOptions | Policy): value is Policy => {
  const candidate = value as Partial<Policy>
  return typeof candidate.execute === 'function' &&
    typeof candidate.wrap === 'function' &&
    typeof candidate.invoke === 'function'
}

/**
 * The registry name becomes the default `name` of the pipeline, so
 * executions, retries, timeouts and rejections come out identified without
 * any per-policy wiring — resilience() already falls back to it for every
 * inner policy. Explicit names always win.
 *
 * The breaker is the exception: its name is the key its state lives under, so
 * a shared store needs the registry name even when the pipeline reports under
 * a different display name.
 */
const withDefaultNames = (name: string, options: ResilienceOptions): ResilienceOptions => ({
  ...options,
  // An absent name and an explicit `undefined` mean the same thing here: no
  // name was chosen, so the registry key stands in.
  name: options.name ?? name,
  ...(options.circuitBreaker !== undefined && { circuitBreaker: { name, ...options.circuitBreaker } })
})

export function createPolicyRegistry (initial?: Record<string, ResilienceOptions | Policy>): PolicyRegistry {
  const entries = new Map<string, Policy>()
  // What the registry built, and is therefore the registry's to release.
  const built = new WeakSet<Policy>()

  const release = (policy: Policy | undefined): void => {
    if (policy === undefined || !built.has(policy)) return
    const releasable = policy as { dispose?: () => void }
    if (typeof releasable.dispose === 'function') releasable.dispose()
  }

  const registry: PolicyRegistry = {
    define (name, config) {
      assertNonEmptyString('policy name', name)
      if (entries.has(name)) {
        throw new RangeError(`policy "${name}" is already defined — a second definition would silently diverge from the first`)
      }

      const prebuilt = isPolicy(config)
      const policy = prebuilt ? config : resilience(withDefaultNames(name, config))
      if (!prebuilt) built.add(policy)
      entries.set(name, policy)
      return policy
    },

    defineAll (configs) {
      for (const [name, config] of Object.entries(configs)) {
        try {
          registry.define(name, config)
        } catch (error) {
          throw new RangeError(`policy "${name}": ${(error as Error).message}`, { cause: error })
        }
      }
    },

    get (name) {
      const policy = entries.get(name)
      if (policy === undefined) {
        const known = entries.size === 0 ? '(none defined)' : [...entries.keys()].join(', ')
        throw new RangeError(`unknown policy "${name}" — defined policies: ${known}`)
      }
      return policy
    },

    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    delete (name) {
      release(entries.get(name))
      return entries.delete(name)
    },

    clear () {
      // Emptied first, so a release that goes wrong cannot leave the registry
      // holding entries it has already torn down. Nothing built here throws
      // from dispose() today — this just keeps that from being load-bearing.
      const defined = [...entries.values()]
      entries.clear()
      for (const policy of defined) release(policy)
    }
  }

  if (initial !== undefined) registry.defineAll(initial)

  return registry
}

/**
 * The default shared registry. Applications with a single policy
 * configuration can use it directly; libraries and multi-tenant setups
 * should create their own with createPolicyRegistry().
 */
export const policies = createPolicyRegistry()
