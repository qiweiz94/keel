import { describe } from 'vitest'

/**
 * Some CLI tests put a `keel` shim on PATH so they can exercise the command
 * the way a user invokes it — `keel level protect`, not `node dist/index.js
 * level protect`. That shim is a `#!/bin/bash` file with no extension, on a
 * `:`-separated PATH. Neither works on Windows: there is no shebang support
 * and no extensionless executable resolution.
 *
 * Those suites are skipped there rather than deleted or faked. The
 * alternative — a parallel `.cmd` shim — is a real option, but it would ship
 * unverified: there is no Windows machine in this loop, and a cross-platform
 * shim asserted only by hope is worse than an honest skip.
 *
 * Everything that does NOT depend on a PATH shim runs on all three
 * platforms. Before this, `npm test` was skipped on Windows entirely and the
 * three-OS matrix reported a type-check as coverage.
 */
export const describePosixShim = describe.skipIf(process.platform === 'win32')
