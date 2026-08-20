import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StuckTracker } from '../stuck-tracker.js'
import { PersistentStuckStore, STUCK_STATE_MAX_WINDOW_MS } from '../stuck-store.js'
import { parseRulesContent } from '../rule-parser.js'
import type { EnforceInput } from '../../types.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * The gap a deep audit found: `keel hook <host>` (Claude Code, Cursor,
 * Codex, Gemini CLI, cline, generic) spawns a FRESH process per tool call,
 * so an in-memory-only `StuckTracker` resets to empty every time and can
 * never see "this exact command already failed N times in the window" —
 * the whole point of the stuck-loop detector. `enforce.ts`'s `initEnforce()`
 * — the choke point for `keel hook` — never wired a `stuckTracker` at all
 * before this fix; only `daemon.ts`'s long-lived process did, which never
 * exercises this gap.
 *
 * This suite proves `PersistentStuckStore` and `StuckTracker`'s optional
 * `persistentStore` wiring close it: TWO SEPARATE `StuckTracker` instances
 * (simulating two separate `keel hook` processes), sharing only a
 * directory and a rule id + cwd + fingerprint, converge on the same
 * escalation state a single long-lived tracker would have reached — plus
 * the bounds/TTL/fail-safe properties that make persisting this safe.
 *
 * End-to-end proof through the REAL `keel hook claude-code` CLI path lives
 * in packages/cli/src/__tests__/stuck-loop-persistence.test.ts. This file
 * is the fast, in-process equivalent for the store/tracker layer alone.
 */

const STUCK_RULE_YAML = `version: 1
rules:
  - id: no-test-loops
    type: stuck
    match: "npm test"
    window_seconds: 900
    max_attempts: 3
    action: redirect
    message: "Test command loop"
`

function makeInput(overrides: Partial<EnforceInput> = {}): EnforceInput {
  return {
    tool: 'Bash',
    args: { command: 'npm test' },
    cwd: '/tmp/keel-stuck-store-test',
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

const rule = parseRulesContent(STUCK_RULE_YAML, '/tmp/stuck-store-rules.yaml').rules[0]

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-stuck-store-test-'))
})

afterEach(() => {
  rmSafe(dir)
})

describe('StuckTracker.persistentStore — cross-process correlation', () => {
  it('two SEPARATE StuckTracker instances sharing one directory accumulate the same escalation a single long-lived tracker would', () => {
    // Process 1: two failing attempts, then exits. Under threshold (3), so
    // its own check() must still allow.
    const tracker1 = new StuckTracker(new PersistentStuckStore(dir))
    tracker1.recordOutcome(rule, makeInput(), 1)
    tracker1.recordOutcome(rule, makeInput(), 1)
    expect(tracker1.check(rule, makeInput())).toBeNull()

    // Process 2: a brand-new StuckTracker instance (in production, a whole
    // new `keel hook` process) — its OWN in-memory `counts` is empty.
    // Without the persisted store it could never see process 1's two
    // failures; with it, checking should already reflect count=2 (still
    // under 3) and recording a THIRD failure here must escalate.
    const tracker2 = new StuckTracker(new PersistentStuckStore(dir))
    expect(tracker2.check(rule, makeInput()), 'process 2 must see process 1\'s 2 prior failures').toBeNull()
    tracker2.recordOutcome(rule, makeInput(), 1)
    const escalation = tracker2.check(rule, makeInput())
    expect(escalation, 'the 3rd failure, recorded by a SECOND process, must escalate').not.toBeNull()
    expect(escalation?.action).toBe('redirect')
    expect(escalation?.attempts).toBe(3)
  })

  it('a DIFFERENT cwd does not correlate — no cross-project bleed', () => {
    const tracker1 = new StuckTracker(new PersistentStuckStore(dir))
    for (let i = 0; i < 3; i++) tracker1.recordOutcome(rule, makeInput({ cwd: '/tmp/project-a' }), 1)
    expect(tracker1.check(rule, makeInput({ cwd: '/tmp/project-a' }))).not.toBeNull()

    const tracker2 = new StuckTracker(new PersistentStuckStore(dir))
    expect(tracker2.check(rule, makeInput({ cwd: '/tmp/project-b' })), 'a different cwd must not see project-a\'s failures').toBeNull()
  })

  it('success recorded by a LATER process resets the loop the EARLIER process built up', () => {
    const tracker1 = new StuckTracker(new PersistentStuckStore(dir))
    tracker1.recordOutcome(rule, makeInput(), 1)
    tracker1.recordOutcome(rule, makeInput(), 1)

    const tracker2 = new StuckTracker(new PersistentStuckStore(dir))
    tracker2.recordOutcome(rule, makeInput(), 0) // success — resets

    const tracker3 = new StuckTracker(new PersistentStuckStore(dir))
    expect(tracker3.check(rule, makeInput())).toBeNull()
    tracker3.recordOutcome(rule, makeInput(), 1)
    tracker3.recordOutcome(rule, makeInput(), 1)
    // Only 2 failures since the reset — must still be under threshold.
    expect(tracker3.check(rule, makeInput())).toBeNull()
  })

  it('a window-expired persisted bucket does not correlate', () => {
    // Simulate two failures recorded well outside the rule's window by
    // writing directly (bypassing bump()'s "now" timestamp).
    const key = 'stuck:no-test-loops:/tmp/keel-stuck-store-test:npm test'
    writeFileSync(join(dir, 'stuck-tracker.json'), JSON.stringify({
      [key]: { count: 2, windowStart: Date.now() - 20 * 60 * 1000, lastAttemptAt: Date.now() - 20 * 60 * 1000, lastExit: 1, windowMs: 900_000 },
    }))
    const tracker = new StuckTracker(new PersistentStuckStore(dir))
    expect(tracker.check(rule, makeInput()), 'an expired bucket (window_seconds: 900) must not correlate').toBeNull()
  })

  it('a corrupt store file degrades to "no prior failures", never throws — recordOutcome starts a fresh bucket', () => {
    writeFileSync(join(dir, 'stuck-tracker.json'), '{ not valid json')
    const tracker = new StuckTracker(new PersistentStuckStore(dir))
    expect(() => tracker.check(rule, makeInput())).not.toThrow()
    expect(tracker.check(rule, makeInput())).toBeNull()
    expect(() => tracker.recordOutcome(rule, makeInput(), 1)).not.toThrow()
  })

  it('check() with no persistentStore configured is unaffected (every pre-existing new StuckTracker() call site behaves exactly as before)', () => {
    const bareTracker = new StuckTracker() // no store — matches daemon.ts's existing call site
    bareTracker.recordOutcome(rule, makeInput(), 1)
    bareTracker.recordOutcome(rule, makeInput(), 1)
    expect(bareTracker.check(rule, makeInput())).toBeNull()
    bareTracker.recordOutcome(rule, makeInput(), 1)
    const escalation = bareTracker.check(rule, makeInput())
    expect(escalation?.action).toBe('redirect')
  })
})

describe('PersistentStuckStore — direct store contract', () => {
  it('bump() increments within the window and resets after it expires', () => {
    const store = new PersistentStuckStore(dir)
    const key = 'stuck:r:/cwd:cmd'
    const a = store.bump(key, 1000, 1)
    expect(a.count).toBe(1)
    const b = store.bump(key, 1000, 1)
    expect(b.count).toBe(2)
    expect(b.windowStart).toBe(a.windowStart) // same window, not restarted

    // Simulate window expiry by writing a stale windowStart directly, then
    // bumping again — must start a fresh count-1 bucket, not keep adding.
    writeFileSync(join(dir, 'stuck-tracker.json'), JSON.stringify({
      [key]: { count: 2, windowStart: Date.now() - 5000, lastAttemptAt: Date.now() - 5000, lastExit: 1, windowMs: 1000 },
    }))
    const c = store.bump(key, 1000, 1)
    expect(c.count).toBe(1)
  })

  it('get() returns null for a missing key, delete() removes an existing one', () => {
    const store = new PersistentStuckStore(dir)
    expect(store.get('nope')).toBeNull()
    const key = 'stuck:r:/cwd:cmd'
    store.bump(key, 60_000, 1)
    expect(store.get(key)).not.toBeNull()
    store.delete(key)
    expect(store.get(key)).toBeNull()
  })

  it('deleteByCwd() clears only buckets encoding that cwd', () => {
    const store = new PersistentStuckStore(dir)
    store.bump('stuck:r:/cwd-a:cmd1', 60_000, 1)
    store.bump('stuck:r:/cwd-a:cmd2', 60_000, 1)
    store.bump('stuck:r:/cwd-b:cmd1', 60_000, 1)
    store.deleteByCwd('/cwd-a')
    expect(store.get('stuck:r:/cwd-a:cmd1')).toBeNull()
    expect(store.get('stuck:r:/cwd-a:cmd2')).toBeNull()
    expect(store.get('stuck:r:/cwd-b:cmd1')).not.toBeNull()
  })

  it('clearAll() empties every bucket', () => {
    const store = new PersistentStuckStore(dir)
    store.bump('stuck:r:/cwd-a:cmd1', 60_000, 1)
    store.bump('stuck:r:/cwd-b:cmd1', 60_000, 1)
    store.clearAll()
    expect(store.get('stuck:r:/cwd-a:cmd1')).toBeNull()
    expect(store.get('stuck:r:/cwd-b:cmd1')).toBeNull()
  })

  it('caps each bucket\'s effective window at STUCK_STATE_MAX_WINDOW_MS regardless of a larger windowMs argument', () => {
    const store = new PersistentStuckStore(dir)
    const key = 'stuck:r:/cwd:cmd'
    // A pathological/typo'd window_seconds far beyond the ceiling.
    store.bump(key, STUCK_STATE_MAX_WINDOW_MS * 100, 1)
    // Simulate that much time passing minus a little, still within the cap.
    writeFileSync(join(dir, 'stuck-tracker.json'), JSON.stringify({
      [key]: { count: 1, windowStart: Date.now() - (STUCK_STATE_MAX_WINDOW_MS - 1000), lastAttemptAt: Date.now(), lastExit: 1, windowMs: STUCK_STATE_MAX_WINDOW_MS * 100 },
    }))
    expect(store.get(key), 'still within the capped window').not.toBeNull()
    // Now push it just past the cap.
    writeFileSync(join(dir, 'stuck-tracker.json'), JSON.stringify({
      [key]: { count: 1, windowStart: Date.now() - (STUCK_STATE_MAX_WINDOW_MS + 1000), lastAttemptAt: Date.now(), lastExit: 1, windowMs: STUCK_STATE_MAX_WINDOW_MS * 100 },
    }))
    expect(store.get(key), 'past the capped window, regardless of the larger requested windowMs').toBeNull()
  })

  it('bounds the total bucket count at MAX_ENTRIES, evicting least-recently-active first', () => {
    const store = new PersistentStuckStore(dir)
    for (let i = 0; i < 520; i++) {
      store.bump(`stuck:r:/cwd-${i}:cmd`, 60_000, 1)
    }
    expect(store.get('stuck:r:/cwd-0:cmd'), 'the earliest bucket should have been evicted').toBeNull()
    expect(store.get('stuck:r:/cwd-519:cmd'), 'the most recent bucket should still be present').not.toBeNull()
  })
})
