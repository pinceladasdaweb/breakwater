import { FallbackFailedError } from '../errors'
import { createEmitter, withObservable, type Observable } from '../events'
import { basePolicy, type Execution, type ExecutionContext, type Policy } from '../policy'

/**
 * A fallback handler: a plain value, or a function that receives the error
 * and the context and produces a replacement value.
 *
 * Note: functions are always treated as handlers — to fall back *to* a
 * function value, wrap it: `fallback(() => myFunction)`.
 */
export type FallbackHandler<T> = T | ((error: unknown, ctx: ExecutionContext) => T | Promise<T>)

export interface FallbackOptions {
  /** Decides which errors activate the fallback. Default: every error. */
  fallbackIf?: (error: unknown) => boolean
}

export interface FallbackEvents extends Record<string, unknown> {
  fallback: { error: unknown, handlerIndex: number, correlationId: string }
}

export interface FallbackPolicy extends Policy, Observable<FallbackEvents> {
  readonly kind: 'fallback'
}

/**
 * Replaces a failed execution with a value. Accepts a single handler or a
 * chain (tries A, then B, then C); when the operation and every handler
 * fail, throws FallbackFailedError.
 *
 * Cancellation never activates the fallback: being cancelled is not failing.
 */
export function fallback<T> (
  handler: FallbackHandler<T> | Array<FallbackHandler<T>>,
  options: FallbackOptions = {}
): FallbackPolicy {
  const handlers = Array.isArray(handler) ? handler : [handler]
  if (handlers.length === 0) {
    throw new RangeError('fallback requires at least one handler')
  }
  const fallbackIf = options.fallbackIf ?? (() => true)
  const emitter = createEmitter<FallbackEvents>()

  const base = basePolicy(async <R>(fn: Execution<R>, ctx: ExecutionContext): Promise<R> => {
    try {
      return await fn(ctx)
    } catch (error) {
      if (ctx.signal.aborted) throw error
      if (!fallbackIf(error)) throw error

      let lastHandlerError: unknown
      for (const [index, candidate] of handlers.entries()) {
        // Re-checked per handler, as retry re-checks per attempt: a caller
        // that aborted while an earlier handler was running must not pay for
        // the ones still queued behind it, each of which may be a network
        // call of its own.
        if (ctx.signal.aborted) throw error
        emitter.emit('fallback', { error, handlerIndex: index, correlationId: ctx.correlationId })
        try {
          const value = typeof candidate === 'function'
            ? await (candidate as (error: unknown, ctx: ExecutionContext) => T | Promise<T>)(error, ctx)
            : candidate
          // The policy contract is generic per call while handlers are typed
          // at the factory; the caller guarantees they line up.
          return value as unknown as R
        } catch (handlerError) {
          lastHandlerError = handlerError
        }
      }
      throw new FallbackFailedError(error, lastHandlerError)
    }
  })

  return withObservable({ ...base, kind: 'fallback' as const }, emitter)
}
