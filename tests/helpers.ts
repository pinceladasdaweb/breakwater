/** Flushes pending microtasks so promise callbacks run between timer ticks. */
export async function drain (): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/**
 * A protected function that never settles on its own and rejects as soon as
 * the pipeline aborts it — the cooperative contract every policy expects.
 *
 * Pass `error` to imitate a driver that raises its own abort type (fetch's
 * AbortError, say) instead of re-throwing the signal's reason.
 */
export function rejectsOnAbort (error?: unknown) {
  return async ({ signal }: { signal: AbortSignal }): Promise<never> => {
    return await new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(error ?? signal.reason),
        { once: true }
      )
    })
  }
}

/**
 * A protected function held in flight until the test lets it finish, so a
 * policy can be observed while an execution occupies it.
 */
export function gated<T = string> (value?: T): {
  fn: () => Promise<T>
  release: () => void
  fail: (error: unknown) => void
} {
  const { promise: gate, resolve, reject } = Promise.withResolvers<void>()
  return {
    fn: async () => {
      await gate
      return (value ?? 'done') as T
    },
    release: () => { resolve() },
    fail: (error) => { reject(error) }
  }
}
