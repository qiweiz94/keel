import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import {
  EnforcementPipeline,
  ActionCache,
  ContentTracker,
  ContextManager,
  AuditLog,
  SequenceDetector,
  FlowTracker,
  loadRuleHierarchy,
  parseRulesFile,
  hashRulesFile,
  detectConflicts,
  mergeRules as mergeRulesFn,
  Suggester,
  StateManager,
} from '../core/enforce/index.js'
import type { ProtectionLevel, RuleContext, EnforceInput, EnforceResult } from '../core/types.js'

export interface EnforceOptions {
  level?: ProtectionLevel
  context?: RuleContext
  agent?: string
  learn?: boolean
  watch?: boolean
}

let pipeline: EnforcementPipeline | null = null
let auditLog: AuditLog | null = null
let contextManager: ContextManager | null = null
let currentSessionId = ''

/**
 * Initialize the enforcement system.
 */
export function initEnforce(projectDir?: string, options?: EnforceOptions): {
  pipeline: EnforcementPipeline
  auditLog: AuditLog
  contextManager: ContextManager
  sessionId: string
} {
  const dir = projectDir || process.cwd()
  const level: ProtectionLevel = options?.level || 'balanced'
  const context: RuleContext = options?.context || detectContext()

  // Generate session ID
  currentSessionId = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  // Load rules
  const hierarchy = loadRuleHierarchy(dir)
  const ruleVersion = hierarchy.project?.version || 1

  // Initialize cache
  const cache = new ActionCache({
    maxSize: 10000,
    persistentPath: join(process.env.HOME || '~', '.keel', 'cache', 'known-good.json'),
  })

  // Initialize components
  const contentTracker = new ContentTracker()
  const sequenceDetector = new SequenceDetector()
  const flowTracker = new FlowTracker()
  const cm = new ContextManager(level)

  // Initialize pipeline
  const stateManager = new StateManager()
  const p = new EnforcementPipeline({
    level,
    context,
    cache,
    contentTracker,
    sequenceDetector,
    flowTracker,
    ruleHierarchy: hierarchy,
    ruleVersion,
    allowedFixTransforms: true,
    enableReasoningCheck: level === 'protect',
    stateManager,
  })

  pipeline = p
  contextManager = cm
  auditLog = new AuditLog()

  return { pipeline: p, auditLog, contextManager: cm, sessionId: currentSessionId }
}

/**
 * Evaluate a tool call against the enforcement policy.
 * This is the main entry point for agent integration.
 */
export async function evaluateToolCall(
  tool: string,
  args: Record<string, unknown>,
  extra?: {
    cwd?: string
    turnNumber?: number
    contextTokens?: number
    level?: ProtectionLevel
    context?: RuleContext
    agent?: string
    subagentOf?: string | null
    reasoning?: string
  },
): Promise<EnforceResult> {
  if (!pipeline || !auditLog || !contextManager) {
    throw new Error('Enforcement not initialized. Call initEnforce() first.')
  }

  const input: EnforceInput = {
    tool,
    args,
    cwd: extra?.cwd || process.cwd(),
    session_id: currentSessionId,
    turn_number: extra?.turnNumber || 0,
    context_tokens: extra?.contextTokens || 0,
    level: extra?.level || 'balanced',
    context: extra?.context || 'local',
    agent: extra?.agent || 'unknown',
    subagent_of: extra?.subagentOf || null,
    reasoning: extra?.reasoning,
  }

  const result = await pipeline.evaluate(input)

  // Record in audit log
  auditLog.record(result, {
    session_id: currentSessionId,
    turn_number: input.turn_number,
    tool: input.tool,
    args: input.args,
    level: input.level,
    context: input.context,
    agent: input.agent,
    subagent_of: input.subagent_of,
    context_tokens: input.context_tokens,
    reasoning: input.reasoning,
  })

  // Check context re-injection
  const needsReinject = contextManager.reportTokens(input.context_tokens)
  if (needsReinject) {
    // The caller should re-inject rules into agent context
    // We just signal it here
  }

  return result
}

/**
 * CLI handler for `keel enforce`.
 */
export async function enforceCommand(options: {
  level?: string
  action?: string
  depth?: string
  learn?: boolean
  watch?: boolean
  audit?: boolean
}) {
  const level = (options.level || 'balanced') as ProtectionLevel
  const dir = process.cwd()

  // Show audit trail if requested
  if (options.audit) {
    const { AuditLog } = await import('../core/enforce/audit.js')
    const auditLog = new AuditLog()
    const entries = auditLog.loadAll()
    const recent = entries.slice(-20).reverse()

    console.log(chalk.bold.cyan('\n  ⚓ Keel Enforce — Recent Activity\n'))
    if (recent.length === 0) {
      console.log(chalk.dim('  No recent enforcement activity.\n'))
      return
    }
    for (const e of recent) {
      const actionColor = e.action === 'deny' ? chalk.red : e.action === 'warn' ? chalk.yellow : chalk.dim
      const ruleInfo = e.rule_id ? ` (${e.rule_id})` : ''
      console.log(`  ${actionColor(`[${e.turn_number || '?'}]`)} ${chalk.dim(e.tool)} ${actionColor(e.action)}${chalk.dim(ruleInfo)}`)
    }
    console.log()
    return
  }

  if (!['sprint', 'balanced', 'protect'].includes(level)) {
    console.log(chalk.red(`Invalid level: "${level}". Use sprint, balanced, or protect.`))
    return
  }

  // Check for CLAUDE.md
  const claudeMdPath = join(dir, 'CLAUDE.md')
  if (!existsSync(claudeMdPath)) {
    console.log(chalk.yellow('No CLAUDE.md found in current directory.'))
    console.log(chalk.cyan('  Run `keel enforce --init` to create one.'))
    return
  }

  // Initialize
  initEnforce(dir, { level, learn: options.learn })

  console.log(chalk.bold.cyan('\n  ⚓ Keel Enforce'))
  console.log(chalk.dim(`  Level: ${chalk.white(level)}`))
  console.log(chalk.dim(`  Config: ${claudeMdPath}`))
  console.log()

  // Parse rules and show status
  const parsed = parseRulesFile(claudeMdPath)
  if (parsed) {
    const activeRules = parsed.rules.length
    console.log(chalk.green(`  ✓ ${activeRules} rules loaded`))

    // Check conflicts
    const hier = loadRuleHierarchy(dir)
    const merged = mergeRulesFn(hier, level, 'local')
    const conflicts = detectConflicts(merged)
    if (conflicts.length > 0) {
      console.log(chalk.yellow(`  ⚠ ${conflicts.length} rule conflict(s) detected`))
      for (const c of conflicts) {
        console.log(chalk.yellow(`     • ${c.reason}`))
      }
    }

    if (options.learn) {
      console.log(chalk.cyan('  📖 Learning mode: recording violations, not blocking'))
      console.log(chalk.dim('     Run `keel suggest` after a few sessions to see recommendations'))
    }
  }

  console.log()
  console.log(chalk.dim('  Ready. Connect your agent:'))
  console.log(chalk.dim('    OpenCode:   built-in (auto-detected)'))
  console.log(chalk.dim('    Claude Code:  add hooks (see docs)'))
  console.log(chalk.dim('    Other agents: keel enforce --watch'))
  console.log()
}

/**
 * Detect if running in CI/CD.
 */
function detectContext(): RuleContext {
  if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI) {
    return 'ci'
  }
  return 'local'
}
