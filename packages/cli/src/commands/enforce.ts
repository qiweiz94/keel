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
  effectiveHierarchyLevel,
} from '../core/enforce/index.js'
import type { ProtectionLevel, RuleContext, EnforcementAction, EnforcementDepth, EnforceInput, EnforceResult } from '../core/types.js'

export interface EnforceOptions {
  level?: ProtectionLevel
  context?: RuleContext
  agent?: string
  learn?: boolean
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
    stateManager,
    reloadRules: () => {
      const next = loadRuleHierarchy(dir)
      currentLevel = next.project?.config.level || next.global?.config.level || currentLevel
      return next
    },
    // A mid-session rules.yaml edit that fails to validate keeps enforcing
    // on the last-known-good ruleset (checkRuleVersion's fail-safe — see
    // pipeline.ts) but was previously silent about it: nothing told the
    // user their edit didn't take. Surface it on stderr so a long-lived
    // caller in this process (keel test, keel allow, an interactive
    // session) doesn't mistake "still enforcing" for "the new rules are
    // live."
    onRulesError: (errors) => {
      console.error(`[keel] rules reload failed — keeping last-known-good rules: ${errors.join('; ')}`)
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
    /**
     * The host's OWN session id (Claude Code's `session_id`, Codex's
     * `session_id`, Cursor's `conversation_id`, ...), when the caller has
     * one. `keel hook <host>` is a fresh process per tool call, so without
     * this the pipeline would see a different random session_id (below)
     * on every single call — which silently defeats anything scoped to a
     * session, including `keel allow <id> --session`. Falls back to the
     * per-process id when the host payload carries none.
     */
    sessionId?: string
  },
): Promise<EnforceResult> {
  if (!pipeline || !auditLog || !contextManager) {
    throw new Error('Enforcement not initialized. Call initEnforce() first.')
  }

  const sessionId = extra?.sessionId || currentSessionId
  const input: EnforceInput = {
    tool,
    args,
    cwd: extra?.cwd || process.cwd(),
    session_id: sessionId,
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
    session_id: sessionId,
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
 * Evaluate a claim-to-evidence obligation against the agent's own completed
 * output OUTSIDE a tool call (v0.4 Phase 1: "give claim-to-evidence real
 * reach") — e.g. Claude Code's `Stop` hook `last_assistant_message`.
 *
 * Deliberately NOT `evaluateToolCall`: that routes through `pipeline.
 * evaluate()`'s full tier stack, which would treat one call per assistant
 * turn as a phantom tool call for flow/sequence/rate state (see
 * EnforcementPipeline.evaluateClaim's own header comment in pipeline.ts) —
 * corrupting exactly the trace-derived counters (runaway-budget, stuck-
 * loop) the v0.4 thesis experiment measures off keel's own traces. This
 * only ever touches `type: claim` rules and the VerificationTracker
 * pending state they share with `type: verification` rules.
 */
export async function evaluateClaimText(
  text: string,
  extra?: { cwd?: string; agent?: string; sessionId?: string },
): Promise<EnforceResult> {
  if (!pipeline || !auditLog) {
    throw new Error('Enforcement not initialized. Call initEnforce() first.')
  }
  const sessionId = extra?.sessionId || currentSessionId
  const input: EnforceInput = {
    tool: 'assistant-message',
    args: {},
    cwd: extra?.cwd || process.cwd(),
    session_id: sessionId,
    turn_number: 0,
    context_tokens: 0,
    level: currentLevel,
    context: 'local',
    agent: extra?.agent || 'unknown',
    subagent_of: null,
    reasoning: text,
  }
  const result = await pipeline.evaluateClaim(input)
  auditLog.record(result, {
    session_id: sessionId,
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
  audit?: boolean
}) {
  // `options.level` is `undefined` unless the caller actually typed
  // `--level=X` (the commander option below carries no default) — that
  // distinction is load-bearing. It used to default to 'balanced', which
  // made `options.level` truthy on EVERY invocation, including a bare
  // `keel enforce` that never mentioned --level at all: the "has no effect
  // without --persist" refusal below fired unconditionally and the status
  // view was unreachable without --persist. See EVIDENCE/m1r-4-mask.md.
  const explicitLevel = options.level as ProtectionLevel | undefined
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

  if (explicitLevel !== undefined && !['sprint', 'balanced', 'protect'].includes(explicitLevel)) {
    console.log(chalk.red(`Invalid level: "${explicitLevel}". Use sprint, balanced, or protect.`))
    process.exitCode = 1
    return
  }
  // --persist without --level has nothing to persist — say so rather than
  // silently writing a fallback the caller never asked for.
  if (options.persist && explicitLevel === undefined) {
    console.log(chalk.red('  --persist requires --level=<sprint|balanced|protect>.'))
    process.exitCode = 1
    return
  }
  if (options.persist) {
    const { writeRulesLevel } = await import('./level.js')
    const { join } = await import('node:path')
    const { existsSync } = await import('node:fs')
    const rulesPath = join(dir, '.keel', 'rules.yaml')
    if (!existsSync(rulesPath)) {
      console.log(chalk.yellow('No .keel/rules.yaml found in the current directory.'))
      console.log(chalk.cyan('  Run `keel enforce init` to create it, or use `keel level <level>` for the global dial.'))
      return
    }
    // Refuse to persist a level into rules that have parse or validation
    // issues — otherwise the level is written into a file the plugin
    // rejects, and the change silently never takes effect.
    const { parseRulesFile, validateRules } = await import('../core/enforce/rule-parser.js')
    const parsed = parseRulesFile(rulesPath)
    const issues = [...(parsed?.errors || []), ...validateRules(parsed?.rules || [])]
    if (issues.length) {
      console.log(chalk.red(`  Refusing to persist level — ${rulesPath} has issues:`))
      for (const issue of issues) console.log(chalk.yellow(`    ⚠ ${issue}`))
      process.exitCode = 1
      return
    }
    writeRulesLevel(rulesPath, explicitLevel!)
    console.log(chalk.green(`  ✓ Persisted project level: ${explicitLevel} (${rulesPath})`))
  }
  if (action && !['report', 'warn', 'deny', 'fix'].includes(action)) {
    console.log(chalk.red(`Invalid action: "${action}". Use report, warn, deny, or fix.`))
    return
  }
  if (depth && !['fast', 'full', 'deep'].includes(depth)) {
    console.log(chalk.red(`Invalid depth: "${depth}". Use fast, full, or deep.`))
    return
  }

  // Loaded AFTER any --persist write above, so a `--level=X --persist` in
  // the same invocation reports back the level it just wrote, not a stale
  // pre-write read.
  const hierarchy = loadRuleHierarchy(dir)
  const rulesPath = hierarchy.project?.sourcePath
  if (!rulesPath) {
    console.log(chalk.yellow('No Keel rules found in the current directory.'))
    console.log(chalk.cyan('  Run `keel enforce init` to create .keel/rules.yaml.'))
    return
  }

  // The dial this invocation actually evaluates against: an explicit
  // --level applies for this run only (see the preview note below);
  // otherwise fall back to the real persisted/effective dial — the same
  // resolution `keel status` uses — rather than a hardcoded assumption
  // that would misreport a project actually running at sprint or protect.
  const level = explicitLevel ?? effectiveHierarchyLevel(hierarchy, 'balanced')

  // Initialize
  initEnforce(dir, { level, learn: options.learn, action, depth })

  console.log(chalk.bold.cyan('\n  ⚓ Keel Enforce'))
  console.log(chalk.dim(`  Level: ${chalk.white(level)}`))
  if (explicitLevel !== undefined && !options.persist) {
    console.log(chalk.dim('  (preview for this run only — not persisted; add --persist to make it the standing dial)'))
  }
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
