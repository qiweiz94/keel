import { defineConfig } from 'vitest/config'

/**
 * opencode-db.test.ts builds real fixture databases via node:sqlite. That
 * module is unflagged on newer Node (this package's dev machines), but CI
 * is pinned to Node 22.12.0, where node:sqlite does not exist at all
 * without --experimental-sqlite (ERR_UNKNOWN_BUILTIN_MODULE, not just a
 * warning) — confirmed by running this exact Node version locally. The
 * production code (opencode-db.ts) already degrades gracefully when the
 * module is missing; the test fixture helper has no reason to, since it
 * exists specifically to exercise real sqlite reads.
 *
 * Set via NODE_OPTIONS (not poolOptions.<pool>.execArgv, which vitest 4.x's
 * actual config schema does not expose — that was tried first and silently
 * had no effect) so it reaches worker threads and forked workers alike,
 * regardless of which pool is active. Applied at config-load time, before
 * any worker spawns, so this doesn't depend on tinypool's flag-forwarding.
 */
if (!process.env.NODE_OPTIONS?.includes('--experimental-sqlite')) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --experimental-sqlite`.trim()
}

/**
 * globalSetup registers the override-isolation guard (AUDIT §8b): a
 * snapshot of real ~/.keel/overrides.json taken once before this package's
 * whole suite runs, and re-checked once after — failing the run if a test
 * leaked a real armed override to disk. See helpers/override-isolation-
 * guard.ts for the full rationale and the tolerance rules that keep this
 * from flaking under concurrent sibling worktrees / a real `keel allow`
 * run by hand mid-suite.
 */
export default defineConfig({
  test: {
    globalSetup: ['./src/enforce/__tests__/helpers/override-isolation-guard.ts'],
  },
})
