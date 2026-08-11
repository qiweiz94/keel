import { readFileSync, existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { EnforcementAction, KeelConfig, KeelRule, ProtectionLevel, RuleContext } from '../types.js'

export interface ParsedRules {
  config: KeelConfig
  rules: KeelRule[]
  sourcePath: string
  version: number
  markdown: string        // the markdown portion (for re-injection)
  errors?: string[]
}

/**
 * Parse rules from a CLAUDE.md file with YAML frontmatter.
 * Also supports standalone .keel.yaml for global rules.
 */
export function parseRulesFile(filePath: string): ParsedRules | null {
  if (!existsSync(filePath)) return null

  const content = readFileSync(filePath, 'utf-8')
  return parseRulesContent(content, filePath)
}

export function parseRulesContent(content: string, sourcePath: string): ParsedRules {
  const frontmatter = extractFrontmatter(content)
  const markdown = frontmatter ? content.replace(/---\n[\s\S]*?\n---\n?/, '') : content

  let config: KeelConfig = { version: 1 }
  let yamlSource = frontmatter

  if (!yamlSource) {
    // No frontmatter — try parsing the entire file as YAML
    // (standalone .keel.yaml files have no frontmatter)
    yamlSource = content
  }

  const errors: string[] = []
  try {
    const parsed = parseYaml(yamlSource)
    if (parsed && typeof parsed === 'object' && 'keel' in parsed) {
      const candidate = parsed.keel
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        config = candidate as KeelConfig
      } else {
        errors.push('Keel configuration must be an object')
      }
    } else if (parsed && typeof parsed === 'object' && 'rules' in parsed) {
      // Direct rules object (standalone .keel.yaml or pure YAML)
      config = parsed as KeelConfig
    } else if (parsed && typeof parsed === 'object' && Object.keys(parsed).length === 0) {
      // Empty file or just comments — use defaults
    }
  } catch (error) {
    errors.push(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (config.rules !== undefined && !Array.isArray(config.rules)) {
    errors.push('Rules must be an array')
  }
  if (typeof config.version !== 'number') errors.push('Keel version must be a number')
  if (config.level !== undefined && !['sprint', 'balanced', 'protect'].includes(String(config.level))) {
    errors.push(`Invalid protection level: ${String(config.level)}`)
  }
  if (config.sprint_expiry_hours !== undefined && (typeof config.sprint_expiry_hours !== 'number' || !Number.isFinite(config.sprint_expiry_hours) || config.sprint_expiry_hours < 0)) {
    errors.push(`sprint_expiry_hours must be a non-negative number (0 disables auto-expiry), got: ${String(config.sprint_expiry_hours)}`)
  }
  if (config.sprint_started_at !== undefined && (typeof config.sprint_started_at !== 'string' || !Number.isFinite(Date.parse(config.sprint_started_at)))) {
    errors.push(`sprint_started_at must be an ISO 8601 timestamp, got: ${String(config.sprint_started_at)}`)
  }
  if (config.promotion_fp_threshold !== undefined && (typeof config.promotion_fp_threshold !== 'number' || !Number.isFinite(config.promotion_fp_threshold) || config.promotion_fp_threshold <= 0 || config.promotion_fp_threshold > 1)) {
    errors.push(`promotion_fp_threshold must be a number in (0, 1] (a fraction of evaluations, e.g. 0.001 for 1 per 1000), got: ${String(config.promotion_fp_threshold)}`)
  }

  return {
    config,
    rules: Array.isArray(config.rules) ? config.rules : [],
    sourcePath,
    version: config.version || 1,
    markdown: markdown.trim(),
    ...(errors.length ? { errors } : {}),
  }
}

export function validateRules(rules: unknown): string[] {
  const errors: string[] = []
  if (!Array.isArray(rules)) return ['Rules must be an array']

  const validTypes = new Set([
    'command', 'filesystem', 'content', 'env', 'network', 'rate', 'time',
    'sequence', 'flow', 'mcp', 'session', 'inheritance', 'context',
    'verification', 'meta', 'research', 'stuck', 'diagnosis', 'claim', 'oracle', 'package',
  ])
  const validActions = new Set(['block', 'deny', 'warn', 'prompt', 'allow', 'mask', 'fix', 'report', 'research', 'redirect'])
  const validLevels = new Set(['sprint', 'balanced', 'protect'])
  // Catalog metadata. These MUST be validated rather than passed through:
  // a typo'd `mode: observ` that silently fell back to enforcing is the
  // worst failure shape a guardrail can have — the user believes a rule is
  // burning in while it is actually blocking, or believes it is blocking
  // while it is silently observing.
  const validModes = new Set(['observe', 'warn', 'block'])
  const validSeverities = new Set(['critical', 'high', 'medium', 'low'])
  const validConfidence = new Set(['high', 'medium', 'low'])
  const validMaturity = new Set(['stable', 'incubating', 'sandbox', 'deprecated'])
  const validCategories = new Set([
    'destructive', 'exfil', 'escalation', 'injection',
    'resource', 'bypass', 'discipline', 'workflow', 'verification', 'supply-chain',
  ])
  // Declared in the type system but with no handler in the enforcement
  // pipeline — accepting them silently gave users a false sense of security.
  const notImplemented = new Set(['mcp', 'inheritance', 'meta', 'session', 'context'])

  for (const candidate of rules) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      errors.push('Rule entries must be objects')
      continue
    }
    const rule = candidate as Partial<KeelRule>
    const label = typeof rule.id === 'string' && rule.id ? rule.id : '<unnamed>'
    if (typeof rule.id !== 'string' || !rule.id.trim()) errors.push('Rule is missing a non-empty id')
    if (rule.type === 'research' && !rule.topics?.length && !rule.trigger) {
      errors.push(`Research rule "${label}" needs topics (freshness form) or a trigger (research-before-solve form)`)
    }
    if (rule.type === 'oracle') {
      if (!rule.paths?.length && !rule.match) {
        errors.push(`Oracle rule "${label}" needs paths (content-diff surface) or match (command-surface) — remove it or add a detection surface`)
      }
      if (!rule.trigger) {
        errors.push(`Oracle rule "${label}" needs a trigger (the failing test-run matcher that arms the recency window) — without it the rule can never fire`)
      }
    }
    if (typeof rule.type === 'string' && notImplemented.has(rule.type)) {
      errors.push(`Rule "${label}" uses type "${rule.type}", which is not implemented by the enforcement engine — remove it or use a supported type`)
      continue
    }
    if (typeof rule.type !== 'string' || !validTypes.has(rule.type)) errors.push(`Rule "${label}" has an unsupported type: ${String(rule.type)}`)
    if (rule.action === 'mask') {
      errors.push(`Rule "${label}" uses action "mask", which is not implemented by the enforcement engine — use "warn" or "deny"`)
    }
    if (rule.mode !== undefined && !validModes.has(String(rule.mode))) {
      errors.push(`Rule "${label}" has an unsupported mode: ${String(rule.mode)} (expected observe, warn, or block)`)
    }
    if (rule.severity !== undefined && !validSeverities.has(String(rule.severity))) {
      errors.push(`Rule "${label}" has an unsupported severity: ${String(rule.severity)}`)
    }
    if (rule.confidence !== undefined && !validConfidence.has(String(rule.confidence))) {
      errors.push(`Rule "${label}" has an unsupported confidence: ${String(rule.confidence)}`)
    }
    if (rule.maturity !== undefined && !validMaturity.has(String(rule.maturity))) {
      errors.push(`Rule "${label}" has an unsupported maturity: ${String(rule.maturity)}`)
    }
    if (rule.category !== undefined && !validCategories.has(String(rule.category))) {
      errors.push(`Rule "${label}" has an unsupported category: ${String(rule.category)}`)
    }
    const actionOptional = rule.type === 'context' || rule.type === 'meta'
    if ((!actionOptional && typeof rule.action !== 'string') || (typeof rule.action === 'string' && !validActions.has(rule.action))) {
      errors.push(`Rule "${label}" has an unsupported action: ${String(rule.action)}`)
    }
    if (rule.level !== undefined && (typeof rule.level !== 'string' || !validLevels.has(rule.level))) errors.push(`Rule "${label}" has an invalid protection level`)
    if (typeof rule.message !== 'string' || !rule.message.trim()) errors.push(`Rule "${label}" is missing a non-empty message`)
    if (rule.type === 'filesystem' && (!Array.isArray(rule.paths) || rule.paths.length === 0)) errors.push(`Rule "${label}" is a filesystem rule but has no paths`)
    if (rule.type === 'content' && (!Array.isArray(rule.patterns) || rule.patterns.length === 0)) errors.push(`Rule "${label}" is a content rule but has no patterns`)
    if (rule.type === 'network' && typeof rule.match !== 'string') errors.push(`Rule "${label}" is a network rule but has no match`)
    if (rule.type === 'package' && rule.age_days !== undefined && (typeof rule.age_days !== 'number' || !Number.isFinite(rule.age_days) || rule.age_days < 0)) {
      errors.push(`Rule "${label}" is a package rule but has an invalid age_days (expected a non-negative number)`)
    }
    if (rule.type === 'env' && (!Array.isArray(rule.vars) || rule.vars.length === 0)) errors.push(`Rule "${label}" is an env rule but has no vars`)
    if (rule.type === 'flow' && (!Array.isArray(rule.sources) || !Array.isArray(rule.sinks))) errors.push(`Rule "${label}" is a flow rule but is missing sources or sinks`)
    if (rule.type === 'sequence' && (!Array.isArray(rule.steps) || rule.steps.length < 2)) {
      errors.push(`Rule "${label}" is a sequence rule but has fewer than two steps`)
    }
    // `claim` reuses verification's trigger/satisfy/pending machinery
    // verbatim (see types.ts's field comment), so it needs the same shape.
    if (rule.type === 'verification' || rule.type === 'claim') {
      if (!rule.trigger) errors.push(`Rule "${rule.id}" is missing ${rule.type}.trigger`)
      if (!rule.satisfy) errors.push(`Rule "${rule.id}" is missing ${rule.type}.satisfy`)
      if (rule.trigger?.paths !== undefined && (!Array.isArray(rule.trigger.paths) || rule.trigger.paths.some(p => typeof p !== 'string' || !p))) {
        errors.push(`Rule "${rule.id}" has an invalid ${rule.type}.trigger.paths (expected an array of non-empty strings)`)
      }
      for (const boundary of Object.values(rule.boundaries || {})) {
        if (!boundary.pattern) errors.push(`Rule "${rule.id}" has a boundary without a pattern`)
      }
    }
    for (const pattern of [
      rule.match,
      rule.match_regex,
      rule.unless_reasoning,
      ...(rule.steps || []).map(step => step.pattern),
      rule.trigger?.pattern,
      rule.satisfy?.pattern,
      ...Object.values(rule.boundaries || {}).map(boundary => boundary.pattern),
    ]) {
      if (typeof pattern === 'string' && pattern) {
        try { new RegExp(pattern) } catch { errors.push(`Rule "${rule.id}" contains invalid regex: ${pattern}`) }
      }
    }
    if (rule.fix && (!Array.isArray(rule.fix) || rule.fix.some(transform => !transform || typeof transform.pattern !== 'string' || typeof transform.replace !== 'string'))) {
      errors.push(`Rule "${label}" has an invalid fix transform`)
    }
  }

  // Duplicate ids within ONE file are always a mistake (cross-scope overrides
  // are legal and handled by mergeRules, but a duplicated id in a single
  // scope silently drops one of the two rules).
  const ids = rules.map(rule => typeof (rule as Partial<KeelRule>)?.id === 'string' ? (rule as Partial<KeelRule>).id as string : '')
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const id of ids) {
    if (id && seen.has(id)) dups.add(id)
    seen.add(id)
  }
  if (dups.size) errors.push(`Duplicate rule id(s) in the same file: ${[...dups].join(', ')}`)

  return errors
}

/**
 * Scan the rule hierarchy: global → user → project → local
 * Returns merged rules with more specific scopes overriding less specific.
 *
 * Sources (in priority order for each level):
 *   global: ~/.keel/rules.yaml → ~/.config/keel/rules.yaml
 *   user:   ~/.config/keel/rules.yaml (legacy)
 *   project: .keel/rules.yaml → AGENTS.md → CLAUDE.md
 *   local:  .keel.local.yaml → AGENTS.local.md → CLAUDE.local.md
 */
export interface RuleHierarchy {
  global: ParsedRules | null      // ~/.keel/rules.yaml
  user: ParsedRules | null        // ~/.config/keel/rules.yaml (legacy)
  project: ParsedRules | null     // .keel/rules.yaml > AGENTS.md > CLAUDE.md
  local: ParsedRules | null       // .keel.local.yaml > AGENTS.local.md > CLAUDE.local.md
}

// ── Sprint auto-expiry + dial transparency ──────────────────────────
//
// `keel level sprint` is the least-friction dial (deny/block softens to
// warn). Left on indefinitely it stops being a deliberate choice and
// becomes the ambient state — the same failure shape as a shell left in
// `set +e` or Gatekeeper's unsafe mode, both of which time out on their
// own rather than trusting the human to remember to flip them back.
// `sprint_started_at` + `sprint_expiry_hours` give sprint the same
// timeout. This is read fresh from whatever config was just loaded off
// disk (no daemon, no session tracking) — a process-per-call host picks
// up the reversion on its very next invocation for free.

export const DEFAULT_SPRINT_EXPIRY_HOURS = 4

/**
 * Default `promotion_fp_threshold`: 1 would-block per 1000 evaluations.
 * `keel retrospective`'s promotion section and `keel promote`'s guidance
 * both read this when the winning rules.yaml (project over global,
 * mirroring `level` precedence — see winningLevelConfig) declares none.
 */
export const DEFAULT_PROMOTION_FP_THRESHOLD = 0.001

/**
 * Which config's `promotion_fp_threshold` wins across the hierarchy:
 * project over global, identical precedence to winningLevelConfig(). A
 * project's rules.yaml is the one a team actually tunes; the global config
 * is the fallback for projects that never override it.
 */
export function winningPromotionThreshold(hierarchy: RuleHierarchy): number {
  return hierarchy.project?.config?.promotion_fp_threshold
    ?? hierarchy.global?.config?.promotion_fp_threshold
    ?? DEFAULT_PROMOTION_FP_THRESHOLD
}

export interface SprintExpiryStatus {
  expired: boolean
  startedAt: number      // epoch ms
  expiryHours: number
  hoursElapsed: number
}

/**
 * Whether a `level: sprint` config has aged past its expiry window, and by
 * how much. Returns null when expiry does not apply: the level isn't
 * sprint, `sprint_expiry_hours` is 0 (disabled), or there is no
 * `sprint_started_at` to measure from (e.g. `level: sprint` set by hand —
 * a rule with no recorded start never auto-expires).
 */
export function sprintExpiryStatus(config: KeelConfig | undefined | null): SprintExpiryStatus | null {
  if (!config || config.level !== 'sprint') return null
  const expiryHours = config.sprint_expiry_hours ?? DEFAULT_SPRINT_EXPIRY_HOURS
  if (!(expiryHours > 0)) return null
  const startedAt = config.sprint_started_at ? Date.parse(config.sprint_started_at) : NaN
  if (!Number.isFinite(startedAt)) return null
  const hoursElapsed = (Date.now() - startedAt) / 3_600_000
  return { expired: hoursElapsed >= expiryHours, startedAt, expiryHours, hoursElapsed }
}

/**
 * The level a config resolves to RIGHT NOW: identical to `config.level`
 * except an expired `level: sprint` resolves to `balanced`. This is the
 * single place "is sprint still in effect" gets decided — pipeline.ts's
 * per-call effectiveLevel() and the CLI's `keel status`/`keel level`
 * announcements all call this instead of re-deriving it, so the
 * enforcement path and the human-facing report can never disagree.
 */
export function resolvedLevel(config: KeelConfig | undefined | null, fallback: ProtectionLevel): ProtectionLevel {
  const level = config?.level as ProtectionLevel | undefined
  if (!level) return fallback
  if (level === 'sprint' && sprintExpiryStatus(config)?.expired) return 'balanced'
  return level
}

/**
 * Which config's `level` wins across the hierarchy: project over global,
 * matching mergeRules' precedence. Exposed separately (rather than folded
 * straight into effectiveHierarchyLevel) so callers that also need sprint
 * expiry metadata — `keel status`'s "sprint expired → balanced" line —
 * can inspect the same config sprintExpiryStatus() would use.
 */
export function winningLevelConfig(hierarchy: RuleHierarchy): KeelConfig | undefined {
  if (hierarchy.project?.config?.level) return hierarchy.project.config
  if (hierarchy.global?.config?.level) return hierarchy.global.config
  return undefined
}

/**
 * The effective level across the whole rule hierarchy right now: project
 * overrides global, and an expired `level: sprint` on whichever config won
 * resolves to balanced. Every command that needs "which dial is actually
 * in effect" (pipeline enforcement, `keel status`, `keel dashboard`,
 * `keel validate`, the daemon) is a thin wrapper around this, so they
 * cannot drift from each other or from the enforcement decision itself.
 */
export function effectiveHierarchyLevel(hierarchy: RuleHierarchy, fallback: ProtectionLevel): ProtectionLevel {
  return resolvedLevel(winningLevelConfig(hierarchy), fallback)
}

/**
 * The action a rule takes when enforced at a given dial, ignoring
 * runtime-only modifiers (observe mode, per-call action_override, and the
 * warn-once-then-block escalation — all of those are per-evaluation state,
 * not a property of the rule+dial pair). `level: protect` rules are
 * floors and never soften; otherwise sprint downgrades deny/block to warn.
 *
 * This is the one real implementation of "does the dial soften this
 * rule" — pipeline.ts's enforcedAction() delegates to it for the actual
 * enforcement decision, and `keel level`'s dial-switch summary diffs its
 * output across the previous and new level so the printed effects are
 * derived from the real ruleset, not hardcoded prose.
 */
export function dialAction(rule: KeelRule, level: ProtectionLevel): EnforcementAction {
  if (rule.level === 'protect') return rule.action
  if (level === 'sprint' && (rule.action === 'deny' || rule.action === 'block')) return 'warn'
  return rule.action
}

export function loadRuleHierarchy(projectDir: string): RuleHierarchy {
  const home = process.env.HOME || '~'

  // Project-level: prefer .keel/rules.yaml, then AGENTS.md, then CLAUDE.md
  const projectRules =
    parseRulesFile(`${projectDir}/.keel/rules.yaml`)
    || parseRulesFile(`${projectDir}/AGENTS.md`)
    || parseRulesFile(`${projectDir}/CLAUDE.md`)

  // Local overrides: prefer .keel.local.yaml, then AGENTS.local.md, then CLAUDE.local.md
  const localRules =
    parseRulesFile(`${projectDir}/.keel.local.yaml`)
    || parseRulesFile(`${projectDir}/AGENTS.local.md`)
    || parseRulesFile(`${projectDir}/CLAUDE.local.md`)

  return {
    global: parseRulesFile(`${home}/.keel/rules.yaml`)
      || parseRulesFile(`${home}/.config/keel/rules.yaml`),
    user: parseRulesFile(`${home}/.config/keel/rules.yaml`)
      || null,
    project: projectRules,
    local: localRules,
  }
}

/**
 * Merge rules from hierarchy into a single flat list.
 * More specific scopes override less specific ones for same rule id.
 */
export function mergeRules(hierarchy: RuleHierarchy, level: ProtectionLevel, context: RuleContext): KeelRule[] {
  const all: KeelRule[] = []

  // Rule `level` is a minimum-dial filter AND a floor marker:
  //   - `level: sprint` rules are active at every dial (sprint is the
  //     lowest dial, so they always fire).
  //   - `level: balanced` rules fire only when the dial is balanced/protect.
  //   - `level: protect` rules are floors: active at EVERY dial and exempt
  //     from the sprint downgrade (effectiveAction) — never silently
  //     disabled when the dial is low.
  // The dial itself softens enforcement (sprint downgrades deny→warn); a
  // rule-level filter would let a user scope a rule to the stricter dials.
  const dialRank: Record<string, number> = { sprint: 0, balanced: 1, protect: 2 }
  const currentRank = dialRank[level] ?? 1

  const pushRules = (source: ParsedRules | null, scope: KeelRule['scope']) => {
    if (!source) return
    for (const rule of source.rules) {
      if (rule.level === 'protect') {
        // floor — active at every dial
      } else if (rule.level !== undefined && (dialRank[rule.level] ?? 0) > currentRank) {
        continue
      }
      // Filter by context
      if (rule.context && !rule.context.includes(context) && !rule.context.includes('both')) continue

      all.push({ ...rule, scope: rule.scope || scope })
    }
  }

  pushRules(hierarchy.global, 'global')
  pushRules(hierarchy.user, 'user')
  pushRules(hierarchy.project, 'project')
  pushRules(hierarchy.local, 'folder')

  // Deduplicate: more specific scope wins for same rule id
  const scopeOrder: Record<string, number> = { global: 0, user: 1, project: 2, folder: 3, session: 4 }
  const deduped = new Map<string, KeelRule>()
  for (const rule of all) {
    const existing = deduped.get(rule.id)
    if (!existing || (rule.scope && scopeOrder[rule.scope] > scopeOrder[existing.scope || 'global'])) {
      deduped.set(rule.id, rule)
    }
  }

  // Sort by priority (higher first), then by type
  return Array.from(deduped.values()).sort((a, b) => (b.priority || 0) - (a.priority || 0))
}

/**
 * Detect conflicts between rules.
 * Returns pairs of rules that contradict each other.
 */
export interface RuleConflict {
  ruleA: KeelRule
  ruleB: KeelRule
  reason: string
}

export function detectConflicts(rules: KeelRule[]): RuleConflict[] {
  const conflicts: RuleConflict[] = []

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]
      const b = rules[j]

      // Same match pattern, different actions
      if (a.match && b.match && a.match === b.match) {
        if ((a.action === 'deny' || a.action === 'block') && (b.action === 'allow')) {
          conflicts.push({ ruleA: a, ruleB: b, reason: `"${a.match}" is denied by "${a.id}" but allowed by "${b.id}"` })
        }
        if ((a.action === 'allow') && (b.action === 'deny' || b.action === 'block')) {
          conflicts.push({ ruleA: a, ruleB: b, reason: `"${b.match}" is denied by "${b.id}" but allowed by "${a.id}"` })
        }
      }

      // Network deny all vs. specific allow
      if (a.type === 'network' && b.type === 'network') {
        if (a.match === '*' && b.except?.length) {
          conflicts.push({ ruleA: a, ruleB: b, reason: `"${a.id}" denies all network, "${b.id}" expects to allow specific domains` })
        }
      }

      // Sequence vs. single action contradiction
      if (a.type === 'sequence' && b.type === 'command') {
        if (a.steps?.some(s => s.tool === b.match)) {
          conflicts.push({ ruleA: a, ruleB: b, reason: `"${a.id}" blocks sequences involving "${b.match}", "${b.id}" individually checks it` })
        }
      }
    }
  }

  return conflicts
}

function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  return match ? match[1] : null
}

/**
 * Compute a content hash for version detection / cache invalidation.
 */
export function hashRulesFile(filePath: string): string {
  if (!existsSync(filePath)) return ''
  const content = readFileSync(filePath, 'utf-8')
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return hash.toString(36)
}
