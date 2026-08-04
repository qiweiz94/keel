import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRulesContent } from '../core/enforce/rule-parser.js'

/**
 * `keel-control-gate` is the rule that keeps keel's control surface owned by
 * the human: an agent that can reconfigure the guardrail has no guardrail.
 *
 * It listed six subcommands by name, which means every NEW mutating
 * subcommand is un-gated by default — the gate does not fail safe. That is
 * how `keel rules harness --append` shipped able to edit ~/.keel/rules.yaml
 * with only a TTY check standing in the way, and a TTY check has a
 * documented environment-variable escape hatch used by the test suite.
 *
 * Defence in depth: the TTY check is the mechanism, this rule is the policy,
 * and neither should be the only thing between an agent and the rules file.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))

function findPluginSource(start: string): string {
  let dir = start
  for (;;) {
    const candidate = join(dir, 'opencode-plugin', 'src', 'plugin.ts')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error('plugin source not found above ' + start)
    dir = parent
  }
}

function controlGatePattern(): RegExp {
  const src = readFileSync(findPluginSource(HERE), 'utf-8')
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  if (!m) throw new Error('DEFAULT_RULES_YAML not found')
  const rules = parseRulesContent(m[1], 'default-rules').rules
  const gate = rules.find(r => r.id === 'keel-control-gate')
  if (!gate?.match) throw new Error('keel-control-gate has no match pattern')
  return new RegExp(gate.match)
}

describe('keel-control-gate', () => {
  const gated = [
    'keel disable',
    'keel allow no-force-push --once',
    'keel level sprint',
    'keel enforce --level=protect',
    'keel install --opencode',
    'keel uninstall',
    // Mutates ~/.keel/rules.yaml — the file the whole control surface rests on.
    'keel rules harness --append',
  ]

  it.each(gated)('blocks: %s', (command) => {
    expect(controlGatePattern().test(command)).toBe(true)
  })

  const allowed = [
    // Read-only. An agent SHOULD be able to show the user these rules —
    // gating the print would just push people back to hand-copying YAML.
    'keel rules harness',
    'keel rules atr --lane enforce',
    'keel scan',
    'keel status',
    'keel audit --tail 20',
    'keel validate',
    'keel retrospective',
  ]

  it.each(allowed)('does not block read-only: %s', (command) => {
    expect(controlGatePattern().test(command)).toBe(false)
  })
})
