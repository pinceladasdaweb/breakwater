import { randomUUID } from 'node:crypto'

/**
 * The context that travels through the whole policy pipeline.
 *
 * It is created by the outermost policy and propagated inwards; policies
 * derive new contexts (never mutate) when they need to change a field.
 */
export interface ExecutionContext {
  /**
   * Combined abort signal: external cancellation, timeouts and retry
   * cancellation all funnel into this single signal. The protected function
   * only ever needs to observe this one.
   */
  readonly signal: AbortSignal
  /** 0 on the first execution; incremented by the retry policy. */
  readonly attempt: number
  /** Travels in every event payload. Generated when not provided. */
  readonly correlationId: string
  /** Free-form data that crosses every policy in the pipeline. */
  readonly metadata: Record<string, unknown>
}

export interface ExecuteOptions {
  /** External cancellation, combined into `ctx.signal`. */
  signal?: AbortSignal
  correlationId?: string
  metadata?: Record<string, unknown>
}

/** The protected function: receives the pipeline context. */
export type Execution<T> = (ctx: ExecutionContext) => Promise<T> | T

/**
 * The contract every policy implements — including the result of compose().
 * Composing policies yields a policy again.
 */
export interface Policy {
  /** Runs `fn` under the protection of this policy. */
  execute: <T>(fn: Execution<T>, options?: ExecuteOptions) => Promise<T>

  /**
   * Decorates a function: same signature in, protected function out.
   * The wrapped function does not receive the context — use execute()
   * when the inner signal is needed. Note: `this` is not forwarded; bind
   * methods before wrapping (`policy.wrap(service.method.bind(service))`).
   */
  wrap: <Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R> | R
  ) => (...args: Args) => Promise<R>

  /**
   * Runs `fn` under this policy within an existing execution context.
   * This is the composition primitive used by compose(); application code
   * should call execute() instead. Any object implementing this contract
   * can participate in composition.
   */
  invoke: <T>(fn: Execution<T>, ctx: ExecutionContext) => Promise<T>

  /**
   * Discriminates the policy type ('retry', 'circuitBreaker', ...) for
   * generic tooling like attachMetrics() and aggregated stats(). Custom
   * policies may omit it.
   */
  readonly kind?: string
}

/** The invoke signature, for policy implementations. */
export type Invoker = <T>(fn: Execution<T>, ctx: ExecutionContext) => Promise<T>

/**
 * Sentinel signal used when the caller provides none. Policies compare
 * against it to skip building composite signals for a parent that can
 * never abort. Internal — not part of the public API.
 */
export const neverAbortedSignal: AbortSignal = new AbortController().signal

export function createContext (options: ExecuteOptions = {}): ExecutionContext {
  return {
    signal: options.signal ?? neverAbortedSignal,
    attempt: 0,
    correlationId: options.correlationId ?? randomUUID(),
    metadata: options.metadata ?? {}
  }
}

/** Builds the execute/wrap surface shared by every policy from its invoke. */
export function basePolicy (invoke: Invoker): Policy {
  const policy: Policy = {
    invoke,
    async execute (fn, options) {
      return await invoke(fn, createContext(options))
    },
    wrap (fn) {
      return async (...args) => await policy.execute(async () => await fn(...args))
    }
  }
  return policy
}
