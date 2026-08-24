import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import type { PipelineConfig } from '../pipeline.js'
import type { EnforceInput } from '../../types.js'

// Regression for the cross-loop floor-shadowing bug: evaluateTiers() used to
// run the `statefulRules` loop (verification/claim/research-trigger types)
// FULLY to completion before the tiered rules loop (command/filesystem/
// network/etc, where `level: protect` floor rules actually live) ever
// started. Any `return this.violation(...)` in the stateful loop ended
// evaluation before the floor loop was reached — a non-floor rule from a
// DIFFERENT rule-type category could shadow a floor.
//
// Live-reproduced by promoting the shipped `source-change-requires-test`
// rule (type: verification, ships as `mode: observe`) out of observe —
// exactly what its own documented lifecycle anticipates (`keel promote`).
// A `git push --force origin main` then matches BOTH that rule's `push`
// boundary (deny, but this is the rule's first-ever violation so it only
// warns per the warn-once escalation) AND the floor rule `no-force-push`
// (`level: protect`, blocks on the FIRST hit, no warn-once grace). Before
// the fix, the verification rule's warn returned before the floor's command
// loop even started, so `no-force-push` never fired at all.

// The CLI vendors core sources (packages/cli/src/core) at build time, so
// this file's own directory is not a fixed number of levels above
// cli/src/commands/install.ts. Walk upward instead of hardcoding the depth
// (same approach as the other protect-floor test files in this directory).
function findInstallSource(start: string): string {
  let dir = start
  for (;;) {
    const candidate = join(dir, 'cli', 'src', 'commands', 'install.ts')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error('cli/src/commands/install.ts not found above ' + start)
    dir = parent
  }
}

const __dir = dirname(fileURLToPath(import.meta.url))
const installTs = readFileSync(findInstallSource(__dir), 'utf-8')
const m = installTs.match(/DEFAULT_RULES_YAML = `([\s\S]*?)\n`/)
if (!m) throw new Error('DEFAULT_RULES_YAML not found in install.ts')
const defaultsYaml = m[1]

// Sanity: the shipped rule must still be `mode: observe` today — if this
// stops matching, the promotion below silently no-ops and the test would
// pass for the wrong reason (the rule already enforcing).
if (!/id: source-change-requires-test[\s\S]*?mode: observe/.test(defaultsYaml)) {
  throw new Error('shipped source-change-requires-test rule is no longer mode: observe — update this test\'s promotion logic')
}

// "keel promote" moves a rule out of observe by dropping `mode: observe`
// from its block. Reproduce that here by stripping the line.
const promotedYaml = defaultsYaml.replace(
  /(id: source-change-requires-test\n(?:[^\n]*\n)*?)\s*mode: observe\n/,
  '$1',
)
if (promotedYaml === defaultsYaml) throw new Error('promotion regex did not match — fix the test')

function pipelineFor(globalYaml: string): EnforcementPipeline {
  const global = parseRulesContent(globalYaml, 'defaults')
  const config: PipelineConfig = {
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: { global, user: null, project: null, local: null },
    ruleVersion: 1,
    overrideStore: { consume: () => false },
    disableFile: join(mkdtempSync(join(tmpdir(), 'keel-cross-loop-shadow-')), 'DISABLED'),
  }
  return new EnforcementPipeline(config)
}

function input(tool: string, args: Record<string, unknown>): EnforceInput {
  return { tool, args, cwd: '/tmp/cross-loop-shadow-project', session_id: 'cross-loop-shadow' }
}

describe('a promoted (non-floor) verification rule cannot shadow a level:protect floor rule across loops', () => {
  it('no-force-push still blocks a force-push to main even though source-change-requires-test also matches and would only warn on its own first hit', async () => {
    const p = pipelineFor(promotedYaml)

    // Trigger the verification obligation: a source-change write with no
    // test run since.
    const triggerResult = await p.evaluate(input('WriteFile', { filePath: 'src/a.ts', content: 'x' }))
    expect(triggerResult.action).toBe('allow')

    // A force-push to main matches BOTH source-change-requires-test's
    // `push` boundary (pending obligation, first violation of this rule ID
    // -> warn-only under the pre-fix single-verdict semantics) AND the
    // no-force-push floor (level: protect -> blocks on the very first hit).
    const result = await p.evaluate(input('Bash', { command: 'git push --force origin main' }))
    console.log('DEBUG RESULT', JSON.stringify(result, null, 2))

    // The floor must win: no-force-push blocks immediately. Before the fix,
    // the statefulRules loop's verification-rule warn returned first and
    // no-force-push was never reached.
    expect(['deny', 'block']).toContain(result.action)
    expect(result.rule_id).toBe('no-force-push')
  })

  it('sanity: with the floor rule removed, the promoted verification rule still only warns on its first hit (proves the fixture is faithful, not just permissive)', async () => {
    const withoutFloor = promotedYaml.replace(
      /\s*- id: no-force-push\n(?:.*\n)*?(?=\s*- id: protected-branch-reset\n)/,
      '\n',
    )
    expect(withoutFloor).not.toBe(promotedYaml)
    expect(withoutFloor).not.toContain('id: no-force-push')

    const p = pipelineFor(withoutFloor)
    await p.evaluate(input('WriteFile', { filePath: 'src/a.ts', content: 'x' }))
    const result = await p.evaluate(input('Bash', { command: 'git push --force origin main' }))

    expect(result.action).toBe('warn')
    expect(result.rule_id).toBe('source-change-requires-test')
  })
})
