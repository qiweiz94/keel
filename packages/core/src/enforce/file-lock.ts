import { openSync, writeSync, closeSync, unlinkSync, statSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { currentFlavor, type PathFlavor } from './path-normalize.js'

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
 * Stale locks (holder crashed/was killed, or was paused by the OS for
 * longer than `staleMs`) are reclaimed so a single dead holder can't
 * wedge every future writer forever. Each acquire writes a unique TOKEN
 * into the lockfile; release only unlinks the file if its contents still
 * match the token this process wrote. Without that check, a reclaim can
 * cascade: holder A stalls past `staleMs`, waiter B reclaims (unlinks A's
 * lock, creates its own), A finally wakes up and calls release — if
 * release unconditionally unlinks, it deletes B's live lock, not its own,
 * and a third process can now enter while B still thinks it's inside.
 * Token verification makes A's late release a no-op instead.
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
 * See file-lock.test.ts for both this fail-safe and the stale-reclaim
 * path exercised directly (deterministically, no child processes needed
 * — state-manager-concurrency.test.ts / ledger-concurrency.test.ts cover
 * the actual cross-process lost-update property those depend on).
 */

export interface LockOptions {
  /** Max total time to wait for the lock before giving up, in ms. */
  timeoutMs?: number
  /** A held lock older than this is assumed abandoned and is reclaimed. */
  staleMs?: number
}

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_STALE_MS = 8000
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

let tokenCounter = 0

function makeToken(): string {
  tokenCounter += 1
  return `${process.pid}:${Date.now()}:${tokenCounter}:${Math.random().toString(36).slice(2)}`
}

/**
 * Classifies an `openSync`/`unlinkSync` error code as retryable lock
 * CONTENTION (someone else legitimately holds or is mid-delete-of the
 * lockfile — keep retrying) vs FATAL (a real problem backoff can't fix —
 * give up per the fail-safe contract).
 *
 * On POSIX, `openSync(path, 'wx')` against an existing file always yields
 * exactly `EEXIST` — the only contention code there. On Windows, the same
 * call against a file another process holds open (or that Windows is
 * mid-deleting, which the OS treats as a pending-delete state until the
 * last handle closes) can instead yield `EBUSY` or `EPERM` — mandatory
 * file locking means "this name is momentarily unusable" surfaces as a
 * sharing-violation code, not always EEXIST. Before this, any of those
 * codes hit the pre-existing `!= 'EEXIST'` branch and returned `null`
 * immediately (the fail-safe "run unlocked" path) instead of retrying —
 * so on Windows, ordinary two-process contention (not a real fault) could
 * silently skip locking on the very first collision instead of waiting
 * out the (typically sub-millisecond) window.
 *
 * A pure function of `(code, flavor)` — not `fs` — specifically so this
 * classification is unit-testable on macOS with `flavor: 'win32'` without
 * faking the filesystem or a real Windows host.
 */
export function classifyLockError(
  code: string | undefined,
  flavor: PathFlavor = currentFlavor(),
): 'contention' | 'fatal' {
  if (code === 'EEXIST') return 'contention'
  if (flavor === 'win32' && (code === 'EBUSY' || code === 'EPERM')) return 'contention'
  return 'fatal'
}

/**
 * `unlinkSync` with bounded retries. On Windows, deleting a file another
 * handle still has open (or that a just-exited child process hasn't fully
 * released yet) raises `EBUSY`/`EPERM` rather than succeeding as it would
 * on POSIX — a `try { unlinkSync } catch {}` there doesn't make the
 * failure harmless, it makes the lockfile PERSIST, so every later
 * acquirer hits `EEXIST` until `staleMs` elapses (an 8s stall by
 * default). A short retry loop absorbs the race instead.
 */
function unlinkWithRetry(path: string, attempts = 5, delayMs = 5): void {
  for (let i = 0; i < attempts; i++) {
    try {
      unlinkSync(path)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return // already gone — the goal state
      if (i === attempts - 1) throw err
      sleepSync(delayMs * (i + 1))
    }
  }
}

/**
 * Attempt to acquire an exclusive lockfile at `lockPath`, retrying with
 * backoff until `timeoutMs` elapses. Returns the token written into the
 * lockfile on success (pass it to `releaseLock`), or `null` on timeout /
 * an unexpected error. Callers MUST treat `null` per the fail-safe
 * contract above (proceed unlocked), never as license to skip the
 * operation.
 */
export function acquireLock(lockPath: string, options: LockOptions = {}): string | null {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const deadline = Date.now() + timeoutMs
  let backoff = INITIAL_BACKOFF_MS

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      const token = makeToken()
      try {
        writeSync(fd, token)
      } finally {
        closeSync(fd)
      }
      return token
    } catch (err) {
      if (classifyLockError((err as NodeJS.ErrnoException).code) !== 'contention') {
        // Unexpected error (EACCES, missing parent dir, ...) — don't spin
        // on something backoff can't fix.
        return null
      }
    }

    // Someone else holds the lock (or, on Windows, it's in a transient
    // sharing-violation state). Reclaim it if it looks abandoned.
    try {
      const heldFor = Date.now() - statSync(lockPath).mtimeMs
      if (heldFor > staleMs) {
        try { unlinkWithRetry(lockPath) } catch { /* raced another reclaimer; loop and retry */ }
        continue // no backoff — try to create it again immediately
      }
    } catch {
      continue // lock vanished between EEXIST and stat — retry immediately
    }

    if (Date.now() >= deadline) return null
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

/**
 * Release the lock at `lockPath`. If `token` is given, only unlinks when
 * the lockfile still contains that exact token — protects against the
 * reclaim-cascade described in the file header (a late release from a
 * holder that was already reclaimed as stale must not delete the new
 * holder's live lock).
 */
export function releaseLock(lockPath: string, token?: string): void {
  try {
    if (token !== undefined) {
      const current = readFileSync(lockPath, 'utf-8')
      if (current !== token) return // reclaimed by someone else — not ours to remove
    }
    unlinkWithRetry(lockPath)
  } catch { /* already gone, never acquired, or vanished while we read it — all fine */ }
}

/**
 * Run `fn` while holding the lock at `lockPath`. See the fail-safe note
 * above: on timeout, `fn` still runs, unlocked.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, options: LockOptions = {}): T {
  const token = acquireLock(lockPath, options)
  try {
    return fn()
  } finally {
    if (token !== null) releaseLock(lockPath, token)
  }
}

/**
 * Write `content` to `path` via write-to-tmp + atomic rename, retrying the
 * rename on transient Windows lock contention (EBUSY/EPERM) instead of
 * treating it as fatal. Every ProblemLedger/StateManager/-Store class in
 * this directory writes its own JSON state with this exact write-tmp-then-
 * rename shape wrapped in a bare catch-and-ignore block around the WHOLE
 * body ("best effort", "non-critical", "state persistence is non-critical"
 * -- same idea, worded differently per file): a
 * transient rename failure was treated identically to a permanent one and
 * silently dropped the write, with the in-memory mutation that produced it
 * gone the moment the next reader reloads from disk under a fresh lock.
 *
 * Reproduced on real windows-latest CI: ledger-concurrency.test.ts and
 * state-manager-concurrency.test.ts (200 iterations across 5 processes,
 * all serialized through the SAME withFileLock-protected read-modify-write
 * cycle) each intermittently lost 1-3 of 200 increments, on runs where the
 * lock itself was never lost (no fail-safe-unlocked branch taken --
 * confirmed by re-reading those logs: every "PASS"/deny/warn-once
 * escalation elsewhere in the same suite that also depends on this lock
 * behaved correctly on the same run). A silently-dropped SAVE under an
 * otherwise-healthy lock is exactly what a swallowed transient rename
 * failure looks like from the outside, and matches the small, rare
 * loss counts far better than a lock-acquisition problem would (losing the
 * LOCK typically loses a whole worker's remaining iterations at once, not
 * 1-3 scattered ones -- a bounded-timeout widening on the lock's own
 * knobs, tried first here as the more obvious suspect, made no measurable
 * difference across three real CI runs, which is the evidence that
 * redirected the investigation to the write side instead).
 *
 * Kept deliberately short-lived (2s, not the 5-30s lock-acquire budgets):
 * this runs WHILE the caller's own lock is held, so a long retry here
 * would itself risk making the current holder look abandoned to a stale-
 * reclaim check on the lock file, the opposite of what this is trying to
 * fix. Never throws -- preserves every existing caller's "best effort,
 * persistence failure is not fatal" contract unchanged; the boolean return
 * is new and safe for every current caller to ignore.
 */
export function writeFileAtomic(path: string, content: string, options: { mode?: number } = {}): boolean {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    if (options.mode !== undefined) writeFileSync(tmp, content, { mode: options.mode })
    else writeFileSync(tmp, content)
  } catch {
    return false
  }

  const deadline = Date.now() + 2000
  let backoff = INITIAL_BACKOFF_MS
  for (;;) {
    try {
      renameSync(tmp, path)
      return true
    } catch (err) {
      const isContention = classifyLockError((err as NodeJS.ErrnoException).code) === 'contention'
      if (!isContention || Date.now() >= deadline) {
        try { unlinkSync(tmp) } catch { /* best effort cleanup of our own tmp file */ }
        return false
      }
      const jittered = Math.random() * backoff
      sleepSync(Math.min(jittered, Math.max(0, deadline - Date.now())))
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
  }
}
