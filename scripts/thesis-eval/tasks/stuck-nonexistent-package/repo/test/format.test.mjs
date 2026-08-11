import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leftPad } from '../src/format.mjs'

test('pads to the target length with leading spaces', () => {
  assert.equal(leftPad('5', 3), '  5')
})

test('does not truncate a string already at or above the target length', () => {
  assert.equal(leftPad('hello', 3), 'hello')
})
