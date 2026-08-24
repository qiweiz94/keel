import { defineConfig, configDefaults } from 'vitest/config'

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
 *
 * `src/core/**` is excluded from discovery: the build step copies
 * packages/core/src into src/core wholesale (see this package's build
 * script) so it can bundle into the CLI, and that copy carries core's own
 * `__tests__` directories along with it. Left unexcluded, `vitest run`
 * silently re-collects and re-runs the ENTIRE packages/core suite a second
 * time (409 extra test cases, confirmed via `vitest list`) — not as a
 * harmless duplicate, but INTERLEAVED with this package's own HOME/
 * KEEL_STATE_DIR-mutating test files inside the same worker process. That
 * is a real cross-file isolation race (the class of bug this lane exists
 * to fix): a copied test file's env-var override can land mid-flight
 * against a genuine CLI test file's own override, and vice versa. Core's
 * suite already runs, and is already verified, under `packages/core`'s own
 * `npm test` — this package has no business re-running it.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [...configDefaults.exclude, 'src/core/**'],
  },
})
