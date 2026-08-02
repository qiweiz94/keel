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
  validateRules,
  Suggester,
  StateManager,
} from '../core/enforce/index.js'
import type { ProtectionLevel, RuleContext, EnforcementAction, EnforcementDepth, EnforceInput, EnforceResult } from '../core/types.js'

export interface EnforceOptions {
  level?: ProtectionLevel
  context?: RuleContext
  agent?: string
  learn?: boolean
  watch?: boolean
  action?: EnforcementAction
  depth?: EnforcementDepth
}

let pipeline: EnforcementPipeline | null = null
let auditLog: AuditLog | null = null
let contextManager: ContextManager | null = null
let currentSessionId = ''
let currentLevel: ProtectionLevel = 'balanced'
let learnMode = false
let actionOverride: EnforcementAction | undefined
let depthOverride: EnforcementDepth | undefined

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
  currentLevel = level
  const context: RuleContext = options?.context || detectContext()
  learnMode = options?.learn === true
  actionOverride = options?.action
  depthOverride = options?.depth

  // Generate session ID
  currentSessionId = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  // Load rules
  const hierarchy = loadRuleHierarchy(dir)
  const ruleErrors = [hierarchy.global, hierarchy.user, hierarchy.project, hierarchy.local]
    .flatMap(source => source ? [...(source.errors || []), ...validateRules(source.rules)] : [])
  if (ruleErrors.length) throw new Error(`Invalid Keel rules: ${ruleErrors.join('; ')}`)
  const ruleVersion = hierarchy.project?.version || 1

  // Initialize cache
  const cache = new ActionCache({
    maxSize: 10000,
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
    defaultAction: level === 'sprint' ? 'warn' : undefined,
    stateManager,
    reloadRules: () => {
      const next = loadRuleHierarchy(dir)
      currentLevel = next.project?.config.level || next.global?.config.level || currentLevel
      return next
    },
    ruleFingerprint: () => [
      join(dir, '.keel', 'rules.yaml'), join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md'),
      join(dir, '.keel.local.yaml'), join(dir, 'AGENTS.local.md'), join(dir, 'CLAUDE.local.md'),
      join(process.env.HOME || '~', '.keel', 'rules.yaml'), join(process.env.HOME || '~', '.config', 'keel', 'rules.yaml'),
    ].map(hashRulesFile).join(':'),
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
    depth?: EnforcementDepth
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
    level: extra?.level || currentLevel,
    context: extra?.context || 'local',
    agent: extra?.agent || 'unknown',
    subagent_of: extra?.subagentOf || null,
    reasoning: extra?.reasoning,
    depth: extra?.depth || depthOverride,
    action_override: actionOverride,
  }

  const evaluated = await pipeline.evaluate(input)
  const result = learnMode && evaluated.rule_id && ['warn', 'deny', 'block', 'fix'].includes(evaluated.action)
    ? {
        ...evaluated,
        action: 'warn' as const,
        message: `[Learning mode] ${evaluated.message}`,
        fix_result: undefined,
      }
    : evaluated

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
  persist?: boolean
  action?: string
  depth?: string
  learn?: boolean
  watch?: boolean
  audit?: boolean
}) {
  const level = (options.level || 'balanced') as ProtectionLevel
  const action = options.action as EnforcementAction | undefined
  const depth = options.depth as EnforcementDepth | undefined
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
  if (options.persist) {
    const { writeRulesLevel } = await import('./level.js')
    const { join } = await import('node:path')
    const { existsSync } = await import('node:fs')
    const rulesPath = join(dir, '.keel', 'rules.yaml')
    if (!existsSync(rulesPath)) {
      console.log(chalk.yellow('No .keel/rules.yaml found in the current directory.'))
      console.log(chalk.cyan('  Run `keel enforce init` to create it, then retry with --persist.'))
      return
    }
    writeRulesLevel(rulesPath, level)
    console.log(chalk.green(`  ✓ Persisted project level: ${level} (${rulesPath})`))
  }
  if (action && !['report', 'warn', 'deny', 'fix'].includes(action)) {
    console.log(chalk.red(`Invalid action: "${action}". Use report, warn, deny, or fix.`))
    return
  }
  if (depth && !['fast', 'full', 'deep'].includes(depth)) {
    console.log(chalk.red(`Invalid depth: "${depth}". Use fast, full, or deep.`))
    return
  }

  const hierarchy = loadRuleHierarchy(dir)
  const rulesPath = hierarchy.project?.sourcePath
  if (!rulesPath) {
    console.log(chalk.yellow('No Keel rules found in the current directory.'))
    console.log(chalk.cyan('  Run `keel enforce init` to create .keel/rules.yaml.'))
    return
  }

  // Initialize
  initEnforce(dir, { level, learn: options.learn, action, depth })

  console.log(chalk.bold.cyan('\n  ⚓ Keel Enforce'))
  console.log(chalk.dim(`  Level: ${chalk.white(level)}`))
  console.log(chalk.dim(`  Config: ${rulesPath}`))
  console.log()

  // Parse rules and show status
  const parsed = parseRulesFile(rulesPath)
  if (parsed) {
    const activeRules = parsed.rules.length
    console.log(chalk.green(`  ✓ ${activeRules} rules loaded`))

    // Check conflicts
    const merged = mergeRulesFn(hierarchy, level, 'local')
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
