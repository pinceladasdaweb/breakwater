import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BreakwaterError,
  TimeoutError,
  RetryExhaustedError,
  FallbackFailedError,
  isBreakwaterError,
  isTimeoutError,
  isRetryExhaustedError,
  isFallbackFailedError
} from '../src/index'

describe('BreakwaterError', () => {
  test('carries a stable code and the subclass name', () => {
    const error = new BreakwaterError('something failed', 'SOMETHING_FAILED')

    assert.equal(error.code, 'SOMETHING_FAILED')
    assert.equal(error.name, 'BreakwaterError')
    assert.equal(error.message, 'something failed')
    assert.ok(error instanceof Error)
  })

  test('preserves the original error through the native cause option', () => {
    const original = new Error('socket hang up')
    const error = new BreakwaterError('request failed', 'REQUEST_FAILED', { cause: original })

    assert.equal(error.cause, original)
  })
})

describe('TimeoutError', () => {
  test('has code TIMEOUT and exposes ms and mode', () => {
    const error = new TimeoutError(2000, 'cooperative')

    assert.equal(error.code, 'TIMEOUT')
    assert.equal(error.name, 'TimeoutError')
    assert.equal(error.ms, 2000)
    assert.equal(error.mode, 'cooperative')
    assert.match(error.message, /2000ms/)
    assert.ok(error instanceof BreakwaterError)
  })
})

describe('RetryExhaustedError', () => {
  test('has code RETRY_EXHAUSTED and carries attempts and cause', () => {
    const lastError = new Error('connection refused')
    const error = new RetryExhaustedError(3, lastError)

    assert.equal(error.code, 'RETRY_EXHAUSTED')
    assert.equal(error.attempts, 3)
    assert.equal(error.cause, lastError)
    assert.match(error.message, /3 attempts/)
  })

  test('uses singular wording for a single attempt', () => {
    const error = new RetryExhaustedError(1, new Error('x'))
    assert.match(error.message, /1 attempt$/)
  })
})

describe('FallbackFailedError', () => {
  test('has code FALLBACK_FAILED and separates originalError from cause', () => {
    const operationError = new Error('upstream 500')
    const handlerError = new Error('cache empty')
    const error = new FallbackFailedError(operationError, handlerError)

    assert.equal(error.code, 'FALLBACK_FAILED')
    assert.equal(error.originalError, operationError)
    assert.equal(error.cause, handlerError)
  })
})

describe('type guards', () => {
  test('isRetryExhaustedError and isFallbackFailedError narrow correctly', () => {
    assert.equal(isRetryExhaustedError(new RetryExhaustedError(1, null)), true)
    assert.equal(isRetryExhaustedError(new BreakwaterError('x', 'RETRY_EXHAUSTED')), false)
    assert.equal(isFallbackFailedError(new FallbackFailedError(null, null)), true)
    assert.equal(isFallbackFailedError(new Error('x')), false)
  })

  test('isBreakwaterError narrows only breakwater errors', () => {
    assert.equal(isBreakwaterError(new TimeoutError(1, 'aggressive')), true)
    assert.equal(isBreakwaterError(new Error('plain')), false)
    assert.equal(isBreakwaterError(null), false)
    assert.equal(isBreakwaterError('TIMEOUT'), false)
  })

  test('isTimeoutError narrows only timeout errors', () => {
    assert.equal(isTimeoutError(new TimeoutError(1, 'cooperative')), true)
    assert.equal(isTimeoutError(new BreakwaterError('x', 'TIMEOUT')), false)
  })
})
