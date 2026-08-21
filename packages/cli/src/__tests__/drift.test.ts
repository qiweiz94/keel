import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRulesContent } from '@get-keel/core'

/**
 * Drift guard: `keel install` writes install.ts's DEFAULT_RULES_YAML to
 * ~/.keel/rules.yaml, while the OpenCode plugin (plugin.ts) enforces the
 * same rules in-session. If the two copies drift, installed enforcement
 * silently differs from what the plugin enforces. They must stay identical
 * in rule ids, match patterns, and actions.
 *
 * The plugin source is read from disk (not imported) so this test guards the
 * canonical source independent of the build step; the built template is
 * additionally checked to guard regeneration.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const INSTALL_SRC = join(HERE, '..', 'commands', 'install.ts')
const PLUGIN_SRC = join(HERE, '..', '..', '..', 'opencode-plugin', 'src', 'plugin.ts')
const INDEX_SRC = join(HERE, '..', 'index.ts')
const TEMPLATE = join(HERE, '..', '..', 'templates', 'keel-enforce.js')

// Full rule objects, not a hand-picked field list: a `paths:`/`exclude:`/
// `patterns:`/`vars:`/`sources:`/`sinks:`/`unless:`/`boundaries:`/etc. glob
// or list edited in one file and forgotten in the other must fail this test
// exactly like a match/action drift does — a field list here is a promise
// to remember to add every new field by hand, which is exactly how the
// paths:/exclude: gap this test used to have got in.
type RuleRow = Record<string, unknown> & { id: string }

function parseYamlBlock(src: string, label: string): RuleRow[] {
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  expect(m, `no DEFAULT_RULES_YAML found in ${label}`).toBeTruthy()
  // plugin.ts interpolates `${LEGACY_PRODUCT_NAME}` at runtime; resolve it
  // here so install.ts's literal copy compares equal.
  const legacy = src.match(/const LEGACY_PRODUCT_NAME = '([^']+)' \+ '([^']+)'/) as RegExpMatchArray | null
  let yaml = m![1]
  if (legacy) yaml = yaml.replaceAll('${LEGACY_PRODUCT_NAME}', `${legacy[1]}${legacy[2]}`)
  const parsed = parseRulesContent(yaml, label)
  expect(parsed.errors, `${label} YAML invalid`).toBeUndefined()
  return (parsed.rules as Array<Record<string, unknown>>).map((r) => ({ ...r, id: String(r.id) }))
}

function ruleTable(rules: RuleRow[]) {
  return new Map(rules.map((r) => [r.id, r]))
}

describe('rules drift: install.ts vs plugin.ts', () => {
  const install = ruleTable(parseYamlBlock(readFileSync(INSTALL_SRC, 'utf-8'), 'install.ts'))
  const plugin = ruleTable(parseYamlBlock(readFileSync(PLUGIN_SRC, 'utf-8'), 'plugin.ts'))
  const template = readFileSync(TEMPLATE, 'utf-8')

  it('enforces the same rule ids', () => {
    expect([...install.keys()].sort()).toEqual([...plugin.keys()].sort())
  })

  it('is byte-for-byte equivalent per rule — every field, not just match/action', () => {
    for (const [id, installRule] of install) {
      const pluginRule = plugin.get(id)
      expect(pluginRule, `plugin missing rule ${id}`).toBeDefined()
      expect(pluginRule, `field drift on ${id}`).toEqual(installRule)
    }
  })

  it('has exactly 49 rules (update this count deliberately when the ruleset changes)', () => {
    // 36 from the Wave-2 tier restructure + 6 pasted at the gate:
    // unverified-package-install, claim-without-evidence,
    // test-oracle-tampering, test-before-commit, runaway-budget-tool-calls,
    // runaway-budget-bash-calls (session/DECISIONS.md, gate-2) + 1 from the
    // M1 ruleset-followups lane: no-destructive-interpreter-body (Task 1 —
    // closes the interpreter-body destructive-coverage gap A2 left open)
    // + 1 from the env-introspection lane: test-oracle-env-introspection
    // (session/v04/EVIDENCE/b2-benchmark.md §4 — content-diff rule for the
    // caller-detection-to-game-tests reward-hacking class the benchmark
    // found and no shipped rule covered)
    // + 1 from the b1-exfil lane: no-exfil-flow-cross-call (AUDIT §5 —
    // warn/sprint sibling of no-exfil-flow that checks FlowTracker's new
    // persisted, session-scoped store so the correlation survives across
    // separate `keel hook` processes, not just within one; see
    // docs/exfil.md)
    // + 1 from the session-composite-trip lane: session-runaway-trip
    // (type: session's first real handler — a composite runaway-loop trip
    // across five session-scoped dimensions, ships mode: observe pending
    // real hit-rate data — see session-tracker.ts, pipeline.ts's
    // session-trip branch, and docs/tiers.md).
    // + 1 from the v1 `type: budget` lane: session-spend-limit — real
    // token/dollar spend read from a host's own local transcript/session
    // record (Claude Code JSONL usage fields, OpenCode's `session` table
    // rollup columns), distinct from the pre-existing call-VOLUME
    // runaway-budget-* rules above (`type: rate`); shipped `mode: observe`
    // pending real-traffic burn-in of the model-string normalization it
    // depends on — see packages/core/src/enforce/budget-tracker.ts.
    // + 1 from the stuck-oscillation lane: command-oscillation (`type:
    // oscillation`, a brand-new RuleType) — the "oscillation (A→B→A)" item
    // ROADMAP.md's Near-term section named as a planned sibling of
    // `no-repeat-loops` (`type: stuck`): a short repeating CYCLE of >= 2
    // DIFFERENT recent command fingerprints within a session's small
    // rolling window, complementary to (never redundant with)
    // no-repeat-loops' own exact-repeat detection; shipped `mode: observe`
    // with zero measured hit-rate evidence, same evidence-gated posture as
    // session-runaway-trip/session-spend-limit above — see
    // packages/core/src/enforce/oscillation-tracker.ts/oscillation-store.ts.
    expect(install.size).toBe(49)
  })

  it('has no unanchored rm -rf / false-positive (BUG 1)', () => {
    for (const [label, table] of [['install', install], ['plugin', plugin]] as const) {
      const deny = table.get('no-destructive-commands')?.match ?? ''
      expect(deny, `${label} still has substring bug`).not.toContain('rm -rf /|rm -rf ~')
      expect(deny).toContain('(?!tmp|var/tmp)')
    }
  })

  it('gates plain git rebase / reset / push -d / gh release delete (GAP 3)', () => {
    const history = plugin.get('git-history-rewrite')?.match ?? ''
    expect(history).toContain('git rebase|')
    expect(history).toContain('git reset (--hard|--soft|--keep|--merge|HEAD~)')
    const publish = plugin.get('publish-gate')?.match ?? ''
    expect(publish).toContain('gh release delete')
    expect(publish).toContain('git push.*')
    expect(new RegExp(publish).test('git push -d origin old-branch')).toBe(true)
    expect(new RegExp(publish).test('git push origin --delete old-branch')).toBe(true)
    expect(new RegExp(publish).test('git push origin development')).toBe(false)
  })

  it('built template is regenerated with the same rules', () => {
    for (const id of plugin.keys()) {
      expect(template, `template missing rule ${id}`).toContain(`- id: ${id}`)
    }
    // The rm-token group is spelled once and reused across every target
    // branch of no-destructive-commands; asserting the group plus the
    // root-target lookahead keeps this canary tied to real behavior rather
    // than to one frozen spelling of the flag letters (wave-3 widened `-rf`
    // to also cover `-fr`, `-r -f` and the long-form flags).
    expect(template).toContain('/(?!tmp|var/tmp)')
    expect(template).toContain('-(rf|fr|r')
    expect(template).toContain('gh release delete')
    expect(template).toContain('git reset (--hard|--soft|--keep|--merge|HEAD~)')
  })
})

/**
 * Third source: `keel enforce init` (index.ts's createEnforceInit) used to
 * carry its own stale, hand-maintained 6-rule set that had drifted from
 * DEFAULT_RULES_YAML — a `no-external-network` blanket network-deny that
 * directly violated the do-not-ship guard install.ts's ruleset avoids, and
 * a `no-delete-outside-src` rule with no equivalent anywhere else. Fixing
 * the drift once is not the same as fixing it permanently: this asserts
 * the STRUCTURE (imports the shared constant, defines no rules of its own)
 * so a future edit can reintroduce a fourth ruleset only by deliberately
 * removing the import — it can't happen by silently pasting YAML back in.
 */
describe('rules drift: index.ts (enforce init) has no third ruleset', () => {
  const indexSrc = readFileSync(INDEX_SRC, 'utf-8')

  it('imports DEFAULT_RULES_YAML from install.js rather than defining its own', () => {
    expect(indexSrc).toMatch(/import\s*\{[^}]*DEFAULT_RULES_YAML[^}]*\}\s*from\s*['"]\.\/commands\/install\.js['"]/)
  })

  it('createEnforceInit contains no inline rules: YAML literal of its own', () => {
    const fnMatch = indexSrc.match(/async function createEnforceInit\(\)[\s\S]*?\n\}/)
    expect(fnMatch, 'createEnforceInit not found in index.ts').toBeTruthy()
    const fnBody = fnMatch![0]
    // The function must reference the shared constant, not spell out YAML
    // rules of its own (no `- id:` rule entries, no standalone `rules:` key
    // followed by a rule list).
    expect(fnBody).toContain('DEFAULT_RULES_YAML')
    expect(fnBody).not.toMatch(/- id:\s*\S+/)
  })

  it('writes the exact same content keel install writes', () => {
    const installSrc = readFileSync(INSTALL_SRC, 'utf-8')
    const m = installSrc.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
    expect(m).toBeTruthy()
    // install.ts's own writeFileSync(rulesPath, DEFAULT_RULES_YAML, ...) call
    // and index.ts's writeRulesFile(rulesPath, DEFAULT_RULES_YAML, ...) call
    // must reference the identical imported binding — not a local copy.
    expect(indexSrc).toMatch(/writeRulesFile\(rulesPath,\s*DEFAULT_RULES_YAML,/)
  })
})
