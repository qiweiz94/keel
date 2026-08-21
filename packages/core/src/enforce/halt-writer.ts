import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHome } from '../home.js'

/**
 * The core-side counterpart of `packages/cli/src/commands/halt.ts`'s
 * `haltSession()` — writes the IDENTICAL sentinel shape (same path, same
 * JSON field names, same `auto_clear_on_restart: false`), so `keel status`/
 * `keel resume`/`EnforcementPipeline.checkHalt()` (all of which read the
 * sentinel `cli/halt.ts` writes) treat a halt triggered from here exactly
 * the same as one triggered by a human running `keel halt`.
 *
 * This function exists ONLY because `packages/core` cannot import from
 * `packages/cli` — the build direction is cli -> core (packages/cli's
 * build script copies packages/core/src into packages/cli/src/core; the
 * reverse import would break both that build and the opencode-plugin
 * esbuild bundle). `cli/halt.ts`'s own header comment names this gap and
 * explicitly anticipates a rule-triggered halt needing a core-side twin —
 * this is that twin. `packages/core/src/enforce/budget-tracker.ts`'s
 * `hard_stop_multiplier` escalation is the first caller; a parallel
 * session-runaway-trip feature (`type: session`, composite) may need this
 * exact same function — reuse it rather than writing a second copy of the
 * sentinel shape.
 *
 * Deliberately as small and boring as `haltSession()` itself: no retry
 * logic, no locking (a halt sentinel overwritten by two racing writers
 * still ends up HALTED either way — the race has no unsafe outcome), no
 * TTL. `mkdirSync(..., { recursive: true })` mirrors `haltSession()`'s own
 * `existsSync` + `mkdirSync` guard exactly.
 */
export function writeHaltSentinel(reason: string, haltFilePath?: string): void {
  const path = haltFilePath || join(resolveHome(), '.keel', 'HALTED')
  const dir = join(path, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const state = {
    halted_at: new Date().toISOString(),
    reason: reason || 'Manual halt',
    auto_clear_on_restart: false,
  }
  writeFileSync(path, JSON.stringify(state, null, 2))
}
