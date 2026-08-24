import type { KeelRule, EnforceInput } from '../types.js'
import { commandFingerprint } from './command-fingerprint.js'
import { commandString } from './arg-utils.js'
import type { PersistentStuckStore } from './stuck-store.js'

/**
 * Stuck-loop detector: identical FAILING command fingerprints within a
 * window, with an escalating ladder (default: 3 → redirect, 5 → deny).
 *
 * Outcomes are recorded from the after-hook (`recordOutcome`), evaluated
 * from the before-hook (`check`): the pipeline's `stuck` rule branch
 * consults this tracker while the tool call is still gated.
 *
 * Reset semantics (progress clears the loop):
 *   - an exit-0 run of the same fingerprint resets its counter
 *   - a different command fingerprint does not increment this one
 *   - the window TTL expires the count
 *
 * IN-MEMORY BY DEFAULT: `counts` lives only in this instance, same caveat
 * as FlowTracker's own (flow-tracker.ts) — fine for a long-lived host
 * (`keel daemon`, daemon.ts) that keeps one StuckTracker open for a whole
 * session, but `keel hook <host>` (Claude Code, Cursor, Codex, Gemini CLI,
 * cline, generic) spawns a FRESH process per tool call, so an in-memory-only
 * tracker resets to empty every time and can never see "this exact command
 * already failed twice in the last 15 minutes."
 *
 * The OPTIONAL `persistentStore` constructor argument closes that gap,
 * mirroring FlowTracker's own `persistentStore` pattern but wired straight
 * into `check()`/`recordOutcome()` themselves rather than a separate
 * sibling method: `no-repeat-loops` is the rule this lane exists to fix,
 * not a new observe-tier rule alongside it, and stuck-store.ts's own header
 * comment documents why that is safe to do directly (the store's fail-safe
 * direction only ever UNDER-counts, so wiring it into the enforcing path
 * cannot make the ladder escalate falsely). `recordOutcome()` writes
 * through to the store when configured — `bump()`/`delete()` become the
 * single source of truth for that bucket instead of a locally-computed
 * increment (see `PersistentStuckStore.bump`'s own doc comment on why a
 * separate read-then-increment would race). `check()` falls back to the
 * persisted count when it is caught up further than the in-memory one —
 * the case that matters is a fresh process whose in-memory map is empty.
 */

export interface StuckState {
  count: number
  windowStart: number
  lastAttemptAt: number
  lastExit: number | null
}

export interface StuckEscalation {
  action: KeelRule['action']
  message: string
  attempts: number
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000

export class StuckTracker {
  private counts = new Map<string, StuckState>()

  constructor(private readonly persistentStore?: PersistentStuckStore) {}

  private key(ruleId: string, cwd: string, fingerprint: string): string {
    return `stuck:${ruleId}:${cwd}:${fingerprint}`
  }

  private fingerprintOf(rule: KeelRule, input: EnforceInput): string {
    const cmd = commandString(input)
    return rule.fingerprint === 'exact' ? cmd : commandFingerprint(cmd)
  }

  recordOutcome(rule: KeelRule, input: EnforceInput, exitCode: number | null): void {
    const cmd = commandString(input)
    if (!cmd) return
    const fp = this.fingerprintOf(rule, input)
    const key = this.key(rule.id, input.cwd, fp)
    const windowMs = (rule.window_seconds || 60) * 1000

    // Success resets the loop (the problem changed).
    if (exitCode === 0) {
      this.counts.delete(key)
      if (this.persistentStore) this.persistentStore.delete(key)
      return
    }
    // Failure-aware rules only count nonzero exits; without an exit code we
    // conservatively count (require_failure defaults true, but the after
    // hook may not report — then absence of progress still escalates).
    if (rule.require_failure === true && exitCode === null) return

    // Cross-process: `bump()` performs its own load -> prune -> increment
    // -> persist cycle under a file lock and is the SINGLE source of truth
    // for this bucket once a store is configured — mirroring its result
    // into the in-memory map (rather than also computing an independent
    // local increment) is what keeps the two from ever disagreeing. See
    // PersistentStuckStore.bump's own doc comment for why a separate
    // read-then-increment here would race across processes.
    if (this.persistentStore) {
      const persisted = this.persistentStore.bump(key, windowMs, exitCode)
      this.counts.set(key, { count: persisted.count, windowStart: persisted.windowStart, lastAttemptAt: persisted.lastAttemptAt, lastExit: persisted.lastExit })
      return
    }

    const now = Date.now()
    const existing = this.counts.get(key)
    if (!existing || now - existing.windowStart > windowMs) {
      this.counts.set(key, { count: 1, windowStart: now, lastAttemptAt: now, lastExit: exitCode })
      return
    }
    existing.count += 1
    existing.lastAttemptAt = now
    existing.lastExit = exitCode
  }

  /**
   * Resolve the bucket key for `input` — EXACT fingerprint match only.
   *
   * This used to also scan for a "near-identical" bucket when no exact
   * match existed, using `nearIdentical(cmd, fp)` — comparing the incoming
   * command's OWN fingerprint against itself, not against any existing
   * bucket's stored command. `commandFingerprint` is idempotent (fingerprinting
   * a fingerprint reproduces it), so that comparison was true for almost
   * any input, and the loop then returned the FIRST existing bucket for the
   * same rule+cwd in Map iteration order — attributing a brand-new,
   * unrelated command to whatever fail-streak happened to exist already.
   * `recordOutcome` above only ever writes under the exact-fingerprint key,
   * so a fuzzy read-side match here could never correspond to a real
   * shared write anyway. Fingerprinting already normalizes the retries this
   * was meant to catch (varying commit messages, flag values, temp paths,
   * hex ids, numeric literals — see command-fingerprint.ts), so two really
   * "near-identical" retries already collapse to the same exact fingerprint
   * without this.
   */
  private bucketOf(rule: KeelRule, input: EnforceInput): { key: string; fp: string } {
    const fp = this.fingerprintOf(rule, input)
    return { key: this.key(rule.id, input.cwd, fp), fp }
  }

  check(rule: KeelRule, input: EnforceInput): StuckEscalation | null {
    const cmd = commandString(input)
    if (!cmd) return null
    const { key, fp } = this.bucketOf(rule, input)
    let state = this.counts.get(key)
    const windowMs = (rule.window_seconds || 60) * 1000

    // Cross-process: a fresh process's in-memory map is empty even though
    // an earlier process already recorded failures for this exact bucket
    // (recordOutcome's write-through above). Prefer the persisted count
    // whenever it is further along than whatever this instance has locally
    // — the case that matters is "nothing locally, something persisted."
    if (this.persistentStore) {
      const persisted = this.persistentStore.get(key)
      if (persisted && (!state || persisted.count > state.count)) {
        state = { count: persisted.count, windowStart: persisted.windowStart, lastAttemptAt: persisted.lastAttemptAt, lastExit: persisted.lastExit }
        this.counts.set(key, state)
      }
    }

    if (!state) return null
    if (Date.now() - state.windowStart > windowMs) {
      this.counts.delete(key)
      if (this.persistentStore) this.persistentStore.delete(key)
      return null
    }

    const ladder = rule.escalation?.length
      ? [...rule.escalation].sort((a, b) => b.at - a.at)
      : [
          { at: rule.block_attempts ?? 5, action: 'deny' as const, message: '' },
          { at: rule.max_attempts ?? 3, action: 'redirect' as const, message: '' },
        ]

    // Highest met threshold wins (count 5 must deny, not redirect).
    for (const step of ladder) {
      if (state.count >= step.at) {
        const message = step.message || defaultMessage(rule.id, fp, state.count, step.action)
        return { action: step.action, message, attempts: state.count }
      }
    }
    return null
  }

  clear(sessionCwd?: string): void {
    if (sessionCwd) {
      for (const [key] of this.counts) {
        if (key.includes(`:${sessionCwd}:`)) this.counts.delete(key)
      }
      if (this.persistentStore) this.persistentStore.deleteByCwd(sessionCwd)
    } else {
      this.counts.clear()
      if (this.persistentStore) this.persistentStore.clearAll()
    }
  }
}

function defaultMessage(ruleId: string, fingerprint: string, attempts: number, action: string): string {
  if (action === 'redirect') {
    return `"${fingerprint}" has failed ${attempts} times — this is a stuck loop. Stop retrying. Run keel_research on the exact error text, record a root-cause hypothesis, then attempt once with a new approach.`
  }
  return `${attempts} identical failures of "${fingerprint}" — retrying without research is blocked. Record a hypothesis (keel_hypothesis) or ask the user.`
}
