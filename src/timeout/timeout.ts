import { TimeoutError } from '../errors'
import { assertPositiveFinite } from '../validate'
import { basePolicy, neverAbortedSignal, type Policy } from '../policy'
import { createEmitter, withObservable, type Observable } from '../events'

export interface TimeoutOptions {
  /**
   * - `cooperative` (default): aborts the context signal and waits for the
   *   function to observe it and settle. Nothing keeps running unobserved,
   *   but the function must honor the signal.
   * - `aggressive`: aborts the signal and rejects with TimeoutError
   *   immediately; the original promise keeps running orphaned. Use it only
   *   when the function cannot be trusted to observe the signal, and be
   *   aware of the leaked work.
   */
  mode?: 'cooperative' | 'aggressive'
}

export interface TimeoutEvents extends Record<string, unknown> {
  timeout: { ms: number, mode: 'cooperative' | 'aggressive', correlationId: string }
}

export interface TimeoutPolicy extends Policy, Observable<TimeoutEvents> {
  readonly kind: 'timeout'
}

/** Rejects with the signal's reason as soon as (or if already) aborted. */
async function rejectOnAbort (signal: AbortSignal): Promise<never> {
  return await new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

/**
 * True when the rejection is our abort surfacing through the function under
 * a different identity. The name check is sufficient: a function rethrowing
 * the reason itself rethrows the TimeoutError, which the caller recognises
 * by identity before ever asking here.
 */
const isAbortSurface = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError'

export function timeout (ms: number, options: TimeoutOptions = {}): TimeoutPolicy {
  assertPositiveFinite('timeout ms', ms)
  const mode = options.mode ?? 'cooperative'
  const emitter = createEmitter<TimeoutEvents>()

  const base = basePolicy(async (fn, ctx) => {
    ctx.signal.throwIfAborted()

    const controller = new AbortController()
    let timeoutError: TimeoutError | undefined

    // Deliberately NOT unref'd: while an execution is in flight the caller
    // is awaiting this policy, and an unref'd timer would let the process
    // exit mid-call with the promise forever unsettled. clearTimeout in the
    // finally already guarantees nothing outlives the call.
    const timer = setTimeout(() => {
      timeoutError = new TimeoutError(ms, mode)
      controller.abort(timeoutError)
    }, ms)

    // Skip the composite when the parent can never abort — avoids a
    // per-call dependent registration on the long-lived sentinel signal.
    const signal = ctx.signal === neverAbortedSignal
      ? controller.signal
      : AbortSignal.any([ctx.signal, controller.signal])

    try {
      const promise = Promise.resolve(fn({ ...ctx, signal }))

      if (mode === 'aggressive') {
        // Race the composite so external cancellation also rejects promptly
        // (the whole point of aggressive is not trusting fn to observe it).
        // Racing also marks the abandoned execution as handled, so a
        // rejection arriving after we gave up cannot reach the process.
        return await Promise.race([promise, rejectOnAbort(signal)])
      }

      return await promise
    } catch (error) {
      // Cancellation is not a timeout: propagate the caller's reason as-is.
      // This single guard owns the invariant — even when the deadline fired
      // first, a caller that cancelled before the call settled hears nothing
      // about a timeout.
      if (ctx.signal.aborted) throw error

      if (timeoutError !== undefined) {
        if (error === timeoutError) {
          emitter.emit('timeout', { ms, mode, correlationId: ctx.correlationId })
          throw error
        }
        // The function may surface our abort as its own error type (e.g.
        // fetch's AbortError): normalize it, keeping the original as cause.
        if (isAbortSurface(error)) {
          emitter.emit('timeout', { ms, mode, correlationId: ctx.correlationId })
          throw new TimeoutError(ms, mode, { cause: error })
        }
        // A genuine domain failure that happened to land after the deadline
        // must not be masked as a timeout.
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  })

  return withObservable({ ...base, kind: 'timeout' as const }, emitter)
}
