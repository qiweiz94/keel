import { defineConfig } from 'vitest/config'

/**
 * Nine of the CLI test files exercise keel the way a user does: by spawning
 * the real `dist/index.js` as a subprocess. That is deliberate — it is the
 * only way to catch defects in argument parsing, exit codes and the wiring
 * between commands, which an in-process import would skip entirely.
 *
 * The cost is startup: each spawn loads a ~1MB bundle, and on a cold macOS
 * CI runner that regularly exceeds vitest's 5s default. Two separate tests
 * (dashboard-web, level) failed that way on CI while passing locally, which
 * is the signature of a timeout that is too tight rather than a real bug —
 * so raise it once here instead of annotating tests one at a time as each
 * one happens to trip.
 *
 * This is a floor for slow machines, not a licence for slow tests: the whole
 * CLI suite runs in well under 10s locally.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
