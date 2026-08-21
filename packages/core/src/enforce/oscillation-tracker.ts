import type { KeelRule, EnforceInput, EnforcementAction } from '../types.js'
import { commandFingerprint } from './command-fingerprint.js'
import { commandString } from './arg-utils.js'
import type { PersistentOscillationStore, PersistedOscillationState, OscillationEntry } from './oscillation-store.js'

/**
 * Oscillation detector: a short repeating CYCLE of length >= 2 in the
 * SEQUENCE of recent command fingerprints (A→B→A→B, or A→B→C→A→B→C) within
 * a session — the sibling `type: stuck` (no-repeat-loops, stuck-tracker.ts)
 * does not catch: that rule only fires on the SAME fingerprint repeated,
 * never on an agent alternating between two or three DIFFERENT failing
 * commands/edits that never converge (e.g. edit file A, edit file B undoing
 * A's change, edit A again).
 *
 * ROLLING WINDOW, not whole-session history: oscillation-store.ts keeps only
 * the last `oscillation_window_size` (default 8) fingerprints per session,
 * pruned by `window_seconds` TTL on top of that — a coincidental repeat
 * separated by a long gap (or by many unrelated intervening calls) must
 * never combine into a phantom cycle. See oscillation-store.ts's header for
 * the persisted shape and this class's `check()` for where the TTL is
 * re-applied live.
 *
 * THE require_failure QUESTION (read before changing the default): should
 * oscillation require the alternating commands to be FAILING, mirroring
 * no-repeat-loops' `require_failure` discriminator, or is pure behavioral
 * alternation (regardless of exit code) itself a valid stuck signal?
 *
 * Defaults to `true` — deliberately, and NOT exposed as a rule-author knob
 * to flip to `false` on this shipped default (the field is still read and
 * honored for a rule an operator defines from scratch — see the field's own
 * check below — this is a statement about what the SHIPPED default rule
 * declares, not a capability restriction). A legitimate TDD red-green-
 * refactor loop — edit test, edit code, edit test, edit code — is
 * LITERALLY period-2 alternation between two fingerprints; the only thing
 * that distinguishes it from a genuine stuck oscillation is that each step
 * SUCCEEDS. Requiring failure excludes that case by construction: the write
 * calls that make up a TDD loop almost always report exitCode 0 (the edit
 * itself succeeded), so `require_failure: true` never even appends them to
 * the window. The one command that legitimately fails and repeats in a TDD
 * loop (the test RUNNER, e.g. `npm test`, re-run each red iteration) is the
 * SAME fingerprint every time — period 1 — which this detector explicitly
 * never matches (see the distinct-fingerprint guard in `check()` below);
 * that is `no-repeat-loops`' territory, not this one's. This is the exact
 * asymmetry no-repeat-loops itself already relies on, and it earned its own
 * promotion out of `mode: observe` on real measured evidence — this
 * detector has none yet, so it starts from the same conservative default.
 *
 * KNOWN GAP this leaves open: an agent oscillating between two edits that
 * each individually SUCCEED (edit A, edit B undoing A, edit A again — no
 * command ever fails) is invisible to the shipped default. Catching that
 * would need a "no net progress" signal — e.g. a file's content hash
 * returning to a prior state — which needs content-state tracking no
 * tracker in this codebase currently feeds into this detector. Left as a
 * documented gap, not force-fit with a weaker proxy; see this rule's
 * `false_positives`/`rationale` in install.ts.
 */

const DEFAULT_WINDOW_SECONDS = 900   // TTL fallback — matches no-repeat-loops' shipped window_seconds
const DEFAULT_BUFFER_SIZE = 8        // rolling-window length fallback — "the last 4-8 calls"
const DEFAULT_MIN_CYCLE_LENGTH = 2
const DEFAULT_MAX_CYCLE_LENGTH = 4
const DEFAULT_MIN_CYCLE_REPEATS = 2  // A→B→A→B is the minimum evidence of a cycle; A→B alone is just two calls

export interface OscillationEscalation {
  action: EnforcementAction
  message: string
  attempts: number      // how many consecutive times the detected unit repeated
  period: number         // the detected cycle length (>= 2)
  cycle: string[]        // the fingerprints making up one repeating unit
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export class OscillationTracker {
  private memory = new Map<string, PersistedOscillationState>()

  constructor(private readonly persistentStore?: PersistentOscillationStore) {}

  private key(ruleId: string, sessionId: string): string {
    return `osc:${ruleId}:${sessionId}`
  }

  private fingerprintOf(rule: KeelRule, cmd: string): string {
    return rule.fingerprint === 'exact' ? cmd : commandFingerprint(cmd)
  }

  /**
   * Record one more attempt's fingerprint into `input.session_id`'s rolling
   * window — or don't, per the require_failure discriminator (see this
   * file's header). Unlike StuckTracker.recordOutcome, a SUCCESS does not
   * clear the window: a success on some UNRELATED command is routine
   * session noise (most calls in a healthy session succeed), not evidence
   * that THIS particular candidate cycle resolved — it simply is never
   * appended, so it cannot itself become part of a detected cycle, but it
   * also does not erase whatever failing history came before it. Only a
   * `require_failure: false` rule appends every outcome, success included.
   */
  recordOutcome(rule: KeelRule, input: EnforceInput, exitCode: number | null): void {
    if (!input.session_id) return
    const cmd = commandString(input)
    if (!cmd) return
    const requireFailure = rule.require_failure !== false
    if (requireFailure) {
      // Unreported outcome: neither counts nor resets — mirrors
      // StuckTracker.recordOutcome's identical `exitCode === null` skip.
      if (exitCode === null) return
      // A clean success is not part of the failing surface this discriminator
      // watches — see this file's header for why it is simply skipped
      // (not appended) rather than clearing the whole window.
      if (exitCode === 0) return
    }
    const fp = this.fingerprintOf(rule, cmd)
    const key = this.key(rule.id, input.session_id)
    const windowMs = (rule.window_seconds || DEFAULT_WINDOW_SECONDS) * 1000
    const bufferSize = rule.oscillation_window_size || DEFAULT_BUFFER_SIZE
    const entry: OscillationEntry = { fp, at: Date.now(), exit: exitCode }

    if (this.persistentStore) {
      const next = this.persistentStore.append(key, entry, windowMs, bufferSize)
      this.memory.set(key, next)
      return
    }
    const now = Date.now()
    const existing = this.memory.get(key)
    const fresh = (existing?.entries || []).filter(e => now - e.at < windowMs)
    const nextEntries = [...fresh, entry].slice(-bufferSize)
    this.memory.set(key, { entries: nextEntries, windowMs })
  }

  /**
   * Resolve the current escalation for `input`'s session, or `null` if no
   * cycle is detected (or the ladder's lowest threshold isn't met yet).
   *
   * Algorithm: re-derive the LIVE window (TTL-pruned against the calling
   * rule's current `window_seconds`, same "never trust the stored value
   * alone" posture as StuckTracker.check()), then scan candidate cycle
   * lengths ascending from `min_cycle_length` to `max_cycle_length`. For
   * each length `p`, take the last `p * min_cycle_repeats` fingerprints,
   * split into `min_cycle_repeats` chunks of size `p`, and require every
   * chunk to equal the first (the candidate "unit"). The smallest `p` that
   * matches wins — a genuine A→B→A→B (p=2) is reported as p=2, never
   * mis-reported as its own p=4 double-repetition.
   *
   * Distinct-fingerprint guard: a unit whose own elements are not at least
   * 2 distinct fingerprints (e.g. p=2 with unit [A, A]) is skipped — that is
   * exact repetition, `no-repeat-loops`' territory, and this detector must
   * never double-count it as a "cycle" of its own.
   */
  check(rule: KeelRule, input: EnforceInput): OscillationEscalation | null {
    if (!input.session_id) return null
    const key = this.key(rule.id, input.session_id)
    let state = this.memory.get(key)

    // Cross-process: a fresh process's in-memory map is empty even though an
    // earlier process already recorded fingerprints for this exact session
    // bucket. Prefer the persisted bucket whenever it is at least as
    // informative as whatever this instance has locally — mirrors
    // StuckTracker.check()'s identical "further along" preference.
    if (this.persistentStore) {
      const persisted = this.persistentStore.get(key)
      if (persisted && (!state || persisted.entries.length >= state.entries.length)) {
        state = persisted
        this.memory.set(key, state)
      }
    }
    if (!state || state.entries.length === 0) return null

    const windowMs = (rule.window_seconds || DEFAULT_WINDOW_SECONDS) * 1000
    const now = Date.now()
    const fresh = state.entries.filter(e => now - e.at < windowMs)
    if (fresh.length !== state.entries.length) {
      state = { ...state, entries: fresh }
      this.memory.set(key, state)
    }
    if (fresh.length === 0) return null

    const minLen = Math.max(2, rule.min_cycle_length || DEFAULT_MIN_CYCLE_LENGTH)
    const maxLen = Math.max(minLen, rule.max_cycle_length || DEFAULT_MAX_CYCLE_LENGTH)
    const minRepeats = Math.max(2, rule.min_cycle_repeats || DEFAULT_MIN_CYCLE_REPEATS)
    const fps = fresh.map(e => e.fp)

    for (let period = minLen; period <= maxLen; period++) {
      const need = period * minRepeats
      if (fps.length < need) continue
      const tail = fps.slice(-need)
      const unit = tail.slice(0, period)
      if (new Set(unit).size < 2) continue

      let matches = true
      for (let i = period; i < tail.length; i += period) {
        if (!arraysEqual(tail.slice(i, i + period), unit)) { matches = false; break }
      }
      if (!matches) continue

      // Count how far back the unit ACTUALLY repeats (may exceed `need`) —
      // the ladder escalates on this, not on the minimum-evidence threshold
      // alone, the same "highest met step wins" shape StuckTracker.check()
      // uses.
      let attempts = 0
      let i = fps.length
      while (i >= period && arraysEqual(fps.slice(i - period, i), unit)) { attempts++; i -= period }

      const ladder = rule.escalation?.length
        ? [...rule.escalation].sort((a, b) => b.at - a.at)
        : [
            { at: minRepeats + 1, action: 'deny' as const, message: '' },
            { at: minRepeats, action: 'redirect' as const, message: '' },
          ]
      for (const step of ladder) {
        if (attempts >= step.at) {
          const message = step.message || defaultMessage(unit, attempts, step.action)
          return { action: step.action, message, attempts, period, cycle: unit }
        }
      }
      return null
    }
    return null
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      for (const [k] of this.memory) {
        if (k.endsWith(`:${sessionId}`)) this.memory.delete(k)
      }
      if (this.persistentStore) this.persistentStore.deleteBySession(sessionId)
    } else {
      this.memory.clear()
      if (this.persistentStore) this.persistentStore.clearAll()
    }
  }
}

function defaultMessage(unit: string[], attempts: number, action: string): string {
  const cycleDesc = unit.map(u => `"${u}"`).join(' → ')
  if (action === 'redirect') {
    return `Oscillating pattern detected: ${cycleDesc} → (repeating) has cycled ${attempts} times without resolving. Stop alternating between these steps — research why neither one is holding, state a root-cause hypothesis, then change approach.`
  }
  return `${attempts} repeats of the oscillating pattern ${cycleDesc} → (repeating) — continuing without new information is blocked. Record a hypothesis or ask the user.`
}
