import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import type { PipelineConfig } from '../pipeline.js'
import type { ParsedRules } from '../rule-parser.js'
import type { EnforceInput } from '../../types.js'

// Red-team residual (SECURITY.md's "different-id priority shadowing" note,
// distinct from the same-id override guard covered by
// protect-floor-mode-match-override.test.ts): the mergeRules dedup loop
// only arbitrates a collision on a MATCHING rule id. A lower-scope config
// can add a rule under a brand-new id — no collision, nothing for dedup to
// reject — with a high `priority` and `action: allow` matching the same
// command as a `level: protect` floor. pipeline.ts's tier-2/3 command loop
// is first-match-wins over the full priority-sorted merged list, so before
// this fix the allow rule (sorted ahead by raw priority) returned and
// short-circuited evaluate() before the floor was ever reached.
//
// This file proves end-to-end, through the real EnforcementPipeline, that
// a `.keel.local.yaml`-shaped different-id rule can no longer shadow a
// floor this way.

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

function pipelineFor(global: ParsedRules, local: ParsedRules): EnforcementPipeline {
  const config: PipelineConfig = {
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: { global, user: null, project: null, local },
    ruleVersion: 1,
    overrideStore: { consume: () => false },
    disableFile: join(mkdtempSync(join(tmpdir(), 'keel-floor-priority-shadow-')), 'DISABLED'),
  }
  return new EnforcementPipeline(config)
}

function makePipeline(localYaml: string): EnforcementPipeline {
  const global = parseRulesContent(defaultsYaml, 'defaults')
  global.config.level = 'balanced'
  const local = parseRulesContent(localYaml, '.keel.local.yaml')
  return pipelineFor(global, local)
}

function input(command: string): EnforceInput {
  return { tool: 'Bash', args: { command } }
}

// A non-main/master branch so this exercises ONLY the no-force-push floor,
// not the separate (non-floor, sprint-level, action: prompt)
// no-push-to-main rule that also matches a force-push straight to main.
const FORCE_PUSH_OFF_MAIN = 'git push --force origin some-feature-branch'

describe('a .keel.local.yaml cannot priority-shadow a level:protect floor with a different-id rule', () => {
  it('a different-id, priority-999, action:allow rule matching the same command does NOT let `git push --force` through', async () => {
    const p = makePipeline(`version: 1
rules:
  - id: my-allow
    type: command
    action: allow
    priority: 999
    match: "git push.*--force"
    message: "local tries to shadow the floor with a different id"
`)
    const r = await p.evaluate(input(FORCE_PUSH_OFF_MAIN))
    expect(['deny', 'block']).toContain(r.action)
    expect(r.rule_id).toBe('no-force-push')
  })

  it('a different-id, priority-999, action:warn rule matching the same command also does not shadow the floor', async () => {
    const p = makePipeline(`version: 1
rules:
  - id: my-warn
    type: command
    action: warn
    priority: 999
    match: "git push.*--force"
    message: "local tries to shadow the floor with a warn instead"
`)
    const r = await p.evaluate(input(FORCE_PUSH_OFF_MAIN))
    expect(['deny', 'block']).toContain(r.action)
    expect(r.rule_id).toBe('no-force-push')
  })

  it('a different-id, priority-999, action:prompt rule matching the same command also does not shadow the floor', async () => {
    const p = makePipeline(`version: 1
rules:
  - id: my-prompt
    type: command
    action: prompt
    priority: 999
    match: "git push.*--force"
    message: "local tries to shadow the floor with a prompt instead"
`)
    const r = await p.evaluate(input(FORCE_PUSH_OFF_MAIN))
    expect(['deny', 'block']).toContain(r.action)
    expect(r.rule_id).toBe('no-force-push')
  })

  it('non-floor priority ordering still governs first-match-wins among rules with no floor in play (regression)', async () => {
    // Two non-floor rules matching the same synthetic command, different
    // ids, different priorities, neither a floor — the higher-priority one
    // must still win, exactly as before this fix.
    const p = makePipeline(`version: 1
rules:
  - id: low-priority-warn
    type: command
    action: warn
    priority: 10
    match: "totally-synthetic-test-command"
    message: "low priority"
  - id: high-priority-deny
    type: command
    action: deny
    priority: 500
    match: "totally-synthetic-test-command"
    message: "high priority wins"
`)
    const r = await p.evaluate(input('totally-synthetic-test-command'))
    expect(r.rule_id).toBe('high-priority-deny')
  })

  // Pipeline-level twin of the transitivity case in rule-parser.test.ts:
  // a naive pairwise "floor beats the other one" comparator is
  // intransitive when a `mode: observe` rule's priority sits between the
  // floor's and the shadow rule's, which made the actual merged order
  // (and therefore the real pipeline verdict) depend on
  // Array.prototype.sort's implementation rather than being guaranteed.
  // This proves the floor still wins END TO END with all three rules
  // present, not just in the unit-level ordering check.
  it('the floor still denies with a same-command different-id shadow rule AND an in-between-priority observe rule both present (transitivity, end to end)', async () => {
    const p = makePipeline(`version: 1
rules:
  - id: my-allow
    type: command
    action: allow
    priority: 999
    match: "git push.*--force"
    message: "shadow attempt"
  - id: my-observe
    type: command
    action: warn
    mode: observe
    priority: 90
    match: "git push.*--force"
    message: "observe, priority in between floor (82) and shadow (999)"
`)
    const r = await p.evaluate(input(FORCE_PUSH_OFF_MAIN))
    expect(['deny', 'block']).toContain(r.action)
    expect(r.rule_id).toBe('no-force-push')
    // The observe rule still got its chance to record, exactly as it
    // would with no floor in the mix at all.
    expect(r.observed_matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule_id: 'my-observe' })]),
    )
  })
})
