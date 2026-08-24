import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import type { EnforceInput, KeelRule, RuleHierarchy } from '../../types.js'
import { findRepoRoot } from './repo-root.js'

/**
 * Wave-2 Lane 5 — synthetic fixtures for session/proposals/
 * test-before-commit.yaml, run through the REAL enforcement pipeline (not
 * a mock), exactly as the CLI's hook wiring would drive it: evaluate()
 * per tool call, plus markVerificationSatisfied() after every step (the
 * post-tool-call hook — see fixture-harness.test.ts's own header for why
 * this matters: without it a passing test run never discharges the
 * obligation and every case would falsely read as a verification.ts bug).
 *
 * Because the rule is `mode: observe`, a "must-fire" case asserts
 * `action: 'allow'` (nothing is ever interrupted) with
 * `observed_action: 'warn'` — NOT `action: 'warn'`. A "must-not-fire" case
 * asserts `observed_action` is undefined.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = findRepoRoot(HERE)
const PROPOSAL_PATH = join(REPO_ROOT, 'session', 'proposals', 'test-before-commit.yaml')

function loadRule(): KeelRule {
  const raw = readFileSync(PROPOSAL_PATH, 'utf-8')
  const parsed = parseYaml(raw) as KeelRule[]
  const rule = parsed.find(r => r.id === 'test-before-commit')
  if (!rule) throw new Error('test-before-commit rule not found in proposal file')
  return rule
}

const RULE = loadRule()

function buildHierarchy(rules: KeelRule[]): RuleHierarchy {
  return {
    global: null,
    user: null,
    local: null,
    project: {
      config: { version: 1, rules },
      rules,
      sourcePath: PROPOSAL_PATH,
      version: 1,
      markdown: '',
    },
  }
}

const noopOverrideStore = { consume: () => false, peek: () => null, list: () => ({}) }

function makePipeline(): EnforcementPipeline {
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    overrideStore: noopOverrideStore,
    ruleHierarchy: buildHierarchy([RULE]),
    ruleVersion: 1,
    allowedFixTransforms: true,
  })
}

function input(tool: string, args: Record<string, unknown>, session: string): EnforceInput {
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

// Runs a step through evaluate() AND the post-tool-call hook, mirroring the
// real CLI wiring (fixture-harness.test.ts:246-249).
async function step(pipeline: EnforcementPipeline, tool: string, args: Record<string, unknown>, session: string) {
  const i = input(tool, args, session)
  const result = await pipeline.evaluate(i)
  pipeline.markVerificationSatisfied(i)
  return result
}

describe('proposal: test-before-commit (observe mode)', () => {
  it('MUST-FIRE: src/ edit followed by git commit with no test run in between', async () => {
    const pipeline = makePipeline()
    await step(pipeline, 'write', { path: 'src/foo.ts', content: 'export const x = 1' }, 'fire-1')
    const result = await step(pipeline, 'Bash', { command: 'git commit -m "add foo"' }, 'fire-1')
    expect(result.rule_id).toBe('test-before-commit')
    // observe mode: never interrupts...
    expect(result.action).toBe('allow')
    // ...but records what would have happened.
    expect(result.observed_action).toBe('warn')
    expect(result.message).toMatch(/^\[observe\] would warn:/)
  })

  it('MUST-FIRE: an earlier test run does NOT count for a LATER edit', async () => {
    const pipeline = makePipeline()
    // Test runs BEFORE any src/ edit — nothing pending yet, this is a no-op.
    await step(pipeline, 'Bash', { command: 'npm test' }, 'fire-2')
    // The edit arms a NEW obligation; the earlier test run cannot discharge
    // an obligation that didn't exist yet.
    await step(pipeline, 'write', { path: 'src/bar.ts', content: 'export const y = 2' }, 'fire-2')
    const result = await step(pipeline, 'Bash', { command: 'git commit -m "add bar"' }, 'fire-2')
    expect(result.rule_id).toBe('test-before-commit')
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBe('warn')
  })

  it('MUST-NOT-FIRE: src/ edit, a passing test run, then commit', async () => {
    const pipeline = makePipeline()
    await step(pipeline, 'write', { path: 'src/foo.ts', content: 'export const x = 1' }, 'not-1')
    await step(pipeline, 'Bash', { command: 'npm test' }, 'not-1')
    const result = await step(pipeline, 'Bash', { command: 'git commit -m "add foo, tested"' }, 'not-1')
    expect(result.rule_id).not.toBe('test-before-commit')
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: a docs-only edit (path outside src/, even mentioning src/ in body) followed by commit', async () => {
    const pipeline = makePipeline()
    await step(pipeline, 'write', { path: 'docs/guide.md', content: 'see src/foo.ts for context' }, 'not-2')
    const result = await step(pipeline, 'Bash', { command: 'git commit -m "update docs"' }, 'not-2')
    expect(result.rule_id).not.toBe('test-before-commit')
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBeUndefined()
  })

  it('MUST-NOT-FIRE: no src/ edit at all, a bare commit', async () => {
    const pipeline = makePipeline()
    const result = await step(pipeline, 'Bash', { command: 'git commit -m "empty commit" --allow-empty' }, 'not-3')
    expect(result.rule_id).not.toBe('test-before-commit')
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBeUndefined()
  })
})
