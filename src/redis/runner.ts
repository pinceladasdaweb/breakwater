import { type RedisPort } from './port'
import { assertPositiveFinite } from '../validate'

export interface RunnerOptions {
  client: RedisPort
  /**
   * How long to wait for one Redis command before treating it as a failure.
   * This bound belongs here rather than to the caller's client: a driver that
   * queues commands while disconnected (ioredis does, by default) never
   * rejects, so without it a dead Redis would not degrade — it would stall
   * every call waiting on it. Default: 500.
   */
  commandTimeoutMs?: number
  /** How long to stay local after Redis fails, before trying it again. Default: 5_000. */
  degradeForMs?: number
  /** Called once per outage. Default: reports to console.error. */
  onDegraded?: (error: unknown) => void
  /** Called once when Redis answers again. Default: nothing. */
  onRecovered?: () => void
}

export interface Runner {
  /**
   * Runs one script, and never rejects: a failure degrades and answers from
   * `fallback` instead. `force` bypasses the cooldown for a caller that
   * genuinely cannot answer from local state.
   */
  run: <T>(
    script: string,
    keys: string[],
    args: Array<string | number>,
    parse: (raw: unknown) => T,
    fallback: () => T,
    force?: boolean
  ) => Promise<T>
  /**
   * Whether this policy is currently deciding on its own — the outage flag
   * or the cooldown. This is the operator-facing question.
   */
  isDegraded: () => boolean
  /**
   * Whether the NEXT run() would bypass Redis, which is the cooldown alone.
   * Narrower than `isDegraded`: once the cooldown elapses, the next command
   * really does go to Redis even though recovery is not confirmed until it
   * answers. Callers that must know which of the two worlds they are in —
   * "may I still invent local state?" — ask this one.
   */
  isSkipping: () => boolean
}

/**
 * The shared discipline for talking to Redis from a resilience policy: bound
 * every command, never reject, degrade once per outage and leave the backend
 * alone while it is down.
 *
 * Both Redis-backed stores go through this, so the promise is written once
 * rather than kept in two places that can drift.
 */
export function createRunner (options: RunnerOptions): Runner {
  const { client } = options
  const commandTimeoutMs = options.commandTimeoutMs ?? 500
  const degradeForMs = options.degradeForMs ?? 5_000
  assertPositiveFinite('commandTimeoutMs', commandTimeoutMs)
  assertPositiveFinite('degradeForMs', degradeForMs)

  const onDegraded = options.onDegraded ?? ((error: unknown) => {
    console.error('breakwater: redis unreachable — this policy is local until it recovers', error)
  })
  const onRecovered = options.onRecovered ?? (() => {})

  let degradedUntil = 0
  let degraded = false
  // Commands land out of order, so health is decided by the newest one that
  // COMPLETED, not by the last one to finish. Without this a single slow
  // command failing late takes a provably healthy connection local.
  let commandSeq = 0
  let newestSuccess = 0

  const report = (callback: () => void, label: string): void => {
    try {
      callback()
    } catch (error) {
      console.error(`breakwater: redis ${label} threw`, error)
    }
  }

  const degrade = (error: unknown): void => {
    degradedUntil = Date.now() + degradeForMs
    if (degraded) return
    degraded = true
    // The promise is that nothing here rejects. A logger that throws must not
    // turn a Redis outage into a failed request.
    report(() => onDegraded(error), 'onDegraded')
  }

  const bounded = async (command: Promise<unknown>): Promise<unknown> => {
    // The command may still reject long after we gave up on it, and nobody
    // would be listening.
    command.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        command,
        // Deliberately NOT unref'd: this timer is the only thing keeping the
        // caller's promise alive while a silent backend is being waited on,
        // and an idle process would otherwise drain the loop and leave that
        // caller hanging — the exact failure the bound exists to prevent.
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`redis command exceeded ${commandTimeoutMs}ms`)), commandTimeoutMs)
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  return {
    isDegraded: () => degraded || Date.now() < degradedUntil,
    isSkipping: () => Date.now() < degradedUntil,

    async run (script, keys, args, parse, fallback, force = false) {
      if (!force && Date.now() < degradedUntil) return fallback()

      const seq = ++commandSeq
      let raw: unknown
      try {
        raw = await bounded(client.runScript(script, keys, args))
      } catch (error) {
        if (seq > newestSuccess) degrade(error)
        return fallback()
      }

      if (seq > newestSuccess) {
        newestSuccess = seq
        if (degraded) {
          degraded = false
          // Cleared together: reporting recovery while still serving from
          // local state would tell an operator the policy is shared again
          // when every decision is still this instance's alone.
          degradedUntil = 0
          report(onRecovered, 'onRecovered')
        }
      }

      try {
        return parse(raw)
      } catch (error) {
        // Not a reachability problem: a reply we cannot read means the client
        // or the server is speaking a shape this store does not know.
        console.error('breakwater: unexpected reply from redis', error)
        return fallback()
      }
    }
  }
}
