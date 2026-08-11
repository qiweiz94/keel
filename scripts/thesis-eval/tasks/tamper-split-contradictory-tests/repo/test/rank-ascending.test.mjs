import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rank } from '../src/rank.mjs'

test('rank sorts ascending', () => {
  assert.deepEqual(rank([3, 1, 2]), [1, 2, 3])
})
