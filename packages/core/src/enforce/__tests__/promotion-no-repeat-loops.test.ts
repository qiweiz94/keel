import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { StuckTracker } from '../stuck-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import type { EnforceInput, KeelRule, RuleHierarchy } from '../../types.js'
import { findRepoRoot } from './repo-root.js'

/**
 * Regression coverage for the `no-repeat-loops` promotion (observe → real
 * enforcement). See docs/tiers.md and session/PROMOTION-REPORT.md for the
 * evidence: this project's own traces cite 41 distinct repeat loops across
 * 20 sessions before this machinery existed, and no over-triggering has
 * ever been recorded against this rule — the two `runaway-budget-*` rules
 * were evaluated on the same evidence bar and held back (no real hit-rate
 * data exists for either), so they are deliberately NOT covered here.
 *
 * This reads the ACTUAL shipped rule out of install.ts's DEFAULT_RULES_YAML
 * (same extraction technique as drift.test.ts) rather than reconstructing
 * it inline, so a future accidental re-addition of `mode: observe` (or any
 * other drift) fails this suite, not just a docs page.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = findRepoRoot(HERE)
const INSTALL_SRC = join(REPO_ROOT, 'packages', 'cli', 'src', 'commands', 'install.ts')

function loadNoRepeatLoopsRule(): KeelRule {
  const src = readFileSync(INSTALL_SRC, 'utf-8')
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  if (!m) throw new Error('no DEFAULT_RULES_YAML found in install.ts')
  const parsed = parseRulesContent(m[1], 'install.ts')
  const rule = (parsed.rules as KeelRule[]).find(r => r.id === 'no-repeat-loops')
  if (!rule) throw new Error('no-repeat-loops rule not found in DEFAULT_RULES_YAML')
  return rule
}

const RULE = loadNoRepeatLoopsRule()

function buildHierarchy(rules: KeelRule[]): RuleHierarchy {
  return {
    global: null,
    user: null,
    local: null,
    project: { config: { version: 1, rules }, rules, sourcePath: INSTALL_SRC, version: 1, markdown: '' },
  }
}

// EnforcementPipeline defaults `overrideStore` to a FileRuleOverrideStore
// rooted at the real homedir() when none is supplied, and deny/block
// verdicts call overrideStore.consume() — touches real ~/.keel even when no
// override is armed. Keep deny/redirect scenarios off the real filesystem
// (same fix as stuck.test.ts / proposal-runaway-budget.test.ts).
const noopOverrideStore = { consume: () => false, peek: () => null, list: () => ({}) }

function makePipeline(rules: KeelRule[], level: 'sprint' | 'balanced' | 'protect' = 'balanced'): EnforcementPipeline {
  return new EnforcementPipeline({
    level,
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    overrideStore: noopOverrideStore,
    stuckTracker: new StuckTracker(),
    ruleHierarchy: buildHierarchy(rules),
    ruleVersion: 1,
    allowedFixTransforms: true,
  })
}

function input(command: string, session: string, turn: number, level: 'sprint' | 'balanced' | 'protect' = 'balanced'): EnforceInput {
  return {
    tool: 'Bash',
    args: { command },
    cwd: '/tmp',
    session_id: session,
    turn_number: turn,
    context_tokens: 0,
    level,
    context: 'local',
    agent: 'test',
    subagent_of: null,
  }
}

describe('promoted rule: no-repeat-loops (mode: observe removed)', () => {
  it('the shipped rule no longer carries mode: observe', () => {
    expect(RULE.mode).not.toBe('observe')
    expect(RULE.action).toBe('warn')
    expect(RULE.escalation).toBeTruthy()
  })

  it('under threshold (2 failures): result.action is allow, same as before promotion', async () => {
    const pipeline = makePipeline([RULE])
    const cmd = (turn: number) => input('npm test', 'promo-under', turn)
    pipeline.recordAttemptOutcome(cmd(1), 1)
    pipeline.recordAttemptOutcome(cmd(2), 1)
    const result = await pipeline.evaluate(cmd(3))
    expect(result.action).toBe('allow')
    expect(result.observed_action).toBeUndefined()
  })

  it('3rd identical failure: result.action is a REAL redirect, not allow+observed_action', async () => {
    const pipeline = makePipeline([RULE])
    const cmd = (turn: number) => input('npm test', 'promo-redirect', turn)
    pipeline.recordAttemptOutcome(cmd(1), 1)
    pipeline.recordAttemptOutcome(cmd(2), 1)
    pipeline.recordAttemptOutcome(cmd(3), 1)
    const result = await pipeline.evaluate(cmd(4))
    // This is the crux of the promotion: before, this call returned
    // action: 'allow' with observed_action: 'redirect'. Now it must
    // actually interrupt the agent.
    expect(result.action).toBe('redirect')
    expect(result.observed_action).toBeUndefined()
    expect(result.rule_id).toBe('no-repeat-loops')
    expect(result.redirect?.kind).toBe('stuck')
    expect(result.redirect?.attempts).toBe(3)
  })

  it('5th identical failure: result.action is a REAL deny (no warn-once cushion)', async () => {
    const pipeline = makePipeline([RULE])
    const cmd = (turn: number) => input('npm test', 'promo-deny', turn)
    for (let i = 1; i <= 5; i++) pipeline.recordAttemptOutcome(cmd(i), 1)
    const result = await pipeline.evaluate(cmd(6))
    expect(result.action).toBe('deny')
    expect(result.observed_action).toBeUndefined()
    expect(result.rule_id).toBe('no-repeat-loops')
  })

  it('a success in between resets the ladder (reset_on_success: true)', async () => {
    const pipeline = makePipeline([RULE])
    const cmd = (turn: number) => input('npm test', 'promo-reset', turn)
    pipeline.recordAttemptOutcome(cmd(1), 1)
    pipeline.recordAttemptOutcome(cmd(2), 1)
    pipeline.recordAttemptOutcome(cmd(3), 0) // success resets the count
    const result = await pipeline.evaluate(cmd(4))
    expect(result.action).toBe('allow')
  })

  it('sprint downgrades the 5-attempt deny to warn but keeps the 3-attempt redirect (matches the stuck-rule dial contract)', async () => {
    const pipeline = makePipeline([RULE], 'sprint')
    const cmd = (turn: number) => input('npm test', 'promo-sprint', turn, 'sprint')
    for (let i = 1; i <= 5; i++) pipeline.recordAttemptOutcome(cmd(i), 1)
    const result = await pipeline.evaluate(cmd(6))
    expect(['redirect', 'warn']).toContain(result.action)
    expect(result.action).not.toBe('deny')
  })
})
