import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import { ProblemLedger, problemKey } from '../problem-ledger.js'
import type { EnforceInput } from '../../types.js'

/**
 * Phase 2b — the root-cause layer:
 *   - ProblemLedger: problems/hypotheses/diagnosis evidence, per-session
 *     active problem, file persistence shared across instances
 *   - `diagnosis` rules: complex fixes gated on a fresh hypothesis (or
 *     diagnosis evidence); recorded hypotheses and git investigation
 *     discharge the gate
 */

const DIAGNOSIS_RULE = `version: 1
rules:
  - id: diagnose-before-refactor
    type: diagnosis
    match: "(refactor|rewrite|migrat|delet|remov|drop)"
    hypothesis_window_seconds: 900
    action: redirect
    message: "Complex change without a stated root cause."
`

function makePipeline(yaml: string, ledger: ProblemLedger): EnforcementPipeline {
  const rules = parseRulesContent(yaml, '/tmp/diagnosis-rules.yaml')
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ledger,
    ruleHierarchy: { global: rules, user: null, project: null, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
  })
}

function input(tool: string, args: Record<string, unknown>, session = 'diag-test'): EnforceInput {
  return {
    tool,
    args,
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

describe('problem ledger', () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    previousHome = process.env.HOME
    process.env.HOME = home
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    execSync(`rm -rf "${home}"`)
  })

  it('tracks failures, the active session problem, and resolution', () => {
    const ledger = new ProblemLedger()
    const key = ledger.recordOutcome('/tmp', 'npm test', 1, 's1')
    ledger.recordOutcome('/tmp', 'npm test', 1, 's1')
    const problem = ledger.problem(key)
    expect(problem?.failures).toBe(2)
    expect(problem?.status).toBe('opened')
    expect(ledger.activeProblemKey('s1')).toBe(key)
    expect(ledger.activeProblemKey('s2')).toBeUndefined()

    ledger.recordOutcome('/tmp', 'npm test', 0, 's1')
    expect(ledger.problem(key)?.status).toBe('resolved')
  })

  it('marks a problem stuck after three failures', () => {
    const ledger = new ProblemLedger()
    const key = ledger.recordOutcome('/tmp', 'npm test', 1, 's1')
    ledger.recordOutcome('/tmp', 'npm test', 1, 's1')
    ledger.recordOutcome('/tmp', 'npm test', 1, 's1')
    expect(ledger.problem(key)?.status).toBe('stuck')
  })

  it('records hypotheses and honors the freshness window', () => {
    const ledger = new ProblemLedger()
    const key = ledger.recordOutcome('/tmp', 'npm test', 1, 's1')
    expect(ledger.hasFreshHypothesis(key, 900)).toBe(false)
    ledger.addHypothesis(key, 'Because the cache is stale, the test fails.', ['evt_1'])
    expect(ledger.hasFreshHypothesis(key, 900)).toBe(true)
    const hyp = ledger.problem(key)?.hypotheses[0]
    expect(hyp?.statement).toContain('Because')
    expect(hyp?.status).toBe('unverified')
  })

  it('persists to disk and shares state across instances', () => {
    const ledger = new ProblemLedger()
    const key = ledger.recordOutcome('/tmp', 'npm test', 1, 's1')
    ledger.addHypothesis(key, 'Because X, Y fails.')
    const recreated = new ProblemLedger()
    expect(recreated.hasFreshHypothesis(key, 900)).toBe(true)
    expect(recreated.activeProblemKey('s1')).toBe(key)
  })

  it('records diagnosis evidence that discharges the gate', () => {
    const ledger = new ProblemLedger()
    const key = ledger.recordOutcome('/tmp', 'npm test', 1, 's1')
    ledger.recordDiagnosis(key, 'git log --oneline -5')
    expect(ledger.hasFreshDiagnosis(key, 900)).toBe(true)
  })
})

describe('diagnosis rules (root-cause marker)', () => {
  let home: string
  let previousHome: string | undefined
  let ledger: ProblemLedger

  beforeEach(() => {
    home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    previousHome = process.env.HOME
    process.env.HOME = home
    ledger = new ProblemLedger()
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    execSync(`rm -rf "${home}"`)
  })

  it('redirects a complex fix when no hypothesis exists for the active problem', async () => {
    const pipeline = makePipeline(DIAGNOSIS_RULE, ledger)
    pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'd1'), 1)
    const result = await pipeline.evaluate(input('write', { filePath: '/tmp/src/x.ts', content: 'refactor' }, 'd1'))
    expect(result.action).toBe('redirect')
    expect(result.redirect?.kind).toBe('diagnosis')
    expect(result.redirect?.suggested_call).toContain('keel_hypothesis')
  })

  it('allows the fix once a hypothesis is recorded for the problem', async () => {
    const pipeline = makePipeline(DIAGNOSIS_RULE, ledger)
    pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'd2'), 1)
    const key = ledger.activeProblemKey('d2')
    ledger.addHypothesis(key as string, 'Because the cache is stale, the test fails.')
    const result = await pipeline.evaluate(input('write', { filePath: '/tmp/src/x.ts', content: 'refactor' }, 'd2'))
    expect(result.action).toBe('allow')
  })

  it('allows diagnosis evidence actions and records them', async () => {
    const yaml = `version: 1
rules:
  - id: diagnose-with-evidence
    type: diagnosis
    match: "(refactor|migrat)"
    fallback_tools: [Bash]
    fallback_pattern: "git (log|blame|bisect)"
    action: redirect
    message: "Diagnose first."
`
    const pipeline = makePipeline(yaml, ledger)
    pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'd3'), 1)
    const key = ledger.activeProblemKey('d3')
    const diag = await pipeline.evaluate(input('Bash', { command: 'git log --oneline -5' }, 'd3'))
    expect(diag.action).toBe('allow')
    expect(ledger.hasFreshDiagnosis(key as string, 900)).toBe(true)
    const fix = await pipeline.evaluate(input('write', { filePath: '/tmp/src/x.ts', content: 'migrate' }, 'd3'))
    expect(fix.action).toBe('allow')
  })

  it('ignores actions that do not match the diagnosis trigger', async () => {
    const pipeline = makePipeline(DIAGNOSIS_RULE, ledger)
    pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'd4'), 1)
    const result = await pipeline.evaluate(input('Bash', { command: 'echo hello' }, 'd4'))
    expect(result.action).toBe('allow')
  })

  it('allows when there is no active problem (nothing failing)', async () => {
    const pipeline = makePipeline(DIAGNOSIS_RULE, ledger)
    const result = await pipeline.evaluate(input('write', { filePath: '/tmp/src/new.ts', content: 'refactor' }, 'd5'))
    expect(result.action).toBe('allow')
  })
})

describe('problem key derivation', () => {
  it('is deterministic per cwd and fingerprint', () => {
    expect(problemKey('/a', 'npm test')).toBe(problemKey('/a', 'npm test'))
    expect(problemKey('/a', 'npm test')).not.toBe(problemKey('/b', 'npm test'))
  })
})
