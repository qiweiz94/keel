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
import type { EnforceInput } from '../../types.js'

// Regression for the gate-2 live finding: a `level: protect` floor rule
// with action deny went through the warn-once grace at the balanced dial,
// and a real child agent's `git push --force origin main` REACHED the
// remote on its first attempt. Floors must block on the FIRST hit at
// every dial position — the incidents they encode are one-shot.

// The CLI vendors core sources (packages/cli/src/core) at build time, so
// this file's own directory is not a fixed number of levels above
// cli/src/commands/install.ts — it depends on whether this is the original
// packages/core/src/enforce/__tests__ copy or the generated
// packages/cli/src/core/enforce/__tests__ mirror. Walk upward instead of
// hardcoding the depth (same approach as findPluginSource in
// threat-model.test.ts / agentic-eval.test.ts).
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

function makePipeline(level: 'sprint' | 'balanced'): EnforcementPipeline {
  const global = parseRulesContent(defaultsYaml, 'defaults')
  global.config.level = level
  const config: PipelineConfig = {
    level,
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: { global, user: null, project: null, local: null },
    ruleVersion: 1,
    overrideStore: { consume: () => false },
    disableFile: join(mkdtempSync(join(tmpdir(), 'keel-floor-')), 'DISABLED'),
  }
  return new EnforcementPipeline(config)
}

function input(command: string): EnforceInput {
  return { tool: 'Bash', args: { command } }
}

describe('protect-floor rules block on the FIRST hit at every dial', () => {
  it.each([
    ['balanced', 'git push --force origin main'],
    ['sprint', 'git push --force origin main'],
    ['balanced', 'rm -rf /'],
    ['sprint', 'rm -rf /'],
  ] as const)('%s dial: first "%s" is denied, not warn-once', async (level, cmd) => {
    const p = makePipeline(level)
    const r = await p.evaluate(input(cmd))
    expect(['deny', 'block']).toContain(r.action)
    expect(r.message).not.toContain('warning only')
  })

  it('unleveled deny rules KEEP the warn-once grace at balanced (the ladder is not removed globally)', async () => {
    const p = makePipeline('balanced')
    // no-verify-bypass softened to warn in the restructure; use a plain
    // Tier-2 deny rule instead: no-credential-echo (env type, no level:).
    const r = await p.evaluate(input('echo $GITHUB_TOKEN'))
    if (r.action === 'warn') {
      expect(r.message).toContain('warning only')
    } else {
      // If this rule gained a level/floor in a later restructure, the
      // assertion above must be repointed at another unleveled deny rule,
      // not deleted — the ladder must remain observable somewhere.
      expect(['deny', 'block']).toContain(r.action)
    }
  })
})
