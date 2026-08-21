import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
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
  /**
   * Every file this ParsedRules' `rules` were actually assembled from:
   * `sourcePath` itself plus, when `extends:` is used, every file
   * resolved anywhere in its extends chain (recursively). Set by
   * resolveExtendsChain(); absent (`undefined`) for a ParsedRules built
   * by a bare parseRulesContent() call with no on-disk resolution (e.g.
   * the shipped DEFAULT_RULES_YAML constant, or a hand-built ParsedRules
   * in a test) — callers that care should fall back to `[sourcePath]` in
   * that case, which ruleFileSources() below does.
   *
   * Exists because `sourcePath` alone is no longer sufficient to detect
   * "did this tier's effective rules change": pipeline.ts's
   * computeRulesHash() (and the CLI's own ruleFingerprint()
   * implementations in daemon.ts/enforce.ts) used to hash each tier's
   * lone `sourcePath` to decide whether to reload. A tier whose rules.yaml
   * declares `extends:` now depends on files that are NOT `sourcePath` —
   * without this, editing an extended base file (tightening OR loosening
   * a rule) would never change the computed hash, and a long-lived
   * process (the daemon, primarily) would keep enforcing stale rules
   * indefinitely. See ruleFileSources() and computeRulesHash()'s own
   * comment in pipeline.ts.
   */
  composedFrom?: string[]
}

/**
 * Parse rules from a CLAUDE.md file with YAML frontmatter.
 * Also supports standalone .keel.yaml for global rules.
 */
export function parseRulesFile(filePath: string): ParsedRules | null {
  if (!existsSync(filePath)) return null

  const content = readFileSync(filePath, 'utf-8')
  const parsed = parseRulesContent(content, filePath)
  // `extends:` resolution happens here, not inside parseRulesContent —
  // extends targets are resolved relative to a real file's own directory
  // (dirname(filePath)), which a bare content+sourcePath call (e.g. the
  // synthetic 'keel:defaults' sourcePath used for the shipped default
  // rules — see daemon.ts/allow.ts) has no meaningful directory for. Every
  // real on-disk rules.yaml goes through parseRulesFile (loadRuleHierarchy,
  // level.ts, validate.ts, enforce.ts all call it directly), so this is the
  // one choke point that needs to resolve extends for the feature to work
  // across all 4 hierarchy tiers.
  return resolveExtendsChain(parsed, [filePath])
}

// ── Minimal / beginner-friendly rule format ──────────────────────────
//
// Defaults applied to every expanded SimpleRule. `level`, `context`, and
// `priority` are given a concrete value; `scope` and `mode` are
// deliberately left UNSET rather than defaulted to a literal:
//   - `scope` is inferred per-tier by mergeRules' pushRules()
//     (`rule.scope || scope`) from which hierarchy file the rule was
//     actually loaded from. Hardcoding e.g. `scope: 'project'` here would
//     silently mis-rank a simple rule authored in the GLOBAL or LOCAL tier
//     in the same-id override arbitration (scopeOrder in mergeRules) — a
//     SimpleRule must sort exactly like a hand-written full-form rule in
//     the same file, and that requires staying unset.
//   - `mode` has a well-defined "no value" semantics already (undefined
//     mode IS fully enforcing — see RuleMode's doc comment in types.ts)
//     that a beginner rule should inherit, not override.
//   - `priority` is NOT left unset. SimpleRule has no `priority` field at
//     all (see its doc comment in types.ts), so leaving this unset would
//     default every expanded rule to priority 0 in mergeRules' final sort
//     — see DEFAULT_SIMPLE_RULE_PRIORITY's own comment for why that is
//     unsafe (it silently out-ranks the shipped catalog's deliberately
//     negative-priority default rules).
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

// Default `priority` for every expanded SimpleRule: comfortably LOWER
// than the lowest priority used by any shipped default rule (currently -10,
// on `no-repeat-loops`/`research-before-fix`/`root-cause-before-refactor`;
// `secret-file-read-without-egress`/`broad-privilege-escalation` sit at -5
// — all in install.ts, all deliberately negative so they sort LAST and
// never shadow a more specific rule ahead of them). SimpleRule has no
// `priority` field (see its doc comment in types.ts), so without an
// explicit default here every simple-form rule would fall through to
// priority 0 in mergeRules' final sort — HIGHER than those deliberately-
// deferred defaults. Since pipeline.ts's tier-2/3 loop is first-match-wins
// over the full priority-sorted rule list, a broad `simple_rules:` command
// rule (e.g. matching `cat |less |head |tail `) would then silently
// out-rank and shadow a curated, narrower, negative-priority default like
// `secret-file-read-without-egress` for every command matching both — with
// the simple-rule author having no way to know or avoid it, since the
// minimal form doesn't expose a `priority` field to set even if they
// wanted to defer. -100 sits well below -10 with headroom for any future
// shipped default: simple-form rules defer to the curated catalog by
// design, unless a future version of the format adds an explicit way to
// opt into a higher priority. See docs/custom-rules.md's "What you get for
// free" section for the user-facing explanation.
const DEFAULT_SIMPLE_RULE_PRIORITY = -100

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
    priority: DEFAULT_SIMPLE_RULE_PRIORITY,
  }

  switch (type) {
    case 'command': {
      if (typeof r.match !== 'string' && typeof r.match_regex !== 'string') {
        return { error: `rule '${label}': type 'command' requires a 'match' or 'match_regex' field (the command text or pattern to catch)` }
      }
      // `.trim()`-based, not a bare falsy check: a whitespace-only `match: "
      // "` is a non-empty STRING (falsy checks like `!r.match` let it
      // through), and `new RegExp(' ').test(...)` matches almost any
      // command — a quoted-whitespace typo becomes a rule that silently
      // shadows everything else. Mirrors the `network` case below, which
      // already gets this right.
      if (typeof r.match === 'string' && !r.match.trim()) return { error: `rule '${label}': 'match' cannot be empty` }
      if (typeof r.match_regex === 'string' && !r.match_regex.trim()) return { error: `rule '${label}': 'match_regex' cannot be empty` }
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
    } else if (parsed && typeof parsed === 'object' && ('rules' in parsed || 'simple_rules' in parsed || 'extends' in parsed)) {
      // Direct rules object (standalone .keel.yaml or pure YAML) — a file
      // that declares ONLY `simple_rules:` (no full-form `rules:` at all)
      // must still be picked up here, or the minimal-form-only case falls
      // through to the "no config keys we recognize" branch below and
      // every simple_rules entry is silently dropped. Same reasoning for
      // `extends:`: a file that ONLY extends a base (adding no rules of
      // its own — e.g. a thin per-project pointer at a shared org policy,
      // or an intermediate link in a longer chain) has neither `rules`
      // nor `simple_rules`, and without this arm its `extends` field (and
      // everything else in `config`, including `level`) would silently
      // fall through to the untouched `{ version: 1 }` default below —
      // extends resolution would just never run, with no error at all.
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
  if (config.extends !== undefined) {
    const extendsList = Array.isArray(config.extends) ? config.extends : [config.extends]
    if (extendsList.length === 0 || extendsList.some(p => typeof p !== 'string' || !p.trim())) {
      errors.push('extends must be a non-empty path string or a non-empty array of non-empty path strings')
    }
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

/**
 * Duplicate rule ids within a single flat rule array. Shared by
 * validateRules() (a duplicate id within ONE physically-parsed file's own
 * `rules:` list is always a copy-paste mistake) and resolveExtendsChain()
 * below, which runs this on each individual file's own rules BEFORE that
 * file gets folded into a cross-file extends merge — where a repeated id
 * across DIFFERENT files is the whole point (an intentional override), not
 * a bug, and must not be flagged the same way.
 */
function findDuplicateRuleIds(rules: unknown[]): string[] {
  const ids = rules.map(rule => typeof (rule as Partial<KeelRule>)?.id === 'string' ? (rule as Partial<KeelRule>).id as string : '')
  const seen = new Set<string>()
  const dups = new Set<string>()
  for (const id of ids) {
    if (id && seen.has(id)) dups.add(id)
    seen.add(id)
  }
  return [...dups]
}

export function validateRules(rules: unknown): string[] {
  const errors: string[] = []
  if (!Array.isArray(rules)) return ['Rules must be an array']

  const validTypes = new Set([
    'command', 'filesystem', 'content', 'env', 'network', 'rate', 'time',
    'sequence', 'flow', 'mcp', 'session', 'inheritance', 'context',
    'verification', 'meta', 'research', 'stuck', 'diagnosis', 'claim', 'oracle', 'package',
    'budget', 'oscillation',
  ])
  // `mask` (a rule-authorable `action: mask`) stays deliberately absent from
  // this set. CORRECTION (sprint/lane-c2): the previous version of this
  // comment additionally claimed that rewriting TOOL OUTPUT after the fact
  // was "a channel this pipeline does not have," citing opencode-plugin's
  // `tool.execute.after` "the hook cannot inject tool results" comment. That
  // citation is about something else (the BEFORE-hook's `redirect` action
  // cannot fabricate a fake tool RESULT for a call it interrupts) and the
  // output-rewrite claim was never actually tested. It has since been live-
  // tested and found FALSE for OpenCode specifically: mutating
  // `tool.execute.after`'s `output.output`/`output.metadata` really does
  // rewrite what the model receives, not just the terminal rendering — see
  // session/transcripts/opencode-tool-execute-after-mutation-probe.txt and
  // `EnforcementPipeline.evaluateOutput()` (pipeline.ts), which reuses these
  // same `type: content` patterns against captured tool output. `mask`
  // STILL isn't added here, though, for a narrower and still-true reason:
  // the mutation only actually reaches the model on ONE host (OpenCode)
  // today — Claude Code's PostToolUse can only inject `additionalContext`
  // (a warning the model sees alongside the original text, not a rewrite of
  // it), and Cursor/Codex/Gemini/Cline/generic have no post-hoc output
  // channel confirmed at all. A rule author writing `action: mask` in
  // rules.yaml would get real redaction on OpenCode and a silent no-op
  // everywhere else — exactly the "declared-but-inconsistent" trap this
  // comment originally existed to avoid, just for a different reason than
  // before. A rule author who wants redaction should still reach for `fix`
  // (pre-execution, args-only, host-independent); the generic action-
  // unsupported check below still fails closed on any leftover
  // `action: mask` in a rules file. `redact` is a real value now — see
  // EnforcementAction in types.ts — but it is pipeline-emitted only
  // (`evaluateOutput()`'s own result), never a rule's `action:` field, and
  // is deliberately left out of this Set for that reason.
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
  const validScopes = new Set(['global', 'user', 'project', 'folder', 'session'])
  const validRuleContexts = new Set(['local', 'ci', 'both'])
  // Declared in the type system but with no handler in the enforcement
  // pipeline — accepting them silently gave users a false sense of security.
  //
  // `type: session` was previously in this set (see git history for the
  // full investigation: pipeline.ts used to have a `continue`-only stub
  // at its old `max_duration_minutes` branch, "handled by context manager"
  // — aspirational, not actual, and context-manager.ts is unrelated
  // token-usage re-injection). It now has a REAL handler — a composite
  // runaway-loop trip across five session-scoped dimensions
  // (`session-runaway-trip`, install.ts) — see pipeline.ts's session-trip
  // branch (`rule.type === 'session'`), session-tracker.ts, and
  // session-store.ts. The old `max_duration_minutes` field is gone;
  // `session_escalation` (types.ts) is the only spelling now. `mcp` /
  // `inheritance` / `meta` / `context` remain genuinely unimplemented and
  // stay in this Set. SPEC.md's tables were updated in the same change
  // that flipped this — see its "Public v1 Release Contract" table and its
  // per-type reference table.
  const notImplemented = new Set(['mcp', 'inheritance', 'meta', 'context'])

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
    if (rule.type === 'session') {
      if (!rule.session_escalation?.length) {
        errors.push(`Session rule "${label}" needs at least one session_escalation entry — without one it can never fire, the exact "declared but inert" shape this type used to have`)
      } else {
        const validDimensions = new Set(['duration_minutes', 'tool_calls', 'bash_calls', 'file_write_churn', 'consecutive_failures'])
        const validStepActions = new Set(['warn', 'prompt', 'deny', 'block'])
        for (const [i, step] of rule.session_escalation.entries()) {
          if (!step || typeof step !== 'object') {
            errors.push(`Session rule "${label}" session_escalation[${i}] must be an object`)
            continue
          }
          if (!validDimensions.has(String(step.dimension))) {
            errors.push(`Session rule "${label}" session_escalation[${i}] has an unsupported dimension: ${String(step.dimension)}`)
          }
          if (typeof step.at !== 'number' || !(step.at > 0)) {
            errors.push(`Session rule "${label}" session_escalation[${i}] needs a positive numeric "at" threshold`)
          }
          if (!validStepActions.has(String(step.action))) {
            errors.push(`Session rule "${label}" session_escalation[${i}] has an unsupported action: ${String(step.action)} (expected warn, prompt, deny, or block)`)
          }
          // SAFETY-CRITICAL (see types.ts's session_escalation doc comment
          // and session-tracker.ts's header): a pure VOLUME dimension —
          // everything except consecutive_failures — must never be able to
          // deny/block, and must never carry `halt: true`. Only a
          // repeated-FAILURE streak (reset on any success) may escalate
          // that far. This is enforced HERE, structurally, rather than left
          // as an authoring convention, so a rules.yaml that gets this
          // backwards is rejected at `keel validate` instead of silently
          // shipping a false-positive-prone halt trigger.
          if (step.dimension !== 'consecutive_failures') {
            if (step.action === 'deny' || step.action === 'block') {
              errors.push(`Session rule "${label}" session_escalation[${i}]: dimension "${String(step.dimension)}" is a volume-only counter and must not escalate past "prompt" — action "${step.action}" is only allowed on "consecutive_failures"`)
            }
            if (step.halt) {
              errors.push(`Session rule "${label}" session_escalation[${i}]: "halt: true" is only allowed on a "consecutive_failures" step — volume-only dimensions must never trip keel halt`)
            }
          }
        }
      }
    }
    if (rule.type === 'budget' && rule.max_tokens === undefined && rule.max_dollars === undefined) {
      errors.push(`Budget rule "${label}" needs max_tokens or max_dollars — remove it or add a spend ceiling`)
    }
    if (rule.type === 'oscillation') {
      if (rule.min_cycle_length !== undefined && (typeof rule.min_cycle_length !== 'number' || rule.min_cycle_length < 2)) {
        errors.push(`Oscillation rule "${label}" has an invalid min_cycle_length (must be a number >= 2 — a length-1 "cycle" is exact repetition, type: stuck's territory)`)
      }
      if (rule.max_cycle_length !== undefined && (typeof rule.max_cycle_length !== 'number' || rule.max_cycle_length < (rule.min_cycle_length ?? 2))) {
        errors.push(`Oscillation rule "${label}" has an invalid max_cycle_length (must be a number >= min_cycle_length)`)
      }
      if (rule.min_cycle_repeats !== undefined && (typeof rule.min_cycle_repeats !== 'number' || rule.min_cycle_repeats < 2)) {
        errors.push(`Oscillation rule "${label}" has an invalid min_cycle_repeats (must be a number >= 2 — A→B→A→B is the minimum evidence of a cycle)`)
      }
      if (rule.oscillation_window_size !== undefined && (typeof rule.oscillation_window_size !== 'number' || rule.oscillation_window_size < 4)) {
        errors.push(`Oscillation rule "${label}" has an invalid oscillation_window_size (must be a number >= 4 — too small to ever hold two repeats of even the shortest cycle)`)
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
    // `scope` and `context` are load-bearing in mergeRules (scopeOrder[]
    // and the context filter, both in this file) but previously had no
    // validation at all. A typo'd `scope` makes `scopeOrder[rule.scope]`
    // `undefined`, and `undefined > scopeOrder['global']` is `false` in
    // JS — so a typo'd global-tier rule becomes PERMANENTLY immune to
    // being overridden by a more-specific tier, with zero error surfaced.
    // A typo'd `context` entry makes the rule fail the context filter in
    // every possible evaluation context — it never gets pushed at all,
    // ever, again silently.
    if (rule.scope !== undefined && (typeof rule.scope !== 'string' || !validScopes.has(rule.scope))) {
      errors.push(`Rule "${label}" has an unsupported scope: ${String(rule.scope)} (expected one of ${[...validScopes].join(', ')})`)
    }
    if (rule.context !== undefined) {
      if (!Array.isArray(rule.context) || rule.context.length === 0 || rule.context.some(c => typeof c !== 'string' || !validRuleContexts.has(c))) {
        errors.push(`Rule "${label}" has an invalid context: ${JSON.stringify(rule.context)} (expected a non-empty array of local, ci, both)`)
      }
    }
    if (typeof rule.message !== 'string' || !rule.message.trim()) errors.push(`Rule "${label}" is missing a non-empty message`)
    if (rule.type === 'filesystem' && (!Array.isArray(rule.paths) || rule.paths.length === 0)) errors.push(`Rule "${label}" is a filesystem rule but has no paths`)
    if (rule.type === 'content' && (!Array.isArray(rule.patterns) || rule.patterns.length === 0)) errors.push(`Rule "${label}" is a content rule but has no patterns`)
    if (rule.type === 'network' && typeof rule.match !== 'string') errors.push(`Rule "${label}" is a network rule but has no match`)
    // pipeline.ts (~line 724) gates its entire command-matching block on
    // `rule.type === 'command' && (rule.match || rule.match_regex ||
    // rule.match_prefix)`. Without this check a full-form `type: command`
    // rule with none of those three fields set passes validation cleanly
    // and is a permanent, silent no-op at evaluation — it can never match
    // anything, ever, with no error surfaced.
    if (rule.type === 'command' && !rule.match && !rule.match_regex && !rule.match_prefix) {
      errors.push(`Rule "${label}" is a command rule but has no match, match_regex, or match_prefix`)
    }
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
      // `topics` (research rules) is read as regex via
      // matchesRulePattern() in pipeline.ts (~line 1002), and
      // `fallback_pattern` (diagnosis rules) likewise (~line 958). Both
      // were previously missing from this loop: a malformed regex in
      // either field passed validation, then matchesRulePattern() silently
      // caught the construction error and returned false — the exact
      // quiet fail-open this loop's own comment above already warns about
      // for `patterns`.
      ...(rule.topics || []),
      rule.fallback_pattern,
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
  const dups = findDuplicateRuleIds(rules)
  if (dups.length) errors.push(`Duplicate rule id(s) in the same file: ${dups.join(', ')}`)

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
  // `redact` is never a rule's `action:` field (validActions above
  // deliberately excludes it — see that Set's comment) — this entry exists
  // only so `Record<EnforcementAction, number>` type-checks as total.
  // Ranked with fix/redirect for the same reason they are: it actively
  // intervenes (rewrites output) but never stops the turn.
  redact: 2,
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
 * Whether `candidate` tightens-or-ties `existing` on all three axes a
 * `level: protect` floor must never be weakened on — action
 * (ACTION_STRENGTH), mode (MODE_STRENGTH via modeStrength), and
 * enforcement surface (sameEnforcementSurface). Always true when
 * `existing` is not itself a floor (nothing to protect).
 *
 * The SINGLE shared implementation of this check: mergeRules' own same-id
 * dedup loop (below, for cross-SCOPE overrides across the global/user/
 * project/local hierarchy) and resolveExtendsChain's applyExtendsOverrides
 * (for same-id overrides introduced via `extends:`) both call this rather
 * than each maintaining their own copy of the tightening logic — the two
 * callers differ only in what they DO with a `false` result (mergeRules
 * silently keeps the floor and drops the weakening override; extends
 * treats it as a load-time error — see resolveExtendsChain's doc comment
 * for why).
 */
function floorTightensOrEqual(existing: KeelRule, candidate: KeelRule): boolean {
  if (existing.level !== 'protect') return true
  const actionOk = candidate.level === 'protect' && ACTION_STRENGTH[candidate.action] >= ACTION_STRENGTH[existing.action]
  const modeOk = modeStrength(candidate.mode) >= modeStrength(existing.mode)
  const surfaceOk = sameEnforcementSurface(existing, candidate)
  return actionOk && modeOk && surfaceOk
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
  // on action, mode, AND enforcement surface. See floorTightensOrEqual
  // (ACTION_STRENGTH, MODE_STRENGTH, sameEnforcementSurface) and this
  // function's doc comment.
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
    if (!floorTightensOrEqual(existing, rule)) continue  // weakening override on some axis — keep the floor
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

// ── extends: rule composition ─────────────────────────────────────────
//
// A rules.yaml (or CLAUDE.md/AGENTS.md frontmatter) may declare
// `extends:` — see KeelConfig.extends' doc comment in types.ts for the
// schema. This is a WITHIN-tier composition mechanism, resolved entirely
// by parseRulesFile() BEFORE loadRuleHierarchy's own 4-tier
// (global/user/project/local) merge ever sees the result — mergeRules
// above has no awareness that a tier's rules came from more than one
// physical file.

/**
 * Generous headroom over any real base-policy chain (a team's own
 * global -> org -> department chain is unlikely to exceed a handful of
 * links), while still failing loudly on a runaway or accidentally very
 * long chain. Belt-and-suspenders alongside the `chain.includes(...)`
 * cycle check below: that check catches a TRUE cycle (A ends up back at
 * a path already in the chain) by identity, which this depth cap does not
 * replace — it exists for the non-cyclic case where every step resolves
 * to a new path but the chain never terminates because it is symlinked
 * (or otherwise regenerated) arbitrarily deep.
 */
const MAX_EXTENDS_DEPTH = 10

/**
 * Layer `overrides` on top of `base` by rule id: a new id is appended, a
 * repeated id replaces the base entry — UNLESS the base entry is a
 * `level: protect` floor and the override would weaken it on any of the
 * three axes floorTightensOrEqual checks (action, mode, or enforcement
 * surface), in which case the base entry is kept AS-IS and a load-time
 * error is recorded naming the rule id and the overriding file.
 *
 * This is the one deliberate divergence from mergeRules' own same-id
 * dedup (which silently keeps the stronger floor and drops a weakening
 * override with no error at all — see mergeRules' doc comment). That
 * silence is correct there: a lower-SCOPE override may come from a
 * project or local file whose author never consciously chose to combine
 * with the global floor, and may not even know it exists — nothing was
 * "decided" that needs surfacing.
 *
 * `extends:` is different: both files were deliberately linked by the
 * SAME author's own `extends:` line. Silently keeping the floor there
 * would hide a real authoring mistake — "I edited my project's rules.yaml
 * to weaken an inherited rule and it just silently didn't take" — from
 * exactly the person positioned to notice and fix it. So this pushes a
 * loud, explicit error into `errors` instead (the same `ParsedRules.errors`
 * channel every other parse failure already uses — see validate.ts,
 * level.ts, status.ts, dashboard.ts, enforce.ts, daemon.ts, all of which
 * already surface it). Concretely, that error flows into
 * pipeline.ts's checkRuleVersion() "last known good" fail-closed reload
 * path: a hierarchy reload that comes back with any errors is rejected
 * wholesale and the previous valid hierarchy keeps enforcing — so an
 * extends edit that would weaken an inherited floor never actually takes
 * effect, it just gets loudly rejected instead of silently no-op'd.
 *
 * CAVEAT inherited from floorTightensOrEqual's surface check
 * (sameEnforcementSurface): it compares by `JSON.stringify`, which is
 * key-INSERTION-ORDER sensitive. Two floor definitions that are
 * semantically identical but list their fields in a different order
 * (e.g. `type` before `match` in one file, after in the other) will read
 * as a surface MISMATCH and trigger this error even though nothing was
 * actually weakened. This is a pre-existing characteristic of
 * sameEnforcementSurface (mergeRules' own scope-based dedup has the same
 * false-positive potential, it just fails silently there instead of
 * loudly) — not something extends introduces, but extends turns it into a
 * user-visible error message instead of a silent drop, so it is worth
 * knowing about here specifically. See the "reordered keys" test in
 * rule-parser.test.ts for the exact observed behavior.
 */
function applyExtendsOverrides(base: KeelRule[], overrides: KeelRule[], errors: string[], overridingSource: string): KeelRule[] {
  const merged = new Map<string, KeelRule>(base.map(rule => [rule.id, rule]))
  for (const rule of overrides) {
    const existing = merged.get(rule.id)
    if (existing && existing.level === 'protect' && !floorTightensOrEqual(existing, rule)) {
      errors.push(
        `Rule "${rule.id}" in "${overridingSource}" attempts to weaken a level:protect floor inherited via extends `
        + `(inherited action: ${existing.action}${existing.mode ? `, mode: ${existing.mode}` : ''}) — `
        + `a protect floor can only be tightened or left as-is across extends, never weakened, on action, mode, or `
        + `match/scope surface. The inherited floor was kept; fix or remove the override in "${overridingSource}".`,
      )
      continue  // keep the existing (stronger) floor rule untouched
    }
    merged.set(rule.id, rule)
  }
  return [...merged.values()]
}

/**
 * Resolve one file's `extends:` chain into a single flat, fully-merged
 * `ParsedRules`. `parsed` is the already-parsed target file (own rules +
 * own config); `chain` is the resolved absolute paths of every file
 * already visited on the path down to `parsed`, `filePath` included —
 * used to detect a cycle (a path re-appearing in `chain`) and to enforce
 * MAX_EXTENDS_DEPTH.
 *
 * Resolution order for `extends: [a, b]` declared in file F: resolve(a),
 * then resolve(b) layered on top (b overrides a on same-id collision),
 * then F's own rules layered on top of both. A chain (F extends a, a
 * itself extends g) is resolved recursively the same way — each base is
 * fully self-resolved (including ITS OWN extends) before F's rules are
 * ever applied, so a protect-floor weakening is caught at whichever link
 * in the chain it is actually introduced, not just at the leaf.
 *
 * Same-id collisions are arbitrated by applyExtendsOverrides(), which
 * reuses floorTightensOrEqual — the EXACT tightening-only logic
 * mergeRules' own dedup loop uses, not a parallel reimplementation.
 */
function resolveExtendsChain(parsed: ParsedRules, chain: string[]): ParsedRules {
  const errors = [...(parsed.errors || [])]

  const ownDupes = findDuplicateRuleIds(parsed.rules)
  if (ownDupes.length) errors.push(`Duplicate rule id(s) in the same file: ${ownDupes.join(', ')} (${parsed.sourcePath})`)

  const raw = parsed.config.extends
  const extendsList = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]

  // Every file this ParsedRules' final `rules` actually depend on —
  // itself plus every extends target resolved below, recursively. See
  // ParsedRules.composedFrom's doc comment for why this has to be tracked
  // explicitly rather than just `sourcePath`.
  const composed = new Set<string>([parsed.sourcePath])

  let baseRules: KeelRule[] = []
  for (const entry of extendsList) {
    // Malformed shape (non-string / empty) was already flagged by
    // parseRulesContent's own `extends` validation — skip quietly here
    // rather than double-erroring on the same problem.
    if (typeof entry !== 'string' || !entry.trim()) continue

    const resolvedPath = resolve(dirname(parsed.sourcePath), entry)

    if (chain.includes(resolvedPath)) {
      errors.push(`Circular extends: "${parsed.sourcePath}" extends "${entry}" (${resolvedPath}), which is already in this extends chain: ${[...chain, resolvedPath].join(' -> ')}`)
      continue
    }
    if (chain.length >= MAX_EXTENDS_DEPTH) {
      errors.push(`"${parsed.sourcePath}" extends "${entry}": extends chain exceeds the maximum depth of ${MAX_EXTENDS_DEPTH} — check for an unintended long or circular chain`)
      continue
    }
    if (!existsSync(resolvedPath)) {
      errors.push(`"${parsed.sourcePath}" extends "${entry}", which does not exist (resolved to ${resolvedPath})`)
      continue
    }

    // `existsSync` is true for a directory too, and readFileSync throws
    // (EISDIR, or EACCES on a permissions-denied file) rather than
    // returning content — unlike parseRulesFile's own top-level read,
    // whose paths are all keel-constructed hierarchy locations, `entry`
    // here is an arbitrary user-authored string. A mistyped `extends:
    // ../shared` pointing at a directory, or a file this process can't
    // read, must produce the same clear load-time error every other
    // extends failure does, not an uncaught exception that takes down
    // `keel hook`/the daemon.
    let baseContent: string
    try {
      baseContent = readFileSync(resolvedPath, 'utf-8')
    } catch (error) {
      errors.push(`"${parsed.sourcePath}" extends "${entry}" (resolved to ${resolvedPath}), which could not be read: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const baseParsed = resolveExtendsChain(parseRulesContent(baseContent, resolvedPath), [...chain, resolvedPath])
    errors.push(...(baseParsed.errors || []))
    for (const source of baseParsed.composedFrom ?? [resolvedPath]) composed.add(source)
    baseRules = applyExtendsOverrides(baseRules, baseParsed.rules, errors, resolvedPath)
  }

  const finalRules = applyExtendsOverrides(baseRules, parsed.rules, errors, parsed.sourcePath)

  return {
    ...parsed,
    rules: finalRules,
    composedFrom: [...composed],
    ...(errors.length ? { errors } : {}),
  }
}

/**
 * Every file a ParsedRules' `rules` were actually composed from:
 * `composedFrom` when it was resolved via resolveExtendsChain (which sets
 * it unconditionally, even with no `extends:` — just `[sourcePath]` in
 * that case), or `[sourcePath]` alone for a ParsedRules that never went
 * through that resolution (a bare parseRulesContent() call — the shipped
 * DEFAULT_RULES_YAML in daemon.ts/allow.ts, or a hand-built ParsedRules in
 * a test). Callers that need to detect "did this tier's effective rules
 * change" — pipeline.ts's computeRulesHash(), and the CLI's own
 * ruleFingerprint() implementations in daemon.ts/enforce.ts — must hash
 * every path this returns, not just `sourcePath`, or an edit to an
 * extended base file silently never invalidates the cache. Null-safe:
 * returns `[]` for a missing tier.
 */
export function ruleFileSources(parsed: ParsedRules | null | undefined): string[] {
  if (!parsed) return []
  return parsed.composedFrom ?? [parsed.sourcePath]
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
