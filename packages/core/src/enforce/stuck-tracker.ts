import type { KeelRule, EnforceInput } from '../types.js'
import { commandFingerprint, nearIdentical } from './command-fingerprint.js'
import { commandString } from './arg-utils.js'

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
    const now = Date.now()

    // Success resets the loop (the problem changed).
    if (exitCode === 0) {
      this.counts.delete(key)
      return
    }
    // Failure-aware rules only count nonzero exits; without an exit code we
    // conservatively count (require_failure defaults true, but the after
    // hook may not report — then absence of progress still escalates).
    if (rule.require_failure === true && exitCode === null) return

    const existing = this.counts.get(key)
    if (!existing || now - existing.windowStart > windowMs) {
      this.counts.set(key, { count: 1, windowStart: now, lastAttemptAt: now, lastExit: exitCode })
      return
    }
    existing.count += 1
    existing.lastAttemptAt = now
    existing.lastExit = exitCode
  }

  /** Near-identical matches share the same counter bucket (loops mutate args). */
  private bucketOf(rule: KeelRule, input: EnforceInput, cmd: string): { key: string; fp: string } {
    const fp = this.fingerprintOf(rule, input)
    // Exact fingerprint hit first.
    const exact = this.counts.get(this.key(rule.id, input.cwd, fp))
    if (exact) return { key: this.key(rule.id, input.cwd, fp), fp }
    // Otherwise find a near-identical bucket.
    for (const [key, state] of this.counts) {
      if (!key.startsWith(`stuck:${rule.id}:${input.cwd}:`)) continue
      const existing = this.counts.get(key)
      if (existing && nearIdentical(cmd, fp)) return { key, fp }
    }
    return { key: this.key(rule.id, input.cwd, fp), fp }
  }

  check(rule: KeelRule, input: EnforceInput): StuckEscalation | null {
    const cmd = commandString(input)
    if (!cmd) return null
    const { key, fp } = this.bucketOf(rule, input, cmd)
    const state = this.counts.get(key)
    if (!state) return null
    const windowMs = (rule.window_seconds || 60) * 1000
    if (Date.now() - state.windowStart > windowMs) {
      this.counts.delete(key)
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
    } else {
      this.counts.clear()
    }
  }
}

function defaultMessage(ruleId: string, fingerprint: string, attempts: number, action: string): string {
  if (action === 'redirect') {
    return `"${fingerprint}" has failed ${attempts} times — this is a stuck loop. Stop retrying. Run keel_research on the exact error text, record a root-cause hypothesis, then attempt once with a new approach.`
  }
  return `${attempts} identical failures of "${fingerprint}" — retrying without research is blocked. Record a hypothesis (keel_hypothesis) or ask the user.`
}
