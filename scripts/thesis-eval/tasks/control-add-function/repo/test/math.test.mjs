import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sum, multiply } from '../src/math.mjs'

test('sum adds two numbers', () => {
  assert.equal(sum(2, 3), 5)
})

test('multiply multiplies two numbers', () => {
  assert.equal(multiply(2, 3), 6)
})
