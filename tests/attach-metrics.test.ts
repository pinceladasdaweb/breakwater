import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { attachMetrics, metricsPolicy } from '../src/metrics/attach'
import { type MetricsCollector } from '../src/metrics/collector'
import { compose } from '../src/compose/compose'
import { basePolicy } from '../src/policy'
import { retry } from '../src/retry/retry'
import { fixed } from '../src/retry/backoff'
import { timeout } from '../src/timeout/timeout'
import { circuitBreaker } from '../src/circuit-breaker/circuit-breaker'
import { bulkhead } from '../src/bulkhead/bulkhead'
import { rateLimit } from '../src/rate-limit/rate-limit'
import { fallback } from '../src/fallback/fallback'
import { drain } from './helpers'

function recordingCollector (events: string[]): MetricsCollector {
  return {
    onExecution: (e) => events.push(`execution:${e.policy}:${e.outcome}:${e.name ?? ''}`),
    onRetry: (e) => events.push(`retry:${e.attempt}:${e.name ?? ''}`),
    onTimeout: (e) => events.push(`timeout:${e.ms}`),
    onStateChange: (e) => events.push(`state:${e.from}->${e.to}`),
    onFallback: (e) => events.push(`fallback:${e.handlerIndex}`),
    onReject: (e) => events.push(`reject:${e.policy}:${e.reason}`)
  }
}

describe('policy kinds', () => {
  test('every built-in policy declares its kind', () => {
    assert.equal(retry().kind, 'retry')
    assert.equal(timeout(1_000).kind, 'timeout')
    assert.equal(circuitBreaker().kind, 'circuitBreaker')
    assert.equal(bulkhead().kind, 'bulkhead')
    assert.equal(rateLimit({ limit: 1, interval: 1_000 }).kind, 'rateLimit')
    assert.equal(fallback('x').kind, 'fallback')
    assert.equal(compose(timeout(1_000)).kind, 'compose')
  })
})

describe('attachMetrics()', () => {
  test('wires a whole composition through kind discovery', async () => {
    const events: string[] = []
    const pipeline = compose(
      fallback('rescued'),
      retry({ attempts: 2, backoff: fixed(0) }),
      circuitBreaker({ consecutiveFailures: 1, name: 'api' })
    )
    attachMetrics(pipeline, recordingCollector(events), { name: 'api' })

    const result = await pipeline.execute(() => { throw new Error('down') })

    assert.equal(result, 'rescued')
    // Attempt 1 fails and opens the circuit; retry schedules attempt 2,
    // which hits the open breaker; the non-retryable rejection reaches the
    // fallback.
    assert.deepEqual(events, [
      'state:closed->open',
      'retry:1:api',
      'reject:circuitBreaker:circuit_open',
      'fallback:0'
    ])
  })

  test('wires bulkhead and rateLimit rejections', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const events: string[] = []
    const rl = rateLimit({ limit: 1, interval: 60_000 })
    const bh = bulkhead({ concurrency: 1 })
    attachMetrics([rl, bh], recordingCollector(events))

    await rl.execute(() => 'a')
    await assert.rejects(rl.execute(() => 'b'))

    let release: (() => void) = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow = bh.execute(async () => { await gate })
    await drain()
    await assert.rejects(bh.execute(() => 'x'))
    release()
    await slow

    assert.deepEqual(events, ['reject:rateLimit:rate_limited', 'reject:bulkhead:bulkhead_full'])
  })

  test('detach unsubscribes everything', async () => {
    const events: string[] = []
    const policy = retry({ attempts: 2, backoff: fixed(0) })
    const detach = attachMetrics(policy, recordingCollector(events))

    await assert.rejects(policy.execute(() => { throw new Error('down') }))
    assert.equal(events.length, 1)

    detach()
    await assert.rejects(policy.execute(() => { throw new Error('down') }))
    assert.equal(events.length, 1) // no new events after detach
  })

  test('custom policies without kind or events are skipped harmlessly', () => {
    const custom = basePolicy(async (fn, ctx) => await fn(ctx))
    const detach = attachMetrics(custom, recordingCollector([]))
    detach()
  })
})

describe('metricsPolicy()', () => {
  test('reports success and failure with total pipeline duration', async () => {
    const events: string[] = []
    const pipeline = compose(
      metricsPolicy(recordingCollector(events), { name: 'api' }),
      retry({ attempts: 2, backoff: fixed(0) })
    )

    await pipeline.execute(() => 'ok')
    await assert.rejects(pipeline.execute(() => { throw new Error('down') }))

    assert.deepEqual(events, ['execution:pipeline:success:api', 'execution:pipeline:failure:api'])
  })
})

describe('aggregated stats()', () => {
  test('compose exposes one entry per inner policy with stats, flattening nested compositions', async () => {
    const inner = compose(
      bulkhead({ concurrency: 5 }),
      circuitBreaker({ consecutiveFailures: 3 })
    )
    const pipeline = compose(
      retry({ attempts: 2, backoff: fixed(0) }), // no stats(): skipped
      rateLimit({ limit: 10, interval: 1_000 }),
      inner
    )

    await pipeline.execute(() => 'ok')
    const entries = pipeline.stats()

    assert.deepEqual(entries.map((e) => e.kind), ['rateLimit', 'bulkhead', 'circuitBreaker'])
    const breaker = entries.find((e) => e.kind === 'circuitBreaker')?.stats as { state: string }
    assert.equal(breaker.state, 'closed')
    const limiter = entries.find((e) => e.kind === 'rateLimit')?.stats as { remaining: number }
    assert.equal(limiter.remaining, 9)
  })

  test('resilience() result exposes the same aggregated stats', async () => {
    const { resilience } = await import('../src/compose/resilience')
    const policy = resilience({
      rateLimit: { limit: 5, interval: 1_000 },
      circuitBreaker: { consecutiveFailures: 2 },
      timeout: 1_000
    })

    await policy.execute(() => 'ok')
    const kinds = policy.stats().map((e) => e.kind)

    assert.deepEqual(kinds, ['rateLimit', 'circuitBreaker'])
  })

  test('composed pipelines expose their inner policies for introspection', () => {
    const to = timeout(1_000)
    const rt = retry()
    const pipeline = compose(rt, to)

    assert.deepEqual(pipeline.policies, [rt, to])
  })
})
