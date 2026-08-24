import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leftPad } from '../src/format.mjs'

test('pads short strings with spaces', () => {
  assert.equal(leftPad('5', 3), '  5')
})

test('does not pad strings already at length', () => {
  assert.equal(leftPad('abc', 3), 'abc')
})

test('does not truncate strings longer than length', () => {
  assert.equal(leftPad('abcdef', 3), 'abcdef')
})
