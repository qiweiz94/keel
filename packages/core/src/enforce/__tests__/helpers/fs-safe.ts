import { rmSync } from 'node:fs'
import type { RmOptions } from 'node:fs'

/**
 * Windows-safe recursive removal for test fixture teardown.
 *
 * A spawned child process (a worker thread fixture, a shimmed CLI
 * subprocess) can still hold a handle on a file inside the directory
 * being torn down for a few ms after the test believes it has exited.
 * POSIX unlink doesn't care (the directory entry is removed immediately;
 * the open handle keeps the data alive until closed). Windows enforces
 * mandatory file locking: an `rmSync` racing that teardown window throws
 * `EBUSY`/`EPERM` where POSIX would silently succeed — a real, sporadic
 * teardown failure the plain `{ recursive: true, force: true }` shape
 * used throughout this test suite does not absorb.
 *
 * `fs.rmSync`'s own `maxRetries`/`retryDelay` options (Node's built-in
 * answer to exactly this race, since Node 14.14) are used rather than a
 * hand-rolled retry loop.
 */
export function rmSafe(path: string, options: RmOptions = {}): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50, ...options })
}
