import { slidingWindow, tokenBucket, type Limiter, type RateLimitDecision, type RateLimitQuota, type RateLimitStore } from '../rate-limit/rate-limit'
import { assertNonEmptyString } from '../validate'
import { type ScriptDefinition, type RedisPort } from './port'
import { createRunner } from './runner'

/**
 * Reads the server clock, so every instance buckets a call the same way.
 * The same NOW the state store uses.
 */
const NOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`

/**
 * Tokens refill continuously and a call takes one, all in one atomic step —
 * deciding and consuming separately is how two instances both spend the last
 * token.
 *
 * KEYS: bucket hash. ARGV: limit, interval ms, capacity, ttl ms.
 */
export const TOKEN_BUCKET: ScriptDefinition = {
  numberOfKeys: 1,
  lua: `
${NOW}
local limit = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local rate = limit / interval

local cur = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(cur[1])
local at = tonumber(cur[2])
if not tokens or not at then
  tokens = capacity
  at = now
end

-- Monotonic clamp, as in the in-process bucket: after a backwards clock step
-- time simply stands still for the bucket. No tokens minted when the clock
-- recovers, and no freeze either.
if now > at then
  tokens = math.min(capacity, tokens + (now - at) * rate)
  at = now
end

local admitted = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  admitted = 1
else
  -- Verified rather than trusted, exactly as the in-process bucket does:
  -- float rounding can leave the naive ceil one millisecond short, and a
  -- caller that honours retryAfterMs with a single scheduled retry would
  -- then be rejected again for the same slot.
  retry = math.max(1, math.ceil((1 - tokens) / rate))
  while tokens + retry * rate < 1 do
    retry = retry + 1
  end
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', at)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return { admitted, retry, math.floor(tokens) }
`
}

/**
 * Exact: never more than `limit` admissions in any window of `interval` ms,
 * counted across the fleet. One sorted set per name, trimmed on every call.
 *
 * KEYS: window sorted set. ARGV: limit, interval ms, ttl ms, unique member.
 */
export const SLIDING_WINDOW: ScriptDefinition = {
  numberOfKeys: 1,
  lua: `
${NOW}
local limit = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local cutoff = now - interval

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
local used = redis.call('ZCARD', KEYS[1])

if used < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
  return { 1, 0, math.max(0, limit - used - 1) }
end

-- Full: the oldest admission decides when a slot frees.
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = math.max(1, math.ceil(tonumber(oldest[2]) + interval - now))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return { 0, retry, 0 }
`
}

const SCRIPTS: Record<string, ScriptDefinition> = {
  bwTokenBucket: TOKEN_BUCKET,
  bwSlidingWindow: SLIDING_WINDOW
}

export interface RedisRateLimitOptions {
  /** Anything that can register a Lua script and run it by name. */
  client: RedisPort
  /** Prepended to every key. Default: 'bwrl:'. */
  prefix?: string
  /**
   * How long to wait for one Redis command before treating it as a failure.
   * Default: 500. See the state store for why this bound belongs here.
   */
  commandTimeoutMs?: number
  /** How long to enforce the quota locally after Redis fails. Default: 5_000. */
  degradeForMs?: number
  /** Called when Redis becomes unreachable. Default: reports to console.error. */
  onDegraded?: (error: unknown) => void
  /** Called when Redis answers again. Default: nothing. */
  onRecovered?: () => void
}

export interface RedisRateLimitStore extends RateLimitStore {
  /** Whether the quota is currently being enforced by this instance alone. */
  isDegraded: () => boolean
}

/**
 * A quota shared across every instance of your service: `limit` per
 * `interval` for the fleet, not per process.
 *
 * Both strategies keep the semantics of their in-process counterparts —
 * continuous refill for the token bucket, exactness for the sliding window —
 * and each decision is a single atomic script, because deciding and
 * consuming in two steps is how two instances both spend the last slot.
 *
 * **When Redis is unreachable the quota becomes local**, enforced by this
 * instance alone with the same numbers. A fleet of N then allows up to N
 * times the rate for the length of the outage — deliberately, because the
 * alternative is a rate limiter that rejects everything the moment its
 * bookkeeping is unreachable. Nothing here rejects.
 */
export function redisRateLimit (options: RedisRateLimitOptions): RedisRateLimitStore {
  const { client } = options
  const prefix = options.prefix ?? 'bwrl:'
  assertNonEmptyString('prefix', prefix)
  if (prefix.includes('{') || prefix.includes('}')) {
    throw new RangeError(`prefix must not contain braces, got ${JSON.stringify(prefix)} — the hash tag is reserved for the quota name`)
  }

  const { run, isDegraded } = createRunner({
    client,
    ...(options.commandTimeoutMs !== undefined && { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.degradeForMs !== undefined && { degradeForMs: options.degradeForMs }),
    onDegraded: options.onDegraded ?? ((error: unknown) => {
      console.error('breakwater: redis rate limit unreachable — the quota is local until it recovers', error)
    }),
    ...(options.onRecovered !== undefined && { onRecovered: options.onRecovered })
  })

  for (const [name, definition] of Object.entries(SCRIPTS)) {
    try {
      const registered = client.defineScript(name, definition) as { then?: unknown } | undefined
      if (typeof registered?.then === 'function') Promise.resolve(registered).catch(() => {})
    } catch {
      // The first call degrades and reports.
    }
  }

  const instanceId = globalThis.crypto.randomUUID()
  let admissions = 0

  const key = (name: string): string => `${prefix}{${name}}`

  // The local fallback IS the in-process limiter: same strategy, same
  // numbers, same verified retry-after. Reimplementing it here is how the
  // degraded path quietly stops matching the shared one.
  const local = new Map<string, { key: string, limiter: Limiter }>()
  const localFor = (name: string, quota: RateLimitQuota): Limiter => {
    // Keyed on the quota too: two policies can share a store and a name with
    // different limits, and the JSDoc promises the quota travelling per call
    // is the source of truth — including here.
    const key = `${quota.strategy}:${quota.limit}:${quota.interval}:${quota.burst}`
    const found = local.get(name)
    if (found !== undefined && found.key === key) return found.limiter

    const limiter = quota.strategy === 'token-bucket'
      ? tokenBucket(quota.limit, quota.interval, quota.burst)
      : slidingWindow(quota.limit, quota.interval)
    local.set(name, { key, limiter })
    return limiter
  }

  const locally = (name: string, quota: RateLimitQuota): RateLimitDecision => {
    const limiter = localFor(name, quota)
    const now = Date.now()
    const retryAfterMs = limiter.tryAcquire(now)
    return retryAfterMs === 0
      ? { admitted: true, retryAfterMs: 0, remaining: limiter.remaining(now) }
      : { admitted: false, retryAfterMs, remaining: 0 }
  }

  return {
    isDegraded,

    acquire: async (name, quota) => await run(
      quota.strategy === 'token-bucket' ? 'bwTokenBucket' : 'bwSlidingWindow',
      [key(name)],
      quota.strategy === 'token-bucket'
        ? [quota.limit, quota.interval, quota.burst, Math.ceil(quota.interval * 2)]
        : [quota.limit, quota.interval, Math.ceil(quota.interval * 2), `${instanceId}:${++admissions}`],
      (raw) => {
        const [admitted, retryAfterMs, remaining] = raw as [number, number, number]
        if (typeof admitted !== 'number' || typeof remaining !== 'number') {
          throw new TypeError(`unreadable rate limit decision from redis: ${JSON.stringify(raw)}`)
        }
        return { admitted: admitted === 1, retryAfterMs, remaining }
      },
      () => locally(name, quota)
    )
  }
}
