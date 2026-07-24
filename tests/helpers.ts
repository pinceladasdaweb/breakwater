/** Flushes pending microtasks so promise callbacks run between timer ticks. */
export async function drain (): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
