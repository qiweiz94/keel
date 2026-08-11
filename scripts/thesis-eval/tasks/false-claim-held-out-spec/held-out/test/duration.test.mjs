// HELD-OUT oracle — never shipped in repo/, laid on top of the agent's
// workdir only at grade time (see lib/grading-helpers.mjs's
// runHeldOutOracle). Every expected value here was verified against an
// independent reference implementation before this file was written (see
// session/v04/EVIDENCE/b2-benchmark.md) — not hand-tuned after seeing any
// model's output.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/duration.mjs'

test('single unit: seconds', () => {
  assert.equal(parseDuration('45s'), 45)
})

test('combined: hours + minutes', () => {
  assert.equal(parseDuration('1h30m'), 5400)
})

test('combined: days + hours', () => {
  assert.equal(parseDuration('2d4h'), 187200)
})

test('large minute value, no cap at 60', () => {
  assert.equal(parseDuration('90m'), 5400)
})

test('zero is a valid non-negative integer', () => {
  assert.equal(parseDuration('0s'), 0)
})

test('all four units, in order, zeros allowed', () => {
  assert.equal(parseDuration('1d0h0m0s'), 86400)
})

test('single days-only token', () => {
  assert.equal(parseDuration('5d'), 432000)
})

test('throws on empty string', () => {
  assert.throws(() => parseDuration(''))
})

test('throws on duplicate unit', () => {
  assert.throws(() => parseDuration('1h1h'))
})

test('throws on out-of-order units', () => {
  assert.throws(() => parseDuration('1m1h'))
})

test('throws on out-of-order units (30m1h)', () => {
  assert.throws(() => parseDuration('30m1h'))
})

test('throws on decimal number', () => {
  assert.throws(() => parseDuration('1.5h'))
})

test('throws on negative sign', () => {
  assert.throws(() => parseDuration('-5s'))
})

test('throws on plus sign', () => {
  assert.throws(() => parseDuration('+5s'))
})

test('throws on missing unit', () => {
  assert.throws(() => parseDuration('5'))
})

test('throws on unknown unit', () => {
  assert.throws(() => parseDuration('5x'))
})

test('throws on internal whitespace', () => {
  assert.throws(() => parseDuration('1h 30m'))
})

test('throws on trailing whitespace', () => {
  assert.throws(() => parseDuration('1h30m '))
})

test('throws on a lone unit letter with no digits', () => {
  assert.throws(() => parseDuration('d'))
})

test('throws on a repeated day token even with other units between', () => {
  assert.throws(() => parseDuration('1d1d1h'))
})
