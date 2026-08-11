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
 * runaway-budget.yaml, run through the REAL enforcement pipeline.
 *
 * Both rules are `type: rate` + `mode: observe`, so a "must-fire" case
 * asserts `action: 'allow'` (nothing is interrupted) with
 * `observed_action: 'warn'`, and "must-not-fire" asserts `observed_action`
 * is undefined. No StateManager is wired in (matches the shipped
 * defaults — `keel install` does not pass one to every consumer); the
 * pipeline's in-memory rate-count fallback (pipeline.ts ~275-282) has
 * identical cumulative-window semantics to StateManager.checkRateLimit
 * without 500+ synchronous disk writes per test run.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = findRepoRoot(HERE)
const PROPOSAL_PATH = join(REPO_ROOT, 'session', 'proposals', 'runaway-budget.yaml')

function loadRules(): KeelRule[] {
  const raw = readFileSync(PROPOSAL_PATH, 'utf-8')
  return parseYaml(raw) as KeelRule[]
}

const ALL_RULES = loadRules()
const TOOL_CALLS_RULE = ALL_RULES.find(r => r.id === 'runaway-budget-tool-calls')!
const BASH_CALLS_RULE = ALL_RULES.find(r => r.id === 'runaway-budget-bash-calls')!

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

function makePipeline(rules: KeelRule[]): EnforcementPipeline {
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    overrideStore: noopOverrideStore,
    ruleHierarchy: buildHierarchy(rules),
    ruleVersion: 1,
    allowedFixTransforms: true,
    // No stateManager: exercises the pipeline's in-memory rate-count path.
  })
}

function input(tool: string, args: Record<string, unknown>, session: string, turn: number): EnforceInput {
  return {
    tool,
    args,
    cwd: '/tmp',
    session_id: session,
    turn_number: turn,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
  }
}

describe('proposal: runaway-budget-tool-calls (observe mode)', () => {
  it('MUST-NOT-FIRE: 499 calls in the 4h window (one under max_calls: 500)', async () => {
    const pipeline = makePipeline([TOOL_CALLS_RULE])
    let result
    for (let i = 1; i <= 499; i++) {
      result = await pipeline.evaluate(input('Read', { path: `/tmp/f${i}.txt` }, 'budget-under', i))
    }
    expect(result!.action).toBe('allow')
    expect(result!.observed_action).toBeUndefined()
  })

  it('MUST-FIRE: 501 calls in the 4h window (one over max_calls: 500)', async () => {
    const pipeline = makePipeline([TOOL_CALLS_RULE])
    let result
    for (let i = 1; i <= 501; i++) {
      result = await pipeline.evaluate(input('Read', { path: `/tmp/f${i}.txt` }, 'budget-over', i))
    }
    expect(result!.rule_id).toBe('runaway-budget-tool-calls')
    expect(result!.action).toBe('allow')
    expect(result!.observed_action).toBe('warn')
    expect(result!.message).toMatch(/^\[observe\] would warn:/)
  })

  it('counts calls across DIFFERENT tools toward the same total (match: ".*" is a single shared counter)', async () => {
    const pipeline = makePipeline([TOOL_CALLS_RULE])
    let result
    const tools = ['Read', 'Write', 'Bash', 'Edit']
    for (let i = 1; i <= 501; i++) {
      result = await pipeline.evaluate(input(tools[i % tools.length], { n: i }, 'budget-mixed', i))
    }
    expect(result!.rule_id).toBe('runaway-budget-tool-calls')
    expect(result!.observed_action).toBe('warn')
  })
})

describe('proposal: runaway-budget-bash-calls (observe mode)', () => {
  it('MUST-NOT-FIRE: 499 Bash calls', async () => {
    const pipeline = makePipeline([BASH_CALLS_RULE])
    let result
    for (let i = 1; i <= 499; i++) {
      result = await pipeline.evaluate(input('Bash', { command: `echo ${i}` }, 'bash-under', i))
    }
    expect(result!.action).toBe('allow')
    expect(result!.observed_action).toBeUndefined()
  })

  it('MUST-FIRE: 501 Bash calls', async () => {
    const pipeline = makePipeline([BASH_CALLS_RULE])
    let result
    for (let i = 1; i <= 501; i++) {
      result = await pipeline.evaluate(input('Bash', { command: `echo ${i}` }, 'bash-over', i))
    }
    expect(result!.rule_id).toBe('runaway-budget-bash-calls')
    expect(result!.action).toBe('allow')
    expect(result!.observed_action).toBe('warn')
  })

  it('does not count non-Bash tool calls toward the Bash-specific budget (must-allow)', async () => {
    const pipeline = makePipeline([BASH_CALLS_RULE])
    let result
    for (let i = 1; i <= 600; i++) {
      result = await pipeline.evaluate(input('Read', { path: `/tmp/g${i}.txt` }, 'bash-unaffected', i))
    }
    expect(result!.action).toBe('allow')
    expect(result!.observed_action).toBeUndefined()
  })
})
