import { openSync, writeSync, closeSync, unlinkSync, statSync } from 'node:fs'

/**
 * file-lock — a dependency-light cross-process advisory lock built on
 * O_EXCL lockfiles, used by StateManager and ProblemLedger to serialize
 * the load -> mutate -> save cycle against a shared JSON file so
 * concurrent hook/agent processes don't clobber each other's writes
 * (lost updates).
 *
 * Mechanism: `openSync(lockPath, 'wx')` atomically creates the lockfile
 * only if it does not already exist (POSIX O_CREAT|O_EXCL) — the OS, not
 * this process, arbitrates the race when two processes attempt it at the
 * same instant. The loser retries with a short bounded backoff.
 *
 * Stale locks (holder crashed/was killed before releasing) are reclaimed
 * once the lockfile is older than `staleMs` — otherwise a single dead
 * process would wedge every future writer forever.
 *
 * FAIL-SAFE CHOICE (binding for all callers): if the lock cannot be
 * acquired within `timeoutMs`, `withFileLock` still runs the callback
 * WITHOUT the lock rather than skipping it or throwing/hanging.
 * Enforcement state must never be silently dropped (a skipped write is a
 * warn-once or circuit-breaker count that quietly never happened) and a
 * hook invocation must never hang (an agent tool call blocked
 * indefinitely is worse than a rare, narrow race). Losing the lock only
 * reintroduces the lost-update race this module exists to close, and
 * only in the improbable case of sustained contention beyond the
 * timeout window (stale locks are already reclaimed well before that) —
 * an acceptable, explicitly-chosen trade against hanging or dropping.
 */

export interface LockOptions {
  /** Max total time to wait for the lock before giving up, in ms. */
  timeoutMs?: number
  /** A held lock older than this is assumed abandoned and is reclaimed. */
  staleMs?: number
}

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_STALE_MS = 5000
const INITIAL_BACKOFF_MS = 4
const MAX_BACKOFF_MS = 60

/**
 * Blocks the calling thread for `ms` milliseconds. The state-manager /
 * problem-ledger read-modify-write cycle is already synchronous
 * (readFileSync/writeFileSync); a short bounded busy-wait here preserves
 * that invariant instead of forcing every caller through async/await.
 * `Atomics.wait` on a throwaway SharedArrayBuffer is the standard sync
 * sleep primitive in Node; environments without it fall back to a spin
 * loop (identical cost profile for waits this short).
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Attempt to acquire an exclusive lockfile at `lockPath`, retrying with
 * backoff until `timeoutMs` elapses. Returns true on success, false on
 * timeout. Callers MUST treat `false` per the fail-safe contract above
 * (proceed unlocked), never as license to skip the operation.
 */
export function acquireLock(lockPath: string, options: LockOptions = {}): boolean {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const deadline = Date.now() + timeoutMs
  let backoff = INITIAL_BACKOFF_MS

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, `${process.pid}:${Date.now()}`)
      } finally {
        closeSync(fd)
      }
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Unexpected error (EACCES, missing parent dir, ...) — don't spin
        // on something backoff can't fix.
        return false
      }
    }

    // Someone else holds the lock. Reclaim it if it looks abandoned.
    try {
      const heldFor = Date.now() - statSync(lockPath).mtimeMs
      if (heldFor > staleMs) {
        try { unlinkSync(lockPath) } catch { /* raced another reclaimer; loop and retry */ }
        continue // no backoff — try to create it again immediately
      }
    } catch {
      continue // lock vanished between EEXIST and stat — retry immediately
    }

    if (Date.now() >= deadline) return false
    // Full jitter (not just capped exponential backoff): under N-way
    // contention, unjittered retries synchronize — every waiter wakes at
    // the same instant and loses the race to the same single winner
    // again, so the LOSERS' wait time grows with N instead of shrinking.
    // Randomizing within [0, backoff] desynchronizes retries so the
    // group drains in roughly backoff/N per waiter instead.
    const jittered = Math.random() * backoff
    sleepSync(Math.min(jittered, Math.max(0, deadline - Date.now())))
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }
}

export function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath) } catch { /* already gone, or never acquired */ }
}

/**
 * Run `fn` while holding the lock at `lockPath`. See the fail-safe note
 * above: on timeout, `fn` still runs, unlocked.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, options: LockOptions = {}): T {
  const acquired = acquireLock(lockPath, options)
  try {
    return fn()
  } finally {
    if (acquired) releaseLock(lockPath)
  }
}
