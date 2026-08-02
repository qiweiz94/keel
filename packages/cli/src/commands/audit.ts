import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import type { AuditEntry } from '../types.js'

export async function auditCommand(options: { json?: boolean; tail?: string }) {
  const logPath = join(process.cwd(), '.keel', 'audit', 'audit.log')
  if (!existsSync(logPath)) {
    console.log(chalk.yellow('No audit log found. Run keel check to generate one.'))
    return
  }

  const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
  const tail = parseInt(options.tail || '50', 10)
  const recent = lines.slice(-tail)

  if (options.json) {
    console.log(`[${recent.join(',')}]`)
    return
  }

  console.log(chalk.cyan(`\nkeel audit (last ${Math.min(tail, recent.length)} of ${lines.length} entries):\n`))
  for (const line of recent) {
    try {
      const entry: AuditEntry = JSON.parse(line)
      const icon = entry.action === 'block' ? chalk.red('✗') :
        entry.action === 'warn' ? chalk.yellow('⚠') : chalk.green('✓')
      const label = entry.action === 'block' ? 'BLOCKED' :
        entry.action === 'warn' ? 'WARN' : 'OK'
      console.log(`${icon} [${chalk.bold(label)}] ${entry.message}`)
      console.log(`   Tool: ${entry.tool_name} | Rule: ${entry.rule_name} | ${entry.timestamp}`)
    } catch { console.log(line) }
  }
}
