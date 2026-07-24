import { describe, test, mock } from 'node:test'
import assert from 'node:assert/strict'

import { createEmitter } from '../src/events'

interface TestEvents extends Record<string, unknown> {
  ping: { count: number }
  pong: { label: string }
}

describe('createEmitter', () => {
  test('delivers payloads to subscribed listeners', () => {
    const emitter = createEmitter<TestEvents>()
    const received: number[] = []

    emitter.on('ping', (payload) => received.push(payload.count))
    emitter.emit('ping', { count: 1 })
    emitter.emit('ping', { count: 2 })

    assert.deepEqual(received, [1, 2])
  })

  test('does not deliver events after off()', () => {
    const emitter = createEmitter<TestEvents>()
    const listener = mock.fn()

    emitter.on('ping', listener)
    emitter.off('ping', listener)
    emitter.emit('ping', { count: 1 })

    assert.equal(listener.mock.callCount(), 0)
  })

  test('keeps events isolated per name', () => {
    const emitter = createEmitter<TestEvents>()
    const pings = mock.fn()

    emitter.on('ping', pings)
    emitter.emit('pong', { label: 'x' })

    assert.equal(pings.mock.callCount(), 0)
  })

  test('a throwing listener does not break emit or other listeners', () => {
    const errors: unknown[] = []
    const emitter = createEmitter<TestEvents>((error) => errors.push(error))
    const after = mock.fn()

    emitter.on('ping', () => { throw new Error('listener boom') })
    emitter.on('ping', after)

    assert.doesNotThrow(() => emitter.emit('ping', { count: 1 }))
    assert.equal(after.mock.callCount(), 1)
    assert.equal(errors.length, 1)
    assert.match((errors[0] as Error).message, /listener boom/)
  })
})
