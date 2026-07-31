import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import chalk from 'chalk'

/**
 * `keel schedule` — automated self-improvement.
 *
 * Installs a launchd (macOS) or cron (Linux) job that periodically runs:
 *   keel gather --since 7   (distills audit history into requirements.md)
 *
 * The job output is logged to ~/.keel/logs/schedule.log for inspection.
 * Remove with `keel schedule --remove`.
 */

const LABEL = 'com.keel.gather'

function keelBinary(): string {
  try {
    const out = execFileSync('which', ['keel'], { encoding: 'utf-8' }).trim()
    if (out) return out
  } catch { /* not on PATH */ }
  return 'keel'
}

function logPath(): string {
  const dir = join(homedir(), '.keel', 'logs')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'schedule.log')
}

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

function launchdExists(): boolean {
  return existsSync(plistPath())
}

function cronLine(): string {
  return `0 9 * * * ${keelBinary()} gather --since 7 >> ${logPath()} 2>&1`
}

function cronJobExists(): boolean {
  try {
    const out = execFileSync('crontab', ['-l'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] })
    return out.includes('keel gather')
  } catch {
    return false
  }
}

function installLaunchd(frequency: string) {
  const weekday = frequency === 'weekly' ? '0' : undefined
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${keelBinary()}</string>
    <string>gather</string>
    <string>--since</string>
    <string>7</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
    ${weekday ? `    <key>Weekday</key>
    <integer>${weekday}</integer>` : ''}
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath()}</string>
  <key>StandardErrorPath</key>
  <string>${logPath()}</string>
</dict>
</plist>
`
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  writeFileSync(plistPath(), plist, 'utf-8')
  execFileSync('launchctl', ['load', plistPath()])
  console.log(chalk.green(`  ✓ Installed launchd job ${LABEL} (${frequency})`))
  console.log(chalk.dim(`    Plist: ${plistPath()}`))
  console.log(chalk.dim(`    Log:   ${logPath()}\n`))
}

function removeLaunchd() {
  if (!launchdExists()) {
    console.log(chalk.dim('  No keel launchd job installed.\n'))
    return
  }
  execFileSync('launchctl', ['unload', plistPath()], { stdio: 'ignore' })
  rmSync(plistPath(), { force: true })
  console.log(chalk.green('  ✓ Removed launchd job ' + LABEL + '\n'))
}

function installCron() {
  try {
    let existing = ''
    try {
      existing = execFileSync('crontab', ['-l'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] })
    } catch { /* no crontab yet */ }
    const lines = existing.split('\n').filter(l => !l.includes('keel gather'))
    lines.push(cronLine())
    execFileSync('crontab', ['-'], { input: lines.join('\n') + '\n', stdio: ['pipe', 'pipe', 'ignore'] })
    console.log(chalk.green('  ✓ Installed cron job (daily 09:00)'))
    console.log(chalk.dim(`    Log: ${logPath()}\n`))
  } catch (err) {
    console.log(chalk.red(`  ✗ Could not install cron job: ${(err as Error).message}\n`))
  }
}

function removeCron() {
  if (!cronJobExists()) {
    console.log(chalk.dim('  No keel cron job installed.\n'))
    return
  }
  try {
    const existing = execFileSync('crontab', ['-l'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] })
    const lines = existing.split('\n').filter(l => !l.includes('keel gather'))
    execFileSync('crontab', ['-'], { input: lines.join('\n') + '\n', stdio: ['pipe', 'pipe', 'ignore'] })
    console.log(chalk.green('  ✓ Removed keel cron job\n'))
  } catch (err) {
    console.log(chalk.red(`  ✗ Could not remove cron job: ${(err as Error).message}\n`))
  }
}

export async function scheduleCommand(frequency: string | undefined, options: { remove?: boolean; status?: boolean }) {
  const isMac = process.platform === 'darwin'

  if (options.remove) {
    if (isMac) removeLaunchd()
    else removeCron()
    return
  }

  if (options.status || !frequency) {
    if (isMac) {
      const installed = launchdExists()
      console.log(chalk.bold.cyan('\n  ⚓ Keel Schedule\n'))
      console.log(installed
        ? chalk.green(`  ✓ Launchd job installed: ${LABEL}`)
        : chalk.dim('  ✗ No keel launchd job installed'))
      if (installed) {
        console.log(chalk.dim(`    Plist: ${plistPath()}`))
      }
      console.log(chalk.dim(`    Log:   ${logPath()}`))
      console.log()
      if (!installed) {
        console.log(chalk.cyan('  Install with:'))
        console.log(chalk.white('    keel schedule daily'))
        console.log(chalk.white('    keel schedule weekly'))
        console.log()
      }
    } else {
      const installed = cronJobExists()
      console.log(chalk.bold.cyan('\n  ⚓ Keel Schedule\n'))
      console.log(installed
        ? chalk.green('  ✓ Cron job installed (daily 09:00)')
        : chalk.dim('  ✗ No keel cron job installed'))
      console.log(chalk.dim(`    Log: ${logPath()}`))
      console.log()
      if (!installed) {
        console.log(chalk.cyan('  Install with:'))
        console.log(chalk.white('    keel schedule daily'))
        console.log()
      }
    }
    return
  }

  if (frequency !== 'daily' && frequency !== 'weekly') {
    console.log(chalk.red(`  Unknown frequency "${frequency}" — use daily or weekly.\n`))
    return
  }

  if (isMac) {
    if (launchdExists()) {
      console.log(chalk.yellow('  Replacing existing keel launchd job...'))
      removeLaunchd()
    }
    installLaunchd(frequency)
  } else {
    if (cronJobExists()) {
      console.log(chalk.yellow('  Replacing existing keel cron job...'))
      removeCron()
    }
    installCron()
  }
}
