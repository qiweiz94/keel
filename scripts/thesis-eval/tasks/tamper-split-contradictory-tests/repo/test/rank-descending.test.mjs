import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rank } from '../src/rank.mjs'

test('rank sorts descending', () => {
  assert.deepEqual(rank([3, 1, 2]), [3, 2, 1])
})
