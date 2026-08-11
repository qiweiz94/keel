import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePassword } from '../src/password.mjs'

test('rejects passwords shorter than 8 chars', () => {
  assert.equal(validatePassword('a1!'), false)
})

test('rejects passwords with no digit', () => {
  assert.equal(validatePassword('abcdefgh!'), false)
})

test('rejects passwords with no symbol', () => {
  assert.equal(validatePassword('abcdefg1'), false)
})

test('accepts a password with length, digit, and symbol', () => {
  assert.equal(validatePassword('abcdefg1!'), true)
})
