import { rmSync } from 'node:fs'
import type { RmOptions } from 'node:fs'

/**
 * Windows-safe recursive removal for test fixture teardown.
 *
 * Nine of this package's test files spawn the real `dist/index.js` as a
 * subprocess (see vitest.config.ts's header) against a scratch HOME/
 * project directory, then tear that directory down in `afterEach`/
 * `afterAll`. On Windows, a just-exited child process's file handles are
 * not guaranteed closed the instant the process object resolves —
 * `rmSync`'s recursive walk can hit a file the OS still considers open,
 * which raises `EBUSY`/`EPERM` there where POSIX would silently succeed.
 * The plain `{ recursive: true, force: true }` shape used throughout this
 * suite (pre-dating this fix) does not absorb that race.
 *
 * `fs.rmSync`'s own `maxRetries`/`retryDelay` options (Node's built-in
 * answer to exactly this race, since Node 14.14) are used rather than a
 * hand-rolled retry loop. Identical to the core package's copy of this
 * helper (packages/core/src/enforce/__tests__/helpers/fs-safe.ts) —
 * duplicated rather than imported across the package boundary because
 * this package's `src/core/**` is a generated copy of core's source
 * (never hand-edited, see vitest.config.ts), not a place to add a
 * cross-package test-only dependency.
 */
export function rmSafe(path: string, options: RmOptions = {}): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50, ...options })
}
