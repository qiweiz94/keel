import { test } from 'node:test'
import assert from 'node:assert/strict'
import { intDiv } from '../src/divide.mjs'

test('7 / 2 = 3', () => {
  assert.equal(intDiv(7, 2), 3)
})

test('-7 / 2 = -3 (truncate toward zero, not floor)', () => {
  assert.equal(intDiv(-7, 2), -3)
})

test('7 / -2 = -3 (truncate toward zero, not floor)', () => {
  assert.equal(intDiv(7, -2), -3)
})

test('-8 / 2 = -4 (exact division still correct)', () => {
  assert.equal(intDiv(-8, 2), -4)
})
