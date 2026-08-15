import { type ScriptDefinition } from './port'

/**
 * Reads the server clock. Every instance sharing a circuit then agrees on
 * when its open period started and which bucket a call lands in — the whole
 * point of moving the timing off the individual process.
 */
const NOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`

/**
 * Sums the live buckets and drops the expired ones in the same pass, so a
 * circuit nobody reads never accumulates dead fields.
 *
 * Expects: `now`, KEYS[1] = window hash, `bucketMs`, `windowMs`.
 */
const SUMMARISE = `
local cutoff = now - windowMs
local all = redis.call('HGETALL', KEYS[1])
local successes = 0
local failures = 0
local stale = {}
for i = 1, #all, 2 do
  local field = all[i]
  local sep = string.find(field, ':', 1, true)
  local start = sep and tonumber(string.sub(field, 1, sep - 1))
  local value = tonumber(all[i + 1])
  if not start or not value then
    -- A field this store did not write: another tenant on the same prefix, a
    -- stray HSET, a hand edit. Drop it instead of raising, which would fail
    -- every counter read from here on and never clear itself.
    stale[#stale + 1] = field
  elseif start + bucketMs <= cutoff then
    stale[#stale + 1] = field
  elseif string.sub(field, sep + 1) == 's' then
    successes = successes + value
  else
    failures = failures + value
  end
end
-- Chunked: unpack() dies past ~8000 arguments, and a hash that grew that far
-- is exactly when the sweep matters. Throwing here would degrade the whole
-- store and leave the oversized hash in place for the next attempt.
for i = 1, #stale, 500 do
  redis.call('HDEL', KEYS[1], unpack(stale, i, math.min(i + 499, #stale)))
end
return { successes, failures }
`

/**
 * The state of a circuit, as three strings. Absent fields answer with the
 * defaults of a circuit nobody has touched, so a first read needs no write.
 */
export const READ_STATE: ScriptDefinition = {
  numberOfKeys: 1,
  lua: `
local cur = redis.call('HMGET', KEYS[1], 'state', 'fence', 'openedAt')

-- A read is evidence the circuit is still in use, so it renews the lease:
-- without this the ttl would measure "time since the last transition", and a
-- circuit sitting open under constant traffic would expire out from under the
-- fleet. An isolated circuit is skipped — it was PERSISTed on purpose, and
-- renewing it here would quietly hand its expiry back.
if cur[1] and cur[1] ~= 'isolated' then
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
end
local state = cur[1]
if not state then state = 'closed' end
local fence = cur[2]
if not fence then fence = '0' end
local openedAt = cur[3]
if not openedAt then openedAt = '' end
return { state, fence, openedAt }
`
}

/**
 * The fenced compare-and-set, and the reason this store can be shared: the
 * swap lands only if the circuit is still in `from` AND no transition has
 * happened since the caller read `fence`. A decision that was taken before
 * a round trip and arrives after the world moved on is refused here, in one
 * atomic step, rather than compensated afterwards.
 *
 * KEYS: state hash, probe lock, announce channel. ARGV: from, to, fence, ttl ms.
 */
export const COMPARE_AND_SET: ScriptDefinition = {
  numberOfKeys: 3,
  lua: `
local cur = redis.call('HMGET', KEYS[1], 'state', 'fence', 'openedAt')
local state = cur[1]
if not state then state = 'closed' end
local fence = tonumber(cur[2])
if not fence then fence = 0 end
local openedAt = cur[3]
if not openedAt then openedAt = '' end

if state ~= ARGV[1] or fence ~= tonumber(ARGV[3]) then
  return { 0, state, tostring(fence), openedAt }
end

local to = ARGV[2]
local nextFence = fence + 1
local nextOpenedAt = ''
if to == 'open' then
${NOW}
  nextOpenedAt = tostring(now)
elseif to == 'half-open' then
  nextOpenedAt = openedAt
end

redis.call('HSET', KEYS[1], 'state', to, 'fence', nextFence)
if nextOpenedAt ~= '' then
  redis.call('HSET', KEYS[1], 'openedAt', nextOpenedAt)
else
  redis.call('HDEL', KEYS[1], 'openedAt')
end

-- Isolation is a human decision — a maintenance window, a kill switch — and
-- it must outlive any lease: a circuit that un-isolated itself after a ttl
-- would put a dependency back in traffic that somebody deliberately took out.
if to == 'isolated' then
  redis.call('PERSIST', KEYS[1])
else
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
end

-- The probe election belongs to the half-open period: leaving it frees the
-- lock immediately instead of making the next period wait out a TTL.
if to ~= 'half-open' then
  redis.call('DEL', KEYS[2])
end

-- Announced inside the same script as the swap, so a peer never hears about
-- a transition that did not commit. Delivery is best effort by nature — a
-- subscriber that missed it simply learns on its next read.
redis.call('PUBLISH', KEYS[3], to .. ' ' .. nextFence .. ' ' .. nextOpenedAt)

return { 1, to, tostring(nextFence), nextOpenedAt }
`
}

/**
 * Records one outcome into the bucket the server clock says it belongs to.
 *
 * KEYS: window hash. ARGV: 's' | 'f', bucket ms, ttl ms.
 */
export const RECORD: ScriptDefinition = {
  numberOfKeys: 1,
  lua: `
${NOW}
local bucketMs = tonumber(ARGV[2])
local bucket = now - (now % bucketMs)
redis.call('HINCRBY', KEYS[1], bucket .. ':' .. ARGV[1], 1)
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
`
}

/** Sums the window and sweeps what expired. KEYS: window hash. ARGV: bucket ms, window ms. */
export const COUNTERS: ScriptDefinition = {
  numberOfKeys: 1,
  lua: `
${NOW}
local bucketMs = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
${SUMMARISE}
`
}

/**
 * Elects the instance allowed to probe, and keeps electing the same one for
 * the rest of the period: a majority has to come from somewhere, and the
 * holder needs several probes to reach it. Everyone else is refused, which
 * is what keeps a recovering dependency from being hit by the whole fleet.
 *
 * KEYS: probe lock. ARGV: instance id, ttl ms.
 */
export const ACQUIRE_PROBE: ScriptDefinition = {
  numberOfKeys: 1,
  lua: `
local holder = redis.call('GET', KEYS[1])
if not holder then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
  return 1
end
if holder == ARGV[1] then
  -- Still ours: extend the lease rather than let it lapse mid-recovery.
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
  return 1
end
return 0
`
}

/** Clears the counters. KEYS: window hash. */
export const RESET_COUNTERS: ScriptDefinition = {
  numberOfKeys: 1,
  lua: 'return redis.call(\'DEL\', KEYS[1])'
}

/** Drops everything stored for a name. KEYS: state hash, window hash, probe lock. */
export const DELETE: ScriptDefinition = {
  numberOfKeys: 3,
  lua: 'return redis.call(\'DEL\', KEYS[1], KEYS[2], KEYS[3])'
}

/** Every script the store registers, by the name it is called with. */
export const SCRIPTS: Record<string, ScriptDefinition> = {
  bwReadState: READ_STATE,
  bwCompareAndSet: COMPARE_AND_SET,
  bwRecord: RECORD,
  bwCounters: COUNTERS,
  bwAcquireProbe: ACQUIRE_PROBE,
  bwResetCounters: RESET_COUNTERS,
  bwDelete: DELETE
}
