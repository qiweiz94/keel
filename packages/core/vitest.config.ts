import { defineConfig } from 'vitest/config'

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
