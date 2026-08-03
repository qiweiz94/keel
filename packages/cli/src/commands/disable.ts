import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'

const DISABLE_FILE = join(process.env.HOME || '~', '.keel', 'DISABLED')

/**
 * Kill switch — disables all enforcement immediately.
 */
export async function disableCommand(options: { until?: number | string; reason?: string }) {
  let untilSeconds: number | null = null
  if (options.until !== undefined && options.until !== '') {
    const parsed = typeof options.until === 'number' ? options.until : parseInt(String(options.until), 10)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.log(chalk.red(`  Invalid --until: "${options.until}". Use a positive number of seconds.`))
      process.exitCode = 1
      return
    }
    untilSeconds = parsed
  }

  const until = untilSeconds
    ? Date.now() + untilSeconds * 1000
    : null

  const disableDir = join(process.env.HOME || '~', '.keel')
  if (!existsSync(disableDir)) {
    mkdirSync(disableDir, { recursive: true })
  }

  const state = {
    disabled_at: new Date().toISOString(),
    expires_at: until ? new Date(until).toISOString() : null,
    reason: options.reason || 'Manual disable',
    auto_enable_on_restart: true,
  }

  writeFileSync(DISABLE_FILE, JSON.stringify(state, null, 2))

  console.log(chalk.bold.yellow('\n  ⚓ Keel DISABLED'))
  console.log(chalk.yellow('  All enforcement is suspended.'))
  console.log()

  if (until) {
    const minutes = Math.round(untilSeconds! / 60)
    console.log(chalk.dim(`  Will auto-enable in ${minutes} minute(s)`))
  } else {
    console.log(chalk.dim('  Will auto-enable on next agent restart.'))
  }

  console.log()
  console.log(chalk.cyan('  Re-enable with:'))
  console.log(chalk.white('    keel enable'))
  console.log()
}

/**
 * Re-enable enforcement after a disable.
 */
export async function enableCommand() {
  if (!existsSync(DISABLE_FILE)) {
    console.log(chalk.green('\n  ✓ Keel is already enabled\n'))
    return
  }

  rmSync(DISABLE_FILE)
  console.log(chalk.green('\n  ✓ Keel re-enabled\n'))
  console.log(chalk.dim('  All rules are active again.\n'))
}

/**
 * Check if Keel is currently disabled (used by the CLI paths).
 *
 * A CORRUPT sentinel fails CLOSED: enforcement stays on (matches the plugin
 * behavior). A corrupt kill-switch must never silently keep enforcement off.
 */
export function isDisabled(): boolean {
  if (!existsSync(DISABLE_FILE)) return false

  try {
    const state = JSON.parse(readFileSync(DISABLE_FILE, 'utf-8'))
    if (state.expires_at && new Date(state.expires_at) < new Date()) {
      rmSync(DISABLE_FILE)
      return false
    }
    return true
  } catch {
    return false
  }
}
