import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { resilience } from '../src/compose/resilience'
import { fixed } from '../src/retry/backoff'
import { type MetricsCollector } from '../src/metrics/collector'
import { isBulkheadRejectedError, isRateLimitedError, isRetryExhaustedError, isTimeoutError } from '../src/errors'
import { drain } from './helpers'

describe('resilience()', () => {
  test('with no options it just runs the function', async () => {
    const policy = resilience()
    assert.equal(await policy.execute(() => 'plain'), 'plain')
  })

  test('accepts a number as timeout shortcut', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const policy = resilience({ timeout: 50 })

    const promise = policy.execute(async ({ signal }) => {
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const assertion = assert.rejects(promise, isTimeoutError)

    await drain()
    t.mock.timers.tick(50)
    await assertion
  })

  test('default order: retry wraps the breaker, fallback catches the give-up', async () => {
    const policy = resilience({
      retry: { attempts: 2, backoff: fixed(0) },
      circuitBreaker: { consecutiveFailures: 10, name: 'payments' },
      fallback: () => 'stale response'
    })
    let calls = 0

    const result = await policy.execute(() => { calls++; throw new Error('down') })

    assert.equal(result, 'stale response')
    assert.equal(calls, 2)
  })

  test('wires a MetricsCollector to every policy without manual setup', async () => {
    const seen: string[] = []
    const collector: MetricsCollector = {
      onExecution: (e) => seen.push(`execution:${e.outcome}:${e.policy}`),
      onRetry: (e) => seen.push(`retry:${e.attempt}`),
      onStateChange: (e) => seen.push(`state:${e.from}->${e.to}:${e.name ?? ''}`),
      onFallback: (e) => seen.push(`fallback:${e.handlerIndex}`)
    }

    const policy = resilience({
      retry: { attempts: 2, backoff: fixed(0) },
      circuitBreaker: { consecutiveFailures: 2, name: 'payments' },
      fallback: () => 'stale',
      metrics: collector
    })

    const result = await policy.execute(() => { throw new Error('down') })

    assert.equal(result, 'stale')
    assert.deepEqual(seen, [
      'retry:1',
      'state:closed->open:payments',
      'fallback:0',
      'execution:success:resilience'
    ])
  })

  test('reports failure outcome when nothing rescues the execution', async () => {
    const outcomes: string[] = []
    const collector: MetricsCollector = {
      onExecution: (e) => outcomes.push(e.outcome)
    }

    const policy = resilience({
      retry: { attempts: 2, backoff: fixed(0) },
      metrics: collector
    })

    await assert.rejects(
      policy.execute(() => { throw new Error('down') }),
      isRetryExhaustedError
    )
    assert.deepEqual(outcomes, ['failure'])
  })

  test('bulkhead slots in outside the breaker and reports rejections to metrics', async () => {
    const rejections: string[] = []
    const policy = resilience({
      bulkhead: { concurrency: 1 },
      circuitBreaker: { consecutiveFailures: 10, name: 'guarded' },
      metrics: { onReject: (e) => rejections.push(`${e.policy}:${e.reason}`) }
    })

    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const slow = policy.execute(async () => { await gate; return 'slow' })
    for (let i = 0; i < 10; i++) await Promise.resolve()

    await assert.rejects(policy.execute(() => 'overflow'), isBulkheadRejectedError)
    assert.deepEqual(rejections, ['bulkhead:bulkhead_full'])

    release()
    assert.equal(await slow, 'slow')
  })

  test('rateLimit slots in and reports rejections to metrics', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] })
    t.mock.timers.setTime(1_000_000)
    const rejections: string[] = []
    const policy = resilience({
      rateLimit: { limit: 1, interval: 1_000, name: 'quota' },
      metrics: { onReject: (e) => rejections.push(`${e.policy}:${e.reason}:${e.name ?? ''}`) }
    })

    assert.equal(await policy.execute(() => 'first'), 'first')
    await assert.rejects(policy.execute(() => 'second'), isRateLimitedError)
    assert.deepEqual(rejections, ['rateLimit:rate_limited:quota'])
  })

  test('fallbackOptions.fallbackIf is honored', async () => {
    const policy = resilience({
      fallback: 'replacement',
      fallbackOptions: { fallbackIf: (e) => !(e instanceof RangeError) }
    })

    await assert.rejects(policy.execute(() => { throw new RangeError('no fallback') }), RangeError)
    assert.equal(await policy.execute(() => { throw new Error('down') }), 'replacement')
  })
})
