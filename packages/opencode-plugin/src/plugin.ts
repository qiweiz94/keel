import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ActionCache,
  ContentTracker,
  EnforcementPipeline,
  FlowTracker,
  SequenceDetector,
  StateManager,
  loadRuleHierarchy,
  hashRulesFile,
  validateRules,
  projectAuditArgs,
  createReceipt,
} from '../../core/src/keel-core.js'

const KEEL_DIR = path.join(os.homedir(), '.keel')
const RULES_PATH = path.join(KEEL_DIR, 'rules.yaml')
const REQUIREMENTS_PATH = path.join(KEEL_DIR, 'requirements.md')
const DISABLED_PATH = path.join(KEEL_DIR, 'DISABLED')
const TRACES_DIR = path.join(KEEL_DIR, 'traces')
const LEGACY_PRODUCT_NAME = 'ai-' + 'enforce'
const DEFAULT_RULES_YAML = `version: 1
level: balanced
rules:
  - id: product-name-is-keel
    type: command
    match: "(sed|replaceAll|rename).*(keel|product).*(${LEGACY_PRODUCT_NAME})"
    action: deny
    level: sprint
    priority: 100
    message: "Product name is 'keel'. Never change it back to ${LEGACY_PRODUCT_NAME}."
  - id: no-force-push
    type: command
    match: "git push --force(?!-with-lease)"
    action: deny
    level: sprint
    message: "Use --force-with-lease instead of --force."
  - id: source-change-requires-test
    type: verification
    trigger:
      tools: [WriteFile, edit]
      path: "src/"
      pattern: "src/"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest)"
    boundaries:
      commit:
        pattern: "git commit"
        action: warn
      push:
        pattern: "git push"
        action: deny
    verification_window_seconds: 300
    action: deny
    message: "Source changes require a successful test run before commit or push."
  - id: verify-format-before-decision
    type: command
    match: "(default|choose).*(format|config|rule)"
    action: warn
    unless_reasoning: "user.*(said|asked|want|use|prefer)|verify|check|ask"
    message: "You are choosing a format without verifying the user. Ask what they use before deciding."
  - id: no-destructive-commands
    type: command
    match: "rm -rf /|rm -rf ~"
    action: deny
    level: sprint
    message: "Destructive commands are blocked."
  - id: must-sign-commits
    type: command
    match: "git commit"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    message: "Auto-adding --signoff to commits."
  - id: re-inject-at-thresholds
    type: context
    message: "Re-inject standing requirements at 8K/16K/32K token thresholds to combat context drift."
  - id: git-history-rewrite
    type: command
    match: "git filter-branch|git rebase (--onto|--root)|git reset --hard|git commit --amend|git stash (drop|clear)"
    action: prompt
    level: sprint
    priority: 80
    message: "Git history mutation — this rewrites shared history. Approval required."
  - id: publish-gate
    type: command
    match: "npm publish|npm unpublish|gh release create|gh repo delete|gh repo transfer"
    action: prompt
    level: sprint
    priority: 80
    message: "Publishing or deleting registry artifacts — approval required."
  - id: verify-before-irreversible
    type: command
    match: "git push --force(?!-with-lease)|rm -rf (?!.*(node_modules|/tmp/|/var/tmp/|Trash))"
    action: warn
    message: "Irreversible action — verify inbound references before proceeding."
`

function ensureRules(): void {
  try {
    if (!fs.existsSync(RULES_PATH)) {
      fs.mkdirSync(KEEL_DIR, { recursive: true })
      fs.writeFileSync(RULES_PATH, DEFAULT_RULES_YAML, 'utf8')
    }
  } catch {}
}

function isDisabled(): boolean {
  try {
    if (!fs.existsSync(DISABLED_PATH)) return false
    const state = JSON.parse(fs.readFileSync(DISABLED_PATH, 'utf8'))
    if (state.expires_at && new Date(state.expires_at) < new Date()) {
      fs.rmSync(DISABLED_PATH, { force: true })
      return false
    }
    return true
  } catch { return true }
}

function consumeRestartDisable(): void {
  try {
    if (!fs.existsSync(DISABLED_PATH)) return
    const state = JSON.parse(fs.readFileSync(DISABLED_PATH, 'utf8'))
    if (state.auto_enable_on_restart && !state.expires_at) fs.rmSync(DISABLED_PATH, { force: true })
  } catch { /* Keep a corrupt disable sentinel in place until manual recovery. */ }
}

function record(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(TRACES_DIR, { recursive: true })
    const now = new Date()
    fs.appendFileSync(path.join(TRACES_DIR, `${now.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({
      t: Date.now(), timestamp: now.toISOString(), agent: 'opencode-plugin', ...entry,
    })}\n`)
  } catch {}
}

function requirementLines(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) return []
    return fs.readFileSync(filePath, 'utf8').split('\n')
      .map(line => line.replace(/^#+\s*/, '').trim())
      .filter(line => line && !line.startsWith('[') && !line.startsWith('<!--'))
  } catch { return [] }
}

function toEnforceInput(tool: string, args: Record<string, unknown>, hookInput: any, level: any, cwd: string) {
  return {
    tool, args, cwd, session_id: hookInput?.sessionID || 'unknown', turn_number: 0,
    context_tokens: 0, level, depth: level === 'protect' ? 'deep' : level === 'sprint' ? 'fast' : 'full',
    context: 'local' as const, agent: 'opencode', subagent_of: null,
    ...(hookInput?.reasoning ? { reasoning: String(hookInput.reasoning) } : {}),
  }
}

function applyFix(args: Record<string, unknown>, result: any): void {
  const fixed = result.fix_result?.fixed
  if (typeof fixed === 'string' && typeof args.command === 'string') args.command = fixed
}

function worktreeFingerprint(directory: string, sourcePath: string | undefined): string | null {
  if (!sourcePath) return null
  try {
    const diff = spawnSync('git', ['-C', directory, 'diff', '--binary', 'HEAD', '--', sourcePath], { encoding: 'utf8' })
    const untracked = spawnSync('git', ['-C', directory, 'ls-files', '--others', '--exclude-standard', '--', sourcePath], { encoding: 'utf8' })
    if (diff.status !== 0 || untracked.status !== 0) return null
    let content = `${diff.stdout}\n${untracked.stdout}`
    for (const relative of untracked.stdout.split('\n').filter(Boolean)) {
      try { content += `\n${relative}\n${fs.readFileSync(path.join(directory, relative), 'utf8')}` } catch {}
    }
    return content
  } catch { return null }
}

export default {
  id: 'keel-enforce',
  server: async (pluginInput: any) => {
    ensureRules()
    const directory = pluginInput?.directory || process.cwd()
    const hierarchy = loadRuleHierarchy(directory)
    const ruleErrors = [hierarchy.global, hierarchy.user, hierarchy.project, hierarchy.local]
      .flatMap(source => source ? [...(source.errors || []), ...validateRules(source.rules)] : [])
    if (ruleErrors.length) {
      throw new Error(`[Keel] Invalid Keel rules: ${ruleErrors.join('; ')}`)
    }
    let level = hierarchy.project?.config.level || hierarchy.global?.config.level || 'balanced'
    let activeHierarchy = hierarchy
    let verificationIds = new Set<string>()
    let verificationBaselines = new Map<string, string | null>()
    const refreshVerificationMetadata = (nextHierarchy: typeof hierarchy) => {
      activeHierarchy = nextHierarchy
      level = nextHierarchy.project?.config.level || nextHierarchy.global?.config.level || 'balanced'
      verificationIds = new Set([
        ...(nextHierarchy.global?.rules || []), ...(nextHierarchy.project?.rules || []), ...(nextHierarchy.local?.rules || []),
      ].filter(rule => rule.type === 'verification').map(rule => rule.id))
      const nextBaselines = new Map<string, string | null>()
      for (const rule of [...(nextHierarchy.global?.rules || []), ...(nextHierarchy.project?.rules || []), ...(nextHierarchy.local?.rules || [])]) {
        if (rule.type === 'verification') nextBaselines.set(rule.id, worktreeFingerprint(directory, rule.trigger?.path))
      }
      verificationBaselines = nextBaselines
    }
    refreshVerificationMetadata(hierarchy)
    const pipeline = new EnforcementPipeline({
      level, context: 'local', cache: new ActionCache({ maxSize: 1000 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(), ruleHierarchy: hierarchy, ruleVersion: 1,
      allowedFixTransforms: true, enableReasoningCheck: level === 'protect',
      defaultAction: level === 'sprint' ? 'warn' : undefined,
      stateManager: new StateManager(),
      reloadRules: () => loadRuleHierarchy(directory),
      ruleFingerprint: () => [
        path.join(directory, '.keel', 'rules.yaml'), path.join(directory, 'AGENTS.md'), path.join(directory, 'CLAUDE.md'),
        path.join(directory, '.keel.local.yaml'), path.join(directory, 'AGENTS.local.md'), path.join(directory, 'CLAUDE.local.md'),
        RULES_PATH, path.join(os.homedir(), '.config', 'keel', 'rules.yaml'),
      ].map(source => hashRulesFile(source)).join(':'),
      onRulesReload: refreshVerificationMetadata,
    })
    const verificationWarnings = new Set<string>()
    const refreshExternalChanges = async () => {
      for (const rule of [...(activeHierarchy.global?.rules || []), ...(activeHierarchy.project?.rules || []), ...(activeHierarchy.local?.rules || [])]) {
        if (rule.type !== 'verification' || !rule.trigger?.path) continue
        const current = worktreeFingerprint(directory, rule.trigger.path)
        const baseline = verificationBaselines.get(rule.id)
        if (current && baseline && current !== baseline) {
          verificationBaselines.set(rule.id, current)
          const tool = rule.trigger.tools?.[0] || rule.trigger.tool || 'WriteFile'
          await pipeline.evaluate(toEnforceInput(tool, { path: rule.trigger.path, content: rule.trigger.path }, pluginInput, level, directory))
        }
      }
    }
    const requirementSources = [REQUIREMENTS_PATH, path.join(directory, '.keel', 'requirements.md')]
      .filter((source, index, all) => all.indexOf(source) === index)
    consumeRestartDisable()

    const before = async (input: any, output: any) => {
      if (isDisabled()) return
      await refreshExternalChanges()
      const args = output?.args || {}
      const result = await pipeline.evaluate(toEnforceInput(input?.tool || 'unknown', args, input, level, directory))
      record({ session_id: input?.sessionID, tool: input?.tool, args: projectAuditArgs(args), rule_id: result.rule_id, action: result.action, message: result.message, hook: 'tool.execute.before' })
      if (result.action === 'fix') applyFix(args, result)
      if (result.action === 'warn' && result.rule_id && verificationIds.has(result.rule_id)) {
        const key = `${result.rule_id}:${directory}`
        if (verificationWarnings.has(key)) {
          throw new Error(`[Keel] ${result.rule_id}: ${result.message}`)
        }
        verificationWarnings.add(key)
      }
      if (result.action === 'deny' || result.action === 'block' || result.action === 'prompt') {
        // Signed-receipt ledger: every gated/blocked action emits an offline-
        // verifiable, hash-chained receipt (`keel verify` reads the same dir).
        try {
          createReceipt('opencode-plugin', input?.tool || 'unknown', projectAuditArgs(args), result.action, result.rule_id || 'unknown', 'keel', input?.sessionID)
        } catch {}
        throw new Error(`[Keel] ${result.rule_id}: ${result.message}`)
      }
    }

    return {
      'tool.execute.before': async (input: any, output: any) => {
        try { await before(input, output) } catch (error) {
          if (error instanceof Error && error.message.startsWith('[Keel]')) throw error
          throw new Error(`[Keel] Enforcement failed closed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      'tool.execute.after': async (input: any, output: any) => {
        try {
          const args = input?.args || {}
          const action = toEnforceInput(input?.tool || 'unknown', args, input, level, directory)
          if (Number(output?.metadata?.exit) === 0) pipeline.markVerificationSatisfied(action)
          record({ session_id: input?.sessionID, tool: input?.tool, args: projectAuditArgs(args), action: 'allow', message: 'Tool completed', hook: 'tool.execute.after' })
        } catch {}
      },
      'experimental.chat.system.transform': async (_input: any, output: any) => {
        try {
          const blocks = requirementSources.map(requirementLines).filter(lines => lines.length)
          if (blocks.length) {
            output.system ||= []
            output.system.push(...blocks.map(lines => `Standing Requirements (mandatory):\n${lines.map(line => `- ${line}`).join('\n')}`))
          }
        } catch {}
      },
      'experimental.session.compacting': async (_input: any, output: any) => {
        try {
          const lines = requirementSources.flatMap(requirementLines)
          if (lines.length) {
            output.context ||= []
            output.context.push(`## Standing Requirements (survive compaction)\n${lines.map(line => `- ${line}`).join('\n')}`)
          }
        } catch {}
      },
    }
  },
}
