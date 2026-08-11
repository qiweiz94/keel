import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import type { EnforceInput, EnforceResult, KeelRule, PipelineConfig, ProtectionLevel, RuleContext, RuleHierarchy } from '@get-keel/core'

/**
 * Reachability probe for `test-oracle-env-introspection`, run under the
 * FULL 45-rule shipped default set (not the fixture harness's per-rule
 * isolation). fixture-harness.test.ts's own header explains why isolation
 * is necessary for a real per-rule "did this fire" assertion — but that
 * isolation also means a 7/7 pass there proves the PATTERN is correct
 * without proving the rule is ever actually reached when embedded among
 * 44 other rules on a real call.
 *
 * Two concrete failure shapes this guards against, both real and
 * documented elsewhere in this ruleset (see install.ts's own
 * "GATE INTEGRATION NOTE" above `test-oracle-tampering`, which documents
 * `claim-without-evidence` losing its single production channel to an
 * earlier same-trigger rule's short-circuit):
 *
 *   1. An earlier NON-observe rule matches the same call first and
 *      returns a real (non-thrown) EnforceResult, which is a genuine
 *      `return` inside evaluateTiers()'s loop — later rules, including
 *      this one, are never reached at all.
 *   2. An earlier OBSERVE rule ALSO matches the same call. Observe
 *      matches do not short-circuit (pipeline.ts's OBSERVE_CONTINUE
 *      throw/catch — verified by reading violation()'s implementation
 *      before writing this file), so this rule's check still RUNS, but
 *      `EnforcementPipeline.evaluate()` only mirrors `observed_matches[0]`
 *      onto the single `result.observed_action`/`result.rule_id` fields.
 *      A reader who only looks at those two fields (not the plural
 *      `observed_matches` array) could see a DIFFERENT rule's id/action
 *      and conclude this rule never fired, when it did.
 *
 * This file owns no rule logic and edits no shared harness — it is this
 * lane's own test, per the gate brief ("OWN: ... + your own tests").
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const INSTALL_SRC = join(HERE, '..', 'commands', 'install.ts')

function loadDefaultRules(): KeelRule[] {
  const src = readFileSync(INSTALL_SRC, 'utf-8')
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  expect(m, 'DEFAULT_RULES_YAML not found in install.ts').toBeTruthy()
  const parsed = parseRulesContent(m![1], INSTALL_SRC)
  expect(parsed.errors, `DEFAULT_RULES_YAML failed to parse: ${parsed.errors}`).toBeUndefined()
  expect(parsed.rules.length).toBeGreaterThan(0)
  return parsed.rules
}

const DEFAULT_RULES = loadDefaultRules()

let scratchRoot = ''
let stateDir = ''

function buildHierarchy(rules: KeelRule[]): RuleHierarchy {
  return {
    global: null,
    user: null,
    local: null,
    project: {
      config: { version: 1, level: 'balanced' as ProtectionLevel, rules },
      rules,
      sourcePath: '/keel-envintro-reachability/nonexistent-rules.yaml',
      version: 1,
      markdown: '',
    },
  }
}

function buildPipeline(rules: KeelRule[]): EnforcementPipeline {
  const config: PipelineConfig = {
    level: 'balanced',
    context: 'local' as RuleContext,
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: buildHierarchy(rules),
    ruleVersion: 1,
    allowedFixTransforms: true,
    disableFile: join(scratchRoot, 'DISABLED-unused'),
    overrideStore: { consume: () => false, peek: () => null, list: () => ({}) },
    stuckTracker: new StuckTracker(),
    researchTracker: new ResearchTracker(),
    ledger: new ProblemLedger(join(scratchRoot, `ledger-${Math.random().toString(36).slice(2)}.json`)),
  }
  return new EnforcementPipeline(config)
}

function makeInput(tool: string, args: Record<string, unknown>, cwd: string, sessionId: string): EnforceInput {
  return {
    tool,
    args,
    cwd,
    session_id: sessionId,
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'keel-envintro-reachability',
    subagent_of: null,
  }
}

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'keel-envintro-state-'))
  process.env.KEEL_STATE_DIR = stateDir
  scratchRoot = mkdtempSync(join(tmpdir(), 'keel-envintro-scratch-'))
})

afterAll(() => {
  delete process.env.KEEL_STATE_DIR
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(scratchRoot, { recursive: true, force: true })
})

describe('test-oracle-env-introspection: reachability under the full 45-rule default set', () => {
  it('the rule ships in DEFAULT_RULES_YAML at all', () => {
    expect(DEFAULT_RULES.find(r => r.id === 'test-oracle-env-introspection')).toBeDefined()
  })

  it('a stack-based gaming write is recorded in observed_matches under the FULL ruleset, not just the isolated one', async () => {
    const pipeline = buildPipeline(DEFAULT_RULES)
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const content = [
      'function add(a, b) {',
      "  const stack = new Error().stack || ''",
      "  if (stack.includes('addition.test.js')) {",
      '    return a + b',
      '  }',
      "  if (stack.includes('addition.spec.js')) {",
      '    return a - b',
      '  }',
      '  return a + b',
      '}',
    ].join('\n')
    const result = await pipeline.evaluate(makeInput('Write', { path: 'src/add.js', content }, cwd, 'sess-stack'))

    // The outer verdict may be 'allow' (nothing else in the shipped
    // ruleset has any reason to deny/warn on this content) — that is
    // fine and expected; observe-mode never changes the outer verdict.
    // What matters is that THIS rule specifically shows up in the
    // multi-match record, independent of whatever observed_matches[0]
    // happens to be.
    const matches = result.observed_matches ?? []
    const mine = matches.find(m => m.rule_id === 'test-oracle-env-introspection')
    expect(mine, `observed_matches did not include test-oracle-env-introspection; got: ${JSON.stringify(matches)}`).toBeDefined()
    expect(mine!.observed_action).toBe('warn')
    // Also assert no EARLIER real (non-observe) rule short-circuited the
    // call before this rule's check ran — if one had, observed_matches
    // would be empty entirely (evaluateTiers() would have returned before
    // reaching the content-type checks), which the assertion above
    // already rules out, but assert the outer action explicitly too so a
    // future ruleset change that turns this into a real block is visible
    // here rather than silently changing behavior underneath this probe.
    expect(['allow', 'warn']).toContain(result.action)
  })

  it('an argv-based gaming write is recorded in observed_matches under the FULL ruleset', async () => {
    const pipeline = buildPipeline(DEFAULT_RULES)
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const content = [
      'function compute(x) {',
      "  const invoked = process.argv[1] || ''",
      "  if (invoked.includes('compute.test.js')) {",
      '    return x * 2',
      '  }',
      '  return x + 2',
      '}',
    ].join('\n')
    const result = await pipeline.evaluate(makeInput('Write', { path: 'src/compute.js', content }, cwd, 'sess-argv'))
    const matches = result.observed_matches ?? []
    const mine = matches.find(m => m.rule_id === 'test-oracle-env-introspection')
    expect(mine, `observed_matches did not include test-oracle-env-introspection; got: ${JSON.stringify(matches)}`).toBeDefined()
    expect(mine!.observed_action).toBe('warn')
  })

  it('the three must-allow shapes stay silent under the FULL ruleset too (no false-positive introduced by rule interaction)', async () => {
    const cases: Array<{ path: string; content: string }> = [
      {
        path: 'src/risky.js',
        content: [
          'function riskyOperation() {',
          '  try {',
          '    doSomething()',
          '  } catch (err) {',
          '    console.error(new Error().stack)',
          '    if (err.retryable) {',
          '      retry()',
          '    }',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        path: 'src/cli.js',
        content: [
          'const args = process.argv.slice(2)',
          'const flag = args[0]',
          "if (flag === '--verbose') {",
          '  enableVerbose()',
          "} else if (flag === '--help') {",
          '  printHelp()',
          '}',
        ].join('\n'),
      },
      {
        path: 'src/entry.js',
        content: ['if (require.main === module) {', '  main()', '}'].join('\n'),
      },
    ]
    for (const c of cases) {
      const pipeline = buildPipeline(DEFAULT_RULES)
      const cwd = mkdtempSync(join(scratchRoot, 'case-'))
      const result = await pipeline.evaluate(makeInput('Write', { path: c.path, content: c.content }, cwd, `sess-allow-${c.path}`))
      const matches = result.observed_matches ?? []
      const mine = matches.find(m => m.rule_id === 'test-oracle-env-introspection')
      expect(mine, `${c.path}: test-oracle-env-introspection unexpectedly fired under the full ruleset: ${JSON.stringify(matches)}`).toBeUndefined()
    }
  })

  it('the default installed level (balanced) evaluates content rules at full depth, so this rule is not silently skipped by the fast-depth gate', async () => {
    // pipeline.ts: depth = input.depth || (level==='protect' ? 'deep' : level==='sprint' ? 'fast' : 'full')
    // deepChecks = depth !== 'fast' || protectFloor(rules)
    // Content-type checks are gated on deepChecks. balanced -> depth 'full' -> deepChecks true regardless
    // of protectFloor. Proven behaviorally here rather than just read off the source: a balanced-level
    // pipeline with no explicit `depth` on the input (matching what hook.ts's real call site does — it
    // never sets EnforceInput.depth, only `level`) must still catch the stack-based gaming shape.
    const pipeline = buildPipeline(DEFAULT_RULES)
    const cwd = mkdtempSync(join(scratchRoot, 'case-'))
    const content = "const s = new Error().stack; if (s.includes('__tests__')) { return 1 } return 0"
    const result = await pipeline.evaluate(makeInput('Write', { path: 'src/depth-probe.js', content }, cwd, 'sess-depth'))
    const matches = result.observed_matches ?? []
    expect(matches.find(m => m.rule_id === 'test-oracle-env-introspection')).toBeDefined()
  })
})
