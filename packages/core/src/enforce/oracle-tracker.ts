import type { KeelRule, EnforceInput } from '../types.js'
import type { StateManager } from './state-manager.js'
import { matches } from './verification.js'
import { commandString } from './arg-utils.js'

/**
 * OracleTracker — the recency half of the test-oracle-tampering detector.
 *
 * Mirrors ResearchTracker's arm shape (a FAILING command matching `trigger`
 * arms a window) but there is no discharge and no boundary: the content-diff
 * and command-surface checks in pipeline.ts are what actually decide
 * whether a weakening pattern was found; this tracker only answers "was
 * there a failing test run recently enough for that pattern to matter".
 *
 * Persisted via StateManager so the recency window survives across
 * process-per-call hosts: the daemon and opencode-plugin integrations may
 * construct a fresh EnforcementPipeline per hook invocation, so the
 * in-memory Map alone cannot bridge the gap between the Bash after-hook
 * call (that recorded the failure) and the later Edit/Write call (that
 * needs to see it). The in-memory map stays as the fast path within a
 * single long-lived process (e.g. `keel enforce` invoked repeatedly in the
 * same daemon) and is always reconciled against StateManager, taking
 * whichever entry is newer.
 */

export interface OracleFailure {
  timestamp: number
  command: string
}

export interface RecentFailure extends OracleFailure {
  ageMs: number
}

export class OracleTracker {
  private failures = new Map<string, OracleFailure>()

  constructor(private readonly stateManager?: StateManager) {}

  // Session-scoped (matches ResearchTracker, the closest sibling pattern:
  // arm on a failing trigger, gate a later action) rather than cwd-only
  // (like StuckTracker/VerificationTracker): two different agent sessions
  // working the same repo must not have one session's red run arm the
  // window for the OTHER session's unrelated edit. The cost is the inverse
  // case documented in the shipped rule's false_positives — the SAME
  // session running a monorepo-wide suite that fails in module A can still
  // arm the window for an unrelated edit it makes in module B.
  private key(rule: KeelRule, input: EnforceInput): string {
    return `oracle:${rule.id}:${input.cwd}:${input.session_id}`
  }

  /**
   * Arm the recency window: called from the after-hook (recordAttemptOutcome)
   * with the exit code of every command. Only a run that matches the rule's
   * `trigger` AND exited nonzero (the trigger's `exit: 'nonzero'`, or — if
   * the rule omits `trigger.exit` — the tracker's own default of "only
   * failures count") records a new failure timestamp. A passing run does
   * NOT clear a prior failure early: the window has its own TTL
   * (`window_seconds`), and a later unrelated passing command (e.g. `npm
   * run lint`) must not reset the clock on a still-fresh red test run.
   */
  observeOutcome(rule: KeelRule, input: EnforceInput, exitCode: number | null): void {
    if (rule.type !== 'oracle' || !rule.trigger) return
    if (!matches(rule.trigger, input)) return

    if (rule.trigger.exit !== undefined) {
      const want = rule.trigger.exit
      if (want === 'nonzero' && (exitCode === 0 || exitCode === null)) return
      if (typeof want === 'number' && exitCode !== want) return
    } else if (exitCode === 0 || exitCode === null) {
      return
    }

    const key = this.key(rule, input)
    const entry: OracleFailure = { timestamp: Date.now(), command: commandString(input) || input.tool }
    this.failures.set(key, entry)
    this.stateManager?.setOracleFailure(key, entry)
  }

  /**
   * The most recent qualifying failure for this rule+cwd, if any, within
   * `rule.window_seconds` (default 900s / 15min). Returns null both when
   * there was never a recorded failure AND when there was one but it has
   * aged out — callers cannot and should not distinguish the two; both mean
   * "no recency evidence right now".
   */
  recentFailure(rule: KeelRule, input: EnforceInput): RecentFailure | null {
    const key = this.key(rule, input)
    const windowMs = (rule.window_seconds ?? 900) * 1000
    const local = this.failures.get(key)
    const persisted = this.stateManager?.oracleFailures[key]
    const entry = !persisted || (local && local.timestamp >= persisted.timestamp) ? local : persisted
    if (!entry) return null
    const ageMs = Date.now() - entry.timestamp
    if (ageMs > windowMs) return null
    return { ...entry, ageMs }
  }

  clear(): void {
    this.failures.clear()
  }
}
