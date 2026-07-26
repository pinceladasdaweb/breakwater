import { BulkheadRejectedError } from '../errors'
import { createEmitter, withObservable, type Observable } from '../events'
import { basePolicy, type ExecutionContext, type Policy } from '../policy'
import { assertPositiveInt, assertNonNegativeInt } from '../validate'

export interface BulkheadOptions {
  /** Maximum concurrent executions. Default: 10. */
  concurrency?: number
  /**
   * Maximum executions waiting for a free slot (FIFO). Default: 0 —
   * saturation rejects immediately.
   */
  queue?: number
  /** Identifies this bulkhead in metrics. */
  name?: string
}

export interface BulkheadStats {
  /** Executions currently holding a slot. */
  active: number
  /** Executions waiting for a slot. */
  queued: number
  concurrency: number
  queueLimit: number
}

export interface BulkheadEvents extends Record<string, unknown> {
  reject: { stats: BulkheadStats, correlationId: string }
}

export interface BulkheadPolicy extends Policy, Observable<BulkheadEvents> {
  stats: () => BulkheadStats
}

/**
 * Limits concurrent executions, protecting the process (and the dependency)
 * from being flooded: up to `concurrency` calls run at once, up to `queue`
 * calls wait in FIFO order, and everything beyond rejects immediately with
 * BulkheadRejectedError.
 */
export function bulkhead (options: BulkheadOptions = {}): BulkheadPolicy {
  const concurrency = options.concurrency ?? 10
  assertPositiveInt('concurrency', concurrency)
  const queueLimit = options.queue ?? 0
  assertNonNegativeInt('queue', queueLimit)

  const emitter = createEmitter<BulkheadEvents>()

  let active = 0
  const waiting: Array<() => void> = []

  const stats = (): BulkheadStats => ({
    active,
    queued: waiting.length,
    concurrency,
    queueLimit
  })

  /**
   * Frees the caller's slot: hands it directly to the next waiter (the
   * count never dips, so a concurrent arrival cannot steal the slot and
   * over-admit) or decrements when nobody waits.
   */
  const release = (): void => {
    const next = waiting.shift()
    if (next !== undefined) next()
    else active--
  }

  const acquire = async (ctx: ExecutionContext): Promise<void> => {
    if (active < concurrency) {
      active++
      return
    }

    if (waiting.length >= queueLimit) {
      emitter.emit('reject', { stats: stats(), correlationId: ctx.correlationId })
      throw new BulkheadRejectedError(stats())
    }

    await new Promise<void>((resolve, reject) => {
      const admit = (): void => {
        ctx.signal.removeEventListener('abort', onAbort)
        resolve()
      }

      const onAbort = (): void => {
        // Leaving the queue must free the position for someone else.
        const index = waiting.indexOf(admit)
        if (index !== -1) waiting.splice(index, 1)
        reject(ctx.signal.reason)
      }

      waiting.push(admit)
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  const base = basePolicy(async (fn, ctx) => {
    ctx.signal.throwIfAborted()

    await acquire(ctx)
    try {
      // The signal may have aborted between admission and resumption; the
      // finally below returns the freshly acquired slot either way.
      ctx.signal.throwIfAborted()
      return await fn(ctx)
    } finally {
      release()
    }
  })

  const policy = {
    ...base,
    stats
  }
  return withObservable(policy, emitter)
}
