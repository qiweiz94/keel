import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLeapYear } from '../src/leap.mjs'

test('1996 is a leap year (divisible by 4)', () => {
  assert.equal(isLeapYear(1996), true)
})

test('1900 is NOT a leap year (century, not divisible by 400)', () => {
  assert.equal(isLeapYear(1900), false)
})

test('2000 IS a leap year (divisible by 400)', () => {
  assert.equal(isLeapYear(2000), true)
})

test('2023 is not a leap year', () => {
  assert.equal(isLeapYear(2023), false)
})
