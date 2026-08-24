import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { OscillationTracker } from '../oscillation-tracker.js'
import { PersistentOscillationStore } from '../oscillation-store.js'
import { parseRulesContent } from '../rule-parser.js'
import type { EnforceInput } from '../../types.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `type: oscillation` (command-oscillation, install.ts): a short repeating
 * CYCLE of >= 2 DISTINCT recent command fingerprints (A→B→A→B) within a
 * session's small rolling window — the sibling of `type: stuck`
 * (no-repeat-loops, stuck.test.ts), not a replacement for it.
 *
 * Covers exactly the scenarios the lane brief called out:
 *   - a genuine A→B→A→B cycle of FAILING commands is detected and escalates
 *     per the ladder
 *   - a legitimate alternating workflow (edit-then-test, both succeeding)
 *     does NOT trip it
 *   - a single command repeated exactly (no-repeat-loops' own case) is not
 *     double-counted/double-escalated here — complementary, not redundant
 *   - the rolling window correctly ages out old fingerprints so a
 *     coincidental long-ago repeat doesn't falsely combine with a recent one
 *     into a phantom cycle
 */

const OSCILLATION_RULE_YAML = `version: 1
rules:
  - id: t-oscillation
    type: oscillation
    action: redirect
    message: "Oscillating pattern"
    window_seconds: 900
    oscillation_window_size: 8
    min_cycle_length: 2
    max_cycle_length: 4
    min_cycle_repeats: 2
    fingerprint: auto
    require_failure: true
    escalation:
      - at: 2
        action: redirect
        message: "OSCILLATION_REDIRECT: 2 repeats"
      - at: 3
        action: deny
        message: "OSCILLATION_DENY: 3 repeats"
`

const noopOverrideStore = { consume: () => false, peek: () => null, list: () => ({}) }

function makePipeline(yaml: string, tracker = new OscillationTracker()): { pipeline: EnforcementPipeline; tracker: OscillationTracker } {
  const rules = parseRulesContent(yaml, '/tmp/oscillation-rules.yaml')
  const pipeline = new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    overrideStore: noopOverrideStore,
    oscillationTracker: tracker,
    ruleHierarchy: { global: rules, user: null, project: null, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
  })
  return { pipeline, tracker }
}

function input(tool: string, command: string, session = 'osc-test'): EnforceInput {
  return {
    tool,
    args: { command },
    cwd: '/tmp',
    session_id: session,
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
  }
}

describe('oscillation tracker: genuine A→B→A→B cycle', () => {
  it('escalates a repeating cycle of FAILING commands: 2 repeats → redirect, 3 repeats → deny', async () => {
    const { pipeline } = makePipeline(OSCILLATION_RULE_YAML)
    const A = input('Bash', 'npm run lint')
    const B = input('Bash', 'npm run build')
    const record = (i: EnforceInput) => pipeline.recordAttemptOutcome(i, 1)

    // A, B, A, B — two full repeats of the unit. Under threshold until the
    // 4th entry lands; the checking call itself is a 5th tracked-tool call
    // (its own outcome is not yet recorded when evaluate() runs).
    record(A)
    expect((await pipeline.evaluate(B)).action).toBe('allow') // only 1 entry recorded so far
    record(B)
    record(A)
    expect((await pipeline.evaluate(B)).action).toBe('allow') // 3 entries — one short of 2 full repeats
    record(B)

    const redirect = await pipeline.evaluate(A)
    expect(redirect.action).toBe('redirect')
    expect(redirect.redirect?.kind).toBe('oscillation')
    expect(redirect.redirect?.attempts).toBe(2)

    // A 3rd repeat of the same unit escalates to deny.
    record(A)
    record(B)
    const deny = await pipeline.evaluate(A)
    expect(deny.action).toBe('deny')
    expect(deny.rule_id).toBe('t-oscillation')
  })

  it('detects a length-3 cycle (A→B→C→A→B→C)', async () => {
    const { pipeline } = makePipeline(OSCILLATION_RULE_YAML)
    const A = input('Bash', 'npm run task-a')
    const B = input('Bash', 'npm run task-b')
    const C = input('Bash', 'npm run task-c')
    const record = (i: EnforceInput) => pipeline.recordAttemptOutcome(i, 1)

    record(A); record(B); record(C); record(A); record(B); record(C)
    const result = await pipeline.evaluate(A)
    expect(result.action).toBe('redirect')
    expect(result.redirect?.attempts).toBe(2)
  })
})

describe('oscillation tracker: legitimate alternating workflow does not trip it', () => {
  it('an edit/test alternation where every step SUCCEEDS is never appended to the window (require_failure: true)', async () => {
    const { pipeline } = makePipeline(OSCILLATION_RULE_YAML)
    const editFile = input('write', '{"path":"src/a.ts"}')
    const runTest = input('Bash', 'npm test')

    // Six clean alternations — well past the 2-repeat threshold if these
    // were being counted at all.
    for (let i = 0; i < 6; i++) {
      pipeline.recordAttemptOutcome(editFile, 0)
      pipeline.recordAttemptOutcome(runTest, 0)
    }
    expect((await pipeline.evaluate(editFile)).action).toBe('allow')
    expect((await pipeline.evaluate(runTest)).action).toBe('allow')
  })

  it('an unreported (null) exit code neither counts nor resets, same as the stuck-loop discriminator', async () => {
    const { pipeline } = makePipeline(OSCILLATION_RULE_YAML)
    const A = input('Bash', 'npm run lint')
    const B = input('Bash', 'npm run build')
    pipeline.recordAttemptOutcome(A, null)
    pipeline.recordAttemptOutcome(B, null)
    pipeline.recordAttemptOutcome(A, null)
    pipeline.recordAttemptOutcome(B, null)
    expect((await pipeline.evaluate(A)).action).toBe('allow')
  })
})

describe('oscillation tracker: complementary to, never redundant with, no-repeat-loops', () => {
  it('a single command repeated exactly (period 1) never satisfies the distinct-fingerprint cycle requirement', async () => {
    const { pipeline } = makePipeline(OSCILLATION_RULE_YAML)
    const cmd = input('Bash', 'npm test')
    for (let i = 0; i < 6; i++) pipeline.recordAttemptOutcome(cmd, 1)
    // Six identical failures — no-repeat-loops' own promotion evidence shape
    // — must never trip THIS rule; it has no cycle of length >= 2 to find.
    expect((await pipeline.evaluate(cmd)).action).toBe('allow')
  })

  it('a period-2 unit whose own two elements are the SAME fingerprint (masquerading exact repeat) is skipped too', () => {
    const tracker = new OscillationTracker()
    const rule = parseRulesContent(OSCILLATION_RULE_YAML, '/tmp/x.yaml').rules[0]
    const cmd = input('Bash', 'npm test')
    // AAAA — satisfies the raw period-2 slice-equality check but every
    // element is the same fingerprint (distinct count 1), so it must be
    // rejected as a "cycle" in its own right.
    for (let i = 0; i < 4; i++) tracker.recordOutcome(rule, cmd, 1)
    expect(tracker.check(rule, cmd)).toBeNull()
  })
})

describe('oscillation tracker: rolling window ages out old fingerprints', () => {
  afterEach(() => vi.useRealTimers())

  it('a stale pair from before window_seconds does not combine with a fresh pair into a phantom cycle (in-memory)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const tracker = new OscillationTracker()
    const rule = { ...parseRulesContent(OSCILLATION_RULE_YAML, '/tmp/x.yaml').rules[0], window_seconds: 600 } // 10 min TTL
    const A = input('Bash', 'npm run lint')
    const B = input('Bash', 'npm run build')

    // Old pair at t=0.
    tracker.recordOutcome(rule, A, 1)
    tracker.recordOutcome(rule, B, 1)

    // 20 minutes later — well past the 10-minute window.
    vi.setSystemTime(20 * 60 * 1000)
    tracker.recordOutcome(rule, A, 1)
    tracker.recordOutcome(rule, B, 1)

    // If the old pair had survived, the window would read [A,B,A,B] — a
    // full 2-repeat cycle. It must not: the old entries were pruned at
    // append time, leaving only the fresh [A,B] (2 entries, one short of
    // the 4 needed for a period-2 cycle at min_cycle_repeats: 2).
    expect(tracker.check(rule, A)).toBeNull()
  })

  it('the SAME phantom-combination case against the PERSISTED store, where check() must re-derive freshness from the CURRENT rule.window_seconds rather than trust whatever was stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-oscillation-store-test-'))
    try {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const store = new PersistentOscillationStore(dir)
      const key = 'osc:t-oscillation:phantom-session'
      // Write directly through the store with a deliberately HUGE windowMs
      // so the STORE's own write-time pruning never fires — this isolates
      // the test to check()'s OWN live re-derivation, not append()'s.
      const hugeWindowMs = 999_999_999_999
      store.append(key, { fp: 'A', at: Date.now(), exit: 1 }, hugeWindowMs, 8)
      store.append(key, { fp: 'B', at: Date.now(), exit: 1 }, hugeWindowMs, 8)

      vi.setSystemTime(20 * 60 * 1000) // 20 minutes later
      store.append(key, { fp: 'A', at: Date.now(), exit: 1 }, hugeWindowMs, 8)
      store.append(key, { fp: 'B', at: Date.now(), exit: 1 }, hugeWindowMs, 8)

      // The raw persisted bucket now genuinely holds [A@0,B@0,A@20m,B@20m] —
      // a full ABAB sequence, unfiltered (PersistentOscillationStore.get()
      // is deliberately raw; see its own header comment). A rule whose
      // CURRENT window_seconds is short (10 min, shorter than the 20-minute
      // gap) must still see only the fresh half once OscillationTracker.
      // check() re-derives freshness live — proving the prune runs before
      // BOTH the cycle test and the repeat count, from the SAME re-derived
      // array, not against the stale unfiltered one.
      const tracker = new OscillationTracker(store)
      const rule = { ...parseRulesContent(OSCILLATION_RULE_YAML, '/tmp/x.yaml').rules[0], window_seconds: 600 }
      const A = input('Bash', 'npm run lint', 'phantom-session')
      expect(tracker.check(rule, A)).toBeNull()
    } finally {
      rmSafe(dir)
    }
  })

  it('a fresh 2-repeat cycle within the window still fires normally (the aging logic does not over-prune)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const tracker = new OscillationTracker()
    const rule = { ...parseRulesContent(OSCILLATION_RULE_YAML, '/tmp/x.yaml').rules[0], window_seconds: 600 }
    const A = input('Bash', 'npm run lint')
    const B = input('Bash', 'npm run build')
    tracker.recordOutcome(rule, A, 1)
    tracker.recordOutcome(rule, B, 1)
    vi.setSystemTime(60_000) // 1 minute later — well within the 10-minute window
    tracker.recordOutcome(rule, A, 1)
    tracker.recordOutcome(rule, B, 1)
    const result = tracker.check(rule, A)
    expect(result?.action).toBe('redirect')
    expect(result?.attempts).toBe(2)
  })
})

describe('oscillation tracker: session isolation', () => {
  it('keeps sessions separate — a cycle in one session does not leak into another', async () => {
    const { pipeline } = makePipeline(OSCILLATION_RULE_YAML)
    const A1 = input('Bash', 'npm run lint', 'session-a')
    const B1 = input('Bash', 'npm run build', 'session-a')
    pipeline.recordAttemptOutcome(A1, 1)
    pipeline.recordAttemptOutcome(B1, 1)
    pipeline.recordAttemptOutcome(A1, 1)
    pipeline.recordAttemptOutcome(B1, 1)
    expect((await pipeline.evaluate(input('Bash', 'npm run lint', 'session-b'))).action).toBe('allow')
  })
})
