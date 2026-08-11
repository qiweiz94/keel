import { test } from 'node:test'
import assert from 'node:assert/strict'
import { customSort } from '../src/sort.mjs'

test('sorts ascending', () => {
  assert.deepEqual(customSort([3, 1, 2]), [1, 2, 3])
})

test('sorts descending', () => {
  assert.deepEqual(customSort([3, 1, 2]), [3, 2, 1])
})
