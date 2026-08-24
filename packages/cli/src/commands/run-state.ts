import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { withFileLock, type LockOptions } from '../core/enforce/file-lock.js'
import { resolveHome } from '../core/home.js'

/**
 * State backing `keel run` / `keel halt --kill` — the process-supervision
 * pair. See run.ts (the writer, on spawn) and run-kill.ts (the reader +
 * the safety-checked kill algorithm).
 *
 * KEYED BY PID (as a string), same shape as every other cross-process
 * store in this codebase (session-store.ts, budget-store.ts, stuck-store.ts,
 * flow-store.ts are all keyed dictionaries under one file + one file-lock,
 * never a flat singleton for "the current X") — a singleton would force
 * `keel run` to either refuse a second concurrent supervised agent or
 * silently stomp the first one's tracking entry the moment a second starts,
 * and this user's own workflow regularly runs several parallel worktree
 * lanes at once. A dead/stale entry for one pid never blocks a fresh entry
 * for a different pid from being recorded or killed independently.
 *
 * File lives directly at `~/.keel/RUN_STATE` (a sibling of the `HALTED`/
 * `DISABLED` sentinels, not under state-manager.ts's `stateDir()` state/
 * subdirectory) — this is a human-facing kill-list a human may reasonably
 * `cat`, not hot-path enforcement bookkeeping, so it stays alongside the
 * other top-level `.keel` control files `halt.ts`/`disable.ts` already
 * write, per haltFilePath()'s own resolveHome() convention.
 */

/**
 * A process's identity beyond its PID — PIDs get recycled by the OS, so a
 * bare PID match is not enough to know "this is the SAME process `keel
 * run` launched" versus "a different process that happens to reuse the
 * pid now". Every field here is compared as an OPAQUE STRING — never
 * parsed into a Date/number — because parsing invites locale/timezone bugs
 * that could make two genuinely different readings compare equal (or two
 * identical readings compare different). Exact string equality is the
 * conservative direction: any difference, including one this module failed
 * to explain, means "not the same process" and the caller must refuse.
 */
export interface ProcessIdentity {
  /**
   * Linux: the raw starttime field (field 22) from `/proc/<pid>/stat`, in
   * clock ticks since boot — prefixed `linux-stat:` so it can never collide
   * with the POSIX-ps form below by accident.
   * Other POSIX (macOS/BSD): `ps -o lstart=` output with `LC_ALL=C` pinned
   * (locale-independent month names), prefixed `posix-lstart:`. Only
   * 1-SECOND resolution on macOS — see `command` below for the discriminator
   * that covers the same-second-start collision this leaves open.
   */
  startTime: string
  /**
   * Secondary discriminator: the full command line (`/proc/<pid>/cmdline`
   * on Linux, `ps -o command=` elsewhere). Two unrelated processes starting
   * within the same wall-clock second (a real risk given macOS's 1s `lstart`
   * resolution) are still very unlikely to share both startTime AND the
   * exact command line.
   */
  command: string
  /**
   * Boot identity: Linux's `/proc/sys/kernel/random/boot_id` (a fresh UUID
   * every boot) or, on macOS, `sysctl -n kern.boottime`'s output. Exists so
   * a REBOOT invalidates every recorded identity outright — `/proc`
   * starttime is ticks-since-boot, so a low pid on a freshly-rebooted
   * machine can otherwise land suspiciously close to an old recorded value.
   * Empty string when unavailable (never treated as a mismatch by itself —
   * see identitiesMatch — only ever narrows, never the sole signal).
   */
  bootId: string
}

export interface RunStateEntry {
  /** ISO timestamp of when `keel run` recorded this entry. */
  started_at: string
  /** The agent-cmd argv `keel run` was given, for display only (`keel status`, disambiguation lists) — never re-executed from this file. */
  command: string[]
  pid: number
  /** Process group id — always equal to `pid` for a POSIX `detached: true` spawn (the child becomes its own group's leader), recorded explicitly rather than assumed at kill-time so a future non-detached caller can't silently break the invariant this file's readers rely on. */
  pgid: number
  identity: ProcessIdentity
  /**
   * True from the moment `keel run` writes this entry (right after the
   * child's `'spawn'` event — exec confirmed succeeded, but identity not
   * read yet) until the identity fields above are populated and this flips
   * to false. `keel halt --kill` MUST refuse to signal any entry still
   * `unverified` — there is nothing to compare a future re-read against, so
   * "kill it anyway" would be exactly the unchecked-PID-trust this whole
   * feature exists to avoid.
   */
  unverified: boolean
  /**
   * Set by a kill attempt that found the pid alive but the identity no
   * longer matching what was recorded (PID reuse) — informational only,
   * never read as a branch condition (a `stale` entry is still fully
   * re-verified from scratch on the next kill attempt; see run-kill.ts's
   * own comment for why a cached verdict is never trusted over a fresh
   * check).
   */
  stale?: boolean
  stale_reason?: string
  stale_detected_at?: string
}

export type RunStateFile = Record<string, RunStateEntry>

export function runStateFilePath(): string {
  return join(resolveHome(), '.keel', 'RUN_STATE')
}

function runStateLockPath(): string {
  return `${runStateFilePath()}.lock`
}

function runStateDir(): string {
  return join(resolveHome(), '.keel')
}

function load(): RunStateFile {
  try {
    const p = runStateFilePath()
    if (!existsSync(p)) return {}
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as RunStateFile
    return {}
  } catch {
    // Corrupt/unreadable — treat as empty rather than throwing. The safe
    // direction for a KILL-LIST is "forget a target" (never kill), not
    // "crash keel run/halt" or "invent a target from noise".
    return {}
  }
}

/** Atomic write (tmp + rename) + `0600`: this file records full argv, which can carry secrets/tokens — same posture as daemon.ts's `daemon-token` (mode 0600 at creation). */
function save(data: RunStateFile): void {
  try {
    mkdirSync(runStateDir(), { recursive: true })
    const p = runStateFilePath()
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmp, p)
    try { chmodSync(p, 0o600) } catch { /* rename preserves the tmp file's mode on POSIX; belt-and-suspenders only */ }
  } catch {
    // Best-effort persistence, same posture as every other store in this
    // codebase (session-store.ts's save(), etc.) — a failed write here
    // means a LATER `keel halt --kill` sees no entry for this pid, which is
    // the safe direction (nothing to kill) rather than the unsafe one.
  }
}

/** Every currently-tracked entry, keyed by pid string. Read-only, no lock — mirrors PersistentSessionStore.get()'s lock-free read contract. */
export function readAllRunState(): RunStateFile {
  return load()
}

/** One entry by pid, or null. */
export function readRunStateEntry(pid: number): RunStateEntry | null {
  const data = load()
  return data[String(pid)] ?? null
}

/**
 * Write a PROVISIONAL entry immediately after the child's `'spawn'` event
 * (exec confirmed) — pid/pgid/command known, identity not yet read,
 * `unverified: true`. Written under the lock so a concurrent `keel halt
 * --kill` reading mid-write never observes a half-written record (the
 * store is JSON-atomic via load/save, but the LOCK is what keeps two
 * `keel run` processes from losing each other's entries on a
 * read-modify-write).
 */
export function writeProvisionalEntry(pid: number, pgid: number, command: string[], lockOptions: LockOptions = {}): void {
  withFileLock(runStateLockPath(), () => {
    const data = load()
    data[String(pid)] = {
      started_at: new Date().toISOString(),
      command,
      pid,
      pgid,
      identity: { startTime: '', command: '', bootId: '' },
      unverified: true,
    }
    save(data)
  }, lockOptions)
}

/** Upgrade a provisional entry once its identity has been read. No-op if the entry is gone (killed/cleared) or its pid no longer matches (defensive — should not happen since pid is the key). */
export function upgradeEntry(pid: number, identity: ProcessIdentity, lockOptions: LockOptions = {}): void {
  withFileLock(runStateLockPath(), () => {
    const data = load()
    const key = String(pid)
    const existing = data[key]
    if (!existing || existing.pid !== pid) return
    data[key] = { ...existing, identity, unverified: false }
    save(data)
  }, lockOptions)
}

/** Remove one entry — used on confirmed kill, confirmed-dead cleanup, and normal `keel run` exit. Guarded: only removes if the CURRENT on-disk entry for this pid still matches (never clobbers a different process that happens to have reused the same pid key between read and write). */
export function removeEntryIfMatches(pid: number, expectedStartedAt: string, lockOptions: LockOptions = {}): void {
  withFileLock(runStateLockPath(), () => {
    const data = load()
    const key = String(pid)
    const existing = data[key]
    if (!existing || existing.pid !== pid || existing.started_at !== expectedStartedAt) return
    delete data[key]
    save(data)
  }, lockOptions)
}

/** Mark an entry stale (informational only — see RunStateEntry.stale's own doc). Guarded the same way removeEntryIfMatches is. */
export function markEntryStaleIfMatches(pid: number, expectedStartedAt: string, reason: string, lockOptions: LockOptions = {}): void {
  withFileLock(runStateLockPath(), () => {
    const data = load()
    const key = String(pid)
    const existing = data[key]
    if (!existing || existing.pid !== pid || existing.started_at !== expectedStartedAt) return
    data[key] = { ...existing, stale: true, stale_reason: reason, stale_detected_at: new Date().toISOString() }
    save(data)
  }, lockOptions)
}

// ── Process identity primitives ──
// Injectable via the optional `deps` param on every function below so
// run-kill.test.ts / run.test.ts can exercise PID-reuse, ps-unavailable,
// and cross-platform branches deterministically, without touching a real
// OS process — see run-kill.ts's own header for the fuller rationale.

export interface ProcessIdentityDeps {
  readFile: typeof readFileSync
  exec: typeof execFileSync
  platform: NodeJS.Platform
}

const realDeps: ProcessIdentityDeps = {
  readFile: readFileSync,
  exec: execFileSync,
  platform: process.platform,
}

function getIdentityLinux(pid: number, deps: ProcessIdentityDeps): { startTime: string; command: string } | null {
  try {
    const stat = deps.readFile(`/proc/${pid}/stat`, 'utf-8') as unknown as string
    // `comm` (field 2) is parenthesized and may itself contain spaces/
    // parens, so locate the LAST ')' and parse only what follows it —
    // fields[0] there is `state` (field 3 overall); `starttime` is field
    // 22 overall, i.e. index 22-3=19 in this post-comm array.
    const closeParen = stat.lastIndexOf(')')
    if (closeParen === -1) return null
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/)
    const startTimeTicks = fields[19]
    if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) return null
    let cmdline = ''
    try {
      cmdline = (deps.readFile(`/proc/${pid}/cmdline`, 'utf-8') as unknown as string).split('\0').filter(Boolean).join(' ')
    } catch { /* /proc/<pid>/cmdline can be empty/unreadable for a zombie — command discriminator degrades to '', startTime alone still gates */ }
    return { startTime: `linux-stat:${startTimeTicks}`, command: cmdline }
  } catch {
    return null
  }
}

function getIdentityPosixPs(pid: number, deps: ProcessIdentityDeps): { startTime: string; command: string } | null {
  try {
    const env = { ...process.env, LC_ALL: 'C' }
    const lstart = (deps.exec('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', env }) as unknown as string).trim()
    if (!lstart) return null
    let command = ''
    try {
      command = (deps.exec('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', env }) as unknown as string).trim()
    } catch { /* command discriminator degrades to '' — startTime (+ bootId) still gates */ }
    return { startTime: `posix-lstart:${lstart}`, command }
  } catch {
    return null
  }
}

function getBootId(deps: ProcessIdentityDeps): string {
  try {
    if (deps.platform === 'linux') {
      return `linux-boot:${(deps.readFile('/proc/sys/kernel/random/boot_id', 'utf-8') as unknown as string).trim()}`
    }
    if (deps.platform === 'darwin') {
      const out = (deps.exec('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf-8' }) as unknown as string).trim()
      return out ? `darwin-boot:${out}` : ''
    }
  } catch { /* unavailable — bootId stays '', a supplementary signal only, never load-bearing alone */ }
  return ''
}

/**
 * Read a process's identity (startTime + command + bootId), or `null` if
 * it could not be determined at all (process gone, `/proc`/`ps` both
 * unavailable, ...). `null` here is the fail-CLOSED-to-inaction signal
 * `run-kill.ts` treats as "cannot verify — refuse", not as "assume gone".
 */
export function getProcessIdentity(pid: number, deps: ProcessIdentityDeps = realDeps): ProcessIdentity | null {
  const viaProc = deps.platform === 'linux' ? getIdentityLinux(pid, deps) : null
  const core = viaProc ?? getIdentityPosixPs(pid, deps)
  if (!core) return null
  return { ...core, bootId: getBootId(deps) }
}

/**
 * Exact string comparison on every field EXCEPT `bootId`, which only
 * narrows when BOTH sides have it (an empty bootId on either side is
 * "unavailable", not "mismatch" — it must never turn a real match into a
 * false refusal just because `sysctl`/`/proc` was unreadable this once).
 */
export function identitiesMatch(a: ProcessIdentity, b: ProcessIdentity): boolean {
  if (a.startTime !== b.startTime) return false
  if (a.command !== b.command) return false
  if (a.bootId && b.bootId && a.bootId !== b.bootId) return false
  return true
}

/** `process.kill(pid, 0)` liveness probe, distinguishing ESRCH (gone) from EPERM (alive, not ours — never treat as "gone", see run-kill.ts). */
export type AliveCheck = 'alive' | 'gone' | 'not-ours'

export function checkAlive(pid: number, killFn: (pid: number, signal: number | string) => void = process.kill.bind(process)): AliveCheck {
  try {
    killFn(pid, 0)
    return 'alive'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EPERM') return 'not-ours'
    return 'gone' // ESRCH, or anything else — the conservative default for a liveness probe is "nothing there to kill"
  }
}

/**
 * Keel's own process group id. Node has no `process.getpgid` — confirmed
 * directly (`typeof process.getpgid === 'undefined'`) — so this shells out
 * to `ps` exactly like the pid-under-test identity lookups above. `null`
 * on ANY failure; callers MUST treat `null` as "cannot verify — refuse",
 * never as "must be different from the target" (see run-kill.ts).
 */
export function getOwnPgid(deps: ProcessIdentityDeps = realDeps): number | null {
  try {
    const out = (deps.exec('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf-8', env: { ...process.env, LC_ALL: 'C' } }) as unknown as string).trim()
    const n = parseInt(out, 10)
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}
