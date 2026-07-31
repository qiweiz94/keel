import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'

/**
 * `keel watch` — tails the audit trail for live monitoring.
 *
 * Shows enforcement entries in real-time as the plugin records them.
 * Run this in one terminal while using OpenCode in another.
 */
export async function watchCommand(options: { json?: boolean }) {
  const tracesDir = join(homedir(), '.keel', 'traces')

  if (!existsSync(tracesDir)) {
    console.log(chalk.yellow('\n  No audit trail found. Plugin has not recorded any activity yet.\n'))
    return
  }

  const today = new Date().toISOString().slice(0, 10)
  const tracePath = join(tracesDir, `${today}.jsonl`)

  console.log(chalk.bold.cyan('\n  ⚓ Keel Watch — Live Audit Monitor\n'))
  console.log(chalk.dim(`  Watching: ${tracePath}`))
  console.log(chalk.dim('  OpenCode tool calls will appear here in real-time.\n'))

  // Show existing entries
  if (existsSync(tracePath)) {
    const lines = readFileSync(tracePath, 'utf-8').trim().split('\n').filter(Boolean)
    if (lines.length > 0) {
      console.log(chalk.dim(`  ${lines.length} existing entries from today:\n`))
      for (const line of lines.slice(-5)) {
        try {
          const entry = JSON.parse(line)
          printEntry(entry, 'history')
        } catch { /* skip corrupt */ }
      }
      console.log()
    }
  }

  // Watch for new entries
  if (existsSync(tracePath)) {
    let lastSize = readFileSync(tracePath, 'utf-8').length
    watchFile(tracePath, { interval: 500 }, (curr) => {
      if (curr.size > lastSize) {
        const content = readFileSync(tracePath, 'utf-8')
        const newData = content.slice(lastSize).trim()
        lastSize = curr.size
        if (newData) {
          for (const line of newData.split('\n').filter(Boolean)) {
            try {
              const entry = JSON.parse(line)
              printEntry(entry, 'live')
            } catch { /* skip corrupt */ }
          }
        }
      }
    })
  } else {
    // File doesn't exist yet — poll for it
    console.log(chalk.dim('  No trace file yet. Waiting for first plugin activity...\n'))
    const interval = setInterval(() => {
      if (existsSync(tracePath)) {
        clearInterval(interval)
        watchCommand(options)
      }
    }, 1000)
  }

  // Keep process alive
  await new Promise(() => {})
}

function printEntry(entry: any, mode: 'live' | 'history') {
  const prefix = mode === 'live' ? chalk.green('▶') : chalk.dim('·')
  const action = entry.action || 'unknown'
  const tool = entry.tool || '?'
  const rule = entry.rule_id ? chalk.dim(` (${entry.rule_id})`) : ''
  const message = entry.message ? ` ${entry.message.slice(0, 80)}` : ''

  let actionColor: (s: string) => string
  let label: string
  switch (action) {
    case 'deny':
    case 'block':
      actionColor = chalk.red
      label = 'DENY'
      break
    case 'warn':
      actionColor = chalk.yellow
      label = 'WARN'
      break
    case 'fix':
      actionColor = chalk.cyan
      label = 'FIX '
      break
    default:
      actionColor = chalk.green
      label = 'OK  '
  }

  console.log(`${prefix} ${actionColor(label)} ${chalk.white(tool)}${rule}${actionColor(message)}`)
}
