// ── Core enforcement primitive ──────────────────────────────────────

export type ProtectionLevel = 'sprint' | 'balanced' | 'protect'

export type RuleScope = 'global' | 'user' | 'project' | 'folder' | 'session'

export type RuleContext = 'local' | 'ci' | 'both'

export type EnforcementDepth = 'fast' | 'full' | 'deep'

// `mask` (redact matched content, as a rule-authorable `action:` value) is
// still deliberately absent from rule-parser.ts's `validActions` — see that
// comment for the current reasoning. CORRECTION (sprint/lane-c2): the
// earlier version of that comment claimed the underlying capability itself
// — rewriting a tool's own output after it runs — was a channel keel does
// not have at all, citing opencode-plugin's `tool.execute.after` "the hook
// cannot inject tool results" comment. That citation is about a DIFFERENT
// thing (the before-hook's `redirect` action cannot fabricate a fake tool
// RESULT to stand in for a call it interrupts) and was never actually
// tested for the after-hook's own output-mutation capability. It has now
// been live-tested and confirmed real for OpenCode specifically: mutating
// `tool.execute.after`'s `output.output`/`output.metadata` fields
// rewrites what the MODEL receives, not just what the terminal renders —
// see session/transcripts/opencode-tool-execute-after-mutation-probe.txt
// and docs/exfil.md's "Output redaction" section. `'redact'` below is that
// capability's result-side vocabulary: distinct from `'redirect'`, and
// deliberately still NOT added to rule-parser.ts's validActions — it is
// never a rule author's `action:` choice, only a verdict
// `EnforcementPipeline.evaluateOutput()` can itself return, because the
// mutation only actually reaches the model on one host (OpenCode) today;
// making it rule-authorable would silently be a no-op everywhere else.
export type EnforcementAction = 'block' | 'deny' | 'warn' | 'prompt' | 'allow' | 'fix' | 'report' | 'research' | 'redirect' | 'redact'

export type RuleType =
  | 'command' | 'filesystem' | 'content' | 'env' | 'network'
  | 'rate' | 'time' | 'sequence' | 'flow' | 'mcp'
  | 'session' | 'inheritance' | 'context' | 'verification' | 'meta'
  | 'research' | 'stuck' | 'diagnosis' | 'claim' | 'oracle' | 'package'
  | 'budget' | 'oscillation'

// ── Keel configuration (YAML frontmatter in CLAUDE.md) ──────────────

export interface KeelConfig {
  version: number
  level?: ProtectionLevel
  /**
   * One or more other rules.yaml (or CLAUDE.md/AGENTS.md frontmatter)
   * files this file builds on — a single path or a list, resolved
   * relative to THIS file's own directory (not cwd, not the leaf file
   * ultimately being loaded). Extended files are parsed and merged in
   * list order BEFORE this file's own `rules:`/`simple_rules:`, so this
   * file can override a base policy by id. A base file may itself
   * declare `extends`, forming a chain — resolved recursively by
   * enforce/rule-parser.ts's resolveExtendsChain(), which also detects
   * circular chains and enforces a max depth.
   *
   * This is a WITHIN-tier composition mechanism, distinct from keel's
   * existing 4-tier global/user/project/local hierarchy (see
   * loadRuleHierarchy in enforce/rule-parser.ts): `extends` lets any
   * single file in any one of those tiers share a base policy with other
   * files, resolved entirely before that tier's rules enter the 4-tier
   * merge. A same-id override that would WEAKEN a `level: protect` floor
   * inherited via `extends` is refused with a load-time error rather than
   * silently resolved — see resolveExtendsChain's doc comment for why
   * this deliberately differs from the 4-tier hierarchy's own same-id
   * dedup (mergeRules), which silently keeps the stronger floor instead.
   */
  extends?: string | string[]
  rules?: KeelRule[]
  /**
   * Minimal/beginner-friendly rule entries — the "bring your own rule"
   * on-ramp that replaced an earlier Rego/WASM policy-engine idea (the
   * team decided a simple YAML shorthand was the better story than asking
   * users to learn Rego). Each entry is a `SimpleRule`: id + type + one
   * match-condition field appropriate to `type` + action + message, with
   * everything else defaulted. Translated into full `KeelRule` objects by
   * `expandSimpleRule()` (enforce/rule-parser.ts) inside
   * `parseRulesContent()`, BEFORE `validateRules()` ever runs — by the
   * time any other code sees a rule, it came from `rules`, whether or not
   * it was authored there. This field is purely additive: `rules` keeps
   * working exactly as before, and a rules file needs neither field to be
   * valid.
   */
  simple_rules?: SimpleRule[]
  cache?: CacheConfig
  re_injection?: ReInjectionConfig
  /**
   * When `level: sprint` was last set via `keel level sprint` (ISO 8601).
   * Written by the CLI's comment-preserving level writer; a hand-edited
   * `level: sprint` with no timestamp never auto-expires. Paired with
   * `sprint_expiry_hours`.
   */
  sprint_started_at?: string
  /**
   * Hours a `level: sprint` dial stays in effect before the EFFECTIVE
   * level (read fresh from this config on every load — no daemon) reverts
   * to balanced. Default 4; 0 disables auto-expiry. Timeout-only — there
   * is deliberately no session-end detection.
   */
  sprint_expiry_hours?: number
  /**
   * False-positive threshold (would-block count ÷ total evaluations) below
   * which `keel retrospective`'s promotion section recommends a `mode:
   * observe` rule as eligible for promotion to `warn`. Default 0.001 (1 per
   * 1000 evaluations) — read fresh from whichever rules.yaml wins
   * precedence (project over global, mirroring `level`), never hardcoded
   * per-rule. See enforce/rule-parser.ts's DEFAULT_PROMOTION_FP_THRESHOLD.
   */
  promotion_fp_threshold?: number
}

/**
 * Enforcement state, orthogonal to the rule's declared `action`.
 * observe → evaluated and recorded, never interrupts (the burn-in state)
 * warn    → surfaced, transient; escalates on repeat
 * block   → enforced at the declared action
 */
export type RuleMode = 'observe' | 'warn' | 'block'

export type RuleCategory =
  | 'destructive' | 'exfil' | 'escalation' | 'injection'
  | 'resource' | 'bypass' | 'discipline' | 'workflow' | 'verification' | 'supply-chain'

export interface KeelRule {
  id: string
  type: RuleType
  level?: ProtectionLevel           // sprint | balanced | protect — when is this rule active
  scope?: RuleScope                 // where in the hierarchy this rule applies
  context?: RuleContext[]           // local | ci | both
  action: EnforcementAction
  message: string
  priority?: number                 // higher = evaluated first

  // ── Catalog metadata (all optional; existing rules keep working) ──
  //
  // `severity` and `confidence` are deliberately SEPARATE axes, following
  // Semgrep and Falco. Severity is "how bad if the rule is right";
  // confidence is "how sure the check is correct". One field cannot
  // express both, and conflating them is why catalogs end up either noisy
  // or toothless: a low-confidence critical rule belongs in observe, while
  // a high-confidence low-severity rule can safely block.
  //
  // `mode` is the enforcement axis, independent of `action`. A rule can
  // declare `action: deny` while sitting in `mode: observe` — it evaluates
  // and is recorded, but never interrupts. That is how a new rule earns
  // its way to blocking (Cloudflare WAF log mode, OPA Gatekeeper dryrun).
  category?: RuleCategory
  severity?: 'critical' | 'high' | 'medium' | 'low'
  confidence?: 'high' | 'medium' | 'low'
  maturity?: 'stable' | 'incubating' | 'sandbox' | 'deprecated'
  mode?: RuleMode
  rationale?: string                // why this matters, in plain language
  remediation?: string              // what to do instead
  false_positives?: string[]        // known benign patterns, shipped with the rule
  review_by?: string                // YYYY-MM-DD — forces periodic re-justification

  // ── Command rules ──
  match?: string                    // regex or literal
  match_prefix?: string
  match_regex?: string

  // ── Filesystem rules ──
  paths?: string[]
  exclude?: string[]
  operations?: ('read' | 'write' | 'delete' | 'overwrite' | 'glob')[]

  // ── Content rules ──
  /**
   * `redact_span` (sprint/lane-c2, opt-in, default false/absent): whether
   * this specific pattern's match span fully covers the secret bytes
   * themselves, as opposed to merely a nearby label/signature that
   * indicates a secret is present without bounding it. This distinction
   * only matters to `EnforcementPipeline.evaluateOutput()` (output
   * redaction) — Tier 5's ordinary write-side content blocking in
   * `evaluateTiers()` ignores this field entirely and behaves exactly as
   * before.
   *
   * Found the hard way: `AKIA[0-9A-Z]{16}` matches exactly an AWS access
   * key — safe to redact in place. `aws_secret_access_key[\t ]*[:=]` and
   * `BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY` match only a LABEL or HEADER
   * — the actual secret (the key material, the PEM body) sits AFTER the
   * match and is not covered by it. Blindly replacing the match span with
   * a "[redacted]" marker on one of these would strip the label and leave
   * the real secret sitting right next to it, verbatim — a false-
   * confidence signal strictly worse than no redaction at all (the trace
   * would say "redacted" while the secret shipped anyway). See
   * `evaluateOutput()`'s own comment and docs/exfil.md's "Output
   * redaction" section for the full reasoning and the shipped rule's
   * per-pattern marking (`no-secrets-in-code`, install.ts).
   *
   * A pattern without `redact_span: true` can still MATCH and be detected
   * (contributes to `EnforceResult.redacted_rule_ids` and the message) —
   * it just never contributes to `redacted_output`, the same restraint
   * `mode: observe` gets for a different reason — UNLESS `redact_widen`
   * (below) is also set on it.
   *
   * `redact_widen` (opt-in, default absent — output-path-only, exactly like
   * `redact_span` above, and with the same "Tier 5's write-side content
   * blocking ignores this field entirely" scoping): for a pattern whose
   * match span is a LABEL/HEADER rather than the secret itself, this tells
   * `EnforcementPipeline.evaluateOutput()` how to extend that match forward
   * to cover the secret bytes that follow it, so the WHOLE span (label +
   * value/body) gets redacted instead of leaving the label stripped and the
   * real secret sitting next to it untouched. Ignored (has no effect) on a
   * pattern that already has `redact_span: true` — that pattern's match
   * already IS the whole secret, nothing to widen.
   *
   *   - `'line'`: the label is immediately followed by its value on the
   *     SAME line (e.g. `aws_secret_access_key[:=]<value>`) — widen to the
   *     next newline, or a bounded character cap if no newline is found
   *     within that bound (a single-line runaway/adversarial blob must not
   *     turn this into an unbounded scan).
   *   - `'pem'`: the label is a PEM `BEGIN` header whose body is MULTI-LINE,
   *     ending at a matching `END ... PRIVATE KEY` footer — widen forward to
   *     that footer (inclusive), or up to a bounded character cap if no
   *     footer is found within it. A capped, footer-less widen still
   *     redacts everything up to the cap (never leaves the match fully
   *     unredacted just because the footer wasn't found) and is flagged as
   *     possibly incomplete — see `EnforceResult.redaction_incomplete_rule_ids`.
   *
   * Both widen strategies search a BOUNDED window forward of the label
   * match, never an unbounded regex — see pipeline.ts's
   * `WIDEN_LINE_MAX_CHARS`/`WIDEN_PEM_MAX_CHARS` and evaluateOutput()'s own
   * comment for the DoS-safety reasoning. See docs/exfil.md's "Output
   * redaction" section for the full design writeup.
   */
  patterns?: ({ regex?: string; prefix?: string; redact_span?: boolean; redact_widen?: 'line' | 'pem' })[]

  // ── Network rules ──
  except?: string[]                 // domains to allow

  // ── Research/freshness rules ──
  topics?: string[]                 // regex list matched against command + reasoning
  max_age_hours?: number            // freshness horizon for the session research cache
  research_window_seconds?: number  // research-before-solve obligation TTL (default 600)
  freshness_seconds?: number        // evidence older than this does NOT discharge (default 1800)

  // ── Stuck-loop rules ──
  max_attempts?: number             // identical failing fingerprint count that redirects (default 3)
  block_attempts?: number           // count that denies (default 5)
  fingerprint?: 'auto' | 'exact'    // auto = normalized identity (default), exact = raw string
  require_failure?: boolean         // only count attempts with a nonzero exit (default true)
  escalation?: Array<{ at: number; action: EnforcementAction; message: string }>  // custom ladder

  // ── Oscillation rules (A→B→A→B cycle detector — sibling of `type: stuck`'s
  // exact-repeat detector, not a replacement: `no-repeat-loops` catches the
  // SAME failing command retried; this catches a short repeating SEQUENCE of
  // DIFFERENT commands/fingerprints, e.g. edit file A, edit file B undoing
  // A's change, edit A again. See oscillation-tracker.ts's header for the
  // full detection algorithm and oscillation-store.ts for the persisted
  // rolling-window shape. Reuses `fingerprint`, `require_failure`,
  // `escalation`, `window_seconds` (TTL), and `match` (optional extra
  // command-text filter on top of the tool-scope gate) from the stuck-rule
  // fields above — only the fields below are new to this type.)
  /** Max recent fingerprints kept per session's rolling window (default 8). Oscillation is a LOCAL pattern — this is deliberately small, not the whole session history. */
  oscillation_window_size?: number
  /** Smallest repeating-unit length to detect, clamped to >= 2 (default 2). A length-1 "cycle" is exact repetition — `type: stuck`'s territory — and is never matched here regardless of this value (see oscillation-tracker.ts's distinct-fingerprint guard). */
  min_cycle_length?: number
  /** Largest repeating-unit length to detect (default 4). */
  max_cycle_length?: number
  /** How many consecutive repeats of a candidate unit are required before it counts as oscillation at all, clamped to >= 2 (default 2 — A→B→A→B is the minimum evidence of a cycle, A→B alone is just two calls). */
  min_cycle_repeats?: number

  // ── Diagnosis rules (root-cause marker) ──
  require_hypothesis?: boolean      // gate the action on a fresh ledger hypothesis (default true)
  hypothesis_window_seconds?: number  // hypothesis freshness window (default 900)
  hypothesis_tools?: string[]       // tools that record hypotheses (default ['keel_hypothesis'])
  fallback_tools?: string[]         // diagnosis EVIDENCE tools that also discharge (e.g. Bash)
  fallback_pattern?: string         // regex for fallback evidence commands (git log|blame|bisect)

  // ── Oracle rules (test-tampering detector) ── deliberately reuses fields
  // from other rule shapes rather than adding new ones:
  //   `paths`          — test-file globs to watch for weakening EDITS
  //                       (content-diff surface — see oracle-signatures.ts)
  //   `match`          — a command-surface pattern, for tampering that
  //                       happens via CLI flag rather than a file edit
  //                       (e.g. `jest -u` / `vitest --update-snapshot`)
  //   `trigger`        — the FAILING test-run matcher (VerificationMatcher
  //                       with `exit: 'nonzero'`) that arms the recency
  //                       window; reuses the exact shape research rules use
  //                       for their research-before-solve obligation
  //   `window_seconds` — the recency window itself (default 900s / 15min);
  //                       a weakening edit/command outside this window of
  //                       the last failing test run does not fire at all in
  //                       the shipped default — see
  //                       session/proposals/test-oracle-tampering.yaml for
  //                       why that threshold is a hard gate, not a dial.

  // ── Environment rules ──
  vars?: string[]

  // ── Package verification rules (slopsquatting install gate) ──
  // No `match` needed: candidate installs are detected automatically from
  // the command across four ecosystems — npm (npm install/i, pnpm add,
  // yarn add, bun add), PyPI (pip install, pip3 install, uv add, uv pip
  // install, poetry add), crates.io (cargo add), and the Go module proxy
  // (go get, go install). See enforce/package-verifier.ts for the full
  // not_found/unverified/age-gate semantics (each ecosystem has its own
  // registry, name grammar, and existence-check nuances — see that
  // module's header); `age_days` is the one configurable knob shared
  // across all four (deny-vs-prompt mapping for existence/reachability is
  // fixed, per that module's header).
  age_days?: number                 // freshness threshold in days (default 30)

  // ── Rate limit rules ──
  window_seconds?: number
  max_calls?: number

  // ── Budget rules (real token/dollar spend, distinct from the `type:
  // rate` call-VOLUME counters shipped as `runaway-budget-tool-calls`/
  // `runaway-budget-bash-calls` — those count tool calls in a window, this
  // measures actual LLM API token/dollar usage read from a host's own
  // local transcript/session record) ──
  //
  // Two-phase, race-free by construction (see budget-tracker.ts): a spend
  // MEASUREMENT (from a Claude Code transcript line or an OpenCode session
  // row) is recorded OUTSIDE evaluate() — at Stop/PostToolUse-equivalent,
  // where the turn/tool-call has already settled — via
  // `EnforcementPipeline.recordBudgetSnapshot()`. That measurement updates
  // a PERSISTED over-budget flag (`~/.keel/state/budget-tracker.json`,
  // PersistentBudgetStore) keyed by rule + session + cwd. `evaluate()`'s
  // own `type: budget` branch (PreToolUse) only ever reads that persisted
  // flag — it never re-reads a transcript on the blocking path — because
  // Claude Code's Stop hook is architecturally observe-only (it cannot
  // block; the turn already completed) and the only correct enforcement
  // point for a budget breach is the NEXT tool call, exactly the same
  // "warn on first violation, persisted state blocks on repeat" shape
  // every other deny rule already uses (docs/integration-guides/
  // claude-code.md).
  /** Token ceiling (sum of input+output+cache-creation+cache-read+thinking tokens) for the session. Always enforceable — token counts need no per-model pricing table. */
  max_tokens?: number
  /**
   * Dollar ceiling for the session. Only ever enforced when the spend
   * measurement's dollar figure is FULLY CONFIDENT — every contributing
   * transcript line's model string matched a known pricing entry. A
   * SINGLE unrecognized model string anywhere in the session (a short
   * alias like `claude-sonnet-5` rather than an official dated model ID —
   * confirmed live on real Claude Code sessions on this machine) degrades
   * the WHOLE session's dollar figure to unavailable (null), never a
   * partial/undercounted total presented as the true one — see
   * budget/claude-transcript.ts's own header comment. A rule that sets
   * `max_dollars` without `max_tokens` risks being a control that can
   * never fire on a session using only aliased model strings; shipping a
   * default with `max_tokens` alone sidesteps that.
   */
  max_dollars?: number
  /**
   * Escalation terminal step (mirrors `type: stuck`'s `escalation` ladder,
   * scaled to a continuous spend measure instead of a discrete attempt
   * count): when the measured spend exceeds `max_tokens` (or
   * `max_dollars`, if confident) by this multiple, the pipeline calls
   * `halt-writer.ts`'s `writeHaltSentinel()` — the SAME sentinel shape
   * `keel halt` writes — in addition to the ordinary per-rule deny.
   * Undefined (the default) disables this entirely. NEVER fires for a
   * `mode: observe` rule regardless of this value — see
   * budget-tracker.ts's own comment: a false positive on an unproven
   * measurement latching deny-everything until a human runs `keel resume`
   * is exactly the hazard `cli/halt.ts`'s own header comment warns
   * against, so this is gated on the rule actually enforcing, not merely
   * observing.
   */
  hard_stop_multiplier?: number

  // ── Time rules ──
  timezone?: string
  schedule?: { start: string; end: string; days?: string[] }
  outside_schedule_action?: EnforcementAction

  // ── Sequence rules ──
  steps?: SequenceStep[]
  sequence_window_seconds?: number

  // ── Verification obligations ──
  //
  // `type: claim` reuses this exact trigger/satisfy/window shape (see
  // enforce/verification.ts and enforce/claim.ts) — an edit arms the
  // obligation, a passing test/build command discharges it, and
  // `verification_window_seconds` bounds how long it stays armed. The
  // difference is only what happens while it is still pending: a
  // `verification` rule gates a BOUNDARY tool call (commit/push) via
  // `boundaries`; a `claim` rule gates the agent's own TEXT asserting the
  // obligation is already met (see claim.ts's grammar). `boundaries` is
  // meaningless for `claim` rules and is ignored if present.
  trigger?: VerificationMatcher
  satisfy?: VerificationMatcher
  boundaries?: Record<string, VerificationBoundary>
  verification_window_seconds?: number

  // ── Flow / IFC rules ──
  sources?: string[]
  sinks?: string[]
  /**
   * When true, a `type: flow` rule is checked against FlowTracker's
   * PERSISTED, session-scoped, TTL'd store (flow-store.ts) instead of its
   * in-memory taggedValues Map — see flow-tracker.ts's checkPersisted().
   * This is what lets `sources`/`sinks` correlate across SEPARATE
   * `keel hook <host>` processes within one session (docs/exfil.md's
   * "Coverage depends on which host integration you use"), not just within
   * one live process the way the default (unset/false) in-memory check()
   * does. Deliberately a distinct rule (see install.ts's
   * no-exfil-flow-cross-call) rather than a flag flipped on the existing
   * no-exfil-flow floor: cross-process correlation has a materially wider
   * false-positive window (the TTL, not one command) and ships at
   * warn/observe, never as a `level: protect` deny. A `cross_call` rule
   * still calls FlowTracker.record() itself (pipeline.ts's flow branch),
   * so it is self-sufficient even in a custom ruleset that ships it
   * without its non-cross_call sibling.
   */
  cross_call?: boolean

  // ── MCP rules ──
  mcp_check?: 'tool_descriptions' | 'tool_results' | 'server_changes'

  // ── Session composite-trip rules (`type: session`) ──
  //
  // A composite runaway-loop trip across five session-scoped dimensions:
  // wall-clock duration, cumulative tool-call count, cumulative Bash-call
  // count, distinct-file-write churn, and consecutive-failure count. Each
  // entry in the ladder targets exactly one dimension and fires once that
  // dimension's live value reaches `at`; the WORST met step across all five
  // wins on any given call (session-tracker.ts's `check()`).
  //
  // New field name is deliberately `session_`-prefixed rather than reusing
  // `type: rate`'s `window_seconds`/`max_calls`: those mean a SLIDING-WINDOW
  // ceiling per matched pattern, a different semantic from a
  // session-cumulative total that never resets on its own — see
  // `runaway-budget-tool-calls`/`-bash-calls` (install.ts) for the sliding-
  // window shape this deliberately does NOT reuse. The shape itself
  // (`{ at, action, message }`) mirrors `type: stuck`'s `escalation` field
  // (see `max_attempts`/`block_attempts`/`escalation` above), extended with
  // one new `dimension` selector so a single rule can carry independent
  // thresholds per dimension instead of one flat count.
  //
  // SAFETY-CRITICAL, enforced structurally by rule-parser.ts's
  // validateRules (not merely by convention): `halt: true` and
  // `action: 'deny' | 'block'` may ONLY appear on a `consecutive_failures`
  // step. `duration_minutes`, `tool_calls`, `bash_calls`, and
  // `file_write_churn` are pure volume counters — they climb whether the
  // session is thriving or stuck, so they may escalate at most to `prompt`;
  // only a repeated-FAILURE streak (reset on any success, exactly like
  // `no-repeat-loops`'s `require_failure`) may ever escalate all the way to
  // a `keel halt` lockdown latch (no auto-expiry — see halt-writer.ts).
  session_escalation?: Array<{
    dimension: 'duration_minutes' | 'tool_calls' | 'bash_calls' | 'file_write_churn' | 'consecutive_failures'
    at: number
    action: EnforcementAction
    message?: string
    /** Trips `keel halt`'s lockdown latch when this step fires. Rejected by validateRules on any dimension other than `consecutive_failures`. */
    halt?: boolean
  }>

  // ── Inheritance rules ──
  propagate_rules?: 'all' | 'global' | 'none'
  propagate_memory?: boolean
  resource_access?: 'full' | 'restrict' | 'none'
  termination?: 'quarantine' | 'merge' | 'discard'

  // ── Fix/mutation ──
  fix?: FixTransform[]

  // ── Reasoning awareness ──
  unless_reasoning?: string         // regex — allow if agent reasoning matches
  unless?: { regex?: string }[]     // existing from CommandRule

  // ── Meta rules ──
  condition?: string                // e.g. "3 denials in 60 seconds"
}

// ── Minimal / beginner-friendly rule format ──────────────────────────
//
// `KeelRule` mirrors keel's own shipped catalog — id, type, level, scope,
// context, action, message, priority, plus ~20 type-specific optional
// fields depending on `type`. That is the right shape for the rules keel
// ships, but it is not a reasonable first thing to hand a user who just
// wants to block one footgun command. `SimpleRule` is that on-ramp: the
// five fields below, with one match-condition field chosen by `type`, and
// nothing else. `expandSimpleRule()` (enforce/rule-parser.ts) is the only
// place a SimpleRule is ever interpreted — it translates each one into a
// full KeelRule before validateRules() or the enforcement pipeline ever
// see it, so there is exactly one rule shape at evaluation time, not two
// parallel formats to keep in sync.
export type SimpleRuleType = 'command' | 'filesystem' | 'content' | 'env' | 'network'

export interface SimpleRule {
  id: string
  type: SimpleRuleType
  action: EnforcementAction
  message: string

  // ── exactly one of these is required, chosen by `type` ──
  match?: string          // type: command | network — regex or literal
  match_regex?: string    // type: command — alternative to `match`
  paths?: string[]        // type: filesystem — glob(s) to watch
  patterns?: string[]     // type: content — plain regex strings (no {regex,prefix} wrapper)
  vars?: string[]         // type: env — environment variable names
}

export interface SequenceStep {
  tool: string
  path?: string                     // optional path matching (${same_ref} for cross-step refs)
  pattern?: string
}

export interface VerificationMatcher {
  tools?: string[]
  tool?: string
  path?: string
  /** Any-of additional path targets (e.g. package.json re-arms the obligation). */
  paths?: string[]
  pattern?: string
  /** Only match when the command exited with this code ('nonzero' for any failure). */
  exit?: number | 'nonzero'
}

export interface VerificationBoundary {
  pattern: string
  action?: EnforcementAction
}

export interface FixTransform {
  pattern: string
  replace: string
}

export interface CacheConfig {
  enabled?: boolean
  max_size?: number                 // max entries in session cache
  ttl_seconds?: number
  persistent?: boolean               // persist across sessions
}

export interface ReInjectionConfig {
  enabled?: boolean
  thresholds?: number[]             // token counts at which to re-inject
}

// ── Enforcement pipeline types ──────────────────────────────────────

export interface EnforceInput {
  tool: string
  args: Record<string, unknown>
  cwd: string
  session_id: string
  turn_number: number
  context_tokens: number
  level: ProtectionLevel
  context: RuleContext
  agent: string                     // 'opencode' | 'claude-code' | 'cline' | etc.
  subagent_of: string | null
  reasoning?: string                // agent's chain-of-thought, if available
  depth?: EnforcementDepth          // fast | full | deep evaluation depth
  action_override?: EnforcementAction // integration-level action override
  /**
   * A completed tool call's OWN output text (stdout, file content read back,
   * an API response body, ...) — populated ONLY for a call into
   * `EnforcementPipeline.evaluateOutput()` (sprint/lane-c2's real-output-
   * capture path, called from a host's PostToolUse-equivalent hook, never
   * from `evaluate()`/`evaluateClaim()`). Every other consumer of
   * `EnforceInput` in this codebase leaves this undefined; it exists so the
   * secret-detection content-rule patterns (`no-secrets-in-code`, `type:
   * content`) can be reused against output text instead of only input text,
   * without overloading `args` (which is the CALL's arguments, not its
   * result) or adding a parallel input shape.
   */
  tool_output?: string
}

export interface EnforceResult {
  action: EnforcementAction
  rule_id?: string | null
  rule_name?: string
  message: string
  matched_pattern?: string
  timestamp: string
  duration_ms?: number
  cache_hit?: boolean
  tier?: number
  fix_result?: Record<string, unknown>
  directive?: ResearchDirective
  redirect?: RedirectDirective
  /**
   * Set only for rules in `mode: observe`: the action that WOULD have been
   * enforced. The verdict itself is `allow`, so nothing is interrupted —
   * this is what lets the dashboard report "would have blocked N times"
   * and measure a rule's false-positive rate before promoting it.
   *
   * When exactly one `mode: observe` rule matched during this evaluate()
   * call, this mirrors `observed_matches[0]` (kept for every pre-existing
   * single-match consumer). When MULTIPLE observe rules matched — now
   * possible since a matched observe rule records and evaluation
   * CONTINUES instead of short-circuiting — this single slot cannot hold
   * all of them; `observed_matches` is the complete picture.
   */
  observed_action?: EnforcementAction
  /**
   * Every `mode: observe` rule that matched during this evaluate() call,
   * in evaluation order. A matched observe rule no longer blinds
   * lower-priority rules on the same call (see pipeline.ts's evaluate()/
   * violation() — the OPA Gatekeeper dryrun / Cloudflare WAF log-mode
   * shape: shadow policies record and evaluation continues), so a single
   * call can carry more than one observation before the real verdict (a
   * later non-observe match, or `allow` if none) is decided. Present only
   * when at least one observe rule matched; absent (not an empty array)
   * otherwise, so JSON.stringify drops it and old trace lines stay
   * byte-identical.
   */
  observed_matches?: Array<{ rule_id: string; observed_action: EnforcementAction; message: string }>
  /**
   * Set only when `action === 'redact'` (`EnforcementPipeline.
   * evaluateOutput()` — see EnforceInput.tool_output's comment): the
   * caller's `tool_output` text with every matched secret-shaped span
   * replaced by an attributed `[redacted-by-keel:<rule_id>]` marker — or
   * `[redacted-by-keel:<rule_id_a>+<rule_id_b>]` when two or more
   * redact_span:true patterns from different rules matched OVERLAPPING (or
   * byte-adjacent) spans: those are merged into a single placeholder
   * covering their union rather than left to corrupt each other via
   * sequential mutation, and every contributing rule id is named, joined
   * by `+`, in match order. A consumer that expects exactly one id after
   * the colon should split on `+` rather than assume a single token.
   * `redacted_rule_ids` (below) is always the flat, individually-listed
   * form regardless of how many placeholders merged which ids — parse that
   * field, not this marker's text, if you need a clean id list. The
   * caller (a host integration) is responsible for actually applying this
   * back onto whatever channel it came from — evaluateOutput() itself never
   * mutates anything; it is a pure function from text to a verdict + a
   * candidate replacement text.
   */
  redacted_output?: string
  /** Every `type: content` rule id whose pattern matched during a `redact` verdict, in match order. Absent when nothing matched. */
  redacted_rule_ids?: string[]
  /**
   * Set only by `EnforcementPipeline.evaluateOutput()`, and only `true`
   * when the scanned text was longer than `MAX_OUTPUT_SCAN_CHARS`
   * (pipeline.ts): content past that bound was never run through the
   * `type: content` patterns at all, so a clean/`allow` verdict on a
   * truncated scan is not a claim that the UNSCANNED tail is clean too —
   * it is silent about it. Before this field existed, that silence was
   * only ever visible in the human-readable `message` string (a "(only the
   * first N chars were scanned)" suffix) — readable by a person, invisible
   * to any caller that branches on the verdict programmatically (a
   * dashboard, an alerting rule, a test asserting "no secret leaked").
   * Absent (not `false`) on every other result shape, so old trace lines
   * and JSON.stringify output stay byte-identical for anyone not reading
   * this field yet.
   */
  scan_truncated?: boolean
  /**
   * Every `type: content` rule id whose `redact_widen: 'pem'` (or `'line'`)
   * pattern matched but hit its bounded search cap before finding a natural
   * closing boundary (a matching PEM `END` footer, or a newline) —
   * `types.ts`'s `redact_widen` doc comment on `KeelRule.patterns[]`. The
   * span up to the cap was still redacted (never left fully exposed just
   * because the boundary wasn't found), but the caller should treat the
   * redaction as possibly incomplete: more secret bytes may sit past the
   * cap, unscanned. Same "a human-readable message note is not enough for a
   * caller that branches on the verdict programmatically" reasoning as
   * `scan_truncated` above. Absent (not an empty array) when nothing hit
   * the cap, so old trace lines and JSON.stringify output stay
   * byte-identical for anyone not reading this field yet.
   */
  redaction_incomplete_rule_ids?: string[]
}

export interface RedirectDirective {
  kind: 'stuck' | 'oscillation' | 'research' | 'diagnosis' | 'plan'
  required_tools: string[]
  target: string
  rationale: string
  rule_id: string
  attempts?: number
  suggested_call?: string
}

export interface ResearchDirective {
  topic: string
  missing: boolean
  stalenessHours?: number
  maxAgeHours: number
  suggestion: string
}

// ── Audit log ───────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string
  session_id?: string
  turn_number?: number
  tool?: string
  args?: Record<string, unknown>
  rule_id?: string | null
  rule_name?: string
  action: EnforcementAction
  message?: string
  level?: ProtectionLevel
  context?: RuleContext
  agent?: string
  subagent_of?: string | null
  cache_hit?: boolean
  duration_ms?: number
  tier?: number
  context_tokens?: number

  // Backward compat fields from old AuditEntry
  tool_name?: string

  reasoning?: string
  fix_applied?: boolean

  /**
   * Mirrors EnforceResult.observed_action: set only for rules in
   * `mode: observe`, carrying the action that WOULD have been enforced while
   * `action` itself stays "allow". Optional so entries written before this
   * field existed still parse — every reader here does a plain `JSON.parse`
   * with no schema check, so an absent key is just `undefined`, not an error.
   */
  observed_action?: EnforcementAction
}

// ── Cache ───────────────────────────────────────────────────────────

export interface CacheEntry {
  verdict: string
  rule_id: string | null
  count: number
  timestamp: number
}

export interface CacheStats {
  size: number
  hits: number
  misses: number
  hit_rate: number
}

// ── Learning layer ──────────────────────────────────────────────────

export interface Suggestion {
  type: 'add_rule' | 'remove_rule' | 'modify_rule' | 'adjust_level' | 'add_exception' | 'cache_tune'
  rule_id?: string
  current_value?: string
  suggested_value?: string
  reason: string
  confidence: 'high' | 'medium' | 'low'
  evidence: {
    sessions_observed: number
    violations_count: number
    false_positive_count: number
    override_count: number
  }
}

export interface ProjectInsights {
  sessions_analyzed: number
  total_tool_calls: number
  total_denies: number
  total_warns: number
  false_positives_reported: number
  most_fired_rules: Array<{ rule_id: string; count: number }>
  most_ignored_rules: Array<{ rule_id: string; count: number }>  // overridden rules
  suggested_rules: Suggestion[]
  cache_efficiency: number  // 0-1
  violation_hotspots: Array<{ token_range: string; count: number }>
}

// ── Backward compatibility aliases ─────────────────────────────────

/**
 * @deprecated Use EnforceResult instead
 */
export type EnforcementResult = EnforceResult

/**
 * @deprecated Use ProtectionLevel instead
 */
export type Level = ProtectionLevel

// ── Existing types (re-exported for compatibility) ──────────────────

export interface PolicyFile {
  version: string
  name?: string
  description?: string
  patterns?: PatternDef[]
  file_rules?: FileRule[]
  command_rules?: CommandRule[]
  content_rules?: ContentRule[]
  env_rules?: EnvRule[]
  network_rules?: NetworkRule[]
  rate_limits?: RateLimit[]
  time_rules?: TimeRule[]
  settings?: PolicySettings
}

export interface PolicySettings {
  default_action?: EnforcementAction
  audit_log?: boolean
  fail_on_error?: boolean
  level?: ProtectionLevel
}

export interface PatternDef {
  id: string
  type: 'regex' | 'prefix' | 'glob'
  pattern: string
  description?: string
}

export interface FileRule {
  name: string
  paths: string[]
  exclude?: string[]
  actions: {
    read?: EnforcementAction
    write?: EnforcementAction
    glob?: EnforcementAction
  }
  message: string
}

export interface CommandRule {
  name: string
  patterns: { prefix?: string; regex?: string }[]
  action: EnforcementAction
  message: string
  unless?: { regex?: string }[]
}

export interface ContentRule {
  name: string
  patterns: ({ ref?: string; regex?: string; prefix?: string })[]
  paths?: string[]
  action: EnforcementAction
  mode?: 'commit' | 'read' | 'write' | 'always'
  message: string
}

export interface EnvRule {
  name: string
  vars: string[]
  action: EnforcementAction
  message: string
}

export interface NetworkRule {
  name: string
  patterns: { regex?: string }[]
  action: EnforcementAction
  message?: string
}

export interface RateLimit {
  name: string
  scope: 'tool' | 'repo' | 'user'
  window: number
  max_calls: number
  action: EnforcementAction
  message: string
}

export interface TimeRule {
  name: string
  timezone?: string
  schedule?: { start: string; end: string; days?: string[] }
  subjects: ({ patterns: { regex?: string }[]; paths?: string[] })[]
  outside_schedule_action: EnforcementAction
  message: string
}

export interface ToolCallEvent {
  tool_name: string
  args: Record<string, unknown>
  cwd: string
  timestamp: string
}
