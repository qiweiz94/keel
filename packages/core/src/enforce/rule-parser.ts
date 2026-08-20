import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { resolveHome } from '../home.js'
import type { EnforcementAction, KeelConfig, KeelRule, ProtectionLevel, RuleContext, RuleMode, SimpleRule, SimpleRuleType } from '../types.js'

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

// ── Minimal / beginner-friendly rule format ──────────────────────────
//
// Defaults applied to every expanded SimpleRule. Only `level` and
// `context` are given a concrete value; `scope`, `priority`, and `mode`
// are deliberately left UNSET rather than defaulted to a literal:
//   - `scope` is inferred per-tier by mergeRules' pushRules()
//     (`rule.scope || scope`) from which hierarchy file the rule was
//     actually loaded from. Hardcoding e.g. `scope: 'project'` here would
//     silently mis-rank a simple rule authored in the GLOBAL or LOCAL tier
//     in the same-id override arbitration (scopeOrder in mergeRules) — a
//     SimpleRule must sort exactly like a hand-written full-form rule in
//     the same file, and that requires staying unset.
//   - `priority`/`mode` have well-defined "no value" semantics already
//     (default priority order; undefined mode IS fully enforcing — see
//     RuleMode's doc comment in types.ts) that a beginner rule should
//     inherit, not override.
//   - `level` is deliberately `'sprint'`, NOT `'balanced'`, even though
//     'balanced' reads like the more cautious choice. mergeRules' dial
//     filter (`rule.level !== undefined && dialRank[rule.level] >
//     currentRank`) DROPS a `level: 'balanced'` rule entirely — not
//     softened, gone — the moment the ambient dial is `keel level sprint`.
//     docs/tiers.md documents the shipped-catalog convention this mirrors:
//     "Most rules don't set one (or carry `level: sprint`, meaning 'no
//     floor — obey the dial')" — "every rule is evaluated at every dial."
//     `level: 'sprint'` and leaving `level` unset are behaviorally
//     identical (neither is ever filtered by dialRank; dialAction still
//     softens deny/block to warn at the sprint dial) — 'sprint' is spelled
//     out because it is self-documenting to the next reader, matching the
//     catalog's own convention, rather than relying on implicit undefined
//     semantics. A beginner's one rule must not silently stop existing
//     the moment they flip keel's least-friction dial.
const DEFAULT_SIMPLE_RULE_LEVEL: ProtectionLevel = 'sprint'
const DEFAULT_SIMPLE_RULE_CONTEXT: RuleContext[] = ['both']

const SIMPLE_RULE_TYPES = new Set<string>(['command', 'filesystem', 'content', 'env', 'network'])

// Mirrors validateRules()' validActions exactly (see that Set's own
// comment for why `mask` is deliberately absent). Kept as a separate
// literal rather than importing validateRules' local const: validating
// against the same set here is what lets a mistyped `action: blok` get
// the friendly, field-specific message below instead of falling through
// to validateRules()' generic "has an unsupported action" dump.
const SIMPLE_RULE_VALID_ACTIONS = new Set<string>(['block', 'deny', 'warn', 'prompt', 'allow', 'fix', 'report', 'research', 'redirect'])

/**
 * Translate one minimal-form `SimpleRule` into a full `KeelRule`, or
 * return a friendly, field-specific error instead of the generic
 * schema-validation dump `validateRules()` produces for the full form.
 * This is the entire beginner contract: id + type + one match-condition
 * field appropriate to `type` + action + message — see SimpleRule's doc
 * comment in types.ts for why the other ~20 KeelRule fields are out of
 * scope for this format (use the full form for anything past these five
 * types, or past a plain match/paths/patterns/vars condition).
 */
export function expandSimpleRule(candidate: unknown): { rule?: KeelRule; error?: string } {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { error: 'a simple_rules entry must be an object' }
  }
  const r = candidate as Partial<SimpleRule>
  const label = typeof r.id === 'string' && r.id.trim() ? r.id : '<unnamed>'

  if (typeof r.id !== 'string' || !r.id.trim()) {
    return { error: `simple rule "${label}": missing a non-empty 'id'` }
  }
  if (typeof r.type !== 'string' || !SIMPLE_RULE_TYPES.has(r.type)) {
    return {
      error: `rule '${label}': 'type' must be one of command, filesystem, content, env, network (got: ${JSON.stringify(r.type)}) — for any other rule type, use the full rule format under 'rules:'`,
    }
  }
  if (typeof r.action !== 'string' || !r.action.trim()) {
    return { error: `rule '${label}': missing an 'action' (e.g. block, deny, warn, allow, prompt, fix)` }
  }
  if (!SIMPLE_RULE_VALID_ACTIONS.has(r.action)) {
    return { error: `rule '${label}': 'action' must be one of ${[...SIMPLE_RULE_VALID_ACTIONS].join(', ')} (got: ${JSON.stringify(r.action)})` }
  }
  if (typeof r.message !== 'string' || !r.message.trim()) {
    return { error: `rule '${label}': missing a non-empty 'message' explaining what this rule does` }
  }

  const type = r.type as SimpleRuleType
  const base: KeelRule = {
    id: r.id,
    type,
    action: r.action as EnforcementAction,
    message: r.message,
    level: DEFAULT_SIMPLE_RULE_LEVEL,
    context: DEFAULT_SIMPLE_RULE_CONTEXT,
  }

  switch (type) {
    case 'command': {
      if (typeof r.match !== 'string' && typeof r.match_regex !== 'string') {
        return { error: `rule '${label}': type 'command' requires a 'match' or 'match_regex' field (the command text or pattern to catch)` }
      }
      if (typeof r.match === 'string' && !r.match) return { error: `rule '${label}': 'match' cannot be empty` }
      if (typeof r.match_regex === 'string' && !r.match_regex) return { error: `rule '${label}': 'match_regex' cannot be empty` }
      if (typeof r.match === 'string') base.match = r.match
      if (typeof r.match_regex === 'string') base.match_regex = r.match_regex
      return { rule: base }
    }
    case 'network': {
      if (typeof r.match !== 'string' || !r.match.trim()) {
        return { error: `rule '${label}': type 'network' requires a 'match' field (the domain or pattern to catch)` }
      }
      base.match = r.match
      return { rule: base }
    }
    case 'filesystem': {
      if (!Array.isArray(r.paths) || r.paths.length === 0) {
        return { error: `rule '${label}': type 'filesystem' requires a non-empty 'paths' list (e.g. paths: ["**/.env"])` }
      }
      if (r.paths.some(p => typeof p !== 'string' || !p)) {
        return { error: `rule '${label}': every entry in 'paths' must be a non-empty string` }
      }
      base.paths = r.paths
      return { rule: base }
    }
    case 'content': {
      if (!Array.isArray(r.patterns) || r.patterns.length === 0) {
        return { error: `rule '${label}': type 'content' requires a non-empty 'patterns' list of regex strings (e.g. patterns: ["sk-[a-zA-Z0-9]+"])` }
      }
      if (r.patterns.some(p => typeof p !== 'string' || !p)) {
        return { error: `rule '${label}': every entry in 'patterns' must be a non-empty regex string` }
      }
      base.patterns = r.patterns.map(p => ({ regex: p }))
      return { rule: base }
    }
    case 'env': {
      if (!Array.isArray(r.vars) || r.vars.length === 0) {
        return { error: `rule '${label}': type 'env' requires a non-empty 'vars' list of environment variable names` }
      }
      if (r.vars.some(v => typeof v !== 'string' || !v)) {
        return { error: `rule '${label}': every entry in 'vars' must be a non-empty string` }
      }
      base.vars = r.vars
      return { rule: base }
    }
  }
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
    } else if (parsed && typeof parsed === 'object' && ('rules' in parsed || 'simple_rules' in parsed)) {
      // Direct rules object (standalone .keel.yaml or pure YAML) — a file
      // that declares ONLY `simple_rules:` (no full-form `rules:` at all)
      // must still be picked up here, or the minimal-form-only case falls
      // through to the "no config keys we recognize" branch below and
      // every simple_rules entry is silently dropped.
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

  // ── Minimal-form rules (`simple_rules:`) ──
  // Additive on top of the full-form `rules:` array: each entry is
  // translated by expandSimpleRule() into a full KeelRule and appended to
  // the rules list returned below, BEFORE validateRules() (called by every
  // hierarchy-tier consumer — see pipeline.ts) ever sees it. Downstream of
  // this function there is exactly one rule shape; nothing else needs to
  // know a rule started life as shorthand.
  const expandedSimpleRules: KeelRule[] = []
  if (config.simple_rules !== undefined) {
    if (!Array.isArray(config.simple_rules)) {
      errors.push('simple_rules must be an array')
    } else {
      for (const candidate of config.simple_rules) {
        const { rule, error } = expandSimpleRule(candidate)
        if (error) errors.push(error)
        else if (rule) expandedSimpleRules.push(rule)
      }
    }
  }

  return {
    config,
    rules: [...(Array.isArray(config.rules) ? config.rules : []), ...expandedSimpleRules],
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
  // `mask` was deliberately dropped from this set (and from EnforcementAction
  // in types.ts) rather than shipped perpetually declared-but-rejected: its
  // only plausible concrete meaning — redact matched sensitive content —
  // either duplicates what `fix` already does (rewrite the command's args
  // pre-execution, e.g. `fix: [{pattern, replace: '[REDACTED]'}]`) or would
  // need to rewrite TOOL OUTPUT after the fact, a channel this pipeline does
  // not have (opencode-plugin/src/plugin.ts's own `tool.execute.after`
  // comment: "the hook cannot inject tool results"). A rule author who wants
  // redaction should reach for `fix`; the generic action-unsupported check
  // below still fails closed on any leftover `action: mask` in a rules file.
  const validActions = new Set(['block', 'deny', 'warn', 'prompt', 'allow', 'fix', 'report', 'research', 'redirect'])
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
      ...(rule.unless || []).map(u => u.regex),
      // content-rule patterns: a typo'd regex here is worse than unless —
      // matchesRulePattern swallows a bad regex into `false` at eval, so the
      // rule loads clean and SILENTLY never matches (a quiet fail-OPEN: a
      // security rule that stops catching what it should). Reject at load.
      ...(rule.patterns || []).map(p => p.regex),
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
  // Delegates to the shared resolveHome() (KEEL_HOME > HOME > homedir()) so
  // this — the reader underlying nearly every command (daemon, rules,
  // status, dashboard, allow, promote, level, validate, suggest) and the
  // opencode plugin — agrees with `keel install` on where the global rule
  // tier lives. Originally this checked only `process.env.HOME ||
  // homedir()`: `HOME` is unset on Windows (the real user-home variable
  // there is `USERPROFILE`, or `HOMEDRIVE`+`HOMEPATH`), so every caller on
  // Windows fell back to the literal string `'~'`, which is not a path
  // `existsSync`/`readFileSync` ever resolves — the global rule tier
  // silently never loaded. resolveHome() preserves that HOME-before-
  // homedir() fallback (several CLI tests sandbox this exact lookup by
  // setting `process.env.HOME` to a scratch directory — fail-closed.test.ts,
  // install.test.ts, and others) while adding KEEL_HOME as the higher-
  // precedence override.
  const home = resolveHome()

  // Project-level: prefer .keel/rules.yaml, then AGENTS.md, then CLAUDE.md
  const projectRules =
    parseRulesFile(join(projectDir, '.keel', 'rules.yaml'))
    || parseRulesFile(join(projectDir, 'AGENTS.md'))
    || parseRulesFile(join(projectDir, 'CLAUDE.md'))

  // Local overrides: prefer .keel.local.yaml, then AGENTS.local.md, then CLAUDE.local.md
  const localRules =
    parseRulesFile(join(projectDir, '.keel.local.yaml'))
    || parseRulesFile(join(projectDir, 'AGENTS.local.md'))
    || parseRulesFile(join(projectDir, 'CLAUDE.local.md'))

  return {
    global: parseRulesFile(join(home, '.keel', 'rules.yaml'))
      || parseRulesFile(join(home, '.config', 'keel', 'rules.yaml')),
    user: parseRulesFile(join(home, '.config', 'keel', 'rules.yaml'))
      || null,
    project: projectRules,
    local: localRules,
  }
}

/**
 * Relative strength of an EnforcementAction, used only to decide whether a
 * more-specific-scope override of a `level: protect` floor rule TIGHTENS or
 * WEAKENS it (mergeRules' dedup loop, below). Higher = stronger
 * intervention. An explicit total order — every EnforcementAction has a
 * defined rank so the comparison never silently falls through to
 * `undefined`:
 *   deny/block (4, tied)   — stop the action outright
 *   > prompt (3)           — requires a human decision before proceeding
 *   > fix/redirect (2)     — actively intervenes, but the turn continues
 *   > warn (1)             — surfaces the issue, does not stop it
 *   > allow/report/research (0) — no intervention
 */
const ACTION_STRENGTH: Record<EnforcementAction, number> = {
  deny: 4, block: 4,
  prompt: 3,
  fix: 2, redirect: 2,
  warn: 1,
  allow: 0, report: 0, research: 0,
}

/**
 * Relative strength of a rule's `mode` (RuleMode — the enforcement axis,
 * independent of `action`; see types.ts's KeelRule.mode doc). Used only to
 * decide whether a more-specific-scope override of a `level: protect`
 * floor TIGHTENS or WEAKENS its effective enforcement (mergeRules' dedup
 * loop, below) — the second neutralization vector the ACTION_STRENGTH
 * check alone does not close: an override can keep `action: deny` +
 * `level: protect` and still silence the floor by adding `mode: observe`,
 * which short-circuits pipeline.ts's effectiveAction() to `allow` no
 * matter how strong the action is.
 *   block / undefined (2, tied) — strongest: fully enforcing (undefined
 *                                  `mode` IS enforcing — see RuleMode's
 *                                  doc comment; a floor with no `mode` at
 *                                  all must not be treated as weaker than
 *                                  one that spells out `mode: block`)
 *   > warn (1)                  — surfaced with escalation, not yet a hard
 *                                  block (see KeelRule.mode's doc comment)
 *   > observe (0)                — weakest: evaluated and recorded, never
 *                                  interrupts
 */
const MODE_STRENGTH: Record<RuleMode, number> = {
  block: 2,
  warn: 1,
  observe: 0,
}

function modeStrength(mode: RuleMode | undefined): number {
  return mode === undefined ? MODE_STRENGTH.block : MODE_STRENGTH[mode]
}

/**
 * Fields a lower-scope override of a `level: protect` floor may freely
 * change without being treated as a weakening: pure catalog metadata that
 * documents the rule but plays no role in whether or how it fires.
 * `action` and `mode` are handled by their own strength checks above, not
 * listed here; `level` and `scope` are checked/assigned separately by
 * mergeRules itself.
 */
const OVERRIDE_COSMETIC_FIELDS = new Set<keyof KeelRule>([
  'message', 'rationale', 'remediation', 'false_positives', 'review_by',
  'category', 'severity', 'confidence', 'maturity',
])

/** Handled by their own dedicated strength checks / dedup logic, not by the identical-surface comparison below. */
const OVERRIDE_STRENGTH_CHECKED_FIELDS = new Set<keyof KeelRule>(['action', 'mode', 'level', 'scope'])

/**
 * Whether a candidate override of a `level: protect` floor changes
 * anything about WHEN or HOW the floor fires, beyond action/mode (each
 * checked separately by ACTION_STRENGTH / MODE_STRENGTH above) and pure
 * catalog metadata (OVERRIDE_COSMETIC_FIELDS). This is the third
 * neutralization vector beyond action and mode: an override can keep
 * `action: deny` + `level: protect` + `mode: block` and still disable a
 * floor for the command it exists to catch by changing its matching
 * surface (`match`/`match_prefix`/`match_regex`/`paths`/`patterns`),
 * narrowing its scope (`exclude`, `operations`, `except`), retiming it
 * (`schedule`), swapping its check class (`type`), or reordering it below
 * a weaker rule that matches the same command and returns first
 * (`priority` — pipeline.ts's tier-2/3 loop is first-match-wins over the
 * full priority-sorted rule list, so a floor demoted below an unrelated
 * `action: warn` rule matching the same command never gets evaluated at
 * all on that call).
 *
 * Rather than enumerate every one of KeelRule's ~40 optional fields by
 * name (a list that silently rots every time a new rule type adds a
 * field), this compares by EXCLUSION: strip the cosmetic and
 * strength-checked fields from both rules and require the remainder to be
 * byte-identical (JSON.stringify). Anything not explicitly named as safe
 * to differ is therefore frozen by construction, including fields added
 * to KeelRule after this guard was written — the allowlist has to be
 * extended deliberately to loosen the guard; the freeze does not have to
 * be extended to keep catching a new field.
 *
 * There is no principled way to tell a legitimate narrowing (a project
 * genuinely needs a tighter regex, or a lower priority) from an
 * adversarial no-op from inside mergeRules alone — it has no notion of
 * "the same dangerous command" to test a candidate surface against. A
 * project that legitimately needs a different enforcement surface for a
 * floor should get keel's maintainers to change the shipped floor rule,
 * not shadow its id from a lower scope.
 */
function sameEnforcementSurface(existing: KeelRule, candidate: KeelRule): boolean {
  const strip = (rule: KeelRule): Partial<KeelRule> => {
    const copy: Partial<KeelRule> = { ...rule }
    for (const field of OVERRIDE_COSMETIC_FIELDS) delete copy[field]
    for (const field of OVERRIDE_STRENGTH_CHECKED_FIELDS) delete copy[field]
    return copy
  }
  return JSON.stringify(strip(existing)) === JSON.stringify(strip(candidate))
}

/**
 * Merge rules from hierarchy into a single flat list.
 * More specific scopes override less specific ones for same rule id —
 * UNLESS the existing rule is a `level: protect` floor and the override
 * would WEAKEN it on ANY of three independent axes:
 *   1. action   — drop `level: protect`, or pick a strictly weaker action
 *                 per ACTION_STRENGTH (e.g. deny -> warn).
 *   2. mode     — keep `level: protect` + the action, but add/loosen
 *                 `mode` per MODE_STRENGTH (e.g. add `mode: observe`,
 *                 which silently downgrades enforcement to allow —
 *                 pipeline.ts's effectiveAction()).
 *   3. surface  — keep `level: protect` + the action + the mode, but
 *                 change anything else that affects when/how the floor
 *                 fires (match/paths/patterns, exclude/operations/except,
 *                 schedule, type, priority — see sameEnforcementSurface's
 *                 doc comment for the full rationale and the exact
 *                 cosmetic-field allowlist).
 * A floor may only be tightened-or-tied on ALL THREE axes by a more
 * specific scope, or it is left alone; that is the entire point of
 * `level: protect` — no project or local file can quietly downgrade it
 * on any vector, not just the declared `action`. A weakening override is
 * simply skipped and the floor already in the map stands untouched (no
 * partial field-merging — the simplest correct rule). Non-floor rules
 * keep the original free-override behavior.
 *
 * A FOURTH axis lives outside the same-id dedup loop entirely: a
 * lower-scope config can add a rule under a brand-new, DIFFERENT id that
 * matches the same dangerous command as a floor, with a higher `priority`
 * and `action: allow` (or `warn`/`prompt`). Same-id dedup never sees it —
 * there is no collision to arbitrate — so it used to reach the merged
 * list untouched and, sorted by priority alone, land ahead of the floor.
 * pipeline.ts's tier-2/3 loop is first-match-wins over the full
 * priority-sorted list: the allow rule matched first and returned,
 * short-circuiting evaluate() before the floor was ever reached on that
 * call. See SECURITY.md's "different-id priority shadowing" note.
 *
 * Closed the same way sameEnforcementSurface treats a floor's OWN
 * `priority` field (see its doc comment): a floor is exempted from
 * priority-based ordering against anything that could actually pre-empt
 * it, rather than trusted to out-rank whatever a lower scope declares.
 * The final sort (below) puts every `level: protect` rule ahead of every
 * rule that could short-circuit it — not "give floors a very high
 * priority," which would still be a number a sufficiently motivated
 * config could try to beat — using three FIXED tiers (observe, floor,
 * everything else), not a pairwise "floor beats the other one"
 * comparator. A pairwise comparator was tried first and rejected: it is
 * intransitive whenever a `mode: observe` rule's priority sits between a
 * floor's and a shadowing rule's (floor 82 < observe 90 < shadow 999 by
 * priority, but floor is still forced ahead of shadow directly — a
 * cycle), which makes `Array.prototype.sort`'s actual output
 * implementation-defined rather than a real guarantee. See the sort's own
 * comment below for the full argument and the fixed-tier definitions.
 *
 * One deliberate exception inside that tiering: a non-floor rule with
 * `mode: observe` is NOT forced behind floors — it is put ahead of
 * everything, floors included. `mode: observe` is not merely a weak
 * action — pipeline.ts's `violation()` checks it FIRST, before the action
 * switch, for every rule type in the tiered loop, and on a match throws
 * OBSERVE_CONTINUE instead of returning: the match is recorded and
 * evaluation falls through to the next rule, no matter what `action` the
 * observe rule declares. It is therefore structurally incapable of
 * shadowing anything regardless of where it sorts, so evaluating it first
 * is free and guarantees it always gets to record — strictly stronger
 * than, and consistent with, the "regardless of priority or evaluation
 * order" observe guarantee this codebase already documents (see
 * pipeline.test.ts's observe-continue block and its "observe match no
 * longer blinds a later real deny rule" case). Every OTHER mode (`block`,
 * `warn`, undefined) reaches the normal action switch and CAN return a
 * definitive verdict, so it stays subject to the floor-first reorder like
 * any other non-floor rule.
 *
 * `priority` still governs the order WITHIN each tier, so this changes
 * nothing for a hierarchy with no floor AND no observe-mode rule
 * involved, and does not touch same-id override arbitration above.
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

  // Deduplicate: more specific scope wins for same rule id, but a
  // level:protect floor can only be tightened or tied, never weakened —
  // on action, mode, AND enforcement surface. See ACTION_STRENGTH,
  // MODE_STRENGTH, sameEnforcementSurface, and this function's doc comment.
  const scopeOrder: Record<string, number> = { global: 0, user: 1, project: 2, folder: 3, session: 4 }
  const deduped = new Map<string, KeelRule>()
  for (const rule of all) {
    const existing = deduped.get(rule.id)
    if (!existing) {
      deduped.set(rule.id, rule)
      continue
    }
    const moreSpecific = rule.scope && scopeOrder[rule.scope] > scopeOrder[existing.scope || 'global']
    if (!moreSpecific) continue
    if (existing.level === 'protect') {
      const actionOk = rule.level === 'protect' && ACTION_STRENGTH[rule.action] >= ACTION_STRENGTH[existing.action]
      const modeOk = modeStrength(rule.mode) >= modeStrength(existing.mode)
      const surfaceOk = sameEnforcementSurface(existing, rule)
      const tightensOrEqual = actionOk && modeOk && surfaceOk
      if (!tightensOrEqual) continue  // weakening override on some axis — keep the floor
    }
    deduped.set(rule.id, rule)
  }

  // Sort into three FIXED tiers, evaluated in this order regardless of
  // declared `priority`, then by priority (higher first) within a tier —
  // see this function's doc comment ("A FOURTH axis") for why a
  // priority-number contest between a floor and an arbitrary different-id
  // rule is not enough on its own.
  //   0. `mode: observe` — can never return a verdict (violation() checks
  //      this before the action switch, for every rule type, and throws
  //      OBSERVE_CONTINUE instead of returning), so evaluating it first is
  //      free: it always gets its chance to record before anything below
  //      it decides the call, matching the existing "regardless of
  //      priority or evaluation order" observe guarantee this codebase
  //      already documents (see pipeline.test.ts's observe-continue
  //      block) rather than merely tolerating it.
  //   1. `level: protect` floors (non-observe) — evaluated next, so
  //      nothing in tier 2 can return ahead of them.
  //   2. everything else.
  // A single two-way "floor beats the other one" comparator is NOT
  // sufficient here and was tried first: it compares floor-vs-observe and
  // observe-vs-regular by priority alone, which is intransitive whenever
  // an observe rule's priority sits between a floor's and a shadowing
  // rule's — e.g. floor(82) < observe(90) by priority, observe(90) <
  // shadow(999) by priority, but floor(82) is still forced ahead of
  // shadow(999) by the floor rule, producing shadow < floor < observe <
  // shadow: a cycle, which makes Array.prototype.sort's output
  // implementation-defined instead of a real guarantee. Fixed tiers avoid
  // this by construction: `rank(a) - rank(b)` alone is a strict total
  // order, so priority only ever breaks ties within one tier and never
  // re-opens a cross-tier comparison.
  const rank = (rule: KeelRule): number => {
    if (rule.mode === 'observe') return 0
    if (rule.level === 'protect') return 1
    return 2
  }
  return Array.from(deduped.values()).sort((a, b) => {
    const rankDiff = rank(a) - rank(b)
    if (rankDiff !== 0) return rankDiff
    return (b.priority || 0) - (a.priority || 0)
  })
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
