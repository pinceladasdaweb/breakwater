import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { basePolicy, createContext } from '../src/policy'

describe('createContext', () => {
  test('applies defaults: never-aborted signal, attempt 0, generated correlationId', () => {
    const ctx = createContext()

    assert.equal(ctx.signal.aborted, false)
    assert.equal(ctx.attempt, 0)
    assert.match(ctx.correlationId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(ctx.metadata, {})
  })

  test('honors provided signal, correlationId and metadata', () => {
    const controller = new AbortController()
    const ctx = createContext({
      signal: controller.signal,
      correlationId: 'req-42',
      metadata: { tenant: 'acme' }
    })

    assert.equal(ctx.signal, controller.signal)
    assert.equal(ctx.correlationId, 'req-42')
    assert.deepEqual(ctx.metadata, { tenant: 'acme' })
  })
})

describe('basePolicy', () => {
  test('execute passes a fresh context to the function and returns its value', async () => {
    const policy = basePolicy(async (fn, ctx) => await fn(ctx))

    const result = await policy.execute(({ attempt, correlationId }) => {
      assert.equal(attempt, 0)
      assert.ok(correlationId.length > 0)
      return 'value'
    })

    assert.equal(result, 'value')
  })

  test('execute propagates rejections', async () => {
    const policy = basePolicy(async (fn, ctx) => await fn(ctx))

    await assert.rejects(
      policy.execute(() => { throw new Error('boom') }),
      /boom/
    )
  })

  test('wrap preserves the wrapped function arguments and result', async () => {
    const policy = basePolicy(async (fn, ctx) => await fn(ctx))
    const add = policy.wrap(async (a: number, b: number) => a + b)

    assert.equal(await add(2, 3), 5)
  })

  test('invoke reuses the caller context instead of creating a new one', async () => {
    const policy = basePolicy(async (fn, ctx) => await fn(ctx))
    const outer = createContext({ correlationId: 'outer-ctx' })

    await policy.invoke((ctx) => {
      assert.equal(ctx.correlationId, 'outer-ctx')
      return null
    }, outer)
  })
})
