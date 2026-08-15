/**
 * What a shared circuit costs.
 *
 * Measures one protected call end to end, against the in-memory store and
 * against Redis, on the two paths that matter: a healthy call (which reads
 * the state, records the outcome and reads the window) and a fast rejection
 * from an open circuit (which reads the state and the counters it rejects on).
 *
 *   docker run --rm -p 6399:6379 redis:7-alpine
 *   REDIS_URL=redis://127.0.0.1:6399 node --import tsx benchmarks/redis-overhead.mjs
 *
 * The Redis numbers are a FLOOR: a loopback server has no network in it. On a
 * real deployment each round trip carries your actual RTT, and the ratio below
 * matters less than the round-trip count it comes from.
 */
import Redis from 'ioredis'

import { circuitBreaker } from '../src/circuit-breaker/circuit-breaker.ts'
import { memoryStore } from '../src/circuit-breaker/state-store.ts'
import { timeWindow } from '../src/circuit-breaker/window.ts'
import { fromIoredis, redisStore } from '../src/redis/index.ts'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6399'
const ITERATIONS = Number(process.env.ITERATIONS ?? 2_000)
const WARMUP = 200

const percentile = (sorted, q) => sorted[Math.max(1, Math.ceil(q * sorted.length)) - 1]

async function measure (label, run) {
  for (let i = 0; i < WARMUP; i++) await run()

  const durations = new Float64Array(ITERATIONS)
  const started = performance.now()
  for (let i = 0; i < ITERATIONS; i++) {
    const at = performance.now()
    await run()
    durations[i] = performance.now() - at
  }
  const elapsed = performance.now() - started
  durations.sort()

  return {
    label,
    opsPerSecond: Math.round((ITERATIONS / elapsed) * 1000),
    p50: percentile(durations, 0.5),
    p99: percentile(durations, 0.99)
  }
}

const ok = () => 'ok'
const boom = () => { throw new Error('down') }

async function healthy (store, name) {
  const breaker = circuitBreaker({ name, stateStore: store, window: timeWindow(30_000) })
  return await measure(name, async () => { await breaker.execute(ok) })
}

async function rejecting (store, name) {
  const breaker = circuitBreaker({ name, consecutiveFailures: 1, halfOpenAfter: 600_000, stateStore: store, window: timeWindow(30_000) })
  await breaker.execute(boom).catch(() => {})
  return await measure(name, async () => { await breaker.execute(ok).catch(() => {}) })
}

const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 })
await client.flushall()

const rows = [
  await healthy(memoryStore({ window: timeWindow(30_000) }), 'memory · healthy call'),
  await healthy(redisStore({ client: fromIoredis(client) }), 'redis · healthy call'),
  await rejecting(memoryStore({ window: timeWindow(30_000) }), 'memory · fast rejection'),
  await rejecting(redisStore({ client: fromIoredis(client) }), 'redis · fast rejection')
]

console.log(`\n${ITERATIONS} iterations per row, sequential, Redis at ${REDIS_URL}\n`)
console.log('| path | ops/sec | p50 | p99 |')
console.log('|---|---:|---:|---:|')
for (const row of rows) {
  console.log(`| ${row.label} | ${row.opsPerSecond.toLocaleString('en-US')} | ${row.p50.toFixed(3)} ms | ${row.p99.toFixed(3)} ms |`)
}

const [memHealthy, redisHealthy] = rows
console.log(`\nhealthy call: ${(redisHealthy.p50 / memHealthy.p50).toFixed(0)}x the p50 of the in-memory store, +${(redisHealthy.p50 - memHealthy.p50).toFixed(3)} ms absolute\n`)

await client.quit()
