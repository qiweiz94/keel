import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ActionCache,
  ContentTracker,
  EnforcementPipeline,
  FlowTracker,
  SequenceDetector,
  StuckTracker,
  ResearchTracker,
  ProblemLedger,
  parseRulesContent,
} from '@get-keel/core'
import type {
  EnforceInput,
  EnforceResult,
  KeelRule,
  PipelineConfig,
  ProtectionLevel,
  RuleContext,
  RuleHierarchy,
} from '@get-keel/core'

/**
 * M1r-1 — floor false-positive corpus (SPEC §8: ~0% FP on a first denial).
 *
 * Concrete known FP (session/v04/AUDIT.md): "no-destructive-commands blocks
 * a safe single-file `git checkout -- <file>`". Verified NOT reproducible
 * against no-destructive-commands itself — its match text has no `checkout`
 * alternative at all (confirmed by regex inspection and `git log -S` across
 * plugin.ts's full history: exactly one commit ever touched the string
 * "checkout", and it is not that rule). The pattern that DOES match
 * `git checkout -- file.ts` is `root-cause-before-refactor`'s
 * `(rm -rf|git checkout -- |git reset --hard|migrate|refactor)` — unanchored,
 * so a single-file checkout, and a plain "migrate"/"refactor" substring
 * inside any path or prose, all matched. It shipped `mode: observe`
 * (verified: the ONE commit that introduced the rule already carried
 * `mode: observe`, predating the audit note itself), so it never actually
 * interrupted anything — `violation()` throws OBSERVE_CONTINUE and the
 * pipeline returns `allow`. The live host's ~/.keel/rules.yaml carries the
 * same unpromoted pattern. Still: an observe-mode rule is a promotion
 * candidate, and the SPEC's ~0% FP target has to hold once promoted, not
 * just today. Fixed by scoping the pattern (this lane) so the corpus below
 * passes on PATTERN grounds, not mode grounds.
 *
 * Two passes:
 *   1. "as shipped" — the full DEFAULT_RULES_YAML ruleset (mode: observe
 *      included), proving today's real verdict for every corpus command.
 *   2. "if promoted" — a copy of DEFAULT_RULES_YAML with
 *      root-cause-before-refactor's `mode: observe` stripped, under an
 *      ACTIVE PROBLEM in the ledger (the only state that arms the rule at
 *      all — see problem-ledger.ts). This is the pass that actually
 *      exercises the tightened pattern; without it, an unchanged or even
 *      broader pattern would pass pass 1 for the same reason (mode, not
 *      pattern) that let the original FP through unnoticed.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const INSTALL_SRC = join(HERE, '..', 'commands', 'install.ts')

function extractRulesYaml(src: string): string {
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  expect(m, 'DEFAULT_RULES_YAML not found in install.ts').toBeTruthy()
  return m![1]
}

function loadDefaultRules(): KeelRule[] {
  const yaml = extractRulesYaml(readFileSync(INSTALL_SRC, 'utf-8'))
  const parsed = parseRulesContent(yaml, INSTALL_SRC)
  expect(parsed.errors, `DEFAULT_RULES_YAML failed to parse: ${parsed.errors}`).toBeUndefined()
  expect(parsed.rules.length).toBeGreaterThan(0)
  return parsed.rules
}

const DEFAULT_RULES = loadDefaultRules()

/** Same ruleset, but with root-cause-before-refactor's `mode: observe`
 * stripped so its pattern is what actually gates the verdict — see file
 * header. Every other rule is untouched (deep-cloned, not shared refs, so
 * mutating this copy can never leak into DEFAULT_RULES). */
function loadEnforcingRootCauseRules(): KeelRule[] {
  const rules = JSON.parse(JSON.stringify(DEFAULT_RULES)) as KeelRule[]
  const rule = rules.find((r) => r.id === 'root-cause-before-refactor')
  expect(rule, 'root-cause-before-refactor not found in DEFAULT_RULES_YAML').toBeTruthy()
  delete (rule as { mode?: string }).mode
  return rules
}

// ── Isolated pipeline construction (same technique as fixture-harness.test.ts) ──

let scratchRoot = ''

beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'keel-floor-fp-'))
  mkdirSync(scratchRoot, { recursive: true })
})

function buildHierarchy(rules: KeelRule[]): RuleHierarchy {
  return {
    global: null,
    user: null,
    local: null,
    project: {
      config: { version: 1, level: 'protect' as ProtectionLevel, rules },
      rules,
      sourcePath: '/keel-floor-fp-test/nonexistent-rules.yaml',
      version: 1,
      markdown: '',
    },
  }
}

function stubOverrideStore() {
  return { consume: () => false, peek: () => null, list: () => ({}) }
}

function buildPipeline(rules: KeelRule[], ledger?: ProblemLedger): EnforcementPipeline {
  const config: PipelineConfig = {
    level: 'protect',
    context: 'local' as RuleContext,
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: buildHierarchy(rules),
    ruleVersion: 1,
    allowedFixTransforms: true,
    disableFile: join(scratchRoot, 'DISABLED-unused'),
    overrideStore: stubOverrideStore(),
    stuckTracker: new StuckTracker(),
    researchTracker: new ResearchTracker(),
    ledger: ledger ?? new ProblemLedger(join(scratchRoot, `ledger-${Math.random().toString(36).slice(2)}.json`)),
  }
  return new EnforcementPipeline(config)
}

function input(command: string, sessionId: string): EnforceInput {
  return {
    tool: 'Bash',
    args: { command },
    cwd: scratchRoot,
    session_id: sessionId,
    turn_number: 1,
    context_tokens: 0,
    level: 'protect',
    context: 'local',
    agent: 'keel-floor-fp-test',
    subagent_of: null,
  }
}

async function evaluate(rules: KeelRule[], command: string, ledger?: ProblemLedger): Promise<EnforceResult> {
  const pipeline = buildPipeline(rules, ledger)
  const sessionId = `floor-fp-${Math.random().toString(36).slice(2)}`
  return pipeline.evaluate(input(command, sessionId))
}

// ── Corpus ──

const SAFE_COMMANDS = [
  'git status',
  'git checkout -- file.ts',
  'git checkout main',
  'git restore file',
  'npm install',
  'npm ci',
  'rm -rf node_modules',
  'rm -rf dist',
  'rm -rf build',
  'ls -la',
  'cat file',
  'mkdir -p x/y',
  'mv a b',
  'cp a b',
  'grep -r foo .',
]

const TRUE_POSITIVES: Array<{ cmd: string; ruleId: string }> = [
  { cmd: 'rm -rf /', ruleId: 'no-destructive-commands' },
  { cmd: 'rm -rf ~', ruleId: 'no-destructive-commands' },
  { cmd: 'r"m" -rf /', ruleId: 'no-destructive-commands' },
  { cmd: 'T=/; rm -rf $T', ruleId: 'no-destructive-commands' },
  { cmd: 'git push --force', ruleId: 'no-force-push' },
  { cmd: 'git reset --hard main', ruleId: 'protected-branch-reset' },
  { cmd: 'python3 -c "shutil.rmtree(\'/\')"', ruleId: 'no-destructive-interpreter-body' },
  { cmd: 'sudo rm -rf /', ruleId: 'no-destructive-commands' },
]

describe('floor FP corpus — as shipped (DEFAULT_RULES_YAML, mode: observe included)', () => {
  it.each(SAFE_COMMANDS)('SAFE, not blocked: %s', async (cmd) => {
    const result = await evaluate(DEFAULT_RULES, cmd)
    expect(['allow', 'warn'], `${cmd} -> action=${result.action} rule=${result.rule_id} msg=${result.message}`)
      .toContain(result.action)
  })

  it.each(TRUE_POSITIVES)('TRUE POSITIVE, still blocks: $cmd', async ({ cmd, ruleId }) => {
    const result = await evaluate(DEFAULT_RULES, cmd)
    expect(['deny', 'block'], `${cmd} -> action=${result.action} rule=${result.rule_id} msg=${result.message}`)
      .toContain(result.action)
    expect(result.rule_id, `${cmd} matched the wrong rule`).toBe(ruleId)
  })
})

describe('floor FP corpus — root-cause-before-refactor pattern, enforcing (mode: observe stripped)', () => {
  // This rule only ever evaluates when there is an ACTIVE PROBLEM for the
  // session (problem-ledger.ts) — recordAttemptOutcome with a nonzero exit
  // opens one. Without it every command here is `allow` for an unrelated
  // reason (no active problem), which would make this pass vacuous.
  function ledgerWithActiveProblem(sessionId: string): ProblemLedger {
    const ledger = new ProblemLedger(join(scratchRoot, `ledger-active-${Math.random().toString(36).slice(2)}.json`))
    ;(ledger as unknown as { recordOutcome: (cwd: string, cmd: string, code: number, session: string) => void })
      .recordOutcome(scratchRoot, 'npm test', 1, sessionId)
    return ledger
  }

  it('does NOT redirect a single-file checkout/restore — the fixed FP', async () => {
    const rules = loadEnforcingRootCauseRules()
    const sessionId = 'active-checkout'
    const ledger = ledgerWithActiveProblem(sessionId)
    const pipeline = buildPipeline(rules, ledger)
    const result = await pipeline.evaluate(input('git checkout -- file.ts', sessionId))
    expect(result.action, `msg=${result.message}`).toBe('allow')
  })

  it('does NOT redirect git checkout main (branch switch, not a discard)', async () => {
    const rules = loadEnforcingRootCauseRules()
    const sessionId = 'active-checkout-main'
    const ledger = ledgerWithActiveProblem(sessionId)
    const pipeline = buildPipeline(rules, ledger)
    const result = await pipeline.evaluate(input('git checkout main', sessionId))
    expect(result.action, `msg=${result.message}`).toBe('allow')
  })

  it('does NOT redirect a write to a migrations/ directory file (path substring)', async () => {
    const rules = loadEnforcingRootCauseRules()
    const sessionId = 'active-migrations-path'
    const ledger = ledgerWithActiveProblem(sessionId)
    const pipeline = buildPipeline(rules, ledger)
    const result = await pipeline.evaluate({
      tool: 'write',
      args: { filePath: 'src/migrations/001_init.ts', content: 'export const up = () => {}' },
      cwd: scratchRoot,
      session_id: sessionId,
      turn_number: 1,
      context_tokens: 0,
      level: 'protect',
      context: 'local',
      agent: 'keel-floor-fp-test',
      subagent_of: null,
    })
    expect(result.action, `msg=${result.message}`).toBe('allow')
  })

  it('STILL redirects a whole-tree discard: git checkout -- .', async () => {
    const rules = loadEnforcingRootCauseRules()
    const sessionId = 'active-checkout-dot'
    const ledger = ledgerWithActiveProblem(sessionId)
    const pipeline = buildPipeline(rules, ledger)
    const result = await pipeline.evaluate(input('git checkout -- .', sessionId))
    expect(result.action, `msg=${result.message}`).toBe('redirect')
    expect(result.rule_id).toBe('root-cause-before-refactor')
  })

  it('STILL redirects a bare whole-tree discard: git checkout .', async () => {
    const rules = loadEnforcingRootCauseRules()
    const sessionId = 'active-checkout-dot-bare'
    const ledger = ledgerWithActiveProblem(sessionId)
    const pipeline = buildPipeline(rules, ledger)
    const result = await pipeline.evaluate(input('git checkout .', sessionId))
    expect(result.action, `msg=${result.message}`).toBe('redirect')
    expect(result.rule_id).toBe('root-cause-before-refactor')
  })

  it('STILL redirects an explicit "refactor" in prose content', async () => {
    const rules = loadEnforcingRootCauseRules()
    const sessionId = 'active-refactor-prose'
    const ledger = ledgerWithActiveProblem(sessionId)
    const pipeline = buildPipeline(rules, ledger)
    // Plain echo, not `git commit`, so the unrelated auto-signoff `fix` rule
    // (higher priority, applies to any commit without --signoff) does not
    // intercept the call before root-cause-before-refactor evaluates.
    const result = await pipeline.evaluate(input('echo "starting a large refactor of the auth module"', sessionId))
    expect(result.action, `msg=${result.message}`).toBe('redirect')
    expect(result.rule_id).toBe('root-cause-before-refactor')
  })
})
