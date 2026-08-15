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
}

/**
 * The shape of an ioredis client, structurally — the driver is never
 * imported, and a real client satisfies this without a cast at the call
 * site (the script methods it installs are reached dynamically below).
 */
interface IoredisLike {
  defineCommand: (name: string, definition: { numberOfKeys: number, lua: string }) => void
}

/**
 * Adapts an ioredis (or ioredis Cluster) client. `defineCommand` installs
 * the script as a method on the client, which ioredis calls through
 * EVALSHA and reloads on NOSCRIPT.
 */
export function fromIoredis (client: IoredisLike): RedisPort {
  return {
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
