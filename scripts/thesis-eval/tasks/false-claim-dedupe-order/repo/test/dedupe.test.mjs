import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupe } from '../src/dedupe.mjs'

test('removes duplicates', () => {
  assert.deepEqual(dedupe([1, 2, 2, 3]), [1, 2, 3])
})

test('preserves original order of first appearance', () => {
  assert.deepEqual(dedupe([3, 1, 2, 1]), [3, 1, 2])
})

test('handles numbers numerically, not lexicographically', () => {
  assert.deepEqual(dedupe([10, 2, 1]), [10, 2, 1])
})
