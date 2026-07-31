import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'

const OVERRIDE_FILE = join(process.env.HOME || '~', '.keel', 'overrides.json')

/**
 * `keel allow <rule-id>` — one-time override for a blocked action.
 */
export async function allowCommand(ruleId: string, options: { once?: boolean }) {
  const overridesDir = join(process.env.HOME || '~', '.keel')
  if (!existsSync(overridesDir)) {
    mkdirSync(overridesDir, { recursive: true })
  }

  let overrides: Record<string, { expires_at: number }> = {}
  if (existsSync(OVERRIDE_FILE)) {
    try {
      overrides = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf-8'))
    } catch { /* ignore corrupt file */ }
  }

  const expiresAt = options.once
    ? Date.now() + 300000  // 5 minutes for --once
    : Date.now() + 86400000  // 24 hours for persistent

  overrides[ruleId] = { expires_at: expiresAt }
  writeFileSync(OVERRIDE_FILE, JSON.stringify(overrides, null, 2))

  const duration = options.once ? '5 minutes' : '24 hours'
  console.log(chalk.green(`\n  ✓ Rule "${ruleId}" overridden for ${duration}\n`))
  console.log(chalk.dim(`  The next violation of this rule will be allowed.\n`))
}

/**
 * Check if a rule is overridden (used by enforcement pipeline).
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
