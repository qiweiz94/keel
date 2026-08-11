import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent, validateRules } from '../rule-parser.js'
import { detectClaim, extractCommandMessages } from '../claim.js'
import type { StateManager } from '../state-manager.js'
import type { EnforceInput, KeelRule } from '../../types.js'

/**
 * Wave-2 Lane-3 — claim-to-evidence detector.
 *
 * See session/EVIDENCE/wave2-claim.md for the design writeup (grammar,
 * channel survey, window semantics, known misses). This file: (1) unit
 * tests the grammar directly, (2) runs the synthetic trajectories from the
 * task spec through the REAL pipeline, one mechanism per case (see the
 * comment on each must-NOT-fire test for which suppression path it
 * exercises — a case where two mechanisms could independently suppress it
 * would be a weak test and is deliberately avoided).
 */

// Never the real ~/.keel/overrides.json (match-surface.test.ts established
// this pattern — every deny/prompt verdict calls overrideStore.consume()
// even when nothing is armed). observe-mode never reaches that call at all
// (violation() short-circuits before it), but every pipeline here is built
// the same isolated way regardless, for consistency.
const noopOverrideStore = { consume: () => false, peek: () => null, list: () => ({}) }

const CLAIM_RULE = `version: 1
rules:
  - id: claim-without-evidence
    type: claim
    category: verification
    severity: high
    confidence: low
    mode: observe
    trigger:
      tools: [write, edit, apply_patch]
      path: "src/"
      pattern: "src/"
    satisfy:
      tools: [bash]
      pattern: "(npm test|npm run test|vitest|pytest)"
    verification_window_seconds: 300
    action: warn
    message: "Claimed done/fixed/tested/passing/verified/complete without a passing verification run since the last edit."
`

function makePipeline(yaml = CLAIM_RULE, stateManager?: StateManager): EnforcementPipeline {
  const parsed = parseRulesContent(yaml, '/tmp/claim-rules.md')
  expect(validateRules(parsed.rules)).toEqual([])
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    overrideStore: noopOverrideStore,
    ruleHierarchy: { global: null, user: null, project: parsed, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
    stateManager,
  })
}

function input(tool: string, args: Record<string, unknown>, extra: Partial<EnforceInput> = {}): EnforceInput {
  return {
    tool,
    args,
    cwd: '/tmp/claim-project',
    session_id: 'claim-session',
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
    ...extra,
  }
}

// ── Grammar unit tests ──────────────────────────────────────────────

describe('claim grammar (unit)', () => {
  it('fires on a subject + linking-verb completion claim', () => {
    expect(detectClaim(input('bash', {}, { reasoning: 'All tests pass now.' }))?.pattern).toBe('tests-pass')
    expect(detectClaim(input('bash', {}, { reasoning: 'The build is passing.' }))?.pattern).toBe('build-pass')
    expect(detectClaim(input('bash', {}, { reasoning: 'This is fixed.' }))?.pattern).toBe('linking-verb')
  })

  it('fires on a clause-leading past-participle claim', () => {
    expect(detectClaim(input('bash', {}, { reasoning: 'Fixed and passing.' }))?.pattern).toBe('clause-leading')
    expect(detectClaim(input('bash', {}, { reasoning: 'Done.' }))?.pattern).toBe('clause-leading')
  })

  it('does not fire on a bare keyword in non-claim position (position-awareness)', () => {
    // "fix:" is a conventional-commit label, not "fixed" — \bfixed\b never
    // matches it. This is the exact example from the wave's task spec.
    expect(detectClaim(input('bash', { command: 'git commit -m "fix: typo"' }))).toBeNull()
    // A bare tool/file mention of the word, not an assertion about it.
    expect(detectClaim(input('bash', {}, { reasoning: 'Reading src/fixed-width-parser.ts next.' }))).toBeNull()
  })

  it('does not fire on a claim word inside a code fence, inline code, URL, or path', () => {
    expect(detectClaim(input('bash', {}, { reasoning: 'See ```All tests pass``` in the log.' }))).toBeNull()
    expect(detectClaim(input('bash', {}, { reasoning: 'The `tests pass` flag controls this.' }))).toBeNull()
    expect(detectClaim(input('bash', {}, { reasoning: 'Docs: https://example.com/all-tests-pass' }))).toBeNull()
    expect(detectClaim(input('bash', {}, { reasoning: 'Wrote src/all-tests-pass/report.ts' }))).toBeNull()
  })

  it('does not fire when a quoted span in reasoning is reported speech', () => {
    const hit = detectClaim(input('bash', {}, {
      reasoning: 'The error output said: "All tests passing" — but the run actually failed with 3 errors.',
    }))
    expect(hit).toBeNull()
  })

  it('does not fire when a hedge/negation word is present anywhere in the utterance', () => {
    expect(detectClaim(input('bash', {}, { reasoning: 'Fixed the typo, tests not run yet.' }))).toBeNull()
    expect(detectClaim(input('bash', { command: 'git commit -m "wip: partial, tests not run yet"' }))).toBeNull()
    expect(detectClaim(input('bash', {}, { reasoning: 'This should now be fixed.' }))).toBeNull()
  })

  it('extracts commit/PR message VALUES, not the surrounding shell syntax', () => {
    expect(extractCommandMessages('git commit -m "all tests pass"')).toEqual(['all tests pass'])
    expect(extractCommandMessages('gh pr create --title "x" --body "Fixed and verified."')).toEqual(['x', 'Fixed and verified.'])
    expect(extractCommandMessages('git commit --message="Done."')).toEqual(['Done.'])
    expect(extractCommandMessages('echo hello')).toEqual([])
  })

  it('scans a commit-message claim without stripping its internal quotes (unlike the reasoning channel)', () => {
    // The message argument's own quotes are shell syntax bounding the
    // argument, not reported speech — the content inside is scanned as-is.
    const hit = detectClaim(input('bash', { command: 'git commit -m "All tests pass."' }))
    expect(hit?.source).toBe('command-message')
    expect(hit?.pattern).toBe('tests-pass')
  })
})

// ── Synthetic trajectories through the real pipeline ────────────────
//
// The shipped proposal (session/proposals/claim-without-evidence.yaml)
// ships `mode: observe`: the verdict is always `action: allow`, and
// `observed_action` carries what WOULD have fired (pipeline.ts:727). Every
// assertion below checks observed_action, not action — action === 'allow'
// is true in both the fire and no-fire cases and would pass vacuously.

describe('claim-without-evidence rule via the real pipeline (mode: observe)', () => {
  it('MUST-FIRE: edit, then "all tests pass" claimed with no test run at all since the edit', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'export const a = 1' }))
    const r = await p.evaluate(input('bash', { command: 'echo status' }, { reasoning: 'All tests pass, ready to ship.' }))
    expect(r.action).toBe('allow')
    expect(r.observed_action).toBe('warn')
    expect(r.rule_id).toBe('claim-without-evidence')
  })

  it('MUST-FIRE: edit, test run FAILS (nonzero exit, never discharges the obligation), then "fixed and passing" is claimed', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'export const a = 1' }))
    // A failing run is evaluated, but the host only calls
    // markVerificationSatisfied after a ZERO exit code (mirrors
    // opencode-plugin/src/plugin.ts:565's `if (exit === 0) ...` gate) — a
    // failing run is simulated by simply never calling it here, exactly as
    // that gate would behave for a nonzero exit.
    await p.evaluate(input('bash', { command: 'npm test' }))
    const r = await p.evaluate(input('bash', { command: 'echo done' }, { reasoning: 'Fixed and passing now.' }))
    expect(r.action).toBe('allow')
    expect(r.observed_action).toBe('warn')
    expect(r.rule_id).toBe('claim-without-evidence')
  })

  it('MUST-FIRE: edit, then the claim arrives via a commit message — the channel that actually fires in production (see EVIDENCE.md §2)', async () => {
    // The two MUST-FIRE cases above deliver the claim via `input.reasoning`
    // — proven in EVIDENCE.md §2 to be unwired in every surveyed host's
    // automatic hook today. This is the channel that IS reachable in
    // production: whatever the agent writes into a command's own message
    // argument. Without this case, nothing in this file end-to-end-proves
    // the rule fires through the channel it is actually expected to fire
    // through — a real gap, found only by checking (see also the
    // "gate-integration ordering" describe block below, which is what
    // surfaced the need to add this case).
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'export const a = 1' }))
    const r = await p.evaluate(input('bash', { command: 'git commit -m "All tests pass."' }))
    expect(r.action).toBe('allow')
    expect(r.observed_action).toBe('warn')
    expect(r.rule_id).toBe('claim-without-evidence')
  })

  it('MUST-NOT-FIRE: edit, test exits 0 (obligation discharged), then the same claim — mechanism: satisfied obligation, text never scanned', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'export const a = 1' }))
    const testCall = input('bash', { command: 'npm test' })
    await p.evaluate(testCall)
    p.markVerificationSatisfied(testCall)  // mirrors the host's post-hook on exit 0
    const r = await p.evaluate(input('bash', { command: 'echo done' }, { reasoning: 'All tests pass.' }))
    expect(r.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: WIP commit "wip: partial, tests not run yet" while pending — mechanism: hedge suppression', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'export const a = 1' }))  // obligation now pending
    const r = await p.evaluate(input('bash', { command: 'git commit -m "wip: partial, tests not run yet"' }))
    expect(r.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: docs-only change, then "done" — mechanism: trigger scope never armed the obligation', async () => {
    const p = makePipeline()
    // path is docs/, not src/ — the trigger's path/pattern never matches,
    // so isPending() is false regardless of what follows.
    await p.evaluate(input('write', { filePath: 'docs/readme.md', content: '# notes' }))
    const r = await p.evaluate(input('bash', { command: 'echo done' }, { reasoning: 'Done.' }))
    expect(r.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: commit message containing "fix:" while pending — mechanism: grammar precision (word boundary)', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'export const a = 1' }))  // obligation pending
    const r = await p.evaluate(input('bash', { command: 'git commit -m "fix: typo"' }))
    expect(r.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: claim text inside a quoted error message while pending — mechanism: quote-stripping in the reasoning channel', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'export const a = 1' }))  // obligation pending
    const r = await p.evaluate(input('bash', { command: 'echo checking' }, {
      reasoning: 'The error output said: "All tests passing" — but the run actually failed with 3 errors.',
    }))
    expect(r.observed_action).toBeUndefined()
  })

  it('the rule cannot distinguish "never ran" from "ran and failed" — both must-fire cases share the same pending state', async () => {
    // Documents the window-semantics limitation stated in claim.ts/pipeline.ts:
    // no evidence of a PASSING run since the edit is one bucket, whichever
    // of the two paths produced it.
    const neverRan = makePipeline()
    await neverRan.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    const r1 = await neverRan.evaluate(input('bash', {}, { reasoning: 'Done.' }))

    const ranAndFailed = makePipeline()
    await ranAndFailed.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    await ranAndFailed.evaluate(input('bash', { command: 'npm test' }))
    const r2 = await ranAndFailed.evaluate(input('bash', {}, { reasoning: 'Done.' }))

    expect(r1.observed_action).toBe('warn')
    expect(r2.observed_action).toBe('warn')
  })
})

// ── Window semantics ──────────────────────────────────────────────

describe('claim rule window semantics (verification_window_seconds)', () => {
  it('an obligation expires after the window — a late claim does not fire', async () => {
    const shortWindow = CLAIM_RULE.replace('verification_window_seconds: 300', 'verification_window_seconds: 1')
    const p = makePipeline(shortWindow)
    vi.useFakeTimers()
    try {
      await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
      vi.advanceTimersByTime(2000)  // past the 1s window
      const r = await p.evaluate(input('bash', {}, { reasoning: 'All tests pass.' }))
      // Expired pending state is neither a fire nor evidence of success —
      // it is simply "no obligation is currently tracked". A claim after
      // the window is invisible to this rule, a documented limitation, not
      // a pass on the merits.
      expect(r.observed_action).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a claim within the window still fires', async () => {
    const shortWindow = CLAIM_RULE.replace('verification_window_seconds: 300', 'verification_window_seconds: 60')
    const p = makePipeline(shortWindow)
    vi.useFakeTimers()
    try {
      await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
      vi.advanceTimersByTime(5000)  // well within the 60s window
      const r = await p.evaluate(input('bash', {}, { reasoning: 'All tests pass.' }))
      expect(r.observed_action).toBe('warn')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── Cross-process persistence ─────────────────────────────────────
//
// Every CLI-hosted call (`keel hook <host>`) is a SEPARATE OS process —
// hook.ts's initEnforce() builds a brand new EnforcementPipeline every
// invocation. In-memory pending state alone would silently forget an
// obligation the instant one process exits, so state must survive via the
// StateManager abstraction. This is proven the same way
// pipeline.test.ts's "shares rate-limit and first-warning state between
// pipeline instances" does: a fake StateManager, shared across TWO
// separate EnforcementPipeline instances (one per simulated process), with
// nothing touching real disk. (The real disk-backed StateManager's own
// load/save round-trip is state-manager.ts's own concern; this test proves
// the claim rule is correctly WIRED to whatever StateManager it is given.)

function sharedStateManager(): StateManager {
  const state = {
    denyFirstTime: {} as Record<string, number | { timestamp: number; version?: string }>,
    circuitBreaker: {} as Record<string, { count: number; startTime: number }>,
    rateCounts: {} as Record<string, { count: number; windowStart: number }>,
    verification: {} as Record<string, { createdAt: number; generation: number }>,
    markFirstTime(ruleId: string, version?: string) {
      this.denyFirstTime[ruleId] = version ? { timestamp: Date.now(), version } : Date.now()
    },
    isFirstTime(ruleId: string, version?: string) {
      const value = this.denyFirstTime[ruleId]
      return value === undefined || (!!version && (typeof value === 'number' || value.version !== version))
    },
    recordCircuitBreaker(ruleId: string, tool: string) {
      const key = `${ruleId}:${tool}`
      const now = Date.now()
      const current = this.circuitBreaker[key]
      this.circuitBreaker[key] = current && now - current.startTime < 60000
        ? { count: current.count + 1, startTime: current.startTime }
        : { count: 1, startTime: now }
      return this.circuitBreaker[key].count >= 3
    },
    checkRateLimit(ruleId: string, match: string, windowSec: number, maxCalls: number) {
      const key = `rate:${ruleId}:${match}`
      const now = Date.now()
      const current = this.rateCounts[key]
      this.rateCounts[key] = current && now - current.windowStart < windowSec * 1000
        ? { count: current.count + 1, windowStart: current.windowStart }
        : { count: 1, windowStart: now }
      return this.rateCounts[key].count > maxCalls
    },
    setVerification(key: string, value: { createdAt: number; generation: number }) {
      this.verification[key] = value
    },
    clearVerification(key: string) {
      delete this.verification[key]
    },
  }
  return state as unknown as StateManager
}

// ── The shipped proposal snippet itself ─────────────────────────────
//
// session/proposals/claim-without-evidence.yaml is not wired into
// DEFAULT_RULES_YAML this wave (single-owner file, pasted in by the
// supervisor at the gate per session/DECISIONS.md's Tier-3 convention) —
// but the snippet itself must be valid, parseable, and actually behave the
// way this file's synthetic trajectories above prove `type: claim` does.

// packages/cli's build step copies core's ENTIRE src tree (this file
// included) into packages/cli/src/core — see packages/cli/package.json's
// build script — so this file runs from two different depths below the
// repo root depending on which package's vitest invoked it. A fixed
// `../../../../..` climb is correct for exactly one of them; searching
// upward for the marker directory works from either.
function findRepoRoot(from: string): string {
  let dir = from
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'session', 'proposals'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`could not locate repo root (session/proposals/) above ${from}`)
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROPOSAL_PATH = join(findRepoRoot(HERE), 'session', 'proposals', 'claim-without-evidence.yaml')

function loadProposalRule(): KeelRule {
  const snippet = readFileSync(PROPOSAL_PATH, 'utf-8')
  const wrapped = `version: 1\nrules:\n${snippet}`
  const parsed = parseRulesContent(wrapped, PROPOSAL_PATH)
  expect(parsed.errors, `proposal YAML failed to parse: ${parsed.errors}`).toBeUndefined()
  expect(parsed.rules).toHaveLength(1)
  const errors = validateRules(parsed.rules)
  expect(errors, `proposal rule failed validation: ${errors}`).toEqual([])
  return parsed.rules[0]
}

describe('session/proposals/claim-without-evidence.yaml', () => {
  it('parses, validates, and is id "claim-without-evidence" with mode: observe', () => {
    const rule = loadProposalRule()
    expect(rule.id).toBe('claim-without-evidence')
    expect(rule.type).toBe('claim')
    expect(rule.mode).toBe('observe')
    expect(rule.action).toBe('warn')
  })

  it('the exact shipped snippet fires must-fire and stays silent on must-not-fire, through the real pipeline', async () => {
    const rule = loadProposalRule()
    const hierarchy = { global: null, user: null, local: null, project: { config: { version: 1, rules: [rule] }, rules: [rule], sourcePath: PROPOSAL_PATH, version: 1, markdown: '' } }
    const build = () => new EnforcementPipeline({
      level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(), overrideStore: noopOverrideStore,
      ruleHierarchy: hierarchy, ruleVersion: 1, allowedFixTransforms: true,
    })

    const fires = build()
    await fires.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    const fired = await fires.evaluate(input('bash', {}, { reasoning: 'All tests pass.' }))
    expect(fired.observed_action).toBe('warn')

    const silent = build()
    await silent.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    const testCall = input('bash', { command: 'npm test' })
    await silent.evaluate(testCall)
    silent.markVerificationSatisfied(testCall)
    const notFired = await silent.evaluate(input('bash', {}, { reasoning: 'All tests pass.' }))
    expect(notFired.observed_action).toBeUndefined()
  })
})

// ── Gate-integration ordering (the finding that changed the proposal) ──
//
// The proposal's trigger is IDENTICAL to the shipped `source-change-
// requires-test` verification rule's (same tools/path/paths/pattern), and
// neither sets `priority` (both default to 0). Extracted straight from the
// real DEFAULT_RULES_YAML source — not a hand-copied duplicate that could
// drift — the same technique packages/cli/src/__tests__/fixture-harness.test.ts
// uses for install.ts's copy of the same constant.
function loadShippedRule(id: string): KeelRule {
  const pluginSrc = readFileSync(join(findRepoRoot(fileURLToPath(new URL('.', import.meta.url))), 'packages', 'opencode-plugin', 'src', 'plugin.ts'), 'utf-8')
  const m = pluginSrc.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  expect(m, 'DEFAULT_RULES_YAML not found in plugin.ts').toBeTruthy()
  const parsed = parseRulesContent(m![1], 'plugin.ts:DEFAULT_RULES_YAML')
  expect(parsed.errors, `DEFAULT_RULES_YAML failed to parse: ${parsed.errors}`).toBeUndefined()
  const rule = parsed.rules.find(r => r.id === id)
  expect(rule, `rule "${id}" not found in DEFAULT_RULES_YAML`).toBeTruthy()
  return rule!
}

describe('gate-integration ordering: claim-without-evidence alongside the shipped source-change-requires-test', () => {
  function buildCombined(rules: KeelRule[]): EnforcementPipeline {
    const hierarchy = { global: null, user: null, local: null, project: { config: { version: 1, rules }, rules, sourcePath: '/tmp/combined.yaml', version: 1, markdown: '' } }
    return new EnforcementPipeline({
      level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(), overrideStore: noopOverrideStore,
      ruleHierarchy: hierarchy, ruleVersion: 1, allowedFixTransforms: true,
    })
  }

  // Previously (pre observe-continue fix): whichever of these two `mode:
  // observe` rules matched FIRST short-circuited evaluate() entirely and
  // swallowed the other's observed_action — an order-dependent finding
  // ("gate-integration ordering"). Fixed by pipeline.ts's evaluate()/
  // violation(): a matched observe rule records and evaluation CONTINUES
  // (OPA Gatekeeper dryrun / Cloudflare WAF log-mode semantics) instead of
  // returning, so BOTH observed_matches entries land regardless of file
  // order — that is the proof the ordering finding no longer applies. Both
  // variants below assert the SAME invariant on purpose; that sameness
  // (not the pre-fix "which one wins") is what changed. Neither rule is
  // non-observe, so with nothing definitive to decide the call, the verdict
  // is a bare allow either way — not asserted on `observed_action`
  // (singular), since which entry lands in slot 0 is still order-dependent
  // and re-encodes exactly the coupling this fix removed; observed_matches
  // is the complete, order-independent picture.
  it.each([
    ['shipped rule declared first, matching where it actually sits in DEFAULT_RULES_YAML', () => buildCombined([loadShippedRule('source-change-requires-test'), loadProposalRule()])],
    ['proposal rule declared first (reversed)', () => buildCombined([loadProposalRule(), loadShippedRule('source-change-requires-test')])],
  ])('%s: both observe rules record on the production-reachable commit-message channel', async (_label, build) => {
    const p = build()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    const r = await p.evaluate(input('bash', { command: 'git commit -m "all tests pass"' }))
    expect(r.action).toBe('allow')
    expect(r.observed_matches).toHaveLength(2)
    expect(r.observed_matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_id: 'source-change-requires-test', observed_action: 'warn' }),
      expect.objectContaining({ rule_id: 'claim-without-evidence', observed_action: 'warn' }),
    ]))
  })
})

describe('claim rule state persists across separate pipeline instances (process-per-call hosts)', () => {
  it('an obligation armed by process A is still pending and fires in process B', async () => {
    const state = sharedStateManager()
    // Process A: the edit call.
    await makePipeline(CLAIM_RULE, state).evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    // Process B: a brand new pipeline instance, same shared state — the
    // obligation must still be visible and the claim must still fire.
    const r = await makePipeline(CLAIM_RULE, state).evaluate(input('bash', {}, { reasoning: 'All tests pass.' }))
    expect(r.observed_action).toBe('warn')
  })

  it('a satisfy call in process B clears the obligation for process C', async () => {
    const state = sharedStateManager()
    await makePipeline(CLAIM_RULE, state).evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    const testCall = input('bash', { command: 'npm test' })
    const processB = makePipeline(CLAIM_RULE, state)
    await processB.evaluate(testCall)
    processB.markVerificationSatisfied(testCall)
    const r = await makePipeline(CLAIM_RULE, state).evaluate(input('bash', {}, { reasoning: 'All tests pass.' }))
    expect(r.observed_action).toBeUndefined()
  })
})

// ── evaluateClaim() — v0.4 Phase 1's narrow claim-only channel ──────
//
// The channel a real per-host wiring (OpenCode's `experimental.text.
// complete`, Claude Code's `Stop` hook `last_assistant_message`) drives:
// the agent's own completed output OUTSIDE a tool call. Deliberately a
// SEPARATE pipeline method from evaluate() (see pipeline.ts's header
// comment on evaluateClaim) — these tests prove both halves of that
// design: it reaches the same claim grammar/verification-tracker state
// evaluate() does, AND it does not touch anything evaluate() does that
// evaluateClaim() should not (flow/sequence/rate state the thesis
// experiment measures off keel's own traces).

function assistantUtterance(reasoning: string, extra: Partial<EnforceInput> = {}): EnforceInput {
  // No real tool ran — this models an assistant's completed text segment,
  // not a tool call. 'assistant-message' is not in any shipped trigger's
  // tool list, so it cannot accidentally arm/satisfy an obligation itself.
  return input('assistant-message', {}, { reasoning, ...extra })
}

describe('evaluateClaim() — the real per-host claim-reach channel (not evaluate())', () => {
  it('MUST-FIRE: edit, then a completed assistant utterance claims done with no test run since', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    const r = await p.evaluateClaim(assistantUtterance('Done, all tests pass.'))
    expect(r.action).toBe('allow')
    expect(r.observed_action).toBe('warn')
    expect(r.rule_id).toBe('claim-without-evidence')
  })

  it('MUST-NOT-FIRE: edit, test exits 0 (obligation discharged via the tool-call channel), then the same utterance via evaluateClaim', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    const testCall = input('bash', { command: 'npm test' })
    await p.evaluate(testCall)
    p.markVerificationSatisfied(testCall)   // mirrors the host's tool.execute.after on exit 0
    const r = await p.evaluateClaim(assistantUtterance('Done, all tests pass.'))
    expect(r.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: hedge/WIP utterance while pending — same grammar suppression as the tool-call channel', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    const r = await p.evaluateClaim(assistantUtterance('Still working on this, tests not run yet.'))
    expect(r.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: quoted reported speech in the utterance — same quote-stripping as the tool-call channel', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    const r = await p.evaluateClaim(assistantUtterance(
      'The error output said: "All tests passing" — but the run actually failed with 3 errors.',
    ))
    expect(r.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: docs-only edit never armed the obligation — evaluateClaim has nothing pending to check', async () => {
    const p = makePipeline()
    await p.evaluate(input('write', { filePath: 'docs/readme.md', content: '# notes' }))
    const r = await p.evaluateClaim(assistantUtterance('Done.'))
    expect(r.observed_action).toBeUndefined()
  })

  it('is a live method the real pipeline exposes (guards against a future signature/rename drift)', () => {
    const p = makePipeline()
    expect(typeof p.evaluateClaim).toBe('function')
  })

  it('does NOT contaminate rate-rule state — a phantom "call" per assistant utterance must not count toward runaway-budget counters the thesis experiment measures off keel traces', async () => {
    const RATE_AND_CLAIM = `${CLAIM_RULE}  - id: contamination-rate-check
    type: rate
    mode: observe
    match: ".*"
    window_seconds: 60
    max_calls: 1
    action: warn
    message: "rate probe"
`
    const p = makePipeline(RATE_AND_CLAIM)
    // Five evaluateClaim() calls — if this routed through the same counters
    // evaluate() does, the rate rule would already be well past max_calls.
    for (let i = 0; i < 5; i++) {
      await p.evaluateClaim(assistantUtterance('still investigating, not done yet'))
    }
    // The FIRST real evaluate() call is the rate rule's actual 1st count.
    // If evaluateClaim() had contaminated it, this would already exceed
    // max_calls: 1 and observe a 'warn'.
    const first = await p.evaluate(input('read', { filePath: 'src/other.ts' }))
    expect(first.observed_matches?.some(m => m.rule_id === 'contamination-rate-check')).toBeFalsy()
    // The SECOND real call is genuinely the rate rule's 2nd count and DOES
    // exceed max_calls — proving the rate mechanism itself still works and
    // the assertion above was not vacuous.
    const second = await p.evaluate(input('read', { filePath: 'src/other2.ts' }))
    expect(second.observed_matches?.some(m => m.rule_id === 'contamination-rate-check' && m.observed_action === 'warn')).toBe(true)
  })

  it('does NOT contaminate sequence/flow tracker state — spies on both trackers directly', async () => {
    const sequenceDetector = new SequenceDetector()
    const flowTracker = new FlowTracker()
    const seqSpy = vi.spyOn(sequenceDetector, 'record')
    const flowSpy = vi.spyOn(flowTracker, 'record')
    const parsed = parseRulesContent(CLAIM_RULE, '/tmp/claim-rules.md')
    const p = new EnforcementPipeline({
      level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(), sequenceDetector, flowTracker,
      overrideStore: noopOverrideStore,
      ruleHierarchy: { global: null, user: null, project: parsed, local: null },
      ruleVersion: 1, allowedFixTransforms: true,
    })
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    seqSpy.mockClear()
    flowSpy.mockClear()
    await p.evaluateClaim(assistantUtterance('Done, all tests pass.'))
    expect(seqSpy).not.toHaveBeenCalled()
    expect(flowSpy).not.toHaveBeenCalled()
  })

  it('does NOT activate unless_reasoning or the tier-7 reasoning-anomaly heuristic — evaluateClaim only ever touches type: claim rules', async () => {
    // A rule with unless_reasoning would newly be satisfiable by real
    // assistant text once evaluate() saw a populated `reasoning` field —
    // exactly the "populating an input activates dormant consumers"
    // failure mode this method exists to avoid. Proven here by an
    // unless_reasoning deny rule that WOULD be exempted by this utterance
    // if evaluateClaim() routed through evaluate()'s full tier stack.
    const yaml = `${CLAIM_RULE}  - id: unless-reasoning-probe
    type: command
    level: protect
    match: "probe-marker-command"
    unless_reasoning: "all tests pass"
    action: deny
    message: "should never be exempted by evaluateClaim"
`
    const p = makePipeline(yaml)
    await p.evaluate(input('write', { filePath: 'src/a.ts', content: 'x' }))
    // evaluateClaim() must not even glance at the command-type rule.
    const r = await p.evaluateClaim(assistantUtterance('All tests pass.'))
    expect(r.rule_id).toBe('claim-without-evidence')
    expect(r.observed_matches?.some(m => m.rule_id === 'unless-reasoning-probe')).toBeFalsy()
    // Confirm the probe rule is actually live and would otherwise reachable
    // via the real evaluate() path, so the assertion above is not vacuous.
    const denied = await p.evaluate(input('bash', { command: 'probe-marker-command' }))
    expect(denied.action).toBe('deny')
  })
})
