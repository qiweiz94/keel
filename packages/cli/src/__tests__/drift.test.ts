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
const TEMPLATE = join(HERE, '..', '..', 'templates', 'keel-enforce.js')

function parseYamlBlock(src: string, label: string): { match: string; action: string }[] {
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  expect(m, `no DEFAULT_RULES_YAML found in ${label}`).toBeTruthy()
  // plugin.ts interpolates `${LEGACY_PRODUCT_NAME}` at runtime; resolve it
  // here so install.ts's literal copy compares equal.
  const legacy = src.match(/const LEGACY_PRODUCT_NAME = '([^']+)' \+ '([^']+)'/) as RegExpMatchArray | null
  let yaml = m![1]
  if (legacy) yaml = yaml.replaceAll('${LEGACY_PRODUCT_NAME}', `${legacy[1]}${legacy[2]}`)
  const parsed = parseRulesContent(yaml, label)
  expect(parsed.errors, `${label} YAML invalid`).toBeUndefined()
  return (parsed.rules as Array<Record<string, string>>).map((r) => ({
    id: r.id,
    match: r.match ?? '',
    action: r.action ?? '',
  }))
}

function ruleTable(rules: { id: string; match: string; action: string }[]) {
  return new Map(rules.map((r) => [r.id, { match: r.match, action: r.action }]))
}

describe('rules drift: install.ts vs plugin.ts', () => {
  const install = ruleTable(parseYamlBlock(readFileSync(INSTALL_SRC, 'utf-8'), 'install.ts'))
  const plugin = ruleTable(parseYamlBlock(readFileSync(PLUGIN_SRC, 'utf-8'), 'plugin.ts'))
  const template = readFileSync(TEMPLATE, 'utf-8')

  it('enforces the same rule ids', () => {
    expect([...install.keys()].sort()).toEqual([...plugin.keys()].sort())
  })

  it('matches the same patterns and actions per rule', () => {
    for (const [id, installRule] of install) {
      const pluginRule = plugin.get(id)
      expect(pluginRule, `plugin missing rule ${id}`).toBeDefined()
      expect(installRule.match, `match drift on ${id}`).toBe(pluginRule!.match)
      expect(installRule.action, `action drift on ${id}`).toBe(pluginRule!.action)
    }
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
  })

  it('built template is regenerated with the same rules', () => {
    for (const id of plugin.keys()) {
      expect(template, `template missing rule ${id}`).toContain(`- id: ${id}`)
    }
    expect(template).toContain('rm -rf /(?!tmp|var/tmp)')
    expect(template).toContain('gh release delete')
    expect(template).toContain('git reset (--hard|--soft|--keep|--merge|HEAD~)')
  })
})
