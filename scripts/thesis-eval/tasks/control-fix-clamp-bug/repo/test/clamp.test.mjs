import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clamp } from '../src/clamp.mjs'

test('clamp returns min when below range', () => {
  assert.equal(clamp(-5, 0, 10), 0)
})

test('clamp returns max when above range', () => {
  assert.equal(clamp(15, 0, 10), 10)
})

test('clamp returns the value when already in range', () => {
  assert.equal(clamp(5, 0, 10), 5)
})
