import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { StateManager } from '../state-manager.js'
import { OracleTracker } from '../oracle-tracker.js'
import { detectWeakening } from '../oracle-signatures.js'
import { parseRulesContent, validateRules } from '../rule-parser.js'
import type { EnforceInput, KeelRule } from '../../types.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Wave-2 Lane 4 — test-oracle tampering detector.
 *
 * Three layers, matching the module split:
 *   - oracle-signatures.ts: pure content-diff heuristics (no I/O, no state)
 *   - oracle-tracker.ts: the recency window (StateManager-backed, so it
 *     survives across process-per-call hosts)
 *   - pipeline.ts's `oracle` branch, exercised end-to-end through the REAL
 *     shipped rule (session/proposals/test-oracle-tampering.yaml) — the
 *     synthetic fixture set the lane mandate calls for.
 */

// ── Layer 1: oracle-signatures.ts (pure) ──

describe('oracle-signatures: detectWeakening (pure content-diff heuristics)', () => {
  it('flags a .skip( added to a previously-unskipped test', () => {
    const before = `describe('math', () => {\n  it('adds', () => { expect(1 + 1).toBe(2) })\n})\n`
    const after = `describe('math', () => {\n  it.skip('adds', () => { expect(1 + 1).toBe(2) })\n})\n`
    const signals = detectWeakening(before, after)
    expect(signals.map(s => s.id)).toContain('skip-added')
  })

  it('flags a python @pytest.mark.skip added', () => {
    const before = `def test_adds():\n    assert 1 + 1 == 2\n`
    const after = `@pytest.mark.skip(reason="flaky")\ndef test_adds():\n    assert 1 + 1 == 2\n`
    const signals = detectWeakening(before, after)
    expect(signals.map(s => s.id)).toContain('skip-added')
  })

  it('flags .only( added (silences the rest of the file)', () => {
    const before = `it('a', () => { expect(1).toBe(1) })\nit('b', () => { expect(2).toBe(2) })\n`
    const after = `it.only('a', () => { expect(1).toBe(1) })\nit('b', () => { expect(2).toBe(2) })\n`
    const signals = detectWeakening(before, after)
    expect(signals.map(s => s.id)).toContain('only-added')
  })

  it('flags assertions removed with no comparable addition', () => {
    const before = `it('adds', () => {\n  expect(1 + 1).toBe(2)\n  expect(2 + 2).toBe(4)\n})\n`
    const after = `it('adds', () => {\n  expect(1 + 1).toBe(2)\n})\n`
    const signals = detectWeakening(before, after)
    expect(signals.map(s => s.id)).toContain('assertions-removed')
  })

  it('flags a whole test block deleted', () => {
    const before = `it('a', () => { expect(1).toBe(1) })\nit('b', () => { expect(2).toBe(2) })\n`
    const after = `it('a', () => { expect(1).toBe(1) })\n`
    const signals = detectWeakening(before, after)
    expect(signals.map(s => s.id)).toContain('test-block-deleted')
    expect(signals.map(s => s.id)).toContain('assertions-removed')
  })

  it('flags an expected-value rewrite on the same assertion call', () => {
    const before = `it('totals', () => { expect(cart.total).toBe(42) })\n`
    const after = `it('totals', () => { expect(cart.total).toBe(0) })\n`
    const signals = detectWeakening(before, after)
    expect(signals.map(s => s.id)).toContain('expected-value-rewrite')
  })

  it('flags a sweeping timeout inflation', () => {
    const before = `it('slow', () => { ... }, { timeout: 2000 })\n`
    const after = `it('slow', () => { ... }, { timeout: 30000 })\n`
    const signals = detectWeakening(before, after)
    expect(signals.map(s => s.id)).toContain('timeout-retry-inflation')
  })

  it('flags a sweeping retry inflation', () => {
    const before = `test.retry(1)\nit('flaky', () => { expect(1).toBe(1) })\n`
    const after = `test.retry(10)\nit('flaky', () => { expect(1).toBe(1) })\n`
    const signals = detectWeakening(before, after)
    expect(signals.map(s => s.id)).toContain('timeout-retry-inflation')
  })

  it('does NOT flag a small, non-sweeping retry bump (1 -> 2)', () => {
    const before = `retries: 1\n`
    const after = `retries: 2\n`
    const signals = detectWeakening(before, after)
    expect(signals.map(s => s.id)).not.toContain('timeout-retry-inflation')
  })

  it('flags a .snap file rewrite by path alone, regardless of content', () => {
    const signals = detectWeakening('old snapshot data', 'new snapshot data', 'src/__snapshots__/App.test.ts.snap')
    expect(signals.map(s => s.id)).toContain('snapshot-file-rewrite')
  })

  it('does NOT flag a pure addition (new test, nothing removed)', () => {
    const before = `it('a', () => { expect(1).toBe(1) })\n`
    const after = `it('a', () => { expect(1).toBe(1) })\nit('b', () => { expect(2).toBe(2) })\n`
    const signals = detectWeakening(before, after)
    expect(signals).toEqual([])
  })

  it('does NOT flag a rename that preserves every assertion', () => {
    const before = `it('computes the total', () => { expect(cart.total).toBe(42) })\n`
    const after = `it('computes the cart total correctly', () => { expect(cart.total).toBe(42) })\n`
    const signals = detectWeakening(before, after)
    expect(signals).toEqual([])
  })

  it('does NOT flag prose-only edits (no test/assert syntax at all)', () => {
    const before = `# Test suite notes\n\nRun with npm test.\n`
    const after = `# Test suite notes\n\nRun with npm test. See CONTRIBUTING.md for details.\n`
    const signals = detectWeakening(before, after)
    expect(signals).toEqual([])
  })
})

// ── Layer 2: OracleTracker (recency window) ──

const TRIGGER_RULE: KeelRule = {
  id: 'oracle-unit',
  type: 'oracle',
  action: 'warn',
  message: 'x',
  mode: 'observe',
  trigger: { tools: ['Bash'], pattern: '(npm test|vitest|jest)', exit: 'nonzero' },
  window_seconds: 900,
}

function oracleInput(tool: string, args: Record<string, unknown>, cwd = '/tmp/oracle-unit', session = 's1'): EnforceInput {
  return {
    tool, args, cwd, session_id: session, turn_number: 1, context_tokens: 0,
    level: 'balanced', context: 'local', agent: 'test', subagent_of: null,
  }
}

describe('OracleTracker: recency window', () => {
  it('arms on a failing trigger match and reports age', () => {
    const tracker = new OracleTracker()
    tracker.observeOutcome(TRIGGER_RULE, oracleInput('Bash', { command: 'npm test' }), 1)
    const recent = tracker.recentFailure(TRIGGER_RULE, oracleInput('write', {}))
    expect(recent).not.toBeNull()
    expect(recent!.ageMs).toBeGreaterThanOrEqual(0)
    expect(recent!.command).toContain('npm test')
  })

  it('does NOT arm on a passing (exit 0) trigger match', () => {
    const tracker = new OracleTracker()
    tracker.observeOutcome(TRIGGER_RULE, oracleInput('Bash', { command: 'npm test' }), 0)
    expect(tracker.recentFailure(TRIGGER_RULE, oracleInput('write', {}))).toBeNull()
  })

  it('does NOT arm on a null exit code (unknown outcome)', () => {
    const tracker = new OracleTracker()
    tracker.observeOutcome(TRIGGER_RULE, oracleInput('Bash', { command: 'npm test' }), null)
    expect(tracker.recentFailure(TRIGGER_RULE, oracleInput('write', {}))).toBeNull()
  })

  it('does NOT arm on a failing command that does not match the trigger pattern', () => {
    const tracker = new OracleTracker()
    tracker.observeOutcome(TRIGGER_RULE, oracleInput('Bash', { command: 'npm run lint' }), 1)
    expect(tracker.recentFailure(TRIGGER_RULE, oracleInput('write', {}))).toBeNull()
  })

  it('expires after window_seconds', () => {
    const tracker = new OracleTracker()
    const agedRule = { ...TRIGGER_RULE, window_seconds: -1 } // already-expired window
    tracker.observeOutcome(agedRule, oracleInput('Bash', { command: 'npm test' }), 1)
    expect(tracker.recentFailure(agedRule, oracleInput('write', {}))).toBeNull()
  })

  it('is session-scoped: a different session in the same cwd sees no arm', () => {
    const tracker = new OracleTracker()
    tracker.observeOutcome(TRIGGER_RULE, oracleInput('Bash', { command: 'npm test' }, '/tmp/oracle-unit', 'session-a'), 1)
    expect(tracker.recentFailure(TRIGGER_RULE, oracleInput('write', {}, '/tmp/oracle-unit', 'session-b'))).toBeNull()
    expect(tracker.recentFailure(TRIGGER_RULE, oracleInput('write', {}, '/tmp/oracle-unit', 'session-a'))).not.toBeNull()
  })

  describe('StateManager persistence (process-per-call hosts)', () => {
    let stateDir: string
    let priorStateDir: string | undefined

    beforeEach(() => {
      stateDir = mkdtempSync(join(tmpdir(), 'keel-oracle-state-'))
      priorStateDir = process.env.KEEL_STATE_DIR
      process.env.KEEL_STATE_DIR = stateDir
    })
    afterEach(() => {
      if (priorStateDir === undefined) delete process.env.KEEL_STATE_DIR
      else process.env.KEEL_STATE_DIR = priorStateDir
      rmSafe(stateDir)
    })

    it('survives a brand-new tracker + StateManager instance (simulates a fresh process per hook call)', () => {
      // Process 1: the Bash after-hook records a failure.
      const sm1 = new StateManager()
      const tracker1 = new OracleTracker(sm1)
      tracker1.observeOutcome(TRIGGER_RULE, oracleInput('Bash', { command: 'npm test' }), 1)

      // Process 2: a fresh StateManager + OracleTracker, as a per-call host
      // would construct after the process exits and a new one spawns for
      // the next tool call. No in-memory state is shared.
      const sm2 = new StateManager()
      const tracker2 = new OracleTracker(sm2)
      const recent = tracker2.recentFailure(TRIGGER_RULE, oracleInput('write', {}))
      expect(recent).not.toBeNull()
      expect(recent!.command).toContain('npm test')
    })
  })
})

// ── Layer 3: the shipped rule, through the real pipeline ──

/**
 * This test file lives at packages/core/src/enforce/__tests__/, but the CLI
 * build COPIES the whole packages/core/src tree into packages/cli/src/core/
 * (see packages/cli's build script) — so this exact file also runs a second
 * time from packages/cli/src/core/enforce/__tests__/, one path segment
 * DEEPER relative to the repo root. A fixed count of ".." would be right in
 * only one of the two locations, so this walks upward looking for the repo
 * root (identified by session/proposals/ existing as a child) instead of
 * assuming a depth.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'session', 'proposals'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('could not locate repo root (session/proposals/) above ' + dirname(fileURLToPath(import.meta.url)))
}

const REPO_ROOT = findRepoRoot()
const PROPOSAL_PATH = join(REPO_ROOT, 'session', 'proposals', 'test-oracle-tampering.yaml')

function loadShippedOracleRule(): KeelRule {
  const yaml = readFileSync(PROPOSAL_PATH, 'utf-8')
  const parsed = parseRulesContent(yaml, PROPOSAL_PATH)
  expect(parsed.errors, `test-oracle-tampering.yaml failed to parse: ${parsed.errors}`).toBeUndefined()
  expect(validateRules(parsed.rules), 'test-oracle-tampering.yaml failed validation').toEqual([])
  expect(parsed.rules).toHaveLength(1)
  return parsed.rules[0]
}

function buildOraclePipeline(rule: KeelRule): { pipeline: EnforcementPipeline; stateManager: StateManager } {
  const stateManager = new StateManager()
  const pipeline = new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: { global: null, user: null, project: { config: { version: 1, level: 'balanced', rules: [rule] }, rules: [rule], sourcePath: '/oracle-fixture/nonexistent.yaml', version: 1, markdown: '' }, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
    stateManager,
  })
  return { pipeline, stateManager }
}

function bashInput(command: string, cwd: string, session: string): EnforceInput {
  return {
    tool: 'Bash', args: { command }, cwd, session_id: session, turn_number: 1,
    context_tokens: 0, level: 'balanced', context: 'local', agent: 'test', subagent_of: null,
  }
}

function writeInput(path: string, content: string, cwd: string, session: string): EnforceInput {
  return {
    tool: 'write', args: { path, content }, cwd, session_id: session, turn_number: 2,
    context_tokens: 0, level: 'balanced', context: 'local', agent: 'test', subagent_of: null,
  }
}

describe('oracle pipeline: session/proposals/test-oracle-tampering.yaml through the real pipeline', () => {
  const rule = loadShippedOracleRule()
  let stateDir: string
  let priorStateDir: string | undefined
  let scratchRoot: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'keel-oracle-pipeline-state-'))
    priorStateDir = process.env.KEEL_STATE_DIR
    process.env.KEEL_STATE_DIR = stateDir
    scratchRoot = mkdtempSync(join(tmpdir(), 'keel-oracle-pipeline-scratch-'))
  })
  afterEach(() => {
    if (priorStateDir === undefined) delete process.env.KEEL_STATE_DIR
    else process.env.KEEL_STATE_DIR = priorStateDir
    rmSafe(stateDir)
    rmSafe(scratchRoot)
  })

  it('ships mode: observe, action: warn — never blocks by construction', () => {
    expect(rule.mode).toBe('observe')
    expect(rule.action).toBe('warn')
    expect(rule.confidence).toBe('low')
    expect(rule.severity).toBe('high')
  })

  // ── MUST-FIRE ──

  it('MUST-FIRE: failing vitest run, then an edit adding .skip to the failing spec', async () => {
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const specPath = join(cwd, 'math.test.ts')
    const before = `import { describe, it, expect } from 'vitest'\ndescribe('math', () => {\n  it('adds', () => { expect(1 + 1).toBe(3) })\n})\n`
    mkdirSync(dirname(specPath), { recursive: true })
    writeFileSync(specPath, before)
    const { pipeline } = buildOraclePipeline(rule)

    const failing = bashInput('npx vitest run', cwd, 'sess-1')
    await pipeline.evaluate(failing)
    pipeline.recordAttemptOutcome(failing, 1)

    const after = `import { describe, it, expect } from 'vitest'\ndescribe('math', () => {\n  it.skip('adds', () => { expect(1 + 1).toBe(3) })\n})\n`
    const result = await pipeline.evaluate(writeInput('math.test.ts', after, cwd, 'sess-1'))
    expect(result.action).toBe('allow')          // mode: observe never blocks
    expect(result.observed_action).toBe('warn')  // but the verdict is recorded
    expect(result.rule_id).toBe('test-oracle-tampering')
    expect(result.message).toContain('skip')
  })

  it('MUST-FIRE: failing run, then deletion of the failing test block', async () => {
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const specPath = join(cwd, 'math.test.ts')
    const before = `it('adds', () => { expect(1 + 1).toBe(3) })\nit('subtracts', () => { expect(2 - 1).toBe(1) })\n`
    mkdirSync(dirname(specPath), { recursive: true })
    writeFileSync(specPath, before)
    const { pipeline } = buildOraclePipeline(rule)

    const failing = bashInput('npm test', cwd, 'sess-2')
    await pipeline.evaluate(failing)
    pipeline.recordAttemptOutcome(failing, 1)

    const after = `it('subtracts', () => { expect(2 - 1).toBe(1) })\n`
    const result = await pipeline.evaluate(writeInput('math.test.ts', after, cwd, 'sess-2'))
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBe('warn')
    expect(result.rule_id).toBe('test-oracle-tampering')
  })

  it('MUST-FIRE: failing run, then `jest -u` (command-surface snapshot rewrite)', async () => {
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const { pipeline } = buildOraclePipeline(rule)

    const failing = bashInput('npx jest', cwd, 'sess-3')
    await pipeline.evaluate(failing)
    pipeline.recordAttemptOutcome(failing, 1)

    const result = await pipeline.evaluate(bashInput('npx jest -u', cwd, 'sess-3'))
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBe('warn')
    expect(result.rule_id).toBe('test-oracle-tampering')
    expect(result.message).toContain('command-surface')
  })

  // ── MUST-NOT-FIRE ──

  it('MUST-NOT-FIRE: test edit with no recent failure', async () => {
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const specPath = join(cwd, 'math.test.ts')
    writeFileSync(specPath, `it('adds', () => { expect(1 + 1).toBe(2) })\n`)
    const { pipeline } = buildOraclePipeline(rule)

    // No prior failing run recorded for this session at all.
    const after = `it.skip('adds', () => { expect(1 + 1).toBe(2) })\n`
    const result = await pipeline.evaluate(writeInput('math.test.ts', after, cwd, 'sess-4'))
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: adding NEW tests after a failure (pure addition)', async () => {
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const specPath = join(cwd, 'math.test.ts')
    const before = `it('adds', () => { expect(1 + 1).toBe(2) })\n`
    writeFileSync(specPath, before)
    const { pipeline } = buildOraclePipeline(rule)

    const failing = bashInput('npm test', cwd, 'sess-5')
    await pipeline.evaluate(failing)
    pipeline.recordAttemptOutcome(failing, 1)

    const after = before + `it('subtracts', () => { expect(2 - 1).toBe(1) })\n`
    const result = await pipeline.evaluate(writeInput('math.test.ts', after, cwd, 'sess-5'))
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: refactor renaming a test, assertions preserved', async () => {
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const specPath = join(cwd, 'math.test.ts')
    const before = `it('computes the total', () => { expect(cart.total).toBe(42) })\n`
    writeFileSync(specPath, before)
    const { pipeline } = buildOraclePipeline(rule)

    const failing = bashInput('npm test', cwd, 'sess-6')
    await pipeline.evaluate(failing)
    pipeline.recordAttemptOutcome(failing, 1)

    const after = `it('computes the cart total correctly', () => { expect(cart.total).toBe(42) })\n`
    const result = await pipeline.evaluate(writeInput('math.test.ts', after, cwd, 'sess-6'))
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: docs edit in tests/README', async () => {
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const readmePath = join(cwd, 'tests', 'README.md')
    mkdirSync(dirname(readmePath), { recursive: true })
    const before = `# Test suite\n\nRun with npm test.\n`
    writeFileSync(readmePath, before)
    const { pipeline } = buildOraclePipeline(rule)

    const failing = bashInput('npm test', cwd, 'sess-7')
    await pipeline.evaluate(failing)
    pipeline.recordAttemptOutcome(failing, 1)

    const after = `# Test suite\n\nRun with npm test. See CONTRIBUTING.md.\n`
    const result = await pipeline.evaluate(writeInput('tests/README.md', after, cwd, 'sess-7'))
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: a passing test run does not arm the window at all', async () => {
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const specPath = join(cwd, 'math.test.ts')
    writeFileSync(specPath, `it('adds', () => { expect(1 + 1).toBe(2) })\n`)
    const { pipeline } = buildOraclePipeline(rule)

    const passing = bashInput('npm test', cwd, 'sess-8')
    await pipeline.evaluate(passing)
    pipeline.recordAttemptOutcome(passing, 0)

    const after = `it.skip('adds', () => { expect(1 + 1).toBe(2) })\n`
    const result = await pipeline.evaluate(writeInput('math.test.ts', after, cwd, 'sess-8'))
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBeUndefined()
  })

  it('MUST-FIRE decays: the same weakening edit outside the recency window does not fire', async () => {
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const specPath = join(cwd, 'math.test.ts')
    writeFileSync(specPath, `it('adds', () => { expect(1 + 1).toBe(2) })\n`)
    // A rule with an already-negative window: any recorded failure is
    // immediately "in the past" relative to the window.
    const agedRule = { ...rule, window_seconds: -1 }
    const { pipeline } = buildOraclePipeline(agedRule)

    const failing = bashInput('npm test', cwd, 'sess-9')
    await pipeline.evaluate(failing)
    pipeline.recordAttemptOutcome(failing, 1)

    const after = `it.skip('adds', () => { expect(1 + 1).toBe(2) })\n`
    const result = await pipeline.evaluate(writeInput('math.test.ts', after, cwd, 'sess-9'))
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBeUndefined()
  })
})

// ── Rule-parser validation ──

describe('rule-parser validation for oracle rules', () => {
  it('rejects an oracle rule with neither paths nor match', () => {
    const errors = validateRules([{ id: 'bad-oracle', type: 'oracle', action: 'warn', message: 'x', trigger: { tools: ['Bash'], pattern: 'npm test', exit: 'nonzero' } }])
    expect(errors.some(e => e.includes('needs paths') || e.includes('detection surface'))).toBe(true)
  })

  it('rejects an oracle rule with no trigger', () => {
    const errors = validateRules([{ id: 'bad-oracle-2', type: 'oracle', action: 'warn', message: 'x', paths: ['**/*.test.ts'] }])
    expect(errors.some(e => e.includes('needs a trigger'))).toBe(true)
  })

  it('accepts a well-formed oracle rule', () => {
    const errors = validateRules([{
      id: 'good-oracle', type: 'oracle', action: 'warn', message: 'x',
      paths: ['**/*.test.ts'], trigger: { tools: ['Bash'], pattern: 'npm test', exit: 'nonzero' },
    }])
    expect(errors).toEqual([])
  })
})

// ── tests-read-only.yaml: parses cleanly, is a plain filesystem/prompt rule ──

describe('session/proposals/tests-read-only.yaml (opt-in, never a default)', () => {
  const TESTS_READ_ONLY_PATH = join(REPO_ROOT, 'session', 'proposals', 'tests-read-only.yaml')

  it('parses and validates cleanly as a filesystem/prompt rule', () => {
    const yaml = readFileSync(TESTS_READ_ONLY_PATH, 'utf-8')
    const parsed = parseRulesContent(yaml, TESTS_READ_ONLY_PATH)
    expect(parsed.errors).toBeUndefined()
    expect(validateRules(parsed.rules)).toEqual([])
    expect(parsed.rules).toHaveLength(1)
    const rule = parsed.rules[0]
    expect(rule.type).toBe('filesystem')
    expect(rule.action).toBe('prompt')
    // Opt-in means no `mode: observe` crutch — this one really does prompt.
    expect(rule.mode).toBeUndefined()
  })

  it('prompts on a test-file write when exercised directly (never merged into a default ruleset)', async () => {
    const yaml = readFileSync(TESTS_READ_ONLY_PATH, 'utf-8')
    const parsed = parseRulesContent(yaml, TESTS_READ_ONLY_PATH)
    const rule = parsed.rules[0]
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-tro-state-'))
    const prior = process.env.KEEL_STATE_DIR
    process.env.KEEL_STATE_DIR = stateDir
    try {
      const pipeline = new EnforcementPipeline({
        level: 'balanced',
        context: 'local',
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(),
        sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: null, user: null, project: { config: { version: 1, level: 'balanced', rules: [rule] }, rules: [rule], sourcePath: '/tro-fixture/nonexistent.yaml', version: 1, markdown: '' }, local: null },
        ruleVersion: 1,
        allowedFixTransforms: true,
        disableFile: join(stateDir, 'DISABLED-unused'),
      })
      const result = await pipeline.evaluate({
        tool: 'write', args: { path: 'src/x.test.ts', content: 'it.skip("x", () => {})' },
        cwd: '/tmp/tro-fixture', session_id: 'tro-1', turn_number: 1, context_tokens: 0,
        level: 'balanced', context: 'local', agent: 'test', subagent_of: null,
      })
      expect(result.action).toBe('prompt')
      expect(result.rule_id).toBe('tests-read-only')
    } finally {
      if (prior === undefined) delete process.env.KEEL_STATE_DIR
      else process.env.KEEL_STATE_DIR = prior
      rmSafe(stateDir)
    }
  })
})
