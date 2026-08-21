import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveMaybeRelative, normalizeForMatch } from './path-normalize.js'
import { resolveHome } from '../home.js'
import type {
  KeelRule, EnforceInput, EnforceResult, EnforcementAction,
  ProtectionLevel, RuleContext, CacheEntry, AuditEntry, ResearchDirective, RedirectDirective,
} from '../types.js'
import { ActionCache, ContentTracker, type CacheContext } from './cache.js'
import type { RuleHierarchy } from './rule-parser.js'
import { mergeRules, detectConflicts, hashRulesFile, loadRuleHierarchy, validateRules, effectiveHierarchyLevel, dialAction, ruleFileSources } from './rule-parser.js'
import { SequenceDetector } from './sequencer.js'
import { FlowTracker } from './flow-tracker.js'
import { StuckTracker } from './stuck-tracker.js'
import { OscillationTracker } from './oscillation-tracker.js'
import { SessionTracker } from './session-tracker.js'
import { writeHaltSentinel } from './halt-writer.js'
import { BudgetTracker, type BudgetSpend } from './budget-tracker.js'
import { ProblemLedger } from './problem-ledger.js'
import { ResearchTracker } from './research-tracker.js'
import type { ResearchCache } from './research/research-cache.js'
import { extractPackageInstalls, checkPackagesCacheOnly, scheduleBackgroundVerification, decidePackageAction, PackageVerifierCache } from './package-verifier.js'
import { applyAmbientConfig, AmbientConfigCache } from './ambient-registry-config.js'
import { StateManager } from './state-manager.js'
import { VerificationTracker, WRITE_TOOL_NAMES } from './verification.js'
import { OracleTracker } from './oracle-tracker.js'
import { detectWeakening } from './oracle-signatures.js'
import { matchesAnyTestGlob } from './oracle-glob.js'
import { FileRuleOverrideStore } from './overrides.js'
import { commandString, commandSurfaces, argPath } from './arg-utils.js'
import { detectClaim } from './claim.js'
import { worstSecretVerdict, shannonEntropyBitsPerChar } from './secret-confidence.js'

export type PipelineTier = 1 | 2 | 3 | 4 | 5 | 6 | 7

/**
 * Thrown by violation() for a `mode: observe` match instead of returning —
 * this is what lets an observed match record itself and fall through to a
 * LOWER-priority rule on the same call instead of blinding it (the OPA
 * Gatekeeper dryrun / Cloudflare WAF log-mode shape: shadow policies
 * record and evaluation continues).
 *
 * Every `return this.violation(...)` call site in evaluate() stays
 * unchanged; the throw is what makes that statement never complete for an
 * observed match. Both rule-matching loops in evaluate() (`statefulRules`
 * and the tiered `rules` loop) wrap their per-rule body in try/catch and
 * treat this exact symbol as "recorded, continue to the next rule" rather
 * than a real error.
 *
 * INVARIANT (compiler-invisible — keep it true by construction): every
 * call to violation() must be lexically inside one of those two loops, so
 * the throw is always caught there. evaluate()'s own outer try/catch is a
 * fail-safe for this invariant breaking, not a substitute for it: an
 * escaped throw would otherwise reach the host (e.g. opencode-plugin's
 * `before()`), which rewrites any non-"[Keel]"-prefixed throw into a hard
 * block — turning an observe rule into the exact short-circuit bug this
 * exists to remove, just relocated one layer up.
 *
 * A THIRD loop exists for the same reason: evaluateClaim()'s single-rule-
 * type loop below (Wave/Phase-1 claim-reach) follows the identical
 * try/catch-and-continue shape, plus its own outer fail-safe in
 * evaluateClaim() itself, mirroring evaluate()'s.
 */
const OBSERVE_CONTINUE = Symbol('keel:observe-continue')

/**
 * Bound on how much of a tool's output `evaluateOutput()` (below) will run
 * `type: content` regex patterns against. `tool.execute.after` is awaited
 * on a host's hot path, and tool output can be multi-megabyte (a large file
 * read, a verbose test run) — running eight-plus global-replace regexes
 * over that on every single tool call is a real cost against this
 * pipeline's own <50ms tier budget. 256KB comfortably covers a typical
 * command's stdout/file read while keeping the scan itself sub-millisecond;
 * text past this bound is left unscanned (and the result says so, rather
 * than silently returning a clean verdict for content that was never
 * looked at — see evaluateOutput()'s own comment).
 */
const MAX_OUTPUT_SCAN_CHARS = 256 * 1024

/**
 * Bounds for `redact_widen` (types.ts's doc comment on
 * `KeelRule.patterns[].redact_widen`) — widening a LABEL/HEADER-only
 * pattern's match forward to cover the secret bytes that follow it, for
 * `EnforcementPipeline.evaluateOutput()` only. Both are deliberately
 * BOUNDED character caps, not unbounded regexes (`[\s\S]*?` up to a
 * lazily-matched footer, or similar): output can be adversarial or simply
 * malformed (no closing boundary at all), and a widen search has to
 * degrade to "redact up to a safe cap, flag possibly-incomplete" rather
 * than either (a) scanning unboundedly looking for a footer that never
 * appears, or (b) leaving the match fully unredacted just because the
 * footer wasn't found — see `widenLabelSpan`'s own comment below.
 */
const WIDEN_LINE_MAX_CHARS = 4 * 1024
const WIDEN_PEM_MAX_CHARS = 8 * 1024

/**
 * PEM footer, covering every key type the shipped `BEGIN (RSA|OPENSSH|EC|
 * DSA) PRIVATE KEY` / `-----BEGIN PRIVATE KEY-----` patterns can widen
 * from: `-----END PRIVATE KEY-----` (PKCS8, no type) or `-----END <TYPE>
 * PRIVATE KEY-----` (traditional/OpenSSH). The optional type group makes
 * one regex correct for both shipped BEGIN patterns' bodies.
 */
const PEM_FOOTER_REGEX = /-----END(?: (RSA|OPENSSH|EC|DSA))? PRIVATE KEY-----/gi

/**
 * Widen a single LABEL/HEADER match — `[labelStart, labelEnd)` — forward to
 * cover the secret bytes that follow it, per `strategy` (types.ts's
 * `redact_widen` doc comment). Always returns an end index; `incomplete:
 * true` means the widen hit its bounded cap before finding a natural
 * closing boundary (a newline for `'line'`, a matching PEM footer for
 * `'pem'`) — the caller still redacts up to that cap (never leaves the
 * match fully unredacted just because the boundary wasn't found), but flags
 * the result as possibly incomplete (`EnforceResult.
 * redaction_incomplete_rule_ids`).
 *
 * Both branches search a SLICE of `scanText` bounded to the relevant max
 * (`WIDEN_LINE_MAX_CHARS`/`WIDEN_PEM_MAX_CHARS`), not the rest of
 * `scanText` itself — `String.indexOf`/`RegExp.exec` are both linear, so
 * neither is catastrophic-backtracking-prone, but bounding the search
 * WINDOW (not just the eventual redaction span) is what actually caps the
 * work done per match regardless of how far away (or entirely absent) the
 * next newline/footer is in a large or adversarial output.
 */
function widenLabelSpan(scanText: string, labelStart: number, labelEnd: number, strategy: 'line' | 'pem'): { end: number; incomplete: boolean } {
  if (strategy === 'line') {
    const cap = Math.min(scanText.length, labelEnd + WIDEN_LINE_MAX_CHARS)
    const window = scanText.slice(labelEnd, cap)
    const nl = window.indexOf('\n')
    if (nl !== -1) return { end: labelEnd + nl, incomplete: false }
    // No newline within the bounded window: stop at the cap. Incomplete
    // only if there is more text past the cap this widen never looked at —
    // if the cap coincides with the actual end of scanText, the "value"
    // legitimately just ends there and nothing was left unscanned.
    return { end: cap, incomplete: cap < scanText.length }
  }
  // strategy === 'pem'
  const cap = Math.min(scanText.length, labelEnd + WIDEN_PEM_MAX_CHARS)
  const window = scanText.slice(labelEnd, cap)
  PEM_FOOTER_REGEX.lastIndex = 0
  const footer = PEM_FOOTER_REGEX.exec(window)
  if (footer) return { end: labelEnd + footer.index + footer[0].length, incomplete: false }
  return { end: cap, incomplete: cap < scanText.length }
}

export interface PipelineConfig {
  level: ProtectionLevel
  context: RuleContext
  cache: ActionCache
  contentTracker: ContentTracker
  sequenceDetector: SequenceDetector
  verificationTracker?: VerificationTracker
  flowTracker: FlowTracker
  ruleHierarchy: RuleHierarchy
  ruleVersion: number
  allowedFixTransforms?: boolean
  stateManager?: StateManager
  overrideStore?: import('./overrides.js').RuleOverrideStore
  researchCache?: ResearchCache
  researchTracker?: ResearchTracker
  stuckTracker?: StuckTracker
  /** Rolling-window A→B→A cycle detector behind `type: oscillation` rules (oscillation-tracker.ts) — sibling of stuckTracker's exact-repeat detection, not a replacement. Optional, same pattern: a rules.yaml with no `type: oscillation` rule never touches it. */
  oscillationTracker?: OscillationTracker
  /** Composite runaway-loop trip behind `type: session` rules (session-tracker.ts). Optional, same pattern as stuckTracker: a rules.yaml with no `type: session` rule never touches it. */
  sessionTracker?: SessionTracker
  /** Two-phase deny state for `type: budget` rules — see budget-tracker.ts's own header comment. `checkDeny` is read from evaluate()'s PreToolUse branch; `record` is called from `recordBudgetSnapshot()`, OUTSIDE evaluate(), by a host's Stop/PostToolUse-equivalent hook. */
  budgetTracker?: BudgetTracker
  oracleTracker?: OracleTracker
  /** Disk-backed verdict cache for `type: package` rules. Defaults to KEEL_STATE_DIR/package-verifier.json. */
  packageVerifierCache?: PackageVerifierCache
  /** Per-cwd, in-memory ambient package-manager config cache (`.npmrc`/`pip.conf`/`.cargo/config.toml`/`GOPRIVATE` — see ambient-registry-config.ts). Defaults to a fresh instance per pipeline, mirroring packageVerifierCache's own lifetime. Injectable so tests can reuse or reset it explicitly. */
  ambientConfigCache?: AmbientConfigCache
  /** Injection point for tests — never hits the real registry unless explicitly provided (or KEEL_NPM_REGISTRY is set outside vitest). */
  packageVerifierFetch?: typeof fetch
  /**
   * Test-only observation hook for the `type: package` cache-miss path
   * (v0.4 package-lookup budget fix). On a cache miss, `evaluate()` fires
   * `scheduleBackgroundVerification` with `void` — never awaited, so the
   * hot path returns immediately — and, if this hook is set, also hands it
   * the settlement promise so a test can `await` the background fill
   * deterministically instead of racing a real timer. Never called by any
   * production host (cli/enforce.ts, daemon.ts, opencode-plugin/plugin.ts
   * do not set it).
   */
  packageVerifierOnBackgroundStart?: (settled: Promise<void>) => void
  ledger?: ProblemLedger
  reloadRules?: () => RuleHierarchy
  ruleFingerprint?: () => string
  onRulesReload?: (hierarchy: RuleHierarchy) => void
  /** Called when a rules reload failed validation; the previous hierarchy is kept. */
  onRulesError?: (errors: string[]) => void
  disableFile?: string
  /** Path to the halt sentinel (~/.keel/HALTED by default via resolveHome()). Mirrors disableFile — lets tests and sandboxed installs redirect it. */
  haltFile?: string
}

/**
 * Tiered enforcement pipeline.
 *
 * Each tier runs from cheapest to most expensive.
 * First definitive match (ALLOW or DENY) short-circuits.
 *
 * Tiers:
 *   1 — Cache hit check (O(1), instant)
 *   2 — Blocklist/allowlist regex match (~0.01ms)
 *   3 — Simple conditionals (path, tool name, time) (~0.1ms)
 *   4 — Rate limit check (~0.01ms)
 *   5 — File content scan (~1-10ms, only if changed)
 *   6 — Sequence + flow tracking (~0.5ms)
 *   7 — Reasoning coherence check (~5-50ms)
 */
export class EnforcementPipeline {
  private config: PipelineConfig
  private verificationTracker: VerificationTracker
  private oracleTracker: OracleTracker
  private denyFirstTime: Map<string, boolean> = new Map()
  private circuitBreaker: Map<string, { count: number; startTime: number }> = new Map()
  private rateCounts: Map<string, { count: number; windowStart: number }> = new Map()
  private lastRulesHash: string = ''
  private previousRulesHash: string = ''
  /**
   * `mode: observe` matches recorded during the CURRENT evaluate() call.
   * Reset at the top of evaluate() and read back at the bottom to decorate
   * the result — see OBSERVE_CONTINUE's header comment for why this is an
   * instance field rather than a threaded parameter. Not concurrency-safe
   * across overlapping evaluate() calls on the same instance, same as
   * every other per-call instance field here (denyFirstTime,
   * circuitBreaker, rateCounts) — this pipeline is built for one call at a
   * time per host process, not concurrent evaluate() calls.
   */
  private observedMatches: Array<{ rule_id: string; observed_action: EnforcementAction; message: string }> = []
  private readonly overrideStore
  private readonly packageVerifierCache: PackageVerifierCache
  private readonly ambientConfigCache: AmbientConfigCache

  constructor(config: PipelineConfig) {
    this.config = config
    this.verificationTracker = config.verificationTracker || new VerificationTracker(config.stateManager)
    // Self-constructed by default (like verificationTracker above) rather
    // than requiring every host (cli/enforce.ts, daemon.ts, opencode-
    // plugin/plugin.ts) to be updated to wire it explicitly — those already
    // pass `stateManager`, which is all OracleTracker needs.
    this.oracleTracker = config.oracleTracker || new OracleTracker(config.stateManager)
    this.overrideStore = config.overrideStore || new FileRuleOverrideStore()
    this.packageVerifierCache = config.packageVerifierCache || new PackageVerifierCache()
    this.ambientConfigCache = config.ambientConfigCache || new AmbientConfigCache()
    this.lastRulesHash = this.computeRulesHash()
    this.loadState()
  }

  /** Load persisted state from StateManager into instance maps. */
  private loadState(): void {
    const sm = this.config.stateManager
    if (!sm) return

    for (const ruleId of Object.keys(sm.denyFirstTime)) {
      if (!sm.isFirstTime(ruleId, this.lastRulesHash)) this.denyFirstTime.set(ruleId, true)
    }
    for (const [key, val] of Object.entries(sm.circuitBreaker)) {
      this.circuitBreaker.set(key, { count: val.count, startTime: val.startTime })
    }
    for (const [key, val] of Object.entries(sm.rateCounts)) {
      this.rateCounts.set(key, { count: val.count, windowStart: val.windowStart })
    }
  }

  private computeRulesHash(): string {
    if (this.config.ruleFingerprint) return this.config.ruleFingerprint()
    const h = this.config.ruleHierarchy
    // ruleFileSources() returns more than [sourcePath] whenever a tier's
    // rules.yaml resolves an `extends:` chain — hashing sourcePath alone
    // would leave an edit to an extended base file (tightening a floor,
    // or otherwise) permanently invisible to this reload check. See
    // ParsedRules.composedFrom's doc comment (rule-parser.ts).
    //
    // `user` is included alongside global/project/local here (it wasn't
    // before this change) — a `~/.config/keel/rules.yaml` that itself
    // `extends:` a shared org policy is exactly the case this feature
    // exists for, and there is no reason for one of the four hierarchy
    // tiers to silently sit outside reload detection while the other
    // three are covered.
    return [
      ...ruleFileSources(h.global),
      ...ruleFileSources(h.user),
      ...ruleFileSources(h.project),
      ...ruleFileSources(h.local),
    ].map(hashRulesFile).join(':')
  }

  /**
   * Check if rules have changed since last evaluation.
   * If so, flush cache and re-merge rules.
   */
  private checkRuleVersion(): boolean {
    const currentHash = this.computeRulesHash()
    if (currentHash !== this.lastRulesHash) {
      const reloaded = this.config.reloadRules?.()
      if (reloaded) {
        const errors = [reloaded.global, reloaded.user, reloaded.project, reloaded.local]
          .flatMap(source => source ? [...(source.errors || []), ...validateRules(source.rules)] : [])
        if (errors.length) {
          // Last known good: a typo mid-session must not silence the
          // guardrails. Keep enforcing with the previous valid hierarchy,
          // surface the errors, and leave the hash unchanged so the reload
          // is retried (and the error re-surfaced) on the next call.
          this.config.onRulesError?.(errors)
          return false
        }
        this.config.ruleHierarchy = reloaded
        this.config.onRulesReload?.(reloaded)
      }
      this.previousRulesHash = this.lastRulesHash
      this.lastRulesHash = this.computeRulesHash()
      this.config.ruleVersion += 1
      this.config.cache.invalidate(this.config.ruleVersion)
      this.denyFirstTime.clear()
      this.config.contentTracker.clear()
      this.config.sequenceDetector.clear()
      this.config.flowTracker.clear()
      return true  // rules changed
    }
    return false
  }

  /**
   * Evaluate an action against all active rules.
   *
   * Thin wrapper around evaluateTiers(): resets the per-call observed-match
   * accumulator, runs the real tiered evaluation, then decorates the
   * result with everything that was observed along the way. Splitting it
   * this way means the many `return this.violation(...)` / `return
   * this.result(...)` sites inside evaluateTiers() need no per-site
   * awareness of observe recording — they just stop short of completing
   * when violation() throws OBSERVE_CONTINUE (see its header comment), and
   * this one place is where the accumulated observations get attached to
   * whatever verdict actually won.
   */
  async evaluate(input: EnforceInput): Promise<EnforceResult> {
    const start = Date.now()
    this.observedMatches = []
    let result: EnforceResult
    try {
      result = await this.evaluateTiers(input)
    } catch (err) {
      // Fail-safe for the OBSERVE_CONTINUE invariant (see its header
      // comment): should never trigger in practice, but degrading to an
      // allow-with-observations is infinitely safer than letting a stray
      // throw reach the host and get rewritten into a hard block.
      if (err === OBSERVE_CONTINUE) {
        result = this.result('allow', '', 'Allowed (observe-only match)', start, false, 0)
      } else {
        throw err
      }
    }
    if (this.observedMatches.length) {
      result.observed_matches = this.observedMatches.map(m => ({ ...m }))
      // observed_action always mirrors observedMatches[0] when at least one
      // observe rule matched — independent of what the definitive verdict
      // turned out to be. Post-fix that verdict can now be a REAL rule's
      // deny/fix/prompt/warn (an observe match no longer blinds it), so
      // "an observe rule fired" and "what finally decided this call" are
      // genuinely separate facts and both need to survive on the result.
      result.observed_action = this.observedMatches[0].observed_action
      // rule_id/rule_name/message are different: those identify WHY the
      // call was interrupted, so they may only be borrowed from the
      // observe match on a bare-allow verdict (no non-observe rule
      // matched at all) — every pre-existing single-match consumer
      // (tests, dashboards, traces) expects exactly that shape. A
      // DEFINITIVE verdict from a real rule must keep its OWN rule_id and
      // message; overwriting them with an unrelated observe rule's would
      // hide the actual reason this call was blocked/fixed/warned.
      if (result.action === 'allow' && !result.rule_id) {
        const first = this.observedMatches[0]
        result.rule_id = first.rule_id
        result.rule_name = first.rule_id
        result.message = first.message
      }
    }
    return result
  }

  /**
   * Narrow claim-to-evidence check for a channel that carries the agent's
   * own completed output OUTSIDE a real tool call — an OpenCode
   * `experimental.text.complete` segment, a Claude Code `Stop` hook's
   * `last_assistant_message`, or any future per-host equivalent (v0.4
   * Phase 1: "give claim-to-evidence real reach").
   *
   * Deliberately NOT `evaluate(input)`: routing a synthetic per-utterance
   * "tool call" through the full tier stack would feed
   * `flowTracker.record`/`sequenceDetector.record` and the `rate`-type
   * stateful rules (e.g. `runaway-budget-tool-calls`) a phantom call once
   * per assistant utterance — corrupting exactly the trace-derived counters
   * (stuck-loop, runaway-budget, flow) the v0.4 thesis experiment measures
   * off keel's own traces in the guarded arm. It would also newly activate
   * two other `input.reasoning` consumers that have been permanently
   * unpopulated in production until this phase: `unless_reasoning` allow-
   * exceptions (types.ts) and the tier-7 `level: protect` reasoning-anomaly
   * heuristic (evaluateTiers() below) — both are behavior changes with
   * their own review, not a side effect of widening the claim channel's
   * reach. This method only ever touches `type: claim` rules and the
   * `VerificationTracker` state they already share with `type:
   * verification` — nothing else in the pipeline sees this call.
   */
  async evaluateClaim(input: EnforceInput): Promise<EnforceResult> {
    const start = Date.now()
    this.observedMatches = []
    let result: EnforceResult
    try {
      result = this.evaluateClaimTier(input, start)
    } catch (err) {
      // Same fail-safe as evaluate()'s outer catch, for the same invariant.
      if (err === OBSERVE_CONTINUE) {
        result = this.result('allow', '', 'Allowed (observe-only match)', start, false, 0)
      } else {
        throw err
      }
    }
    if (this.observedMatches.length) {
      result.observed_matches = this.observedMatches.map(m => ({ ...m }))
      result.observed_action = this.observedMatches[0].observed_action
      if (result.action === 'allow' && !result.rule_id) {
        const first = this.observedMatches[0]
        result.rule_id = first.rule_id
        result.rule_name = first.rule_id
        result.message = first.message
      }
    }
    return result
  }

  /** The single-rule-type loop evaluateClaim() wraps. See its own header comment. */
  private evaluateClaimTier(input: EnforceInput, start: number): EnforceResult {
    // Same halt-wins-first ordering as evaluateTiers() — without this, a
    // halted session's Stop-hook claim-to-evidence check could still return
    // its OWN independent deny/allow verdict (with a different rule_id and
    // message than the halt), even though every real tool call the agent
    // could use to actually satisfy that claim is already being denied by
    // evaluateTiers(). Deliberately NOT applied to evaluateOutput() below —
    // see that method's own comment for why.
    const halted = this.checkHalt(start)
    if (halted) return halted
    this.checkRuleVersion()
    const level = this.effectiveLevel(input)
    const rules = mergeRules(this.config.ruleHierarchy, level, input.context)
    for (const rule of rules) {
      if (rule.type !== 'claim') continue
      try {
        if (this.verificationTracker.isPending(rule, input)) {
          const claim = detectClaim(input)
          if (claim) {
            const message = `${rule.message} (claimed via ${claim.source}: "${claim.phrase}")`
            return this.violation(input, rule, message, start, 6, rule.id)
          }
        }
      } catch (err) {
        if (err === OBSERVE_CONTINUE) continue
        throw err
      }
    }
    return this.result('allow', '', 'Allowed (no matching claim rule)', start, false, 0)
  }

  /**
   * Scan a completed tool call's OWN output text (`input.tool_output`) for
   * secret-shaped content, reusing the exact `type: content` regex patterns
   * that already gate what gets WRITTEN to a file (`no-secrets-in-code`,
   * `evaluateTiers()`'s Tier 5 content branch above) — sprint/lane-c2's
   * output-capture-and-redact path, for a host's PostToolUse-equivalent
   * hook. Live-verified (not inferred) to actually change what an OpenCode
   * session's model receives when the caller applies `redacted_output` back
   * onto the host's mutable output object — see
   * session/transcripts/opencode-tool-execute-after-mutation-probe.txt and
   * docs/exfil.md's "Output redaction" section. On every OTHER host this
   * result is, at best, a warning a caller can inject as context (Claude
   * Code's `additionalContext`) — see hook.ts.
   *
   * Deliberately NOT `evaluate()` or `evaluateClaim()`: this is a pure
   * text-in, verdict-and-candidate-replacement-text-out function. It never
   * touches flowTracker/sequenceDetector/rate state, never consults
   * VerificationTracker, and — critically — never mutates anything itself;
   * the caller decides whether and how to apply `redacted_output`.
   *
   * `mode: observe` content rules are deliberately excluded from producing
   * an `action: 'redact'` verdict here, the same restraint `evaluate()`'s
   * OBSERVE_CONTINUE gives every other rule type: a rule the user configured
   * to only WATCH must never itself cause a live mutation of what the agent
   * sees — that would be enforcement from a rule believed to be inert, the
   * failure this codebase's own memory calls the worst shape a guardrail can
   * have. An observe-mode content rule that matches output text is still
   * recorded (`redacted_rule_ids` includes it, `observed_matches` carries
   * it), just never contributes its span to `redacted_output`.
   *
   * Bounded: `tool_output` can be multi-megabyte (a large file read, a
   * verbose test run) and this runs on every call through a host's after-
   * hook, awaited on that hook's own hot path. Text past
   * `MAX_OUTPUT_SCAN_CHARS` is not scanned — the result says so
   * (`truncated: true` is folded into the message) rather than silently
   * returning a clean verdict for content it never looked at.
   *
   * Deliberately does NOT check the halt latch (checkHalt(), below) the way
   * evaluateTiers() and evaluateClaimTier() do. This method never blocks —
   * it only ever returns 'allow' or 'redact' for output that already ran —
   * so skipping it during a halt would not stop anything from executing;
   * it would just make a leaked secret MORE likely to reach the model
   * unredacted, which is the opposite of what a lockdown is for.
   */
  async evaluateOutput(input: EnforceInput): Promise<EnforceResult> {
    const start = Date.now()
    const text = input.tool_output
    if (!text) return this.result('allow', '', 'No tool output to scan', start, false, 5)
    this.checkRuleVersion()
    const level = this.effectiveLevel(input)
    // Deliberately NOT gated on `depth`/sprint's "skip content checks for
    // speed" trade-off (evaluateTiers()'s `deepChecks`): that trade-off
    // exists because a blocking content check costs the agent real friction
    // at the fast dial. This check never blocks — the only cost of running
    // it at every dial is the scan itself (bounded below), and a leaked
    // secret is not a cost sprint's speed/safety trade-off was ever meant to
    // accept. A stated choice, not an oversight.
    const rules = mergeRules(this.config.ruleHierarchy, level, input.context)
    const truncated = text.length > MAX_OUTPUT_SCAN_CHARS
    const scanText = truncated ? text.slice(0, MAX_OUTPUT_SCAN_CHARS) : text
    // Three buckets, not two — see `KeelRule.patterns[].redact_span`'s doc
    // comment in types.ts for the full reasoning. A match only ever lands
    // in `matchedRuleIds` (actually mutated) when EITHER: the rule itself is
    // enforcing (not `mode: observe`) AND the specific pattern that matched
    // has `redact_span: true` (its match span is known to fully cover the
    // secret bytes, not just a nearby label) — OR the pattern has
    // `redact_widen` set (types.ts's doc comment on
    // `KeelRule.patterns[].redact_widen`), in which case the label match is
    // widened forward to cover the value/body that follows it before being
    // added as a candidate span. Everything else that matched is still
    // recorded (`spanUnsafeRuleIds`) with the reason it did NOT drive a
    // mutation, because a partial redaction that strips a label while
    // leaving the real secret verbatim is a false-confidence signal — worse
    // than no redaction at all.
    const matchedRuleIds: string[] = []
    const observeOnlyRuleIds: string[] = []
    const spanUnsafeRuleIds: string[] = []
    const widenIncompleteRuleIds: string[] = []
    let matchedPattern: string | undefined

    // Every redact_span:true pattern's occurrences are located against the
    // ORIGINAL `scanText` first, into a flat list of candidate spans — NOT
    // mutated one at a time as they're found. The previous implementation
    // tested each pattern against `scanText` (correct) but then called
    // `redacted.replace(...)` against a string ALREADY REWRITTEN by an
    // earlier pattern's replacement. Two overlapping patterns whose spans
    // covered the same bytes meant the second pattern's `re.test(scanText)`
    // check still passed (it's tested against the untouched original), so
    // it was credited in `matchedRuleIds` as successfully redacted, even
    // though its span had already been consumed/altered by the first
    // pattern's replace() — its own replace() then found nothing left to
    // match (or matched unrelated shifted text) in the already-mutated
    // string, so the region it claimed to redact could survive VERBATIM in
    // the output while still being listed as successfully redacted — false
    // confidence, not partial redaction.
    const candidateSpans: Array<{ start: number; end: number; ruleId: string }> = []
    for (const rule of rules) {
      if (rule.type !== 'content' || !rule.patterns) continue
      for (const pattern of rule.patterns) {
        if (!pattern.regex) continue // `prefix` patterns have no well-defined redaction span
        let re: RegExp
        try { re = new RegExp(pattern.regex, 'gi') } catch { continue }
        if (!re.test(scanText)) continue
        matchedPattern = matchedPattern || pattern.regex
        if (rule.mode === 'observe') {
          if (!observeOnlyRuleIds.includes(rule.id)) observeOnlyRuleIds.push(rule.id)
          continue // recorded, never mutates — see this method's header comment
        }
        if (pattern.redact_span !== true) {
          if (!pattern.redact_widen) {
            if (!spanUnsafeRuleIds.includes(rule.id)) spanUnsafeRuleIds.push(rule.id)
            continue // recorded, never mutates — the match span doesn't bound the secret (types.ts's redact_span doc)
          }
          // `redact_widen` set: this is still a LABEL/HEADER-only match, but
          // one this pattern has opted in to widening — extend each
          // occurrence forward to cover the value/body that follows,
          // bounded (widenLabelSpan's own comment, above), rather than
          // leaving it in spanUnsafeRuleIds untouched.
          const widenFinder = new RegExp(pattern.regex, 'gi')
          let widenOccurrence: RegExpExecArray | null
          while ((widenOccurrence = widenFinder.exec(scanText))) {
            const labelStart = widenOccurrence.index
            const labelEnd = labelStart + widenOccurrence[0].length
            const widened = widenLabelSpan(scanText, labelStart, labelEnd, pattern.redact_widen)
            candidateSpans.push({ start: labelStart, end: widened.end, ruleId: rule.id })
            if (widened.incomplete && !widenIncompleteRuleIds.includes(rule.id)) widenIncompleteRuleIds.push(rule.id)
            if (widenOccurrence[0].length === 0) widenFinder.lastIndex++ // guard a zero-width pattern from looping forever
          }
          continue
        }
        // Locate every occurrence of THIS pattern against the original
        // text — a fresh 'g'-flagged regex so `.lastIndex` starts at 0
        // regardless of what the `re.test()` probe above already advanced.
        const finder = new RegExp(pattern.regex, 'gi')
        let occurrence: RegExpExecArray | null
        while ((occurrence = finder.exec(scanText))) {
          candidateSpans.push({ start: occurrence.index, end: occurrence.index + occurrence[0].length, ruleId: rule.id })
          if (occurrence[0].length === 0) finder.lastIndex++ // guard a zero-width pattern from looping forever
        }
      }
    }

    // Resolve overlaps by MERGING them into their union, rather than
    // picking one span and discarding the other: sort by start, then walk
    // the list folding any span that starts at or before the current
    // group's end into that group (extending its end, recording every
    // contributing rule id). This is the stronger of the two fixes this
    // method's own bug write-up allows for (union vs. skip-and-report) —
    // it means NO byte covered by ANY matched redact_span:true pattern is
    // ever left exposed just because a different pattern also covers it,
    // and every rule that contributed a span to a group is honestly
    // credited for that group's redaction (its bytes really were removed,
    // jointly with the other contributor's).
    candidateSpans.sort((a, b) => a.start - b.start)
    const mergedSpans: Array<{ start: number; end: number; ruleIds: string[] }> = []
    for (const span of candidateSpans) {
      const current = mergedSpans[mergedSpans.length - 1]
      if (current && span.start <= current.end) {
        current.end = Math.max(current.end, span.end)
        if (!current.ruleIds.includes(span.ruleId)) current.ruleIds.push(span.ruleId)
      } else {
        mergedSpans.push({ start: span.start, end: span.end, ruleIds: [span.ruleId] })
      }
    }
    for (const group of mergedSpans) {
      for (const ruleId of group.ruleIds) {
        if (!matchedRuleIds.includes(ruleId)) matchedRuleIds.push(ruleId)
      }
    }

    // A single replacement pass over the ORIGINAL text, in span order —
    // nothing is ever mutated and then re-scanned.
    let redacted = scanText
    if (mergedSpans.length) {
      let out = ''
      let cursor = 0
      for (const group of mergedSpans) {
        out += scanText.slice(cursor, group.start) + `[redacted-by-keel:${group.ruleIds.join('+')}]`
        cursor = group.end
      }
      out += scanText.slice(cursor)
      redacted = out
    }

    const truncNote = truncated ? ` (only the first ${MAX_OUTPUT_SCAN_CHARS} chars were scanned)` : ''
    if (!matchedRuleIds.length) {
      const notes: string[] = []
      if (observeOnlyRuleIds.length) notes.push(`${observeOnlyRuleIds.join(', ')} matched in mode: observe — recorded, not redacted`)
      if (spanUnsafeRuleIds.length) notes.push(`${spanUnsafeRuleIds.join(', ')} matched a label/signature only (redact_span not set) — recorded, not redacted, because the match does not bound the secret`)
      const note = notes.length ? ` (${notes.join('; ')})` : ''
      const result = this.result('allow', '', `No secret-shaped content in tool output${note}${truncNote}`, start, false, 5)
      const detectedOnly = [...new Set([...observeOnlyRuleIds, ...spanUnsafeRuleIds])]
      if (detectedOnly.length) result.redacted_rule_ids = detectedOnly
      // See scan_truncated's doc comment (types.ts): this is the path that
      // was lying by omission — a truncated scan that happened to find
      // nothing in its scanned prefix returned a plain `allow` with no
      // programmatic signal that anything past MAX_OUTPUT_SCAN_CHARS went
      // unlooked-at. `truncNote` already said so in the human-readable
      // message; this is the same fact for a caller that branches on the
      // verdict instead of reading prose.
      if (truncated) result.scan_truncated = true
      return result
    }
    // Set-deduped: a custom `type: content` rule can mix an unmarked
    // pattern (lands in spanUnsafeRuleIds) with a redact_span:true or
    // redact_widen pattern (lands in matchedRuleIds) — same rule id,
    // different pattern, different bucket. Without dedup here the id would
    // appear twice in this message and in the public `redacted_rule_ids`
    // field.
    const allIds = [...new Set([...matchedRuleIds, ...observeOnlyRuleIds, ...spanUnsafeRuleIds])]
    // See EnforceResult.redaction_incomplete_rule_ids' doc comment: a
    // `redact_widen` match that hit its bounded cap before finding a
    // natural closing boundary (newline / PEM footer) is STILL redacted up
    // to that cap — it is not left exposed — but the caller should not
    // treat it as a confirmed-complete removal the way a redact_span:true
    // or a footer-terminated widen match is.
    const widenNote = widenIncompleteRuleIds.length
      ? ` (${widenIncompleteRuleIds.join(', ')} widened to its bounded cap without finding a closing boundary — redacted up to the cap; treat as possibly incomplete)`
      : ''
    const result = this.result('redact', matchedRuleIds[0], `Tool output contained secret-shaped content (${allIds.join(', ')}) — redacted before delivery${widenNote}${truncNote}.`, start, false, 5)
    result.matched_pattern = matchedPattern
    result.redacted_output = truncated ? redacted + text.slice(MAX_OUTPUT_SCAN_CHARS) : redacted
    result.redacted_rule_ids = allIds
    if (widenIncompleteRuleIds.length) result.redaction_incomplete_rule_ids = widenIncompleteRuleIds
    if (truncated) result.scan_truncated = true
    return result
  }

  /**
   * The halt latch — `keel halt`'s inverse of the DISABLED kill switch
   * below. Where DISABLED ALLOWS every call, HALTED DENIES every call, and
   * it is checked strictly before DISABLED (see evaluateTiers()'s and
   * evaluateClaimTier()'s call sites) so halt wins even when both
   * sentinels are present — an agent that already ran `keel disable`
   * cannot escape a halt set afterward, and `keel disable`'s own purpose
   * (turn keel off) does not extend to a halt's purpose (nothing, not even
   * keel's own controls, should un-stick this without a human).
   *
   * Unlike the DISABLED check, there is no expires_at to consult (a halt
   * never auto-clears) and a corrupt sentinel does not throw — it fails
   * closed the OTHER way: existence of the file is itself sufficient to
   * keep denying, so a damaged JSON body degrades the DISPLAYED reason,
   * never the verdict. Reads the file directly (readFileSync in a single
   * try/catch) rather than existsSync()-then-readFileSync(): a bare
   * existsSync() swallows EACCES/ELOOP identically to ENOENT, so "cannot
   * determine" and "confirmed absent" would both read as "not halted" — a
   * permissions glitch would silently defeat the latch. Only a confirmed
   * ENOENT means genuinely not halted; every other read failure (missing
   * permissions, a symlink loop, a corrupt/unparseable body) fails closed.
   */
  private checkHalt(start: number): EnforceResult | null {
    const haltPath = this.config.haltFile || join(resolveHome(), '.keel', 'HALTED')
    let raw: string
    try {
      raw = readFileSync(haltPath, 'utf-8')
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      // Cannot confirm the sentinel is absent — fail closed rather than
      // silently passing every call through.
      return this.result('deny', 'keel-halted', "Keel is HALTED: unable to confirm halt state. Run 'keel resume' to clear.", start, false, 0)
    }
    let reason = 'Manual halt'
    try {
      const state = JSON.parse(raw)
      if (state && typeof state.reason === 'string' && state.reason) reason = state.reason
    } catch {
      reason = 'unknown (corrupt sentinel)'
    }
    return this.result('deny', 'keel-halted', `Keel is HALTED: ${reason}. Run 'keel resume' to clear.`, start, false, 0)
  }

  private async evaluateTiers(input: EnforceInput): Promise<EnforceResult> {
    const start = Date.now()
    // The halt latch is checked before EVERYTHING else, including
    // checkRuleVersion() below — a rules reload/cache invalidation/tracker
    // flush has no reason to run on every call while halted, and checking
    // it first is what makes halt win over the DISABLED kill switch (see
    // checkHalt()'s own header comment).
    const halted = this.checkHalt(start)
    if (halted) return halted
    // The hierarchy is reloaded below (checkRuleVersion); the active level is
    // re-derived from the reloaded rules so the first call after a level change
    // (keel level / enforce --persist) evaluates at the NEW level, not the
    // stale caller-supplied one.
    this.checkRuleVersion()
    const level = this.effectiveLevel(input)
    const depth = input.depth || (level === 'protect' ? 'deep' : level === 'sprint' ? 'fast' : 'full')
    // `level: protect` rules are floors: even at sprint (fast depth) they must
    // stay fully enforced, so their check classes cannot be skipped.
    const protectFloor = (rules: ReturnType<typeof mergeRules>) =>
      rules.some(rule => rule.level === 'protect' && (rule.type === 'content' || rule.type === 'sequence' || rule.type === 'flow'))
    const reasoningChecks = depth === 'deep'

    // Check global kill switch (sentinel file). checkHalt() above already
    // returned if HALTED is set, so reaching this point means the call is
    // not halted — HALTED wins over DISABLED unconditionally (see
    // checkHalt()'s header comment for why), so this DISABLED branch only
    // ever runs when a halt is either absent or already cleared.
    const sentinelPath = this.config.disableFile || join(resolveHome(), '.keel', 'DISABLED')
    if (existsSync(sentinelPath)) {
      try {
        const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf-8'))
        if (sentinel.expires_at && new Date(sentinel.expires_at) < new Date()) {
          rmSync(sentinelPath)
        } else {
          return this.result('allow', '', 'Enforcement disabled via kill switch', start, false, 0)
        }
      } catch (err) {
        // ENOENT is a race: the sentinel was removed by another process between
        // existsSync and readFileSync — treat as not-disabled, not as corruption.
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          // not disabled
        } else {
          throw new Error('Invalid Keel kill-switch state; run `keel enable` to recover')
        }
      }
    }

    // Flow tracking observes every action, not only actions that already
    // violated another rule. This lets a later sink see sensitive reads.
    this.config.flowTracker.record(input, '')

    // Get merged rules for current level and context
    const rules = mergeRules(this.config.ruleHierarchy, level, input.context)
    const deepChecks = depth !== 'fast' || protectFloor(rules)
    const statefulRules = rules.filter(rule =>
      ['verification', 'claim', 'research', 'stuck', 'oscillation', 'rate', 'time'].includes(rule.type)
      || (deepChecks && ['sequence', 'flow', 'oracle'].includes(rule.type))
    )
    // Approval-gated rules are re-evaluated on every call: the user may grant
    // a one-time override (`keel allow <id> --once`) between attempts, so a
    // cached verdict would bypass fresh override checks.
    const gatedRules = rules.filter(rule => this.effectiveAction(rule, input) === 'prompt')
    if (statefulRules.length) {
      const maxWindow = Math.max(...statefulRules.map(rule => rule.sequence_window_seconds || rule.window_seconds || 60))
      this.config.sequenceDetector.setWindow(maxWindow * 1000)
      // Stateful rules depend on every action and cannot use a stateless cache verdict.
      this.config.sequenceDetector.record(input)
    }

    // Floor-first pass: `level: protect` rules are floors and must never be
    // shadowed by a non-floor rule from a DIFFERENT rule-type/loop category.
    // mergeRules() already rank-sorts `rules` (observe, then protect floors,
    // then everything else), so WITHIN one loop a floor rule already sorts
    // ahead of a non-floor one — but this method runs the statefulRules
    // loop just below (verification/claim/research-trigger) BEFORE it ever
    // reaches the tiered rule-matching loop (command/filesystem/network/
    // etc — runTieredRules(), below), and that unconditional ordering
    // ignores rank entirely. A `level: protect` floor rule of type command
    // (e.g. no-force-push) would then only be evaluated AFTER the
    // statefulRules loop already had a chance to `return` for an unrelated
    // non-floor rule (e.g. a promoted `source-change-requires-test`
    // verification rule), silently shadowing the floor.
    //
    // Fix: run the floor subset of runTieredRules()'s rule types FIRST,
    // before statefulRules ever starts, so those floors can always return
    // ahead of any non-floor verification/claim/research-trigger rule.
    // verification/claim are excluded from this floor-first subset — they
    // are EXCLUSIVELY handled inside the statefulRules loop (boundary/
    // isPending), which already runs before the remaining tiered pass, so
    // they were never shadowable in the first place; moving their handling
    // earlier would only reorder verificationTracker.observeTrigger() (still
    // fired later, inside runTieredRules()) relative to the boundary/
    // isPending check for no benefit and real risk of changing obligation-
    // tracking semantics. `research` is NOT excluded: a `topics`-based
    // (knowledge-freshness) floor rule is ONLY ever evaluated inside
    // runTieredRules() (the statefulRules loop's research handling requires
    // `rule.trigger`), so it needs the same floor-first protection as
    // command/filesystem/etc.
    //
    // `mode: observe` rules are ALSO included in this first pass — not
    // because they are floors, but because mergeRules()'s rank(0 = observe,
    // 1 = protect floor, 2 = everything else) exists specifically so an
    // observe rule "always gets its chance to record before anything below
    // it decides the call" (rule-parser.ts's own comment, backed by
    // pipeline.test.ts's observe-continue block). A first pass filtered on
    // `level: protect` ALONE would invert that for exactly the case that
    // test covers: a non-floor observe rule sits at rank 0 in `rules`, so
    // without this it would only run in the SECOND pass (after
    // statefulRules) while a `level: protect` deny rule matching the same
    // command now runs in the FIRST pass and returns before the observe
    // rule ever gets to record — turning "observe records, then the real
    // rule decides" into "the floor decides and the observe rule's own
    // match on this call is silently lost," a regression of the same
    // shadowing class this fix exists to close. Including observe rules
    // here is free: violation() never lets one return (OBSERVE_CONTINUE is
    // thrown and caught by runTieredRules' own try/catch), so hoisting one
    // ahead of the statefulRules loop cannot change what decides the call —
    // only what it silently loses the chance to record.
    const cmdSurfacesBox: { value?: string[] } = {}
    const isStatefulOnlyRuleType = (t: string) => t === 'verification' || t === 'claim'
    const floorTieredRules = rules.filter(rule => (rule.mode === 'observe' || rule.level === 'protect') && !isStatefulOnlyRuleType(rule.type))
    const floorTieredSet = new Set(floorTieredRules)
    if (floorTieredRules.length) {
      const floorResult = this.runTieredRules(floorTieredRules, input, start, deepChecks, cmdSurfacesBox)
      if (floorResult) return floorResult
    }

    for (const rule of statefulRules) {
      // See OBSERVE_CONTINUE's header comment: a `mode: observe` match
      // inside this iteration throws instead of returning from
      // violation(). Catching it here records the observation (already
      // pushed to this.observedMatches by violation()) and moves on to the
      // NEXT rule instead of exiting evaluateTiers() — an observe rule can
      // no longer blind a later rule on the same call.
      try {
        if (rule.type === 'verification') {
          const boundaryMessage = this.verificationTracker.boundary(rule, input)
            if (boundaryMessage) {
              const stateKey = `${rule.id}:${input.cwd}`
              const boundaryRule: KeelRule = boundaryMessage.action
                ? { ...rule, action: boundaryMessage.action as KeelRule['action'] }
                : rule
              return this.violation(input, boundaryRule, boundaryMessage.message, start, 6, stateKey)
            }
        }

        // Claim-to-evidence obligations: reuses the SAME trigger/satisfy/
        // pending state machine as `type: verification` (see
        // verification.ts's isObligationRule and types.ts's field comment).
        // While an edit's obligation is still pending — no test/build command
        // has been seen since, or the last one seen never discharged it
        // (including a FAILED run: markSatisfied is only ever called by the
        // host after a zero exit code, so a failing run leaves the obligation
        // pending exactly like no run at all) — any claim-shaped text on this
        // or a later call fires. The rule cannot and does not try to
        // distinguish "never ran" from "ran and failed"; both are "no
        // evidence of success since the edit", which is what the message says.
        if (rule.type === 'claim' && this.verificationTracker.isPending(rule, input)) {
          const claim = detectClaim(input)
          if (claim) {
            const message = `${rule.message} (claimed via ${claim.source}: "${claim.phrase}")`
            return this.violation(input, rule, message, start, 6, rule.id)
          }
        }
        // Research-before-solve obligations: a pending obligation (a failing
        // command was seen, no fresh research since) gates the next fix via
        // its boundaries. Discharge happens below and on recordAttemptOutcome.
        if (rule.type === 'research' && rule.trigger && this.config.researchTracker) {
          const researchTracker = this.config.researchTracker
          if (researchTracker.discharge(rule, input)) continue
          const boundaryMessage = researchTracker.boundary(rule, input)
          if (boundaryMessage) {
            const boundaryRule: KeelRule = boundaryMessage.action
              ? { ...rule, action: boundaryMessage.action as KeelRule['action'] }
              : { ...rule, action: 'redirect' as const }
            const directive: RedirectDirective = {
              kind: 'research',
              required_tools: rule.satisfy?.tools?.length ? rule.satisfy.tools : ['keel_research'],
              target: `fix action while a failing command still lacks fresh research`,
              rationale: rule.message,
              rule_id: rule.id,
              suggested_call: `keel_research({ query: "<the failing module or error>" })`,
            }
            return this.violation(input, boundaryRule, boundaryMessage.message, start, 6, rule.id, directive, true)
          }
        }
      } catch (err) {
        if (err === OBSERVE_CONTINUE) continue
        throw err
      }
    }

    // ── Tier 1: Cache check ──
    const cached = statefulRules.length || gatedRules.length || input.action_override ? null : this.config.cache.get(
      input.tool, input.args, this.config.ruleVersion, this.cacheContext(input, depth),
    )
    if (cached) {
      if (cached.verdict === 'deny' || cached.verdict === 'block') {
        if (cached.rule_id && this.overrideStore.consume(cached.rule_id, input.session_id)) {
          return this.result('allow', cached.rule_id, this.overrideMessage(cached.rule_id), start, true, 1)
        }
        return this.result('deny', cached.rule_id || '', 'Cached deny verdict', start, true, 1)
      }
      if (cached.verdict === 'allow') {
        return this.result('allow', '', 'Allowed (cached)', start, true, 1)
      }
    }

    // ── Tier 2-3: Match rules against action ──
    // Lazily computed once per evaluate() call (not per rule) — the
    // command-normalizer sits on this hot path, see command-normalizer.ts's
    // perf caps. `undefined` until the first `type: command` rule needs it.
    const remainingTieredRules = floorTieredRules.length ? rules.filter(rule => !floorTieredSet.has(rule)) : rules
    const tieredResult = this.runTieredRules(remainingTieredRules, input, start, deepChecks, cmdSurfacesBox)
    if (tieredResult) return tieredResult

    // ── Tier 7: Reasoning coherence check ──
    if (reasoningChecks && level === 'protect' && input.reasoning) {
      // Simple heuristic: if agent is doing something it shouldn't
      const dangerSignals = [
        /ignore.*(rule|policy|restrict)/i,
        /bypass.*(check|guard|protect)/i,
        /disable.*(safety|keel|hook)/i,
        /workaround.*(rule|block)/i,
        /don'?t tell.*(user|human)/i,
        /hid(e|den).*(action|change)/i,
      ]
      for (const signal of dangerSignals) {
        if (signal.test(input.reasoning)) {
          return this.result('warn', 'reasoning-anomaly', `Suspicious reasoning pattern detected`, start, false, 7)
        }
      }
    }

    // ── Allowed — cache and return ──
    // Never cache a call that recorded an observe match: a `(tool, args)`
    // pair that trips an observe rule needs to be re-evaluated (and
    // re-recorded) on every repeat, since a cached tier-1 `allow` on the
    // NEXT identical call would return before the rules loop ever runs —
    // exactly the traffic an observe rule burning in most needs to count,
    // silently starving its shadow counters.
    if (!statefulRules.length && !gatedRules.length && !this.observedMatches.length) {
      this.config.cache.set(input.tool, input.args, this.config.ruleVersion, {
        verdict: 'allow',
        rule_id: null,
        count: 0,
        timestamp: Date.now(),
      }, this.cacheContext(input, depth))
    }

    return this.result('allow', '', 'Allowed (no matching rule)', start, false, 0)
  }

  /**
   * The tiered rule-matching loop (rate/time/command/filesystem/network/
   * package/stuck/diagnosis/research(topics)/env/content/oracle/sequence/
   * flow/session) — Tiers 2 through 6. Extracted out of evaluateTiers() so
   * it can be run TWICE over two different slices of the same rank-ordered
   * `rules` list: once for the `mode: observe` + `level: protect` subset —
   * ranks 0 and 1, in that relative order — (before the statefulRules loop
   * even starts), and once for everything else (in its original position,
   * after statefulRules) — see evaluateTiers()'s "Floor-first pass" comment
   * for why observe rules ride along with the floors instead of only the
   * floors moving. `cmdSurfaces` is boxed so both calls share the same
   * lazily-computed memo instead of recomputing it.
   * Returns the first violation/result produced by any rule in `list`, or
   * `undefined` if none of them produced a verdict.
   */
  private runTieredRules(list: KeelRule[], input: EnforceInput, start: number, deepChecks: boolean, cmdSurfaces: { value?: string[] }): EnforceResult | undefined {
    for (const rule of list) {
      // See OBSERVE_CONTINUE's header comment and the identical try/catch
      // on the statefulRules loop above: this try wraps every tier-2
      // through tier-6 check below (rate/time/command/filesystem/network/
      // package/stuck/diagnosis/research/env/content/oracle/sequence/flow)
      // so a `mode: observe` match on ANY of them records and falls
      // through to the next rule instead of exiting evaluateTiers().
      // Deliberately NOT re-indented (the block below is unchanged from
      // before this fix) — the try/catch is the minimal diff that gets
      // continue semantics without re-flowing ~400 lines of tier logic.
      try {
      // Check rate limit rules
      if (rule.type === 'rate') {
        const matchPattern = rule.match || input.tool
        // Try the real command text first — a JSON-escaped haystack breaks
        // quoted commands and end-of-string anchors (see commandString).
        // The raw-args surface stays as a fallback so a rate rule targeting
        // a non-command arg value keeps working.
        if (rule.match
          && !this.matchesRulePattern(rule.match, `${input.tool} ${commandString(input)}`)
          && !this.matchesRulePattern(rule.match, `${input.tool} ${JSON.stringify(input.args)}`)) continue
        const windowSec = rule.window_seconds || 60
        const maxCalls = rule.max_calls || 10
        const rateKey = `rate:${rule.id}:${matchPattern}`
        const now = Date.now()
        const existing = this.rateCounts.get(rateKey)

        const exceeded = this.config.stateManager
          ? this.config.stateManager.checkRateLimit(rule.id, matchPattern, windowSec, maxCalls)
          : (() => {
            if (existing && (now - existing.windowStart) < windowSec * 1000) {
              existing.count++
              return existing.count > maxCalls
            }
            this.rateCounts.set(rateKey, { count: 1, windowStart: now })
            return false
          })()
        if (this.config.stateManager) {
          const persisted = this.config.stateManager.rateCounts[rateKey]
          if (persisted) this.rateCounts.set(rateKey, { ...persisted })
        }
        if (exceeded) {
          return this.violation(input, rule, `Rate limit: ${maxCalls} calls per ${windowSec}s for "${matchPattern}"`, start, 2)
        }
        continue
      }

      // Check time-based rules
      if (rule.type === 'time' && rule.schedule) {
        const now = new Date()
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        const currentDay = dayNames[now.getDay()]
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
        const { start: windowStart, end: windowEnd, days } = rule.schedule

        // Optional command match: without it the rule fires on EVERY action
        // outside its schedule, which is almost never what a time rule wants.
        if (rule.match) {
          const cmdStr = commandString(input)
          if (!this.matchesRulePattern(rule.match, cmdStr)) continue
        }

        if (days && !days.some(d => d.toLowerCase() === currentDay)) {
          // Today is outside schedule
          return this.violation(input, rule, `Outside schedule: ${days.join(', ')} ${windowStart}-${windowEnd}`, start, 2)
        }
        if (windowStart && windowEnd) {
          // The schedule is the ALLOWED window. A window with start > end
          // spans midnight (e.g. 22:00-09:00 is allowed overnight): the naive
          // "before start OR after end" test is then always true, so an
          // overnight window needs the inverted comparison.
          const inside = windowStart <= windowEnd
            ? (currentTime >= windowStart && currentTime <= windowEnd)
            : (currentTime >= windowStart || currentTime <= windowEnd)
          if (!inside) {
            return this.violation(input, rule, `Outside schedule window: ${windowStart}-${windowEnd}`, start, 2)
          }
        } else if (windowStart && currentTime < windowStart) {
          return this.violation(input, rule, `Before schedule start: ${windowStart}`, start, 2)
        } else if (windowEnd && currentTime > windowEnd) {
          return this.violation(input, rule, `After schedule end: ${windowEnd}`, start, 2)
        }
        continue
      }

      // Match against command patterns. Matched against BOTH the raw
      // command text and the bounded-normalized surfaces (quote-
      // obfuscation stripped, compound commands split, inline vars
      // expanded, interpreter bodies exposed — command-normalizer.ts) so a
      // rule that only ever matched the raw string keeps matching it
      // (surfaces[0] is always raw — see commandSurfaces' doc), and now
      // additionally catches the normalized-only bypasses.
      //
      // TWO exceptions stay pinned to the raw string ONLY (`cmdStr`), both
      // because widening them would make the ADDITIVE guarantee false —
      // either one could turn a command that used to deny into an allow:
      //   - `unless`: widening the EXCEPTION check with the same `some()`
      //     used for the match check is not "conservative," it is
      //     subtractive — a normalized-only surface could satisfy an
      //     `unless` pattern the raw string never satisfied, exempting a
      //     command that denied before this lane existed.
      //   - `fix`-actioned rules: `fixAction()` (and `violation()`'s own
      //     internal fix branch, for a rule reached a different way)
      //     mutate and report the RAW command text unconditionally once
      //     triggered — neither re-checks that the pattern actually
      //     matched that raw text. A normalized-only match on a `fix` rule
      //     would produce a PHANTOM fix: `fix_result.original ===
      //     fix_result.fixed` (the raw string never contained what the
      //     pattern found only in a normalized surface), silently
      //     reporting a mutation that never happened — its own instance of
      //     "a control that lies." So a `fix`-actioned rule is gated on
      //     `cmdStr` alone for BOTH the trigger and the mutation, exactly
      //     its pre-A2 behavior; only non-fix actions (deny/warn/prompt/
      //     redirect/...) get the wider normalized surface.
      if (rule.type === 'command' && (rule.match || rule.match_regex || rule.match_prefix)) {
        const cmdStr = commandString(input)
        const isFix = this.effectiveAction(rule, input) === 'fix' && !!rule.fix
        const pattern = rule.match_regex || rule.match
        let matches: boolean
        if (isFix) {
          matches = rule.match_prefix
            ? cmdStr.toLowerCase().startsWith(rule.match_prefix.toLowerCase())
            : !!pattern && this.matchesRulePattern(pattern, cmdStr)
        } else {
          cmdSurfaces.value ??= commandSurfaces(input)
          matches = rule.match_prefix
            ? cmdSurfaces.value.some(s => s.toLowerCase().startsWith(rule.match_prefix!.toLowerCase()))
            : !!pattern && cmdSurfaces.value.some(s => this.matchesRulePattern(pattern, s))
        }

        if (matches) {
          // Check unless_reasoning
          if (rule.unless_reasoning && input.reasoning) {
            const unlessRegex = new RegExp(rule.unless_reasoning, 'i')
            if (unlessRegex.test(input.reasoning)) {
              continue  // Reasoning explains the action — allow
            }
          }

          // Check unless patterns — raw-only, see the block comment above.
          if (rule.unless) {
            let shouldSkip = false
            for (const u of rule.unless) {
              if (u.regex) {
                const unlessRegex = new RegExp(u.regex, 'i')
                if (unlessRegex.test(cmdStr)) {
                  shouldSkip = true
                  break
                }
              }
            }
            if (shouldSkip) continue
          }

          // Fix action — mutate arguments (operates on the RAW command text).
          if (isFix) {
            return this.fixAction(input, rule, cmdStr, start)
          }

          return this.violation(input, rule, rule.message, start, 2)
        }
      }

      // Match against filesystem patterns
      // Reads are skipped (mirroring content rules): reading a secret file
      // for legitimate config work must not double-flag, and exfiltration of
      // read data is the flow rules' job. Filesystem rules police writes.
      if (rule.type === 'filesystem' && rule.paths && !/^read/i.test(input.tool)) {
        const args = input.args as Record<string, unknown>
        const pathStr = argPath(args)
        const resolvedPath = resolveMaybeRelative(pathStr, input.cwd)
        const operation = String(args.operation || '')
        const excluded = (rule.exclude || []).some(p => this.pathMatches(resolvedPath, p))
        // Positives OR together (matches if ANY positive pattern matches);
        // negations (`!pattern`) AND-exclude (excluded if it matches ANY
        // negated pattern) — standard allow/deny-list semantics. An
        // earlier version ran the whole list through a single `.some()`,
        // which meant a negated entry alongside a positive one (e.g.
        // `["**/*.ts", "!**/node_modules/**"]`) matched on EITHER "is a
        // .ts file" OR "is outside node_modules" — the latter is true for
        // nearly every write, so the negation inverted into matching
        // almost everything instead of excluding node_modules from the
        // .ts match. A paths list containing ONLY negated entries (no
        // shipped rule does this, but the pipeline test suite does) keeps
        // its existing meaning: matches when the value matches NONE of
        // the negated patterns (there's no positive to require).
        const positivePatterns = rule.paths.filter(p => !p.startsWith('!'))
        const negatedPatterns = rule.paths.filter(p => p.startsWith('!')).map(p => p.slice(1))
        const positiveMatched = positivePatterns.length === 0
          ? true
          : positivePatterns.some(p => this.pathMatches(resolvedPath, p))
        const negatedExcluded = negatedPatterns.some(p => this.pathMatches(resolvedPath, p))
        const pathMatched = positiveMatched && !negatedExcluded
        const operationMatched = !rule.operations?.length || rule.operations.includes(operation as any)
        if (pathMatched && operationMatched && !excluded) return this.violation(input, rule, rule.message, start, 3)
      }

      // Match against network patterns
      if (rule.type === 'network' && rule.match) {
        const url = typeof input.args === 'object' && input.args !== null
          ? (input.args as Record<string, unknown>).url || (input.args as Record<string, unknown>).host || ''
          : ''

        const urlStr = String(url)
        // Check except list first
        if (rule.except) {
          let isExcepted = false
          for (const ex of rule.except) {
            if (urlStr.includes(ex)) { isExcepted = true; break }
          }
          if (isExcepted) continue
        }

        if (this.matchesRulePattern(rule.match, urlStr)) return this.violation(input, rule, rule.message, start, 3)
      }

      // Match against package-install commands (slopsquatting gate). Lazy
      // by construction: extractPackageInstalls is a cheap regex/tokenizer
      // pass, and this branch never makes a network call of its own. See
      // enforce/package-verifier.ts for the full verdict semantics.
      //
      // CACHE-FIRST, NEVER-BLOCKS-ON-NETWORK DESIGN (v0.4 package-lookup
      // budget fix — replaces an earlier version of this branch that
      // called `checkPackages(..., { totalTimeoutMs: 2000 })` synchronously
      // here, which meant a cache MISS against a slow/unreachable registry
      // blocked THIS call for up to 2000ms — a ~40x violation of the
      // <50ms hot-path budget, measured directly in
      // session/v04/EVIDENCE/a4-perf.md §5.3 (2003.8ms / 2003.5ms). Fixed
      // as two stages:
      //   1. `checkPackagesCacheOnly` — disk-cache read only, zero I/O, no
      //      `await`. A fresh cached verdict (deny/prompt/allow) is used
      //      exactly as before. This is what keeps a REPEAT install of the
      //      same package fast and deterministic.
      //   2. A cache MISS never blocks: it comes back as an `unverified` /
      //      `not_yet_checked` placeholder, which `decidePackageAction`
      //      downgrades to `prompt` — honoring this gate's existing
      //      "unverified -> prompt" design instead of inventing a new
      //      action. `scheduleBackgroundVerification` is then fired for the
      //      miss with `void` (never awaited) to fill the cache for the
      //      NEXT call on that package; the background lookup keeps its
      //      own 2s budget but cannot block this evaluate() call because
      //      nothing here awaits it.
      //
      // Known, accepted tradeoff: the FIRST attempt at an uncached
      // nonexistent package now prompts (not_yet_checked) rather than
      // denying — only a REPEAT of the same install (after the background
      // fill lands a `not_found` verdict in the cache) gets the
      // deterministic deny. The human-approval prompt still stops a blind
      // install on the first attempt; it just isn't the instant
      // deterministic deny the old synchronous path gave (at the cost of
      // blocking every miss for up to 2s). This also means the background
      // fill's completion is host-dependent: it survives in a long-lived
      // host process (the opencode plugin constructs one EnforcementPipeline
      // per plugin load and reuses it for the whole session; same for the
      // MCP daemon), but a short-lived host that calls `process.exit()`
      // right after rendering the verdict (packages/cli/src/commands/
      // hook.ts's claude-code/codex/gemini/cursor path) kills the
      // background promise before it can complete — process.exit()
      // terminates immediately regardless of any timer's ref state, so
      // the deny-on-retry guarantee does not hold there today. Out of this
      // branch's scope to fix (hook.ts is a different lane's file); noted
      // here so it isn't mistaken for a universal guarantee.
      //
      // Action mapping is PARTIALLY fixed, not fully rule-configurable:
      //   - not_found  -> forced 'deny', skipFirstWarning (unfulfillable
      //     regardless of intent — a cache-confirmed hallucinated install
      //     is already blocked, not just warned).
      //   - known_hallucination -> forced 'deny', skipFirstWarning — same
      //     high-confidence treatment as not_found, for the same reason:
      //     a name documented as an LLM hallucination target that
      //     ALSO currently resolves on the registry is the deterministic
      //     slopsquatting shape (see package-verifier.ts's
      //     decidePackageAction header), not a case that benefits from a
      //     softer first-warning.
      //   - unverified -> forced 'prompt' (network failure / timeout /
      //     scoped-404 / budget-exhausted / not-yet-checked must NEVER
      //     deny — a hallucination-registry match on an unverified result
      //     still only prompts, per the same invariant; see
      //     buildUnverifiedMessage).
      //   - age_gate   -> the rule's own declared `action` (this is the
      //     "configurable" axis the rule author controls, e.g. downgrade
      //     to `warn` or escalate to `deny` for the age check specifically).
      //
      // Tier-1 cache note: `gatedRules` (above, computed from each rule's
      // STATIC declared `action`) already excludes this rule from the
      // stateless allow-cache as long as it ships `action: prompt` (the
      // default) — a network verdict must never be cached forever by
      // (tool, args) alone, since the age-gate outcome for the same
      // command changes as the package ages past the threshold, and a
      // not_yet_checked miss becomes a real verdict once the background
      // fill lands. If a rule author overrides the top-level `action` to
      // something other than `prompt` (e.g. `warn`), that automatic
      // exclusion no longer applies and an identical install command CAN
      // cache a stale tier-1 `allow` until the rules file changes —
      // acceptable for the shipped default (`action: prompt`), called out
      // here for anyone reconfiguring it.
      if (rule.type === 'package') {
        const cmdStr = commandString(input)
        const rawSpecs = extractPackageInstalls(cmdStr)
        if (rawSpecs.length === 0) continue
        // Ambient package-manager config (.npmrc/pip.conf/.cargo/config.toml/
        // GOPRIVATE) — offline, synchronous, only runs for a command that
        // already matched an install pattern. See ambient-registry-config.ts
        // for the false-deny bug this closes: a name that resolves via a
        // team's internal registry, with NO command-line signal at all, no
        // longer hard-denies on the first try.
        const specs = applyAmbientConfig(rawSpecs, input.cwd, process.env, this.ambientConfigCache)
        const ageThresholdDays = rule.age_days ?? 30
        const { results, misses } = checkPackagesCacheOnly(specs, this.packageVerifierCache)
        if (misses.length > 0) {
          // Fire-and-forget: NEVER awaited on the hot path. `void` makes
          // that explicit at the call site; the settlement promise only
          // ever leaves this function via the test-only observer hook.
          const settled = scheduleBackgroundVerification(misses, {
            ageThresholdDays,
            totalTimeoutMs: 2000,
            cache: this.packageVerifierCache,
            fetchImpl: this.config.packageVerifierFetch,
          })
          this.config.packageVerifierOnBackgroundStart?.(settled)
        }
        const decision = decidePackageAction(results, ageThresholdDays)
        if (decision.reason === 'ok') continue
        if (decision.reason === 'not_found') {
          return this.violation(input, { ...rule, action: 'deny' }, decision.message, start, 3, rule.id, undefined, true)
        }
        if (decision.reason === 'known_hallucination') {
          // Same forced-deny + skipFirstWarning treatment as not_found —
          // see this branch's own header note above and
          // decidePackageAction's header for why this is a high-confidence
          // deny, not a softer warn/prompt.
          return this.violation(input, { ...rule, action: 'deny' }, decision.message, start, 3, rule.id, undefined, true)
        }
        if (decision.reason === 'unverified') {
          return this.violation(input, { ...rule, action: 'prompt' }, decision.message, start, 3)
        }
        if (decision.reason === 'dependency_confusion') {
          // Forced 'warn' — deliberately weaker than deny/prompt, and only
          // ever reached (per decidePackageAction's own priority order)
          // once every package in the command has ALREADY cleared
          // not_found/unverified/age_gate. See ambient-registry-config.ts's
          // header and decidePackageAction's own comment for why this must
          // never outrank a deny.
          return this.violation(input, { ...rule, action: 'warn' }, decision.message, start, 3)
        }
        // age_gate — rule.action stands as declared.
        return this.violation(input, rule, decision.message, start, 3)
      }

      // Match against stuck-loop rules: the same failing command fingerprint
      // repeated within a window escalates (3 → redirect, 5 → deny). Counts
      // are recorded by the after-hook via recordAttemptOutcome.
      if (rule.type === 'stuck' && rule.match && this.config.stuckTracker) {
        const cmdStr = commandString(input)
        if (!this.matchesRulePattern(rule.match, cmdStr)) continue
        const escalation = this.config.stuckTracker.check(rule, input)
        if (escalation) {
          const directive: RedirectDirective = {
            kind: 'stuck',
            required_tools: ['keel_research', 'keel_hypothesis'],
            target: `identical failing command (${escalation.attempts} attempts)`,
            rationale: rule.message,
            rule_id: rule.id,
            attempts: escalation.attempts,
            suggested_call: 'keel_research({ query: "<the exact error text>" })',
          }
          return this.violation(input, { ...rule, action: escalation.action }, escalation.message, start, 2, rule.id, directive, true)
        }
        continue
      }

      // Match against oscillation rules: a short repeating CYCLE of >= 2
      // DISTINCT recent command fingerprints (A→B→A→B) within one session's
      // rolling window — the sibling of the stuck-loop branch above, not a
      // duplicate of it: that branch only ever fires on the SAME fingerprint
      // repeated (bucketed per fingerprint), so a genuine A→B→A→B never
      // accumulates a count there at all, and this branch's own
      // distinct-fingerprint guard (oscillation-tracker.ts's `check()`)
      // means a pure exact-repeat never satisfies IT either — the two are
      // complementary, never double-counting the same evidence. Scoped to
      // Bash calls and WRITE_TOOL_NAMES (the same curated write-tool set the
      // session-runaway-trip branch below already uses for its own
      // file_write_churn dimension — see its own comment for why the looser
      // `!/^read/i` heuristic was tried and rejected): oscillation is about
      // commands/edits that actually DO something, not read-only
      // exploration. `rule.match`, if declared, is an ADDITIONAL filter on
      // top of that scope (unlike `type: stuck`, where `match` is the ONLY
      // gate) — optional because a session-scoped detector watching "every
      // mutating call" is a coherent default with no filter at all.
      if (rule.type === 'oscillation' && this.config.oscillationTracker) {
        const isTrackedTool = input.tool === 'Bash' || WRITE_TOOL_NAMES.has(input.tool.toLowerCase())
        if (!isTrackedTool) continue
        if (rule.match) {
          const cmdStr = commandString(input)
          if (!this.matchesRulePattern(rule.match, cmdStr)) continue
        }
        const escalation = this.config.oscillationTracker.check(rule, input)
        if (escalation) {
          const directive: RedirectDirective = {
            kind: 'oscillation',
            required_tools: ['keel_research', 'keel_hypothesis'],
            target: `oscillating pattern: ${escalation.cycle.join(' → ')} (repeated ${escalation.attempts} times)`,
            rationale: rule.message,
            rule_id: rule.id,
            attempts: escalation.attempts,
            suggested_call: 'keel_research({ query: "<why this keeps reverting>" })',
          }
          return this.violation(input, { ...rule, action: escalation.action }, escalation.message, start, 2, rule.id, directive, true)
        }
        continue
      }

      // Match against budget rules (real token/dollar spend — distinct
      // from the call-VOLUME `type: rate` runaway-budget-* rules). This is
      // the ENTIRE blocking-path contract for `type: budget`: it only
      // ever reads the persisted flag `BudgetTracker.record()` already
      // wrote from a Stop/PostToolUse-equivalent hook — it never reads a
      // transcript or database on this call. See types.ts's `max_tokens`
      // comment and budget-tracker.ts's own header for the full two-phase
      // rationale (Claude Code's Stop hook cannot block, so the only
      // race-free enforcement point is the NEXT PreToolUse call, gated on
      // state that already settled).
      if (rule.type === 'budget' && this.config.budgetTracker) {
        const deny = this.config.budgetTracker.checkDeny(rule, input)
        if (deny) {
          return this.violation(input, rule, deny.message, start, 3, rule.id)
        }
        continue
      }

      // Match against diagnosis rules (root-cause marker): complex or
      // destructive fixes are gated on a fresh hypothesis (or diagnosis
      // evidence) for the session's active problem in the ledger.
      if (rule.type === 'diagnosis' && this.config.ledger) {
        const cmdStr = commandString(input)

        // Diagnosis evidence actions (git log/blame/bisect) are recognized
        // regardless of the trigger — they record evidence on the active
        // problem and pass.
        if (rule.fallback_tools?.includes(input.tool) && rule.fallback_pattern && this.matchesRulePattern(rule.fallback_pattern, cmdStr)) {
          const activeKey = this.config.ledger.activeProblemKey(input.session_id)
          if (activeKey) this.config.ledger.recordDiagnosis(activeKey, cmdStr)
          continue
        }

        if (!rule.match) continue
        // Diagnosis rules gate on the CONTENT of a complex change (a write
        // whose body says "refactor"), not a shell command, so the raw-args
        // JSON surface stays primary here — stripping content keys (as
        // commandString does) would blind the gate to exactly what it
        // watches for. The command surface is tried too, additively, so an
        // anchored pattern can still match a Bash invocation without
        // JSON-escaping distortion; neither surface can remove a match the
        // other finds.
        const cmdHaystack = `${input.tool} ${cmdStr}`
        const jsonHaystack = `${input.tool} ${JSON.stringify(input.args)}`
        if (!this.matchesRulePattern(rule.match, jsonHaystack) && !this.matchesRulePattern(rule.match, cmdHaystack)) continue
        const windowSec = rule.hypothesis_window_seconds ?? 900
        const problemKey = this.config.ledger.activeProblemKey(input.session_id)
        // Nothing is failing — nothing to diagnose; never stall green work.
        if (!problemKey) continue

        const hasHypothesis = this.config.ledger.hasFreshHypothesis(problemKey, windowSec)
        const hasDiagnosis = this.config.ledger.hasFreshDiagnosis(problemKey, windowSec)
        if (hasHypothesis || hasDiagnosis) continue

        const directive: RedirectDirective = {
          kind: 'diagnosis',
          required_tools: rule.hypothesis_tools ?? ['keel_hypothesis'],
          target: 'complex fix without a stated root cause',
          rationale: rule.message,
          rule_id: rule.id,
          suggested_call: 'keel_hypothesis({ statement: "Because X, Y fails. Fix: Z." })',
        }
        return this.violation(input, { ...rule, action: rule.action || 'redirect' }, rule.message, start, 2, rule.id, directive, true)
      }

      // Match against knowledge-freshness rules: the agent is about to act
      // on a topic whose session research is missing or stale. Excluded
      // from the Tier-1 allow-cache (stateful per session) so a cached
      // `allow` can never let stale knowledge through.
      if (rule.type === 'research' && rule.topics?.length) {
        const haystack = `${commandString(input)} ${input.reasoning || ''}`
        if (!rule.topics.some((t) => this.matchesRulePattern(t, haystack))) continue
        if (rule.except?.some((d) => haystack.includes(d))) continue
        if (!this.config.researchCache) continue

        const maxAgeHours = rule.max_age_hours ?? (Number(process.env.KEEL_RESEARCH_MAX_AGE_HOURS) || 24)
        const probe = this.config.researchCache.probe(input.session_id, rule.topics, maxAgeHours)
        if (probe.hit) continue

        const topic = rule.topics[0]
        const missing = probe.entries.length === 0
        const directive = {
          topic,
          missing,
          stalenessHours: probe.stalenessHours,
          maxAgeHours,
          suggestion: `Run keel_research { query: "${topic}" } (or your platform web_search), then re-run this action.`,
        }
        return this.result('research', rule.id, `Knowledge freshness gate: ${missing ? 'no research' : `research ${probe.stalenessHours?.toFixed(1)}h old (max ${maxAgeHours}h)`} for "${topic}". ${directive.suggestion}`, start, false, 3, undefined, directive)
      }

      // Match against environment variable names appearing in the command
      // (echo $VAR, printenv VAR, export VAR=...) — the pipeline has no
      // access to the agent's process environment, so matching is on the
      // command/args text. Never on file content (commandString strips it).
      if (rule.type === 'env' && rule.vars?.length) {
        const cmdStr = commandString(input)
        const varHit = rule.vars.some(v => cmdStr.toLowerCase().includes(String(v).toLowerCase()))
        if (varHit) return this.violation(input, rule, rule.message, start, 3)
      }

      // Match against content patterns (Tier 5 — only if file changed)
      // Content rules police writes: a read of an already-written file would
      // double-flag content the write rule already accepted, and pure reads
      // (e.g. reading .env to detect exfiltration via flow rules) must pass.
      if (deepChecks && rule.type === 'content' && rule.patterns && !/^read/i.test(input.tool)) {
        const args = input.args as Record<string, unknown>
        const pathStr = argPath(args)
        const resolvedPath = resolveMaybeRelative(pathStr, input.cwd)
        // apply_patch carries the new content in patchText and the target
        // path only inside `*** Add File:` markers — both are honored here.
        const patchText = String(args.patchText || '')
        // An Edit-shaped call (oldString/newString — the shape a host's
        // in-place string-replace tool sends) carries the content the
        // agent is ABOUT to write in `newString`, not `content`/`text` —
        // omitting it here made every Edit-shaped call invisible to
        // `no-secrets-in-code` (a Tier-2 DENY rule) and
        // `test-oracle-env-introspection`: an agent could write a secret
        // into a file via Edit and this branch would scan an empty string.
        // `new_string` (snake_case) is ALSO checked: Claude Code's real
        // Edit tool schema sends `old_string`/`new_string`, the exact same
        // spelling argPath() above already had to add for `file_path` after
        // a live probe found the camelCase-only path check let a write to
        // `.claude/settings.json` slip past a protect floor undetected —
        // the same class of miss, just on the content side of the same
        // tool call instead of the path side.
        const inlineContent = String(args.content || args.text || args.newString || args.new_string || patchText || '')
        const isFile = resolvedPath && existsSync(resolvedPath) && statSync(resolvedPath).isFile()
        // Inline content is ALWAYS checkable — it is what the agent is about
        // to write. Only the disk-scan fallback is gated on the file having
        // changed since the last scan; gating inline content on the file's
        // disk hash let an overwrite of an already-scanned file smuggle
        // secrets past the content rules.
        const diskChanged = isFile && this.config.contentTracker.hasChanged(resolvedPath)
        if (inlineContent || diskChanged) {
          for (const pattern of rule.patterns) {
            const content = inlineContent || (isFile ? readFileSync(resolvedPath, 'utf-8') : '')
            // Local-only false-positive filter (secret-confidence.ts) —
            // ONLY for patterns whose match span IS the secret bytes
            // themselves (redact_span: true, see types.ts's doc and
            // secret-confidence.ts's header). A pattern without
            // redact_span (PEM headers, aws_secret_access_key=) matches
            // only a LABEL, never a secret-shaped substring — scoring
            // that text would misfire on every single match of those
            // patterns, so they fall straight through to the unchanged
            // unconditional check below, exactly as before this feature.
            //
            // Deliberately write-side ONLY (this branch, not
            // evaluateOutput()'s redaction path below) and deliberately
            // NOT gated on file-path context: the target path an agent
            // writes to is attacker-controlled input, so "lower
            // confidence because the path looks like docs/" would be a
            // two-line bypass (write the real credential to
            // docs/notes.md instead of src/). worstSecretVerdict() only
            // ever clears a match via an exact/structural
            // placeholder-shape allowlist (a known literal, AWS's
            // documented EXAMPLE-suffix convention, or a redaction-shaped
            // run of one repeated character) — never via entropy or path,
            // both of which are calibration-free facts about the string
            // itself, not a threshold. See
            // no-path-context-bypass.test.ts / secret-confidence.test.ts
            // for the regression pinning a real-shaped key still denies
            // identically in README.md / docs/ / *.test.ts / *.example.
            if (pattern.regex && pattern.redact_span === true) {
              const verdict = worstSecretVerdict(pattern.regex, content)
              if (verdict === 'deny') {
                // Entropy is purely observational here (see
                // secret-confidence.ts's header for why it cannot itself
                // clear or soften a match) — surfaced in the message only
                // as a diagnostic for a human reviewing the block, never
                // consulted to decide the action.
                const sample = new RegExp(pattern.regex, 'i').exec(content)?.[0]
                const entropyNote = sample ? ` (candidate entropy ${shannonEntropyBitsPerChar(sample).toFixed(2)} bits/char)` : ''
                return this.violation(input, rule, `${rule.message}${entropyNote}`, start, 5)
              }
              if (verdict === 'allow') continue // known placeholder/redaction shape — never even warn; keep scanning remaining patterns
              // verdict === null: pattern.regex matched nothing, fall through with no violation for this pattern
              continue
            }
            if ((pattern.regex && this.matchesRulePattern(pattern.regex, content)) || (pattern.prefix && content.startsWith(pattern.prefix))) {
              return this.violation(input, rule, rule.message, start, 5)
            }
          }
          if (isFile) this.config.contentTracker.markUnchanged(resolvedPath)
        }
      }

      // Match against oracle rules (test-oracle-tampering detector, Tier 5):
      // two independent detection surfaces on the SAME rule — a content-diff
      // surface (`paths`, for a weakening EDIT to a test file) and a
      // command-surface (`match`, for tampering via a CLI flag the pipeline
      // never sees a diff for, e.g. `jest -u`). Both are gated on
      // OracleTracker.recentFailure: a weakening pattern with no failing
      // test run inside the recency window produces NO finding at all in
      // the shipped default — see oracle-tracker.ts and
      // session/proposals/test-oracle-tampering.yaml for why that is a
      // hard gate, not a severity dial. `mode: observe` on the shipped rule
      // means `violation()` below still only ever returns `allow` with
      // `observed_action` set — nothing here can block by itself.
      if (deepChecks && rule.type === 'oracle') {
        // Command-surface: the invocation itself IS the tamper — no diff to
        // read. Runs first because it is the cheaper check.
        if (rule.match) {
          const cmdStr = commandString(input)
          if (cmdStr && this.matchesRulePattern(rule.match, cmdStr)) {
            const recent = this.oracleTracker.recentFailure(rule, input)
            if (recent) {
              const age = Math.round(recent.ageMs / 1000)
              return this.violation(input, rule, `${rule.message} [command-surface: "${cmdStr}" ran ${age}s after failing run "${recent.command}"]`, start, 5)
            }
          }
        }

        // Content-diff surface: an edit to a file matching the test-file
        // globs, scanned against the file's PRE-edit content. An Edit-shape
        // call (oldString/newString) diffs just the changed region — more
        // precise than the full file and avoids a disk read entirely; a
        // Write-shape call (content/text, no oldString) diffs against the
        // on-disk content, mirroring the content-rule block just above.
        if (rule.paths && !/^read/i.test(input.tool)) {
          const args = input.args as Record<string, unknown>
          const pathStr = argPath(args)
          const resolvedPath = resolveMaybeRelative(pathStr, input.cwd)
          // NOT this.pathMatches — see oracle-glob.ts's header for the
          // pre-existing bug in that shared matcher that made it unusable
          // for a pattern like "**/*.test.*".
          const pathMatched = !!resolvedPath && matchesAnyTestGlob(resolvedPath, rule.paths)
          if (pathMatched) {
            const patchText = String(args.patchText || '')
            // Same camelCase/snake_case pair as the content-rule block
            // above (`args.newString`/`args.new_string`) — Claude Code's
            // real Edit tool sends the snake_case spelling.
            const newText = String(args.content ?? args.text ?? args.newString ?? args.new_string ?? patchText ?? '')
            const explicitOld = typeof args.oldString === 'string'
              ? args.oldString
              : typeof args.old_string === 'string' ? args.old_string : undefined
            const isFile = explicitOld === undefined && existsSync(resolvedPath) && statSync(resolvedPath).isFile()
            const oldText = explicitOld !== undefined ? explicitOld : (isFile ? readFileSync(resolvedPath, 'utf-8') : '')
            if (newText || oldText) {
              const signals = detectWeakening(oldText, newText, resolvedPath || pathStr)
              if (signals.length) {
                const recent = this.oracleTracker.recentFailure(rule, input)
                if (recent) {
                  const age = Math.round(recent.ageMs / 1000)
                  const detail = signals.map(s => s.detail).join('; ')
                  return this.violation(input, rule, `${rule.message} [${detail}; ${age}s after failing run "${recent.command}"]`, start, 5)
                }
              }
            }
          }
        }
      }

      // Check sequence rules (Tier 6)
      if (deepChecks && rule.type === 'sequence' && rule.steps) {
        const seqResult = this.config.sequenceDetector.check(input, rule)
        if (seqResult) {
          return this.violation(input, rule, seqResult, start, 6)
        }
      }

      if (rule.type === 'verification' || rule.type === 'claim') {
        this.verificationTracker.observeTrigger(rule, input)
        // Race fix (docs/integrations.md's "known gap"): record the
        // obligation's generation right now, BEFORE this call runs, so that
        // if it turns out to be the satisfying command, markVerificationSatisfied()
        // (called later from the post-hook, after this command's exit code is
        // known) can tell whether a LATER edit re-armed the obligation while
        // this command was still executing — and if so, refuse to discharge
        // a generation this run started before and never actually covered.
        this.verificationTracker.observeSatisfyStart(rule, input)
      }

      // Check flow/IFC rules (Tier 6)
      if (deepChecks && rule.type === 'flow' && rule.sources && rule.sinks) {
        // Record successful reads before evaluating a later sink action.
        // Runs for EVERY type:flow rule, including `cross_call` ones — a
        // cross_call rule is self-sufficient on purpose, so a custom
        // rules.yaml that ships it WITHOUT its non-cross_call sibling (a
        // user who wants only the soft warn, not the no-exfil-flow hard
        // deny) still persists its own matching reads. When both
        // no-exfil-flow and no-exfil-flow-cross-call are active together
        // (the shipped default), a single real read event is recorded/
        // persisted once per rule sharing its sources — a small, bounded
        // storage cost (flow-store.ts's MAX_TAGS_PER_SESSION caps it), not
        // a correctness issue.
        this.config.flowTracker.record(input, rule)
        if (rule.cross_call) {
          // Cross-call (persisted-store) correlation — see flow-tracker.ts's
          // checkPersisted() and docs/exfil.md.
          const flowResult = this.config.flowTracker.checkPersisted(input, rule)
          if (flowResult) {
            return this.violation(input, rule, flowResult, start, 6)
          }
        } else {
          const flowResult = this.config.flowTracker.check(input, rule)
          if (flowResult) {
            return this.violation(input, rule, flowResult, start, 6)
          }
        }
      }

      // Composite session-runaway trip (`type: session`, shipped default
      // `session-runaway-trip`): five session-scoped dimensions in one
      // atomically-locked record (session-store.ts), escalating through an
      // author-declared ladder (session-tracker.ts). Bumps activity on
      // EVERY call that reaches this branch — only when a `type: session`
      // rule is actually active, so a rules.yaml with none never pays this
      // cost — then checks whether the worst met step across all five
      // dimensions fires. No `match:` gating (unlike `stuck`/`rate`): a
      // session trip is scoped by session_id, not by matching the specific
      // command, so it applies to every tool call in the session.
      if (rule.type === 'session' && rule.session_escalation?.length && this.config.sessionTracker) {
        const args = input.args as Record<string, unknown>
        // A "write" call, for the file_write_churn dimension: gated on
        // WRITE_TOOL_NAMES (verification.ts) — the SAME curated write-tool
        // set `type: verification`/`type: claim` obligations already use to
        // decide "did this call just modify a file" — rather than a looser
        // `!/^read/i.test(tool)` heuristic. The looser form was tried first
        // and rejected: Grep/Glob/LS all take a `path` argument argPath()
        // happily resolves and none of them start with "read", so an agent
        // grepping 80 directories would have counted as 80 distinct file
        // writes — a false "scope creep" prompt from pure exploration. Bash
        // is also excluded by construction (it isn't in WRITE_TOOL_NAMES):
        // its own volume is already covered by the bash_calls dimension.
        const pathStr = WRITE_TOOL_NAMES.has(input.tool.toLowerCase()) ? argPath(args) : ''
        const writePath = pathStr ? resolveMaybeRelative(pathStr, input.cwd) : undefined
        this.config.sessionTracker.recordActivity(rule, input, { isBash: input.tool === 'Bash', writePath })

        const escalation = this.config.sessionTracker.check(rule, input)
        if (escalation) {
          // skipFirstWarning: true — same reasoning as the stuck-loop
          // branch above (no-repeat-loops): the ladder ITSELF is already
          // the escalation (warn at a low threshold, prompt higher, deny
          // at the top) built from calls that already climbed through the
          // lower steps. Applying pipeline.ts's own SEPARATE warn-once-
          // then-block grace on top of that would blunt the terminal deny
          // step into yet another one-time warning — verified live: without
          // this flag, the very first call to ever reach the deny+halt step
          // downgraded to "First violation... warning only," exactly the
          // false negative this flag exists to prevent.
          const result = this.violation(input, { ...rule, action: escalation.action }, escalation.message, start, 2, rule.id, undefined, true)
          // Only trip `keel halt` when the step both (a) declared `halt:
          // true` — which validateRules already guarantees is only ever
          // true on a consecutive_failures step — AND (b) the verdict that
          // ACTUALLY came back is deny/block. (b) matters on its own: the
          // sprint dial can downgrade a deny to warn (dialAction(), called
          // from within violation()), and a human's `keel allow <id>
          // --once` can consume the override and turn this specific call
          // into an `allow` — writing the halt sentinel BEFORE checking the
          // real result would silently override both of those and latch a
          // permanent lockdown the human/dial had just relaxed. Observe
          // mode needs no separate check here: `violation()` throws
          // OBSERVE_CONTINUE before ever reaching this line, so an
          // observe-mode session rule can never write the sentinel.
          if (escalation.halt && (result.action === 'deny' || result.action === 'block')) {
            writeHaltSentinel(this.config.haltFile || join(resolveHome(), '.keel', 'HALTED'), escalation.message)
          }
          return result
        }
        continue
      }
      } catch (err) {
        if (err === OBSERVE_CONTINUE) continue
        throw err
      }
    }
    return undefined
  }

  markVerificationSatisfied(input: EnforceInput): void {
    const rules = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context)
    for (const rule of rules) {
      if (rule.type === 'verification' || rule.type === 'claim') this.verificationTracker.markSatisfied(rule, input)
    }
  }

  /**
   * Record an attempt outcome (exit code) from the after-hook. Feeds the
   * stuck-loop detector: only FAILING fingerprints accumulate, an exit-0
   * run resets the loop, and matching rules update their counters.
   */
  recordAttemptOutcome(input: EnforceInput, exitCode: number | null): void {
    const cmd = commandString(input)
    if (this.config.ledger && cmd) {
      this.config.ledger.recordOutcome(input.cwd, cmd, exitCode, input.session_id)
    }
    if (this.config.researchTracker) {
      const rules = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context)
      for (const rule of rules) {
        if (rule.type === 'research' && rule.trigger) this.config.researchTracker.observeTrigger(rule, input, exitCode)
      }
    }
    // Oracle recency window: armed by the SAME after-hook, regardless of
    // whether a stuckTracker was supplied (oracleTracker is always present —
    // see the constructor). Must run before the stuckTracker early-return
    // below, which only concerns the stuck-loop branch.
    {
      const rules = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context)
      for (const rule of rules) {
        if (rule.type === 'oracle') this.oracleTracker.observeOutcome(rule, input, exitCode)
      }
    }

    // Session composite trip's consecutive_failures dimension: fed by the
    // SAME after-hook exit code as the stuck-loop detector below, but
    // scoped to the whole session rather than one command fingerprint —
    // every `type: session` rule gets a recordOutcome() call regardless of
    // what command ran. Must run before the stuckTracker early-return
    // below, same reasoning as the oracle block above.
    if (this.config.sessionTracker) {
      const rules = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context)
      for (const rule of rules) {
        if (rule.type === 'session' && rule.session_escalation?.length) {
          this.config.sessionTracker.recordOutcome(rule, input, exitCode)
        }
      }
    }

    // Oscillation rolling window: fed by the SAME after-hook exit code as
    // the stuck-loop detector below, but appended regardless of which
    // fingerprint it is (the window holds a SEQUENCE of recent fingerprints,
    // not one bucket per fingerprint) — see oscillation-tracker.ts's
    // recordOutcome for the require_failure discriminator. Scoped to the
    // same Bash/WRITE_TOOL_NAMES tool set the evaluate()-side branch checks,
    // so a Read/Grep/exploration call never dilutes the window. Must run
    // before the stuckTracker early-return below, same reasoning as the
    // oracle/session blocks above.
    if (this.config.oscillationTracker && (input.tool === 'Bash' || WRITE_TOOL_NAMES.has(input.tool.toLowerCase()))) {
      const rules = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context)
      for (const rule of rules) {
        if (rule.type !== 'oscillation') continue
        if (rule.match && !this.matchesRulePattern(rule.match, cmd)) continue
        this.config.oscillationTracker.recordOutcome(rule, input, exitCode)
      }
    }

    if (!this.config.stuckTracker) return
    const rules = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context)
    for (const rule of rules) {
      if (rule.type !== 'stuck' || !rule.match) continue
      if (!this.matchesRulePattern(rule.match, cmd)) continue
      this.config.stuckTracker.recordOutcome(rule, input, exitCode)
    }
  }

  /**
   * Record a fresh spend MEASUREMENT for every `type: budget` rule, from a
   * host's Stop/PostToolUse-equivalent hook — deliberately OUTSIDE
   * evaluate()'s PreToolUse path (see BudgetTracker's own header comment
   * for why: Claude Code's Stop hook cannot block, so this call can never
   * itself deny anything; it only updates the persisted flag the NEXT
   * PreToolUse call's `type: budget` branch reads). `spend` is already
   * computed by the caller (budget/claude-transcript.ts's
   * `measureClaudeCodeSpend`, budget/opencode-db.ts's
   * `measureOpenCodeSpend`, or a fixture/test's own literal value) — this
   * method never reads a transcript or database itself, only applies the
   * measurement to every budget rule in the current ruleset.
   */
  recordBudgetSnapshot(input: EnforceInput, spend: BudgetSpend): void {
    if (!this.config.budgetTracker) return
    const rules = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context)
    for (const rule of rules) {
      if (rule.type !== 'budget') continue
      this.config.budgetTracker.record(rule, input, spend)
    }
  }

  /**
   * Evaluate a proposed fix/mutation instead of blocking.
   */
  private fixAction(input: EnforceInput, rule: KeelRule, cmdStr: string, start: number): EnforceResult {
    if (!rule.fix) {
      return this.block(input, rule, rule.message, start, 2)
    }

    let fixed = cmdStr
    for (const t of rule.fix) {
      fixed = fixed.replace(new RegExp(t.pattern, 'g'), t.replace)
    }

    return {
      action: 'fix',
      rule_id: rule.id,
      rule_name: rule.id,
      message: `${rule.message}\n   → Applied fix: ${cmdStr} → ${fixed}`,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - start,
      cache_hit: false,
      tier: 2,
      fix_result: { original: cmdStr, fixed },
    }
  }

  private block(input: EnforceInput, rule: KeelRule, message: string, start: number, tier: PipelineTier): EnforceResult {
    // Track circuit breaker
    const cbKey = `${rule.id}:${input.tool}`
    const now = Date.now()
    const cb = this.circuitBreaker.get(cbKey) || { count: 0, startTime: now }

    // Reset if more than 60s since first deny
    if (now - cb.startTime > 60000) {
      cb.count = 0
      cb.startTime = now
    }

    const sm = this.config.stateManager
    if (sm) {
      sm.recordCircuitBreaker(rule.id, input.tool)
      const persisted = sm.circuitBreaker[cbKey]
      if (persisted) {
        cb.count = persisted.count
        cb.startTime = persisted.startTime
      }
    } else {
      cb.count++
    }
    this.circuitBreaker.set(cbKey, cb)

    // Cache the deny
    this.config.cache.set(input.tool, input.args, this.config.ruleVersion, {
      verdict: 'deny',
      rule_id: rule.id,
      count: 0,
      timestamp: Date.now(),
    }, this.cacheContext(input, this.effectiveDepth(input)))

    // Track for flow analysis
    this.config.flowTracker.record(input, rule.id)

    const result = this.result('deny', rule.id, message, start, false, tier)

    // Circuit breaker: if 3+ denies in 60s for same rule+tool, escalate
    if (cb.count >= 3) {
      return { ...result, message: `${message}\n   ⚠ This has been blocked ${cb.count} times in 60s. Approve with \`keel allow ${rule.id} --once\` or investigate.` }
    }

    return result
  }

  /**
   * The result message for a consumed override, worded for the mode that
   * actually consumed it — `--once` is spent, `--session`/the 24h window
   * form are not, and telling the user "one-time" when it is neither is a
   * control that lies about its own state.
   */
  private overrideMessage(ruleId: string): string {
    // peek() is part of the RuleOverrideStore interface, but — like
    // consume() above — this must never throw just because some caller's
    // overrideStore (a test double, an older thin client) only implements
    // a subset of it.
    try {
      const remaining = this.overrideStore.peek(ruleId)
      if (remaining?.mode === 'session') return `Session override consumed for "${ruleId}" (this agent session only)`
      if (remaining?.mode === 'window') return `Standing override consumed for "${ruleId}" (active until it expires)`
    } catch { /* fall through to the once wording below */ }
    return `One-time override consumed for "${ruleId}"`
  }

  /**
   * Approval gate (`action: prompt`). Behaves like a deny (blocks, tracks the
   * circuit breaker, caches a deny verdict for override consumption) but is
   * reported as `prompt` and always requires explicit user approval via
   * `keel allow <id> --once`. Never escalates from warn-once — the first
   * violation is already gated.
   */
  private gate(input: EnforceInput, rule: KeelRule, message: string, start: number, tier: PipelineTier): EnforceResult {
    const blocked = this.block(input, rule, message, start, tier)
    return {
      ...blocked,
      action: 'prompt',
      message: `${blocked.message}\n   → Approval required: run \`keel allow ${rule.id} --once\` to approve this action.`,
    }
  }

  private violation(input: EnforceInput, rule: KeelRule, message: string, start: number, tier: PipelineTier, warningKey = rule.id, directive?: RedirectDirective, skipFirstWarning = false): EnforceResult {
    // Observe mode: record what would have happened, interrupt nothing —
    // and, critically, do not stop evaluation either. Returning an
    // EnforceResult here (the pre-fix shape) would make the caller's
    // `return this.violation(...)` exit evaluateTiers() immediately,
    // blinding every lower-priority rule on this call to a match that was
    // never supposed to interrupt anything in the first place. Throwing
    // OBSERVE_CONTINUE instead means that `return` statement never
    // completes; the nearest of the two loop-body try/catches in
    // evaluateTiers() catches it, and the loop moves on to the next rule.
    // See OBSERVE_CONTINUE's header comment for the full invariant.
    if (rule.mode === 'observe') {
      const would = this.enforcedAction(rule, input)
      this.observedMatches.push({ rule_id: rule.id, observed_action: would, message: `[observe] would ${would}: ${message}` })
      throw OBSERVE_CONTINUE
    }
    const action = this.effectiveAction(rule, input)
    if (action === 'fix') {
      if (rule.fix && rule.type === 'command') {
        const args = input.args as Record<string, unknown>
        const raw = typeof input.args === 'string'
          ? input.args
          : typeof args.command === 'string' ? args.command
            : typeof args.cmd === 'string' ? args.cmd : ''
        if (raw) return this.fixAction(input, rule, raw, start)
      }
      return this.warn(input, rule, `${message} (no automatic fix available)`, start, tier)
    }
    if (action === 'redirect') {
      // Course correction, not a block: never escalates warn-once,
      // self-clears on compliance. Carries the machine-readable directive
      // to the model.
      //
      // Overrides ARE consumed here, same as deny/prompt below — this used
      // to be the one action branch that skipped the check, so a stuck
      // `no-repeat-loops` redirect (type: stuck, action escalated to
      // redirect at 3 identical failing attempts) could not be unstuck by
      // a human running `keel allow <id> --once`: the override sat armed
      // and unconsumed while every subsequent identical call kept getting
      // redirected regardless. `research`/`diagnosis` redirects go through
      // this same branch and get the same fix for the same reason — none
      // of the three had a way for a human override to actually clear one.
      if (this.overrideStore.consume(rule.id, input.session_id)) {
        return this.result('allow', rule.id, this.overrideMessage(rule.id), start, false, tier)
      }
      return this.result('redirect', rule.id, message, start, false, tier, undefined, undefined, directive)
    }
    if (action === 'warn' || action === 'allow' || action === 'report') {
      return action === 'warn' ? this.warn(input, rule, message, start, tier) : this.result(action, rule.id, message, start, false, tier)
    }
    if (action === 'prompt') {
      // Approval gate: always blocks, no first-warn escalation. Never auto-
      // downgraded by sprint level — irreversible operations stay gated.
      // A human-run `keel allow <id> --once` covers the next violation.
      if (this.overrideStore.consume(rule.id, input.session_id)) {
        return this.result('allow', rule.id, this.overrideMessage(rule.id), start, false, tier)
      }
      return this.gate(input, rule, message, start, tier)
    }
    if (action === 'deny' || action === 'block') {
      const first = this.isFirstWarning(warningKey)
      // At protect the dial's promise is block-first: a deny violation is
      // blocked immediately, with no warning pass. balanced/sprint keep the
      // warn-once-then-block escalation — EXCEPT for `level: protect` FLOOR
      // rules, which block first at every dial position. A floor that warns
      // on its first hit is not a floor: the incidents these rules encode
      // (forced push to main, rm -rf /, prod DROP TABLE) are one-shot
      // irreversible, and the warn pass was found live — a forced push to
      // main REACHED the remote through the warn-once grace (gate-2).
      const blockFirst = this.effectiveLevel(input) === 'protect' || rule.level === 'protect' || skipFirstWarning
      if (first && !blockFirst && input.action_override !== 'deny' && input.action_override !== 'block') {
        // The first violation only warns — never consume an armed override
        // for it, or the approval is wasted on a call that would not have
        // been blocked (the next one would then be blocked anyway).
        this.denyFirstTime.set(warningKey, true)
        this.config.stateManager?.markFirstTime(warningKey, this.lastRulesHash)
        return this.warn(input, rule, `First violation of "${rule.id}" — warning only. Next time will be blocked.`, start, tier)
      }
      this.denyFirstTime.set(warningKey, true)
      if (this.overrideStore.consume(rule.id, input.session_id)) {
        return this.result('allow', rule.id, this.overrideMessage(rule.id), start, false, tier)
      }
      return this.block(input, rule, message, start, tier)
    }
    return this.warn(input, rule, `${message} (action "${action}" is not supported by this integration)`, start, tier)
  }

  private effectiveLevel(input: EnforceInput): ProtectionLevel {
    // Project-over-global precedence, then sprint auto-expiry
    // (sprint_started_at + sprint_expiry_hours) on top of whichever
    // config's `level` won — see effectiveHierarchyLevel(). Read fresh
    // from the just-loaded hierarchy every call, so a process-per-call
    // host picks up the reversion with no daemon.
    return effectiveHierarchyLevel(this.config.ruleHierarchy, input.level)
  }

  /**
   * What this rule actually does right now.
   *
   * `mode: observe` short-circuits to allow: the rule still evaluates and
   * is still recorded, but never interrupts. Breadth (which rules run) and
   * enforcement (what happens on a match) are separate axes — a new rule
   * burns in under observe and is promoted once its false-positive rate is
   * known, rather than interrupting on its very first hit.
   */
  private effectiveAction(rule: KeelRule, input: EnforceInput): EnforcementAction {
    if (rule.mode === 'observe') return 'allow'
    return this.enforcedAction(rule, input)
  }

  /** The action a rule would take if it were enforcing (ignores observe). */
  private enforcedAction(rule: KeelRule, input: EnforceInput): EnforcementAction {
    if (input.action_override) return input.action_override
    // dialAction() is the shared floor + sprint-downgrade logic (also used
    // by `keel level`'s dial-switch summary). effectiveLevel() is the LIVE
    // level — reloaded with the rules and expiry-checked — so both the
    // sprint downgrade and its auto-expiry take effect without a plugin
    // restart.
    return dialAction(rule, this.effectiveLevel(input))
  }

  private cacheContext(input: EnforceInput, depth: string): CacheContext {
    return {
      cwd: input.cwd,
      level: this.effectiveLevel(input),
      context: input.context,
      depth,
      action: input.action_override,
      rules_hash: this.lastRulesHash,
    }
  }

  private effectiveDepth(input: EnforceInput): string {
    return input.depth || (this.effectiveLevel(input) === 'protect' ? 'deep' : this.effectiveLevel(input) === 'sprint' ? 'fast' : 'full')
  }

  private matchesRulePattern(pattern: string, value: string): boolean {
    try { return new RegExp(pattern, 'i').test(value) } catch { return false }
  }

  private isFirstWarning(ruleId: string): boolean {
    if (this.denyFirstTime.has(ruleId)) return false
    return this.config.stateManager?.isFirstTime(ruleId, this.lastRulesHash) ?? true
  }

  private pathMatches(rawValue: string, rawPattern: string): boolean {
    // Canonicalize separators/drive-letter-case/case-fold (Windows: `\` ->
    // `/`, UNC preserved, NTFS case-insensitivity applied) BEFORE running
    // the glob-to-regex conversion below. That conversion — including its
    // documented "**" + bare "*" interaction — is deliberately unchanged:
    // see oracle-glob.ts's header for why fixing that specific bug is out
    // of this lane's scope (every shipped filesystem rule depends on its
    // current matching behavior; changing it needs its own ruleset-wide
    // verification). What's fixed here is Windows path-string handling
    // only, so `**/.env` still matches the same POSIX values it always did
    // (normalizeForMatch is identity on posix) and now ALSO matches a real
    // Windows argument path like `C:\repo\.env`.
    const value = normalizeForMatch(rawValue)
    const normalized = normalizeForMatch(rawPattern)
    // `**` matches across any number of segments; `*` matches within one
    // segment only (never crosses `/`). Only engaged for patterns that use
    // `**`, keeping the legacy prefix and includes semantics for simple
    // patterns (existing rules depend on them).
    //
    // A single pass over each `**`-split part handles both jobs at once: a
    // literal `*` becomes `[^/]*` directly, and every other regex-special
    // character gets backslash-escaped. The previous implementation tried
    // to do this in two passes -- escape special characters first (with a
    // class that did not include `*`), then convert an escaped `\*` to
    // `[^/]*` -- but since `*` was never a member of the escape class, no
    // `\*` was ever produced, so that second step never fired. A bare `*`
    // then survived into the final regex as a raw quantifier applied to
    // whatever character preceded it (e.g. `.env*` compiled to a regex
    // where `*` quantified the "v" in "env", not "match anything after
    // it"), so patterns like `**/.env*` silently failed to match
    // `.env.local`.
    if (normalized.includes('**')) {
      const regex = '^' + normalized
        .split('**')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '[^/]*' : `\\${ch}`)))
        .join('.*') + '$'
      try { return new RegExp(regex).test(value) } catch { return false }
    }
    const prefix = normalized.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\/$/, '')
    return value === prefix || value.startsWith(prefix + '/') || value.includes(normalized.replace(/\*/g, ''))
  }

  private warn(input: EnforceInput, rule: KeelRule, message: string, start: number, tier: PipelineTier): EnforceResult {
    this.config.flowTracker.record(input, rule.id)
    return this.result('warn', rule.id, message, start, false, tier)
  }

  private result(
    action: EnforcementAction,
    ruleId: string,
    message: string,
    start: number,
    cacheHit: boolean,
    tier: number,
    fixResult?: Record<string, unknown>,
    directive?: ResearchDirective,
    redirect?: RedirectDirective,
  ): EnforceResult {
    return {
      action,
      rule_id: ruleId || null,
      rule_name: ruleId,
      message,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - start,
      cache_hit: cacheHit,
      tier: tier as PipelineTier,
      fix_result: fixResult,
      directive,
      redirect,
    }
  }

  getCircuitBreakerState(): Array<{ ruleId: string; tool: string; count: number }> {
    const state: Array<{ ruleId: string; tool: string; count: number }> = []
    for (const [key, val] of this.circuitBreaker) {
      const [ruleId, tool] = key.split(':')
      state.push({ ruleId, tool, count: val.count })
    }
    return state
  }

  getFirstTimeViolations(): string[] {
    return Array.from(this.denyFirstTime.keys())
  }
}
