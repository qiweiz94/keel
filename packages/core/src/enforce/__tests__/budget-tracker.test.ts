import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BudgetTracker } from '../budget-tracker.js'
import { PersistentBudgetStore } from '../budget-store.js'
import { parseRulesContent } from '../rule-parser.js'
import type { EnforceInput, KeelRule } from '../../types.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Point 4 (two-phase enforcement, CRITICAL point in the design audit):
 * Claude Code's Stop hook cannot block, so `BudgetTracker` splits into a
 * write-only `record()` (called from a Stop/PostToolUse-equivalent hook,
 * OUTSIDE the PreToolUse path) and a read-only `checkDeny()` (called from
 * `EnforcementPipeline.evaluate()`'s `type: budget` branch). This suite
 * proves that split is race-free by construction: `checkDeny()` NEVER
 * derives a verdict from anything but the state `record()` already wrote,
 * a fresh key denies nothing, and a rule that only OBSERVES never writes
 * the HALTED sentinel even when grossly over budget (point 7 / the
 * `cli/halt.ts` hazard this must not reintroduce).
 */

const BUDGET_RULE_YAML = `version: 1
rules:
  - id: session-cap
    type: budget
    max_tokens: 1000
    action: deny
    message: "Over budget"
`

const BUDGET_RULE_HARD_STOP_YAML = `version: 1
rules:
  - id: session-cap-enforcing
    type: budget
    max_tokens: 1000
    hard_stop_multiplier: 3
    mode: block
    action: deny
    message: "Over budget"
`

const BUDGET_RULE_OBSERVE_HARD_STOP_YAML = `version: 1
rules:
  - id: session-cap-observe
    type: budget
    max_tokens: 1000
    hard_stop_multiplier: 3
    mode: observe
    action: deny
    message: "Over budget"
`

function rule(yaml: string): KeelRule {
  return parseRulesContent(yaml, '/tmp/budget-tracker-rules.yaml').rules[0] as KeelRule
}

function makeInput(overrides: Partial<EnforceInput> = {}): EnforceInput {
  return {
    tool: 'Bash',
    args: { command: 'echo hi' },
    cwd: '/tmp/keel-budget-tracker-test',
    session_id: 'session-a',
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
    ...overrides,
  }
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-budget-tracker-test-'))
})

afterEach(() => {
  rmSafe(dir)
})

/**
 * A spy standing in for the real `writeHaltSentinel` — see BudgetTracker's
 * constructor comment for why this injection point exists at all: this
 * lets the hard_stop_multiplier escalation logic be tested WITHOUT ever
 * writing to a real `~/.keel/HALTED`, the same isolation concern
 * `override-isolation-guard.ts` (this directory) exists to catch for a
 * different sentinel file.
 */
function haltSpy(): { calls: string[]; fn: (reason: string) => void } {
  const calls: string[] = []
  return { calls, fn: (reason: string) => { calls.push(reason) } }
}

describe('BudgetTracker — two-phase deny (point 4)', () => {
  it('a fresh key (never measured) denies nothing', () => {
    const tracker = new BudgetTracker(new PersistentBudgetStore(dir))
    const r = rule(BUDGET_RULE_YAML)
    expect(tracker.checkDeny(r, makeInput())).toBeNull()
  })

  it('record() over budget → checkDeny() denies the NEXT call, using only the persisted flag', () => {
    const tracker = new BudgetTracker(new PersistentBudgetStore(dir))
    const r = rule(BUDGET_RULE_YAML)
    const input = makeInput()

    // Measurement phase (simulates a Stop/PostToolUse-equivalent hook).
    tracker.record(r, input, { tokens: 5000, dollars: 25, dollarsConfident: true, unavailable: false, unrecognizedModels: [] })

    // Enforcement phase (simulates the NEXT PreToolUse call) — a
    // DIFFERENT BudgetTracker instance over the SAME store, proving this
    // is disk-persisted state, not an in-memory carry-over within one
    // object (mirrors stuck-store.test.ts's "two separate instances"
    // cross-process proof).
    const secondProcess = new BudgetTracker(new PersistentBudgetStore(dir))
    const deny = secondProcess.checkDeny(r, input)
    expect(deny).not.toBeNull()
    expect(deny!.message).toContain('5,000 tokens')
  })

  it('record() under budget never denies', () => {
    const tracker = new BudgetTracker(new PersistentBudgetStore(dir))
    const r = rule(BUDGET_RULE_YAML)
    const input = makeInput()
    tracker.record(r, input, { tokens: 10, dollars: 0.01, dollarsConfident: true, unavailable: false, unrecognizedModels: [] })
    expect(tracker.checkDeny(r, input)).toBeNull()
  })

  it('different sessions/cwds never share a budget bucket', () => {
    const tracker = new BudgetTracker(new PersistentBudgetStore(dir))
    const r = rule(BUDGET_RULE_YAML)
    tracker.record(r, makeInput({ session_id: 'session-over' }), { tokens: 5000, dollars: null, dollarsConfident: false, unavailable: false, unrecognizedModels: [] })
    expect(tracker.checkDeny(r, makeInput({ session_id: 'session-under' }))).toBeNull()
  })
})

describe('BudgetTracker.record() — point 5, unavailable measurements never silently read as under budget', () => {
  it('an unavailable measurement with NO prior confirmed state denies nothing (nothing to fabricate a deny from) but is recorded as unavailable', () => {
    const store = new PersistentBudgetStore(dir)
    const tracker = new BudgetTracker(store)
    const r = rule(BUDGET_RULE_YAML)
    const input = makeInput()

    tracker.record(r, input, { tokens: 0, dollars: null, dollarsConfident: false, unavailable: true, unrecognizedModels: [] })

    expect(tracker.checkDeny(r, input)).toBeNull()
    const raw = store.get(`budget:${r.id}:${input.session_id}:${input.cwd}`)
    expect(raw?.unavailable).toBe(true)
    expect(raw?.overBudget).toBe(false)
  })

  it('an unavailable measurement carries a PRIOR over-budget flag forward unchanged — never silently clears it', () => {
    const store = new PersistentBudgetStore(dir)
    const tracker = new BudgetTracker(store)
    const r = rule(BUDGET_RULE_YAML)
    const input = makeInput()

    tracker.record(r, input, { tokens: 5000, dollars: 25, dollarsConfident: true, unavailable: false, unrecognizedModels: [] })
    expect(tracker.checkDeny(r, input)).not.toBeNull()

    // A later measurement attempt fails to read the transcript at all.
    tracker.record(r, input, { tokens: 0, dollars: null, dollarsConfident: false, unavailable: true, unrecognizedModels: [] })

    // The deny must still stand — an unreadable transcript is NOT evidence
    // spend dropped back under budget.
    const deny = tracker.checkDeny(r, input)
    expect(deny).not.toBeNull()
    const raw = store.get(`budget:${r.id}:${input.session_id}:${input.cwd}`)
    expect(raw?.unavailable).toBe(true)
    expect(raw?.overBudget).toBe(true)
    expect(raw?.spendTokens).toBe(5000) // carried forward, not reset to 0
  })
})

describe('BudgetTracker.record() — hard_stop_multiplier escalation gated on enforcement mode (point 7 / point 2 of advisor review)', () => {
  it('a mode: observe rule NEVER triggers the halt writer, even grossly over its hard_stop_multiplier', () => {
    const store = new PersistentBudgetStore(dir)
    const spy = haltSpy()
    const tracker = new BudgetTracker(store, spy.fn)
    const r = rule(BUDGET_RULE_OBSERVE_HARD_STOP_YAML)
    const input = makeInput()

    // 5000 tokens is 5x max_tokens (1000), well past hard_stop_multiplier: 3.
    tracker.record(r, input, { tokens: 5000, dollars: null, dollarsConfident: false, unavailable: false, unrecognizedModels: [] })
    expect(spy.calls).toEqual([])
  })

  it('an actually-enforcing rule (mode: block) DOES trigger the halt writer once past hard_stop_multiplier', () => {
    const store = new PersistentBudgetStore(dir)
    const spy = haltSpy()
    const tracker = new BudgetTracker(store, spy.fn)
    const r = rule(BUDGET_RULE_HARD_STOP_YAML)
    const input = makeInput()

    tracker.record(r, input, { tokens: 5000, dollars: null, dollarsConfident: false, unavailable: false, unrecognizedModels: [] })
    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0]).toContain('session-cap-enforcing')
  })

  it('does NOT trigger the halt writer when under the multiplier, even while enforcing', () => {
    const store = new PersistentBudgetStore(dir)
    const spy = haltSpy()
    const tracker = new BudgetTracker(store, spy.fn)
    const r = rule(BUDGET_RULE_HARD_STOP_YAML)
    const input = makeInput()
    // 1500 tokens exceeds max_tokens (1000) but is only 1.5x it, under the 3x multiplier.
    tracker.record(r, input, { tokens: 1500, dollars: null, dollarsConfident: false, unavailable: false, unrecognizedModels: [] })
    expect(spy.calls).toEqual([])
  })
})

describe('writeHaltSentinel (real, default halt writer) — shape parity with cli/halt.ts, path injectable', () => {
  it('writes the exact sentinel shape cli/halt.ts writes, at an INJECTED path (never the real home)', async () => {
    const { writeHaltSentinel } = await import('../halt-writer.js')
    const { readFileSync } = await import('node:fs')
    const path = join(dir, 'HALTED')
    writeHaltSentinel('test reason', path)
    const body = JSON.parse(readFileSync(path, 'utf-8'))
    expect(body).toEqual({
      halted_at: expect.any(String),
      reason: 'test reason',
      auto_clear_on_restart: false,
    })
  })
})
