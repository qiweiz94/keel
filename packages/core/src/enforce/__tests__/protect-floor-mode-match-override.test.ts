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
import type { EnforceInput, KeelRule } from '../../types.js'

// Red-team residual (SECURITY.md §"Residual on floor overrides"): the
// mergeRules floor-override guard used to compare the `action` field only.
// A lower-scope override that kept `action: deny` + `level: protect` but
// added `mode: observe` (which short-circuits enforcement to allow — see
// pipeline.ts's effectiveAction) or replaced `match` with a pattern that
// never fires still neutralized the floor. This file proves end-to-end,
// through the real EnforcementPipeline (not just mergeRules' return value),
// that neither vector lets a dangerous command through anymore.

// Same upward-walk as protect-floor-first-hit.test.ts: the CLI vendors
// core sources at build time, so this file's own directory is not a fixed
// number of levels above cli/src/commands/install.ts.
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
    disableFile: join(mkdtempSync(join(tmpdir(), 'keel-floor-mode-match-')), 'DISABLED'),
  }
  return new EnforcementPipeline(config)
}

function makePipeline(localYaml: string): EnforcementPipeline {
  const global = parseRulesContent(defaultsYaml, 'defaults')
  global.config.level = 'balanced'
  const local = parseRulesContent(localYaml, '.keel.local.yaml')
  return pipelineFor(global, local)
}

/**
 * A local override built by CLONING the real shipped `no-force-push` floor
 * (rather than hand-typing its regex into a YAML string, which would be a
 * transcription hazard) and changing only the given fields. Guarantees the
 * override is byte-identical to the floor on every field except the ones
 * under test — otherwise a test claiming to isolate the mode axis could
 * actually be rejected on an incidental surface mismatch (e.g. a hand-typed
 * override omitting `match` entirely) and pass for the wrong reason. See
 * sameEnforcementSurface in rule-parser.ts: ANY field difference outside
 * action/mode/cosmetic-metadata is already enough to reject an override, so
 * a test with an incidental mismatch cannot tell that check apart from the
 * one this file exists to verify.
 */
function makePipelineWithClonedFloorOverride(overrides: Partial<KeelRule>): EnforcementPipeline {
  const global = parseRulesContent(defaultsYaml, 'defaults')
  global.config.level = 'balanced'
  const floor = global.rules.find(r => r.id === 'no-force-push')
  if (!floor) throw new Error('no-force-push not found in DEFAULT_RULES_YAML')
  const clonedOverride: KeelRule = { ...JSON.parse(JSON.stringify(floor)), ...overrides }
  const local: ParsedRules = { config: { version: 1 }, rules: [clonedOverride], sourcePath: '.keel.local.yaml', version: 1, markdown: '' }
  return pipelineFor(global, local)
}

function input(command: string): EnforceInput {
  return { tool: 'Bash', args: { command } }
}

// A non-main/master branch so this exercises ONLY the no-force-push floor,
// not the separate (non-floor, sprint-level, action: prompt)
// no-push-to-main rule that also matches a force-push straight to main —
// that rule is a legitimate independent gate, not the floor under test,
// and its "prompt" verdict would mask whether the floor itself still
// denies once its mode/match have been tampered with.
const FORCE_PUSH_OFF_MAIN = 'git push --force origin some-feature-branch'

describe('a .keel.local.yaml cannot neutralize a level:protect floor via mode or match', () => {
  it('adding `mode: observe` to no-force-push (keeping deny+protect, everything else byte-identical to the floor) does NOT let `git push --force` through', async () => {
    // The override is a clone of the real floor with ONLY `mode` and
    // `message` changed — the same `match` regex, same everything else —
    // so a rejection here can only be attributed to the mode axis, not an
    // incidental surface mismatch (see makePipelineWithClonedFloorOverride's
    // doc comment for why that distinction matters).
    const p = makePipelineWithClonedFloorOverride({ mode: 'observe', message: 'local silences the floor via mode' })
    const r = await p.evaluate(input(FORCE_PUSH_OFF_MAIN))
    expect(['deny', 'block']).toContain(r.action)
  })

  it('replacing `match` on no-force-push with a non-matching pattern (keeping deny+protect) does NOT let `git push --force` through', async () => {
    const p = makePipeline(`version: 1
rules:
  - id: no-force-push
    type: command
    action: deny
    level: protect
    match: "this-pattern-never-fires-xyz"
    message: "local narrows the floor's match"
`)
    const r = await p.evaluate(input(FORCE_PUSH_OFF_MAIN))
    expect(['deny', 'block']).toContain(r.action)
  })

  it('a local override that strictly tightens (adds mode:observe removed, i.e. promotes to enforcing) is still honored end to end', async () => {
    // Sanity check on the other direction: a floor authored with
    // `mode: observe` at the global scope (burning in) CAN be promoted to
    // enforcing by a more specific scope — tightening must not be blocked
    // by this guard.
    const globalObserve = parseRulesContent(`version: 1
level: balanced
rules:
  - id: custom-observing-floor
    type: command
    action: deny
    level: protect
    mode: observe
    match: "danger-command"
    message: "floor burning in under observe"
`, 'defaults')
    const local = parseRulesContent(`version: 1
rules:
  - id: custom-observing-floor
    type: command
    action: deny
    level: protect
    match: "danger-command"
    message: "local promotes out of observe"
`, '.keel.local.yaml')
    const config: PipelineConfig = {
      level: 'balanced',
      context: 'local',
      cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(),
      sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(),
      ruleHierarchy: { global: globalObserve, user: null, project: null, local },
      ruleVersion: 1,
      overrideStore: { consume: () => false },
      disableFile: join(mkdtempSync(join(tmpdir(), 'keel-floor-mode-match-tighten-')), 'DISABLED'),
    }
    const p = new EnforcementPipeline(config)
    const r = await p.evaluate(input('danger-command'))
    expect(['deny', 'block']).toContain(r.action)
  })
})
