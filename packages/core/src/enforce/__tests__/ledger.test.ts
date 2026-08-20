import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import { ProblemLedger, problemKey, ledgerPath } from '../problem-ledger.js'
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

// EnforcementPipeline defaults `overrideStore` to a FileRuleOverrideStore
// rooted at the real `homedir()` when none is supplied, and every deny/
// warn/redirect verdict calls `overrideStore.consume()` — which touches
// real ~/.keel (mkdir + lock file) even when no override is ever armed.
// An in-memory stub keeps this suite's redirect scenarios off the real
// filesystem (see match-surface.test.ts's `noopOverrideStore`, same fix,
// same root cause).
const noopOverrideStore = { consume: () => false, peek: () => null, list: () => ({}) }

function makePipeline(yaml: string, ledger: ProblemLedger): EnforcementPipeline {
  const rules = parseRulesContent(yaml, '/tmp/diagnosis-rules.yaml')
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    overrideStore: noopOverrideStore,
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

describe('ledgerPath — KEEL_STATE_DIR resolves to a FILE, not the bare dir', () => {
  const previousEnv = process.env.KEEL_STATE_DIR

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.KEEL_STATE_DIR
    else process.env.KEEL_STATE_DIR = previousEnv
  })

  it('joins ledger.json onto KEEL_STATE_DIR, matching the homedir fallback shape', () => {
    process.env.KEEL_STATE_DIR = '/tmp/keel-state-example'
    // The fallback branch (no env var) is `join(homedir(), '.keel', 'state',
    // 'ledger.json')` — a FILE path ending in ledger.json. The env branch
    // must have the same shape: a file, not the bare directory. Getting
    // this wrong means ProblemLedger's `renameSync(tmp, this.path)` tries
    // to rename a file onto an existing directory (EISDIR/ENOTDIR),
    // silently swallowed by save()'s `catch { /* best effort */ }` — every
    // write under KEEL_STATE_DIR is a silent no-op.
    expect(ledgerPath()).toBe(join('/tmp/keel-state-example', 'ledger.json'))
  })
})

describe('problem ledger', () => {
  let home: string
  let previousHome: string | undefined
  let previousStateDir: string | undefined

  beforeEach(() => {
    home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    previousHome = process.env.HOME
    process.env.HOME = home
    // ledgerPath() prefers KEEL_STATE_DIR over the HOME-derived fallback
    // (see problem-ledger.ts), so setting HOME alone does not isolate
    // ProblemLedger when KEEL_STATE_DIR is set in the outer environment
    // (blanket mode, e.g. `KEEL_STATE_DIR=$(mktemp -d) npm test`) — every
    // test/file would then resolve the same literal ledger.json and
    // clobber each other's concurrent writes. Overriding KEEL_STATE_DIR
    // per test closes that gap regardless of the outer environment.
    previousStateDir = process.env.KEEL_STATE_DIR
    process.env.KEEL_STATE_DIR = join(home, 'keel-state')
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousStateDir === undefined) delete process.env.KEEL_STATE_DIR
    else process.env.KEEL_STATE_DIR = previousStateDir
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
  let previousStateDir: string | undefined
  let ledger: ProblemLedger

  beforeEach(() => {
    home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    previousHome = process.env.HOME
    process.env.HOME = home
    // See the 'problem ledger' describe block above: KEEL_STATE_DIR must
    // be overridden per test too, not just HOME, or a blanket
    // KEEL_STATE_DIR in the outer environment defeats this isolation.
    previousStateDir = process.env.KEEL_STATE_DIR
    process.env.KEEL_STATE_DIR = join(home, 'keel-state')
    ledger = new ProblemLedger()
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousStateDir === undefined) delete process.env.KEEL_STATE_DIR
    else process.env.KEEL_STATE_DIR = previousStateDir
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

/**
 * `LedgerData.problems` used to grow forever: `falsifyStaleHypotheses()`
 * existed but was never called from any production path (only tests
 * called it directly), and even called, it only flipped a hypothesis's
 * `status` — it never removed a problem entry. `pruneStale()` (wired into
 * `load()`, so it runs on construction, on `reloadIfChanged()`, and on
 * every `withLock()` mutation's reload — not just when something
 * remembers to call an admin method) now does both. These tests write
 * ledger.json directly (bypassing the class) to plant entries at
 * specific ages, since `recordOutcome`/`addHypothesis` always stamp
 * `Date.now()`.
 */
describe('problem ledger — bounded growth (stale pruning wired into load)', () => {
  const tmpDirs: string[] = []
  function freshLedgerPath(): string {
    const dir = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    tmpDirs.push(dir)
    return join(dir, 'ledger.json')
  }

  afterEach(() => {
    while (tmpDirs.length) {
      const dir = tmpDirs.pop()!
      execSync(`rm -rf "${dir}"`)
    }
  })

  const DAY_MS = 24 * 60 * 60 * 1000

  it('drops a problem whose last_seen is older than the 24h TTL, on construction alone', () => {
    const path = freshLedgerPath()
    const now = Date.now()
    const staleKey = problemKey('/stale/project', 'npm test')
    const freshKey = problemKey('/fresh/project', 'npm test')
    writeFileSync(path, JSON.stringify({
      problems: {
        [staleKey]: {
          problem_key: staleKey, first_seen: now - 2 * DAY_MS, last_seen: now - DAY_MS - 60_000,
          fingerprint: 'x', status: 'stuck', failures: 3, last_exit: 1, hypotheses: [], recent_diagnosis: [],
        },
        [freshKey]: {
          problem_key: freshKey, first_seen: now - 1000, last_seen: now - 1000,
          fingerprint: 'x', status: 'opened', failures: 1, last_exit: 1, hypotheses: [], recent_diagnosis: [],
        },
      },
      active: {},
    }))

    const ledger = new ProblemLedger(path)
    expect(ledger.problem(staleKey)).toBeUndefined()
    expect(ledger.problem(freshKey)).toBeDefined()
    expect(ledger.problems().length).toBe(1)
  })

  it('falsifies a stale unverified hypothesis even on a problem that is still fresh (last_seen recent)', () => {
    const path = freshLedgerPath()
    const now = Date.now()
    const key = problemKey('/still/active', 'npm test')
    writeFileSync(path, JSON.stringify({
      problems: {
        [key]: {
          problem_key: key, first_seen: now - 2 * DAY_MS, last_seen: now - 500, // touched recently
          fingerprint: 'x', status: 'stuck', failures: 3, last_exit: 1,
          hypotheses: [{ id: 'hyp_1', statement: 'old guess', evidence: [], at: now - DAY_MS - 60_000, status: 'unverified' }],
          recent_diagnosis: [],
        },
      },
      active: {},
    }))

    const ledger = new ProblemLedger(path)
    const problem = ledger.problem(key)
    expect(problem).toBeDefined()
    expect(problem?.hypotheses[0].status).toBe('falsified')
  })

  it('clears an active-session pointer that referenced a now-pruned problem', () => {
    const path = freshLedgerPath()
    const now = Date.now()
    const staleKey = problemKey('/gone/project', 'npm test')
    writeFileSync(path, JSON.stringify({
      problems: {
        [staleKey]: {
          problem_key: staleKey, first_seen: now - 2 * DAY_MS, last_seen: now - DAY_MS - 60_000,
          fingerprint: 'x', status: 'stuck', failures: 3, last_exit: 1, hypotheses: [], recent_diagnosis: [],
        },
      },
      active: { s1: staleKey },
    }))

    const ledger = new ProblemLedger(path)
    expect(ledger.activeProblemKey('s1')).toBeUndefined()
  })

  it('a problem well within the TTL survives untouched', () => {
    const path = freshLedgerPath()
    const now = Date.now()
    const key = problemKey('/recent/project', 'npm test')
    writeFileSync(path, JSON.stringify({
      problems: {
        [key]: {
          problem_key: key, first_seen: now - 1000, last_seen: now - 1000,
          fingerprint: 'x', status: 'opened', failures: 1, last_exit: 1,
          hypotheses: [{ id: 'hyp_1', statement: 'recent guess', evidence: [], at: now - 1000, status: 'unverified' }],
          recent_diagnosis: [],
        },
      },
      active: { s1: key },
    }))

    const ledger = new ProblemLedger(path)
    expect(ledger.problem(key)?.failures).toBe(1)
    expect(ledger.problem(key)?.hypotheses[0].status).toBe('unverified')
    expect(ledger.activeProblemKey('s1')).toBe(key)
  })
})
