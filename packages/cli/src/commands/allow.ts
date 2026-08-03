import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'
import { loadRuleHierarchy, parseRulesContent, validateRules } from '../core/enforce/rule-parser.js'
import { FileRuleOverrideStore } from '../core/enforce/overrides.js'

const OVERRIDE_FILE = join(homedir(), '.keel', 'overrides.json')

/**
 * `keel allow <rule-id>` — override a blocked action.
 *
 *   keel allow <id> --once   — the NEXT violation is allowed (single use)
 *   keel allow <id>          — ALL violations allowed for 24 hours (window)
 *
 * The user owns the control surface: agents are hard-blocked from running
 * this command by the `keel-control-gate` rule.
 */
export async function allowCommand(ruleId: string, options: { once?: boolean }) {
  const known = await knownRuleIds()
  if (!known.includes(ruleId)) {
    console.log(chalk.red(`  Unknown rule id: "${ruleId}"`))
    console.log(chalk.yellow(`  Known rule ids: ${known.length ? known.join(', ') : '(none — no rules loaded)'}`))
    console.log(chalk.dim('  Run `keel validate` or `keel status` to see the active rules.'))
    process.exitCode = 1
    return
  }

  const overridesDir = join(homedir(), '.keel')
  if (!existsSync(overridesDir)) {
    mkdirSync(overridesDir, { recursive: true })
  }

  let overrides: Record<string, { expires_at: number; mode?: string }> = {}
  if (existsSync(OVERRIDE_FILE)) {
    try {
      overrides = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf-8'))
    } catch { /* ignore corrupt file */ }
  }

  const expiresAt = options.once
    ? Date.now() + 300000  // 5 minutes for --once
    : Date.now() + 86400000  // 24 hours for the window form

  overrides[ruleId] = { expires_at: expiresAt, ...(options.once ? { mode: 'once' } : { mode: 'window' }) }
  writeFileSync(OVERRIDE_FILE, JSON.stringify(overrides, null, 2))

  const duration = options.once ? '5 minutes' : '24 hours'
  console.log(chalk.green(`\n  ✓ Rule "${ruleId}" overridden for ${duration}\n`))
  console.log(chalk.dim(options.once
    ? '  The next violation of this rule will be allowed.\n'
    : '  All violations of this rule are allowed until it expires.\n'))
}

/**
 * Collect every rule id keel knows about — the merged hierarchy plus the
 * built-in default set the plugin falls back to when no rules exist.
 */
async function knownRuleIds(): Promise<string[]> {
  const ids = new Set<string>()
  try {
    const hierarchy = loadRuleHierarchy(process.cwd())
    for (const scope of [hierarchy.global, hierarchy.user, hierarchy.project, hierarchy.local]) {
      if (scope?.rules) for (const rule of scope.rules) if (rule.id) ids.add(rule.id)
    }
  } catch { /* fall through to defaults */ }
  try {
    const { DEFAULT_RULES_YAML } = await import('./install.js')
    const defaults = parseRulesContent(DEFAULT_RULES_YAML, 'keel:defaults')
    if (!(defaults.errors || []).length) {
      for (const rule of defaults.rules) if (rule.id) ids.add(rule.id)
    }
  } catch { /* defaults unavailable — hierarchy ids only */ }
  return [...ids]
}

/**
 * Check if a rule is overridden (used by `keel status`).
 */
export function isRuleOverridden(ruleId: string): boolean {
  if (!existsSync(OVERRIDE_FILE)) return false
  try {
    const overrides = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf-8'))
    const override = overrides[ruleId]
    if (!override) return false
    if (override.expires_at < Date.now()) {
      // Expired — clean up
      delete overrides[ruleId]
      writeFileSync(OVERRIDE_FILE, JSON.stringify(overrides, null, 2))
      return false
    }
    return true
  } catch {
    return false
  }
}

export const overrideStoreForStatus = new FileRuleOverrideStore()
