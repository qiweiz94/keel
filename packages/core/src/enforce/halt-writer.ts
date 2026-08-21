import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHome } from '../home.js'

/**
 * Write the `keel halt` sentinel from WITHIN `packages/core` — a
 * core-side counterpart to `packages/cli/src/commands/halt.ts`'s
 * `haltSession()`, which core cannot call directly (the build direction
 * is cli -> core via the `cpSync('../core/src', './src/core')` step in
 * the cli package's build script; the reverse import would break both
 * that build and the opencode-plugin esbuild bundle — see halt.ts's own
 * header comment for the full explanation).
 *
 * Exists so a rule-triggered escalation living in `pipeline.ts` (a
 * `type: session` composite trip's terminal `consecutive_failures` step,
 * see pipeline.ts's session-trip branch; a `type: budget` token/dollar
 * rule may ALSO need this — if you're reading this because you're
 * building that rule and this file already exists, reuse it as-is rather
 * than duplicating it) can trip the SAME lockdown latch `keel halt`
 * itself writes, with no human in the loop.
 *
 * MUST write the identical sentinel shape haltSession() writes — same
 * path resolution, same JSON field names — so `keel status`/`keel
 * resume`/pipeline.ts's own `checkHalt()` interpret a rule-triggered halt
 * exactly like a manual one:
 *   path: join(resolveHome(), '.keel', 'HALTED')  (or the caller's
 *     override, mirroring PipelineConfig.haltFile — see below)
 *   body: { halted_at: <ISO string>, reason: <string>,
 *           auto_clear_on_restart: false }
 *
 * Takes the target path as a parameter rather than hardcoding
 * `resolveHome()` internally: `pipeline.ts`'s own `checkHalt()` resolves
 * the sentinel path as `this.config.haltFile || join(resolveHome(),
 * '.keel', 'HALTED')`, and a caller that skipped `config.haltFile` here
 * would write to the REAL `~/.keel/HALTED` even when the pipeline itself
 * was constructed with an isolated test path — exactly the kind of bug
 * that latches a developer's own machine deny-everything from a unit
 * test. Callers inside pipeline.ts must pass
 * `this.config.haltFile || join(resolveHome(), '.keel', 'HALTED')`
 * (the same expression checkHalt() already uses) explicitly.
 *
 * Idempotent, same as haltSession(): calling this while already halted
 * just overwrites the sentinel with the new reason/timestamp. Never
 * throws — a failed write here must not crash the hot enforcement path;
 * the caller has already decided to deny this call on its own terms
 * regardless of whether the halt sentinel write itself succeeds.
 */
export function writeHaltSentinel(haltPath: string, reason: string): void {
  try {
    const haltDir = join(haltPath, '..')
    if (!existsSync(haltDir)) mkdirSync(haltDir, { recursive: true })
    const state = {
      halted_at: new Date().toISOString(),
      reason: reason || 'Rule-triggered halt',
      auto_clear_on_restart: false,
    }
    writeFileSync(haltPath, JSON.stringify(state, null, 2))
  } catch {
    // Fail-safe: a halt-sentinel write failure must never crash the
    // enforcement hot path. The call being denied right now already
    // carries the real verdict; losing the persistent latch just means a
    // LATER call might not see it, which degrades toward "denies
    // resumed", not toward a false allow.
  }
}

/** Default halt sentinel path, matching checkHalt()'s own fallback exactly. */
export function defaultHaltPath(): string {
  return join(resolveHome(), '.keel', 'HALTED')
}
