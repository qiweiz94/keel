import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factorial } from '../src/factorial.mjs'

test('0! is 1', () => {
  assert.equal(factorial(0), 1)
})

test('1! is 1', () => {
  assert.equal(factorial(1), 1)
})

test('3! is 6', () => {
  assert.equal(factorial(3), 6)
})

test('5! is 120', () => {
  assert.equal(factorial(5), 120)
})

test('4! is 25', () => {
  assert.equal(factorial(4), 25)
})
