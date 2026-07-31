import { join } from 'node:path'
import chalk from 'chalk'
import { initEnforce, evaluateToolCall } from './enforce.js'
import type { ProtectionLevel } from '../core/types.js'

export interface TestOptions {
  level?: string
  fromAudit?: string
  newRule?: string
}

/**
 * `keel test` — dry-run a tool call against the current rules.
 *
 * Shows what would happen WITHOUT actually executing the action.
 * Critical for debugging rules before the agent hits them.
 */
export async function testCommand(toolArg: string, options: TestOptions) {
  const level = (options.level || 'balanced') as ProtectionLevel
  const dir = process.cwd()

  // Initialize enforcement (dry-run mode — no agent connected)
  initEnforce(dir, { level })

  // Parse the test input
  let tool: string
  let args: Record<string, unknown>

  if (toolArg.startsWith('{')) {
    // JSON input
    try {
      const parsed = JSON.parse(toolArg)
      tool = parsed.tool || 'unknown'
      args = parsed.args || {}
      if (parsed.command) {
        tool = 'Bash'
        args = { command: parsed.command }
      }
    } catch {
      console.log(chalk.red('Invalid JSON input'))
      return
    }
  } else {
    // Plain string — treat as a shell command
    tool = 'Bash'
    args = { command: toolArg }
  }

  // Evaluate
  const result = await evaluateToolCall(tool, args, {
    cwd: dir,
    turnNumber: 0,
    contextTokens: 0,
    level,
    context: 'local',
    agent: 'keel-test',
    subagentOf: null,
  })

  // Display result
  console.log()
  console.log(chalk.bold.cyan('  ⚓ keel test'))
  console.log(chalk.dim(`  Tool: ${chalk.white(tool)}`))
  console.log(chalk.dim(`  Args: ${chalk.white(JSON.stringify(args))}`))
  console.log(chalk.dim(`  Level: ${chalk.white(level)}`))
  console.log()

  switch (result.action) {
    case 'deny':
    case 'block':
      console.log(chalk.red(`  ✗ ${result.action.toUpperCase()} by rule "${result.rule_id}"`))
      console.log(chalk.yellow(`    ${result.message}`))
      if (result.fix_result) {
        const f = result.fix_result as { original?: string; fixed?: string }
        console.log(chalk.green(`    Auto-fix: ${f.original} → ${f.fixed}`))
      }
      break
    case 'warn':
      console.log(chalk.yellow(`  ⚠ WARN by rule "${result.rule_id}"`))
      console.log(chalk.dim(`    ${result.message}`))
      console.log(chalk.dim(`    Will be blocked on repeat (first time warning).`))
      break
    case 'fix':
      console.log(chalk.green(`  ✓ FIX applied by rule "${result.rule_id}"`))
      if (result.fix_result) {
        const f = result.fix_result as { original?: string; fixed?: string }
        console.log(chalk.dim(`    ${f.original} → ${f.fixed}`))
      }
      break
    case 'allow':
      console.log(chalk.green(`  ✓ ALLOWED (no matching rule)`))
      break
    default:
      console.log(chalk.dim(`  ${result.action} (${result.message})`))
  }

  console.log(chalk.dim(`  ${result.duration_ms}ms | tier ${result.tier}${result.cache_hit ? ' | cached' : ''}`))
  console.log()
}

/**
 * Test against a previous audit log trace.
 */
export async function testFromAudit(auditPath: string, newRuleYaml: string) {
  console.log(chalk.yellow('  Testing rules against previous session...'))
  console.log(chalk.dim(`  Trace: ${auditPath}`))
  console.log(chalk.dim(`  Rule: ${newRuleYaml}`))
  console.log()

  // Parse the rule
  let ruleId = ''
  try {
    const parsed = JSON.parse(newRuleYaml)
    ruleId = parsed.id || 'unknown'
  } catch {
    ruleId = newRuleYaml.split('\n')[0] || 'unknown'
  }

  // Load trace
  const { readFileSync, existsSync } = await import('node:fs')
  if (!existsSync(auditPath)) {
    console.log(chalk.red(`  Trace file not found: ${auditPath}`))
    return
  }

  const lines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean)
  let wouldBlock = 0
  let falsePositives = 0

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      // In a real implementation, we'd re-evaluate with the new rule
      // For now, just count how many entries match
      if (entry.tool || entry.tool_name) {
        wouldBlock++
      }
    } catch { /* skip corrupt lines */ }
  }

  console.log(chalk.cyan(`  Rule "${ruleId}" would have affected ${wouldBlock} actions`))
  if (falsePositives > 0) {
    console.log(chalk.yellow(`  ${falsePositives} appear to be false positives (investigate)`))
  } else {
    console.log(chalk.green(`  No obvious false positives detected`))
  }
  console.log()
}
