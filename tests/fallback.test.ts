import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { fallback } from '../src/fallback/fallback'
import { isFallbackFailedError } from '../src/errors'

describe('fallback()', () => {
  test('requires at least one handler', () => {
    assert.throws(() => fallback([]), RangeError)
  })

  test('is transparent on success', async () => {
    const policy = fallback('replacement')
    assert.equal(await policy.execute(() => 'original'), 'original')
  })

  test('falls back to a plain value', async () => {
    const policy = fallback('replacement')
    assert.equal(await policy.execute(() => { throw new Error('down') }), 'replacement')
  })

  test('falls back to a function receiving the error and the context', async () => {
    const policy = fallback((error: unknown, ctx) => {
      assert.match((error as Error).message, /down/)
      assert.equal(ctx.correlationId, 'req-1')
      return 'computed'
    })

    const result = await policy.execute(() => { throw new Error('down') }, { correlationId: 'req-1' })
    assert.equal(result, 'computed')
  })

  test('walks the chain until a handler succeeds, emitting one event per attempt', async () => {
    const indexes: number[] = []
    const policy = fallback<string>([
      () => { throw new Error('cache empty') },
      () => 'from second handler'
    ])
    policy.on('fallback', ({ handlerIndex }) => indexes.push(handlerIndex))

    assert.equal(await policy.execute(() => { throw new Error('down') }), 'from second handler')
    assert.deepEqual(indexes, [0, 1])
  })

  test('throws FallbackFailedError when the whole chain fails', async () => {
    const policy = fallback<string>([
      () => { throw new Error('handler A failed') },
      () => { throw new Error('handler B failed') }
    ])

    await assert.rejects(
      policy.execute(() => { throw new Error('operation failed') }),
      (error: unknown) => {
        assert.ok(isFallbackFailedError(error))
        assert.match((error.originalError as Error).message, /operation failed/)
        assert.match((error.cause as Error).message, /handler B failed/)
        return true
      }
    )
  })

  test('respects fallbackIf, rethrowing errors that should not activate it', async () => {
    const policy = fallback('replacement', {
      fallbackIf: (error) => !(error instanceof RangeError)
    })

    await assert.rejects(policy.execute(() => { throw new RangeError('bad input') }), RangeError)
    assert.equal(await policy.execute(() => { throw new Error('down') }), 'replacement')
  })

  test('cancellation never activates the fallback', async () => {
    const policy = fallback('replacement')
    const controller = new AbortController()

    await assert.rejects(
      policy.execute(({ signal }) => {
        controller.abort(new Error('cancelled'))
        assert.equal(signal.aborted, true)
        throw new Error('aborted work')
      }, { signal: controller.signal }),
      /aborted work/
    )
  })
})
