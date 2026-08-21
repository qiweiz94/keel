import type { KeelRule, EnforceInput, EnforcementAction } from '../types.js'
import type { PersistentSessionStore, PersistedSessionState } from './session-store.js'

/**
 * SessionTracker — the composite runaway-loop trip behind `type: session`
 * rules (shipped default: `session-runaway-trip`). Tracks FIVE session-
 * scoped dimensions in one record per (rule, session_id) — see
 * session-store.ts's header for why they share one lock — and escalates
 * through an author-declared ladder (`rule.session_escalation`) that mixes
 * all five.
 *
 * THE SAFETY-CRITICAL ASYMMETRY (do not remove without re-reading the
 * design brief this shipped from): `duration_minutes`, `tool_calls`,
 * `bash_calls`, and `file_write_churn` are pure VOLUME counters — they go
 * up whether the session is thriving or stuck, so a legitimate long
 * session must never let them alone reach `keel halt`. Only
 * `consecutive_failures` is failure-aware (reset on any exit-0, per
 * session-store.ts's `bumpFailure`), mirroring `type: stuck`'s
 * `no-repeat-loops` (`require_failure` + `fingerprint: auto`) — repeated
 * FAILURE, not repeated activity, is the one signal allowed to escalate
 * all the way to a halt with no auto-expiry. rule-parser.ts's
 * `validateRules` enforces this STRUCTURALLY (rejects `halt: true` or
 * `action: deny|block` on any non-`consecutive_failures` step) so this is
 * true by construction, not by convention — this tracker does not need to
 * (and does not) re-check it, but never relies on that alone: see
 * pipeline.ts's session-trip branch, which only ever writes the halt
 * sentinel when `escalation.halt` is set AND the enforced action actually
 * resolved to deny/block (accounting for the sprint dial and a consumed
 * override) — never from the escalation step's declared action alone.
 */

export type SessionDimension = 'duration_minutes' | 'tool_calls' | 'bash_calls' | 'file_write_churn' | 'consecutive_failures'

export interface SessionEscalationStep {
  dimension: SessionDimension
  at: number
  action: EnforcementAction
  message?: string
  /** Only ever honored on a `consecutive_failures` step — see this file's header. */
  halt?: boolean
}

export interface SessionTripEscalation {
  action: EnforcementAction
  message: string
  dimension: SessionDimension
  value: number
  halt: boolean
}

/** Ranks how severe a met escalation step is, for picking the WORST met step across all five dimensions on one call. `halt` always outranks a plain deny/block of the same action (both resolve to `action: 'deny'|'block'` at the type level, but a halt step is a strictly worse outcome). */
function stepSeverity(step: SessionEscalationStep): number {
  const base = step.action === 'deny' || step.action === 'block' ? 3 : step.action === 'prompt' ? 2 : 1
  return base + (step.halt ? 10 : 0)
}

/**
 * Is `candidate` a worse (or equally severe but more informative) met step
 * than `current`? Used to fold every met escalation step down to the ONE
 * that decides the call.
 *
 * Tie-break order, deliberately NOT "higher `at` wins" alone: at the
 * shipped default thresholds, a session that just crossed BOTH
 * tool_calls@500 (severity 1) and consecutive_failures@3 (severity 1, a
 * LOWER `at`) would report "500+ tool calls" instead of the 3-failure
 * streak — same outer action either way, but the wrong dimension in the
 * trace, right where `mode: observe`'s whole point is a human reading
 * `observed_action`/the message to decide whether to promote the rule. A
 * failure-aware dimension is always the more actionable signal (it is
 * literally the one no volume count can ever explain on its own — see this
 * file's SAFETY-CRITICAL header comment) so it wins any tie before `at`
 * ever gets consulted.
 */
function isWorse(candidate: SessionEscalationStep, current: SessionEscalationStep): boolean {
  const bySeverity = stepSeverity(candidate) - stepSeverity(current)
  if (bySeverity !== 0) return bySeverity > 0
  const candidateIsFailureAware = candidate.dimension === 'consecutive_failures'
  const currentIsFailureAware = current.dimension === 'consecutive_failures'
  if (candidateIsFailureAware !== currentIsFailureAware) return candidateIsFailureAware
  return candidate.at > current.at
}

export class SessionTracker {
  constructor(private readonly persistentStore?: PersistentSessionStore) {}

  private key(ruleId: string, sessionId: string): string {
    return `session:${ruleId}:${sessionId}`
  }

  /**
   * Record one more tool call toward the composite counters. A no-op (and
   * a no-write) when no persistent store is configured — an in-memory-only
   * tracker (the opencode plugin's long-lived process — see enforce.ts's
   * own comment on why that host doesn't need one) still needs SOMEWHERE
   * to keep counts, so this class also keeps a small in-memory fallback map
   * for that case.
   */
  private memory = new Map<string, PersistedSessionState>()

  recordActivity(rule: KeelRule, input: EnforceInput, opts: { isBash: boolean; writePath?: string }): void {
    if (!input.session_id) return
    const key = this.key(rule.id, input.session_id)
    if (this.persistentStore) {
      const next = this.persistentStore.bumpActivity(key, opts)
      this.memory.set(key, next)
      return
    }
    const now = Date.now()
    const existing = this.memory.get(key)
    const base: PersistedSessionState = existing || {
      sessionStart: now, lastActivityAt: now, toolCalls: 0, bashCalls: 0,
      filesWritten: [], fileWriteChurn: 0, consecutiveFailures: 0, lastExit: null,
    }
    const next: PersistedSessionState = {
      ...base,
      lastActivityAt: now,
      toolCalls: base.toolCalls + 1,
      bashCalls: base.bashCalls + (opts.isBash ? 1 : 0),
    }
    if (opts.writePath && !base.filesWritten.includes(opts.writePath)) {
      next.fileWriteChurn = base.fileWriteChurn + 1
      next.filesWritten = [...base.filesWritten, opts.writePath]
    }
    this.memory.set(key, next)
  }

  /** Record an attempt outcome for the consecutive-failures dimension — see session-store.ts's `bumpFailure` for the exact reset/increment/no-op semantics this mirrors for the in-memory fallback path. */
  recordOutcome(rule: KeelRule, input: EnforceInput, exitCode: number | null): void {
    if (!input.session_id) return
    const key = this.key(rule.id, input.session_id)
    if (this.persistentStore) {
      const next = this.persistentStore.bumpFailure(key, exitCode)
      if (next) this.memory.set(key, next)
      return
    }
    if (exitCode === null) return
    const now = Date.now()
    const existing = this.memory.get(key)
    if (!existing) return
    this.memory.set(key, {
      ...existing,
      lastActivityAt: now,
      consecutiveFailures: exitCode === 0 ? 0 : existing.consecutiveFailures + 1,
      lastExit: exitCode,
    })
  }

  private currentValue(dimension: SessionDimension, state: PersistedSessionState): number {
    switch (dimension) {
      case 'duration_minutes': return (Date.now() - state.sessionStart) / 60000
      case 'tool_calls': return state.toolCalls
      case 'bash_calls': return state.bashCalls
      case 'file_write_churn': return state.fileWriteChurn
      case 'consecutive_failures': return state.consecutiveFailures
    }
  }

  /**
   * Resolve the worst met escalation step across all five dimensions for
   * this call, or `null` if none are met. "Worst" = highest `stepSeverity`;
   * ties broken by the higher `at` threshold, then declaration order —
   * deterministic, so the same state always resolves the same verdict.
   */
  check(rule: KeelRule, input: EnforceInput): SessionTripEscalation | null {
    if (!input.session_id || !rule.session_escalation?.length) return null
    const key = this.key(rule.id, input.session_id)
    let state = this.memory.get(key)
    if (this.persistentStore) {
      const persisted = this.persistentStore.get(key)
      if (persisted) state = persisted
    }
    if (!state) return null

    let best: { step: SessionEscalationStep; value: number } | null = null
    for (const step of rule.session_escalation) {
      const value = this.currentValue(step.dimension, state)
      if (value < step.at) continue
      if (!best || isWorse(step, best.step)) {
        best = { step, value }
      }
    }
    if (!best) return null
    const message = best.step.message || defaultMessage(best.step, best.value)
    return {
      action: best.step.action,
      message,
      dimension: best.step.dimension,
      value: best.value,
      // Structural invariant (rule-parser.ts's validateRules) already
      // guarantees `halt` is never set on a non-consecutive_failures step —
      // this clamp makes it true by construction here too, for any rule
      // that reaches the pipeline without going through that validation
      // (e.g. the opencode plugin's hardcoded DEFAULT_RULES_YAML fallback
      // parse path, which calls parseRulesContent but the plugin does not
      // re-run validateRules against its own fallback constant).
      halt: best.step.dimension === 'consecutive_failures' && !!best.step.halt,
    }
  }
}

function defaultMessage(step: SessionEscalationStep, value: number): string {
  const rounded = Math.round(value * 10) / 10
  const labels: Record<SessionDimension, string> = {
    duration_minutes: `session duration ${rounded}m`,
    tool_calls: `${rounded} tool calls this session`,
    bash_calls: `${rounded} Bash calls this session`,
    file_write_churn: `${rounded} distinct files written this session`,
    consecutive_failures: `${rounded} consecutive failing attempts`,
  }
  return `Session runaway trip: ${labels[step.dimension]} (threshold ${step.at}).`
}
