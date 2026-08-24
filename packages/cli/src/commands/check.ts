import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import chalk from 'chalk'
import { initEnforce, evaluateToolCall, flushBackgroundWork } from './enforce.js'
import { BLOCKING_ACTIONS } from './evaluate.js'
import { isPkillPython, checkSecretInCommand } from './check-helpers.js'
import { verifyFileSyntax } from '../core/file-verify.js'
import { loadRuleHierarchy } from '../core/enforce/index.js'
import { analyzeReasoning, type ReasoningVerdict } from '../reasoning.js'
import { checkAnomaly, printAnomaly } from '../anomaly.js'
import type { EnforceResult } from '../core/types.js'

/** Reported as the calling agent on every evaluation this command makes. */
const AGENT = 'keel-check'

export async function checkCommand(
  target: string | undefined,
  options: { file?: string; command?: string; ci?: boolean; write?: boolean; analyzeReasoning?: string }
) {
  const cwd = process.cwd()

  // Safety-critical: an unconfigured project (no rules.yaml anywhere across
  // all four hierarchy tiers — global, user, project, local) must not
  // silently pass every check as "clean". `init.ts --hooks` wires
  // `keel check --ci` DIRECTLY into the pre-commit hook it installs, so a
  // silent no-op here would mean an unconfigured repo's commits sail
  // through with zero enforcement — the exact "control that lies" failure
  // this migration exists to close, just inverted (too strict -> too
  // silent). initEnforce() itself would happily build a pipeline out of an
  // all-null hierarchy and evaluate every call to `allow`, so this has to
  // be checked separately, before calling it.
  //
  // This does NOT exit early: `isPkillPython`/`checkSecretInCommand`
  // (check-helpers.ts), the syntax check, behavioral anomaly detection, and
  // --analyze-reasoning are all independent of rules.yaml and must keep
  // working even in a totally unconfigured project — an early
  // `process.exit(0)` here used to silently turn `keel check
  // --analyze-reasoning <text>` into a no-op the moment rules.yaml went
  // missing, which is its own "control that lies" failure, just for a
  // different detector. Only the pipeline-backed rule evaluation
  // (evaluateToolCall) is skipped, gated on `pipelineReady` below.
  const hierarchy = loadRuleHierarchy(cwd)
  const noRulesAnywhere = !hierarchy.global && !hierarchy.user && !hierarchy.project && !hierarchy.local
  if (noRulesAnywhere) {
    console.log(chalk.red.bold('⚠ No Keel rules found — run \'keel install\'.'))
    console.log(chalk.red('  keel check is not enforcing anything via rules.yaml (secret/command/path rules).'))
  }

  let pipelineReady = false
  if (!noRulesAnywhere) {
    try {
      initEnforce(cwd, { context: 'local' })
      pipelineReady = true
    } catch (err) {
      // A parse/validation error in the rules themselves. This PRESERVES
      // check.ts's own long-documented 0/1 exit contract (wrapper
      // scripts/hooks key off exit code) rather than adopting `keel
      // evaluate`'s exit-2 "init error" convention.
      console.log(chalk.red(`✗ [BLOCKED] Keel rules failed to load: ${(err as Error).message}`))
      await flushBackgroundWork()
      process.exit(1)
    }
  }

  let hasViolations = false

  // --ci mode: check all staged files
  if (options.ci && !options.file && !options.command && !target) {
    try {
      const staged = execSync('git diff --cached --name-only', { encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean)
      if (staged.length === 0) {
        console.log(chalk.green('✓ No staged changes to check.'))
        await flushBackgroundWork()
        return
      }
      for (const file of staged) {
        if (!existsSync(file)) continue
        const content = readFileSync(file, 'utf-8')
        // Content-based secret scanning (the `no-secrets-in-code` `type:
        // content` rule) happens for free via the pipeline's own dispatch
        // on write_file's `content` field — no standalone secret-scan call
        // needed here anymore.
        if (pipelineReady) {
          const result = await evaluateToolCall(
            'write_file', { filePath: file, content }, { cwd, agent: AGENT },
          )
          printResult(result)
          if (BLOCKING_ACTIONS.has(result.action)) hasViolations = true
        }

        // Syntax-check staged files. Advisory (warn), so it surfaces a broken
        // edit at commit time without rejecting the commit outright.
        const syntax = await verifyFileSyntax(file)
        if (syntax) printResult(syntaxWarning(file, syntax))
      }
      if (!hasViolations) {
        // Do not print "pass policy" when no policy actually ran — the
        // exact "control that lies" phrasing this migration exists to
        // remove, just moved into the success message instead of the exit
        // code. The loud warning printed above already said the pipeline
        // is off; the closing line has to agree with it.
        console.log(pipelineReady
          ? chalk.green('✓ All staged changes pass policy.')
          : chalk.yellow('⚠ No blocking findings — but rules.yaml was not evaluated (see warning above).'))
      }
    } catch (err) {
      console.log(chalk.red(`Error checking staged changes: ${err}`))
    }
    await flushBackgroundWork()
    if (hasViolations) process.exit(1)
    return
  }

  if (options.file || target) {
    const filePath = options.file || target!
    // Path-based rules must NOT depend on the file existing or being
    // readable. The PreToolUse hook asks about a file the agent is about to
    // *create* — a write to a not-yet-existent .env is precisely the case
    // that has to be caught. read and write are separately expressible in a
    // rule, so the caller has to say which it is asking about. Without
    // --write, a rule that blocks writes but permits reads could never fire
    // from the CLI — and the PreToolUse hook asks about Write/Edit through
    // exactly this path.
    //
    // Deliberate behavior change from the legacy PolicyEngine path: a plain
    // read (no --write) no longer gets content-based secret scanning here —
    // it only gets the path-rule evaluation below. This matches every other
    // real enforcement host's read/write split (content rules are
    // write-side only, see pipeline.ts). `--file X --write` (or `--ci`)
    // still scans content.
    if (pipelineReady) {
      const fileResult = await evaluateToolCall(
        options.write ? 'write_file' : 'read_file',
        { filePath }, { cwd, agent: AGENT },
      )
      printResult(fileResult)
      if (BLOCKING_ACTIONS.has(fileResult.action)) hasViolations = true
    }

    if (existsSync(filePath)) {
      const syntax = await verifyFileSyntax(filePath)
      if (syntax) printResult(syntaxWarning(filePath, syntax))
    }
  }

  if (options.command) {
    const cmd = options.command
    if (pipelineReady) {
      const cmdResult = await evaluateToolCall('bash', { command: cmd }, { cwd, agent: AGENT })
      printResult(cmdResult)
      if (BLOCKING_ACTIONS.has(cmdResult.action)) hasViolations = true
    }

    // The default rule catalog has zero `pkill` coverage
    // (no-destructive-commands' match regex never mentions it), so this
    // check has no modern-pipeline equivalent to route through — call the
    // ported helper directly, same as the legacy PolicyEngine.checkPKillPython.
    if (isPkillPython(cmd)) {
      printResult({
        action: 'block', rule_name: 'pkill-python',
        message: 'pkill -f python blocked (can kill system processes)',
        timestamp: new Date().toISOString(),
      })
      hasViolations = true
    }

    // `no-secrets-in-code` is `type: content`, which only ever scans
    // content-bearing tool args (write_file's `content`, an Edit's
    // `newString`, ...) — pipeline.ts never treats a bash tool call's
    // `args.command` as scannable content, so a secret typed straight into
    // a shell command has no modern-pipeline equivalent either. Call the
    // ported helper directly, same as the legacy PolicyEngine.checkSecret.
    const secretInCmd = checkSecretInCommand(cmd)
    if (secretInCmd.matched) {
      printResult({
        action: 'block', rule_name: 'secret-in-command',
        message: 'Secret detected in command',
        timestamp: new Date().toISOString(),
      })
      hasViolations = true
    }

    // NOTE (deliberately dropped, out of scope for this migration): the
    // legacy PolicyEngine.checkHookBypass's `--no-verify`/core.hooksPath
    // detection is now covered by the `no-verify-bypass` default rule
    // above — but its MCP-github-specific message
    // ("mcp__github__* bypasses local git hooks") and its
    // HUSKY=0/LEFTHOOK=0/SKIP=-prefixed env-var bypass detection have no
    // default-rule equivalent anywhere in the platform today. See
    // SECURITY.md's "Enforcement limits" section.
  }

  // Behavioral anomaly detection — independent of PolicyEngine/the
  // enforcement pipeline, unchanged by this migration.
  if (options.command) {
    const anomaly = checkAnomaly('local', 'bash', { command: options.command })
    if (anomaly) {
      printAnomaly(anomaly)
      if (anomaly.confidence > 0.7) hasViolations = true
    }
  }

  // Reasoning trace analysis (--analyze-reasoning flag) — also independent
  // of PolicyEngine/the enforcement pipeline, unchanged by this migration.
  if (options.analyzeReasoning) {
    const verdict: ReasoningVerdict | null = analyzeReasoning({
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

  await flushBackgroundWork()

  // Exit status is part of the contract, not just --ci decoration: the
  // PreToolUse hook and any wrapper script key on it. A blocked command that
  // exits 0 reads as success to every caller that is not scraping stdout.
  if (hasViolations) {
    process.exit(1)
  }
}

function syntaxWarning(filePath: string, detail: string): EnforceResult {
  return {
    action: 'warn',
    rule_name: 'auto-verify',
    message: `Syntax error in ${filePath}: ${detail}`,
    timestamp: new Date().toISOString(),
  }
}

function printResult(result: { action: string; rule_name?: string; message: string; timestamp?: string; matched_pattern?: string }) {
  // BLOCKING_ACTIONS ('deny'/'block'/'prompt'/'redirect'/'research') all
  // stop the call, not just 'block' — see evaluate.ts's own comment on why
  // that set exists. Displaying only 'block' as red here would make a
  // `prompt`/`redirect`/`research` verdict print as a green "OK" even
  // though it is failing the run and about to exit 1 — confusing output
  // for exactly the verdicts most likely to need a human's attention.
  const blocking = BLOCKING_ACTIONS.has(result.action as EnforceResult['action'])
  const icon = blocking ? chalk.red('✗') :
    result.action === 'warn' ? chalk.yellow('⚠') :
    chalk.green('✓')
  const label = blocking ? 'BLOCKED' :
    result.action === 'warn' ? 'WARN' : 'OK'
  console.log(`${icon} [${chalk.bold(label)}] ${result.message} (rule: ${result.rule_name})`)
}
