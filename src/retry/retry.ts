import { basePolicy, type Policy } from '../policy'
import { exponential, type Backoff } from './backoff'
import { RetryExhaustedError, isBreakwaterError } from '../errors'
import { assertPositiveFinite, assertPositiveInt } from '../validate'
import { createEmitter, withObservable, type Observable } from '../events'

export interface RetryOptions {
  /**
   * Total number of executions, including the first one. `1` means no retry.
   * Default: 3.
   */
  attempts?: number
  /**
   * Time budget in ms for all attempts and delays combined. When the next
   * delay would exceed it, the policy gives up immediately.
   */
  deadline?: number
  /** Delay strategy between attempts. Default: exponential full jitter. */
  backoff?: Backoff
  /**
   * Decides whether an error is worth retrying. By default every error is
   * retried except circuit breaker rejections (CIRCUIT_OPEN /
   * CIRCUIT_ISOLATED) — retrying against an open circuit is wasted work.
   */
  retryIf?: (error: unknown) => boolean
  /** Cancels pending retries and delays, combined with the context signal. */
  signal?: AbortSignal
}

export interface RetryEvents extends Record<string, unknown> {
  retry: { attempt: number, error: unknown, delay: number, correlationId: string }
  giveUp: { attempts: number, error: unknown, correlationId: string }
}

export interface RetryPolicy extends Policy, Observable<RetryEvents> {}

const defaultRetryIf = (error: unknown): boolean =>
  !(isBreakwaterError(error) && !error.retryable)

/** Waits `ms`, rejecting with the signal's reason if it aborts first. */
async function sleep (ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    // Deliberately NOT unref'd: the caller is awaiting the retried call, and
    // an unref'd delay would let the process exit mid-retry with the promise
    // forever unsettled.
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function retry (options: RetryOptions = {}): RetryPolicy {
  const attempts = options.attempts ?? 3
  assertPositiveInt('attempts', attempts)
  if (options.deadline !== undefined) assertPositiveFinite('deadline', options.deadline)
  const deadline = options.deadline
  const backoff = options.backoff ?? exponential()
  const retryIf = options.retryIf ?? defaultRetryIf
  const emitter = createEmitter<RetryEvents>()

  const base = basePolicy(async (fn, ctx) => {
    const signal = options.signal !== undefined
      ? AbortSignal.any([ctx.signal, options.signal])
      : ctx.signal
    signal.throwIfAborted()

    const start = Date.now()
    let lastError: unknown

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await fn({ ...ctx, signal, attempt: attempt - 1 })
      } catch (error) {
        lastError = error

        // Cancellation is not a failure: never retry once the signal aborted.
        if (signal.aborted) throw error
        if (!retryIf(error)) throw error

        if (attempt === attempts) break

        const delay = backoff(attempt)
        if (deadline !== undefined && Date.now() - start + delay > deadline) {
          emitter.emit('giveUp', { attempts: attempt, error, correlationId: ctx.correlationId })
          throw new RetryExhaustedError(attempt, error)
        }

        emitter.emit('retry', { attempt, error, delay, correlationId: ctx.correlationId })
        await sleep(delay, signal)
      }
    }

    emitter.emit('giveUp', { attempts, error: lastError, correlationId: ctx.correlationId })
    throw new RetryExhaustedError(attempts, lastError)
  })

  return withObservable(base, emitter)
}
