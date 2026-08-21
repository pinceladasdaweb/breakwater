/**
 * A Lua script the store registers once and then calls by name.
 *
 * `numberOfKeys` is what makes the script routable in a cluster and
 * prefixable at all — it is declared here and enforced on every call.
 */
export interface ScriptDefinition {
  lua: string
  numberOfKeys: number
}

/**
 * The whole surface `redisStore` needs from a Redis client: register a
 * script, then run it by name. Nothing else — no generic command runner,
 * so every operation the store performs is a single atomic script.
 *
 * Keys and arguments travel as two arrays and never as a variadic tail:
 * a misplaced key would otherwise read something nobody named, on a node
 * nobody meant to reach.
 *
 * A client whose driver registers scripts (SHA on the wire, reloaded on
 * NOSCRIPT) plugs straight in; the adapters below cover the popular ones.
 */
export interface RedisPort {
  defineScript: (name: string, definition: ScriptDefinition) => void | Promise<void>
  runScript: (name: string, keys: string[], args: Array<string | number>) => Promise<unknown>
  /**
   * Optional: listen on a channel, and hand back a way to stop.
   *
   * Subscriptions need a connection of their own — a client in subscriber
   * mode cannot run commands — so this is separate from `runScript` and a
   * store without it simply does no pushing.
   */
  subscribe?: (channel: string, onMessage: (message: string) => void) => (() => void) | Promise<() => void>
}

/**
 * The shape of an ioredis client, structurally — the driver is never
 * imported, and a real client satisfies this without a cast at the call
 * site (the script methods it installs are reached dynamically below).
 */
interface IoredisLike {
  defineCommand: (name: string, definition: { numberOfKeys: number, lua: string }) => void
}

interface IoredisSubscriber {
  subscribe: (channel: string) => Promise<unknown>
  unsubscribe: (channel: string) => Promise<unknown>
  on: (event: 'message', listener: (channel: string, message: string) => void) => unknown
  off: (event: 'message', listener: (channel: string, message: string) => void) => unknown
}

/**
 * Adapts an ioredis (or ioredis Cluster) client. `defineCommand` installs
 * the script as a method on the client, which ioredis calls through
 * EVALSHA and reloads on NOSCRIPT.
 *
 * Pass a SECOND connection — `client.duplicate()` — to enable pushed state
 * changes. ioredis puts a subscribed connection into subscriber mode, where
 * it can no longer run commands, so the two cannot be the same.
 */
export function fromIoredis (client: IoredisLike, subscriber?: IoredisSubscriber): RedisPort {
  // One connection carries every channel, so leaving one is only safe when
  // the last listener on it is gone. Without this, disposing one breaker
  // silently stops the pushes for every other breaker sharing its name.
  const listenersPerChannel = new Map<string, number>()

  const drop = (channel: string): void => {
    const left = (listenersPerChannel.get(channel) ?? 1) - 1
    if (left > 0) {
      listenersPerChannel.set(channel, left)
      return
    }
    listenersPerChannel.delete(channel)
    subscriber?.unsubscribe(channel).catch(() => {})
  }

  return {
    ...(subscriber !== undefined && {
      async subscribe (channel: string, onMessage: (message: string) => void) {
        const listener = (from: string, message: string): void => {
          if (from === channel) onMessage(message)
        }
        subscriber.on('message', listener)
        // Counted BEFORE the round trip, not after it. A release landing while
        // this subscribe is still in flight would otherwise read a count that
        // does not include us, reach zero, and UNSUBSCRIBE the channel we are
        // in the middle of acquiring — leaving a live listener attached to a
        // subscription the server no longer has, and pushes silently gone.
        listenersPerChannel.set(channel, (listenersPerChannel.get(channel) ?? 0) + 1)
        try {
          await subscriber.subscribe(channel)
        } catch (error) {
          // The caller never gets a release function for a subscription that
          // did not happen, so giving the count back here is the only chance.
          subscriber.off('message', listener)
          drop(channel)
          throw error
        }

        let released = false
        return () => {
          if (released) return
          released = true
          subscriber.off('message', listener)
          drop(channel)
        }
      }
    }),

    defineScript (name, definition) {
      client.defineCommand(name, { numberOfKeys: definition.numberOfKeys, lua: definition.lua })
    },
    async runScript (name, keys, args) {
      const command = (client as unknown as Record<string, unknown>)[name]
      if (typeof command !== 'function') {
        throw new TypeError(`ioredis has no command "${name}" — defineScript must run before runScript`)
      }
      // The spread happens HERE, at the driver boundary, so the port itself
      // keeps keys and arguments apart.
      return await (command as (...argv: Array<string | number>) => Promise<unknown>).call(client, ...keys, ...args)
    }
  }
}

/** The shape of a node-redis v4+ client, structurally. */
interface NodeRedisLike {
  scriptLoad: (lua: string) => Promise<string>
  evalSha: (sha: string, options: { keys: string[], arguments: string[] }) => Promise<unknown>
}

const isNoScript = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('NOSCRIPT')

/**
 * Adapts a node-redis v4+ client, whose scripts are normally declared when
 * the client is created — too early for a store built later. This registers
 * lazily instead: SCRIPT LOAD on first use, then EVALSHA, reloading once if
 * the server forgot the script (a restart or a failover).
 */
export function fromNodeRedis (client: NodeRedisLike): RedisPort {
  const scripts = new Map<string, { lua: string, sha?: string }>()

  return {
    defineScript (name, definition) {
      scripts.set(name, { lua: definition.lua })
    },
    async runScript (name, keys, args) {
      const script = scripts.get(name)
      if (script === undefined) {
        throw new TypeError(`no script named "${name}" — defineScript must run before runScript`)
      }
      // node-redis wants every argument as a string.
      const argv = args.map(String)
      script.sha ??= await client.scriptLoad(script.lua)
      try {
        return await client.evalSha(script.sha, { keys, arguments: argv })
      } catch (error) {
        if (!isNoScript(error)) throw error
        script.sha = await client.scriptLoad(script.lua)
        return await client.evalSha(script.sha, { keys, arguments: argv })
      }
    }
  }
}
