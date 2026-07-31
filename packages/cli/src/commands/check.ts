import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import chalk from 'chalk'
import { PolicyEngine } from '../policy-engine.js'
import { analyzeReasoning, type ReasoningVerdict } from '../reasoning.js'
import { checkAnomaly, printAnomaly } from '../anomaly.js'

export async function checkCommand(
  target: string | undefined,
  options: { file?: string; command?: string; ci?: boolean; write?: boolean; analyzeReasoning?: string }
) {
  const cwd = process.cwd()
  const engine = new PolicyEngine(join(cwd, '.keel.yaml'))
  engine.loadPolicy()

  let hasViolations = false

  // --ci mode: check all staged files
  if (options.ci && !options.file && !options.command && !target) {
    try {
      const staged = execSync('git diff --cached --name-only', { encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean)
      if (staged.length === 0) {
        console.log(chalk.green('✓ No staged changes to check.'))
        return
      }
      for (const file of staged) {
        if (!existsSync(file)) continue
        const content = readFileSync(file, 'utf-8')
        const secretResult = engine.checkSecret(content)
        if (secretResult) { printResult(secretResult); hasViolations = true }
        const fileResults = engine.evaluate({
          tool_name: 'write_file', args: { filePath: file }, cwd,
          timestamp: new Date().toISOString(),
        })
        for (const r of fileResults) { printResult(r); if (isViolation(r)) hasViolations = true }

        // Syntax-check staged files. Advisory (warn), so it surfaces a broken
        // edit at commit time without rejecting the commit outright.
        const syntax = await engine.autoVerify(file)
        if (syntax) { printResult(syntax); if (isViolation(syntax)) hasViolations = true }
      }
      if (!hasViolations) console.log(chalk.green('✓ All staged changes pass policy.'))
    } catch (err) {
      console.log(chalk.red(`Error checking staged changes: ${err}`))
    }
    if (hasViolations) process.exit(1)
    return
  }

  if (options.file || target) {
    const filePath = options.file || target!
    // Path-based rules must NOT depend on the file existing or being
    // readable. The PreToolUse hook asks about a file the agent is about to
    // *create* — a write to a not-yet-existent .env is precisely the case
    // that has to be caught, and it was previously skipped because this
    // evaluation sat behind readFileSync in the same try block.
    // read and write are separately expressible in a file_rule, so the caller
    // has to say which it is asking about. Without --write, a rule that blocks
    // writes but permits reads could never fire from the CLI — and the
    // PreToolUse hook asks about Write/Edit through exactly this path.
    const fileResults = engine.evaluate({
      tool_name: options.write ? 'write_file' : 'read_file',
      args: { filePath }, cwd,
      timestamp: new Date().toISOString(),
    })
    for (const r of fileResults) { printResult(r); if (isViolation(r)) hasViolations = true }

    // Content-based rules need the bytes, so they stay best-effort.
    try {
      const content = readFileSync(filePath, 'utf-8')
      const secretResult = engine.checkSecret(content)
      if (secretResult) { printResult(secretResult); hasViolations = true }
    } catch {
      /* unreadable or not yet created — path rules above already applied */
    }

    if (existsSync(filePath)) {
      const syntax = await engine.autoVerify(filePath)
      if (syntax) { printResult(syntax); if (isViolation(syntax)) hasViolations = true }
    }
  }

  if (options.command) {
    const cmd = options.command
    // Check for secrets in command string
    const secretResult = engine.checkSecret(cmd)
    if (secretResult) { printResult(secretResult); hasViolations = true }
    // Policy-based command evaluation
    const cmdResults = engine.evaluate({
      tool_name: 'bash', args: { command: cmd }, cwd,
      timestamp: new Date().toISOString(),
    })
    for (const r of cmdResults) { printResult(r); if (isViolation(r)) hasViolations = true }
    // Built-in guard checks
    if (engine.isDestructiveCommand(cmd)) {
      printResult({ action: 'block', rule_name: 'destructive-command',
        message: 'Destructive command detected', timestamp: new Date().toISOString() })
      hasViolations = true
    }
    if (engine.checkForcePush(cmd)) {
      printResult({ action: 'block', rule_name: 'force-push',
        message: 'Use --force-with-lease instead of --force', timestamp: new Date().toISOString() })
      hasViolations = true
    }
    if (engine.checkNoVerify(cmd)) {
      printResult({ action: 'block', rule_name: 'no-verify',
        message: 'AI agents must not bypass git hooks with --no-verify', timestamp: new Date().toISOString() })
      hasViolations = true
    }
    if (engine.checkHookBypass(cmd)) {
      const isMCPBypass = /\bmcp__github__/.test(cmd)
      printResult({
        action: 'block', rule_name: 'hook-bypass',
        message: isMCPBypass
          ? 'MCP API write detected — bypasses local git hooks. Use git directly instead.'
          : 'Git hook bypass attempt detected',
        timestamp: new Date().toISOString(),
      })
      hasViolations = true
    }
    if (engine.checkSudo(cmd)) {
      printResult({ action: 'block', rule_name: 'sudo',
        message: 'Sudo usage blocked by policy', timestamp: new Date().toISOString() })
      hasViolations = true
    }
    if (engine.checkPKillPython(cmd)) {
      printResult({ action: 'block', rule_name: 'pkill-python',
        message: 'pkill -f python blocked (can kill system processes)', timestamp: new Date().toISOString() })
      hasViolations = true
    }
  }

  // Behavioral anomaly detection
  if (options.command) {
    const anomaly = checkAnomaly('local', 'bash', { command: options.command })
    if (anomaly) {
      printAnomaly(anomaly)
      if (anomaly.confidence > 0.7) hasViolations = true
    }
  }

  // Reasoning trace analysis (--analyze-reasoning flag)
  if (options.analyzeReasoning) {
    const verdict = analyzeReasoning({
      reasoning: options.analyzeReasoning,
      proposedAction: options.command || '',
      toolName: 'bash',
    })
    if (verdict) {
      const icon = verdict.suggestedAction === 'block' ? chalk.red('✗') :
        verdict.suggestedAction === 'warn' ? chalk.yellow('⚠') : chalk.green('?')
      const label = verdict.suggestedAction === 'block' ? 'BLOCK' :
        verdict.suggestedAction === 'warn' ? 'WARN' : 'NOTE'
      console.log(`${icon} [${chalk.bold(label)}] Reasoning: ${verdict.explanation}`)
      console.log(`   Confidence: ${(verdict.confidence * 100).toFixed(0)}%`)
      if (verdict.suggestedAction === 'block') hasViolations = true
    } else {
      console.log(chalk.green('Reasoning analysis: no suspicious patterns'))
    }
  }

  if (!target && !options.file && !options.command && !options.ci) {
    console.log(chalk.cyan('keel check'))
    console.log('Usage: keel check <file>')
    console.log('       keel check --command "<shell-command>"')
    console.log('       keel check --file <path>')
    console.log('       keel check --ci  (check staged changes against policy)')
  }

  // Exit status is part of the contract, not just --ci decoration: the
  // PreToolUse hook and any wrapper script key on it. A blocked command that
  // exits 0 reads as success to every caller that is not scraping stdout.
  if (hasViolations) {
    process.exit(1)
  }
}

/**
 * Only a `block` fails the run.
 *
 * `warn` is advisory and `allow` is an explicit permit; treating either as a
 * violation is what made `check --ci` exit 1 for every staged file — the
 * unconditional `edit-before-read` warning fires on all of them, so the
 * pre-commit hook installed by `init --hooks` rejected every commit.
 */
function isViolation(result: { action: string }): boolean {
  return result.action === 'block'
}

function printResult(result: { action: string; rule_name?: string; message: string; timestamp?: string; matched_pattern?: string }) {
  const icon = result.action === 'block' ? chalk.red('✗') :
    result.action === 'warn' ? chalk.yellow('⚠') :
    chalk.green('✓')
  const label = result.action === 'block' ? 'BLOCKED' :
    result.action === 'warn' ? 'WARN' : 'OK'
  console.log(`${icon} [${chalk.bold(label)}] ${result.message} (rule: ${result.rule_name})`)
}
