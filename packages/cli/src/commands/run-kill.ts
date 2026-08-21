import { execFileSync } from 'node:child_process'
import {
  readAllRunState,
  removeEntryIfMatches,
  markEntryStaleIfMatches,
  checkAlive,
  getProcessIdentity,
  getOwnPgid,
  identitiesMatch,
  type RunStateEntry,
  type AliveCheck,
  type ProcessIdentity,
} from './run-state.js'

/**
 * The safety-checked kill algorithm behind `keel halt --kill` — see
 * halt.ts for how this is wired into the command and run-state.ts for the
 * store this reads/mutates.
 *
 * FAIL-SAFE DIRECTION IS THE OPPOSITE OF THIS CODEBASE'S USUAL RULE. Every
 * other fail-safe in this codebase (halt.ts's `isHalted()`, disable.ts's
 * `isDisabled()`, budget-tracker.ts's unavailable-spend handling, ...)
 * fails toward the SAFER side of a binary the pipeline is already
 * enforcing — for `isHalted()` that means "stay denying" on ambiguity. A
 * kill signal has no such symmetric-safe default: the two outcomes are
 * "an operator's runaway agent keeps running a few seconds longer" versus
 * "keel sent a fatal signal to the wrong process group". Those are not
 * comparably bad. So EVERY check in `killOne` below that hits an ambiguous
 * or unverifiable state (own-pgid lookup failed, identity can't be read,
 * an entry is still `unverified`, a pid is alive but not one we can safely
 * characterize) returns a REFUSAL, never a "proceed anyway". A human who
 * needs the kill to happen NOW still has the OS's own `kill`/`pkill`
 * available outside keel — this module's job is to never be the thing
 * that fires on the wrong target, not to guarantee the kill always lands.
 */

export const DEFAULT_KILL_GRACE_MS = 5000
const KILL_POLL_INTERVAL_MS = 250

export type KillOutcome =
  | { kind: 'not-tracked' }
  | { kind: 'unverified' }
  | { kind: 'refused-pgid-0-or-1' }
  | { kind: 'refused-own-pgid' }
  | { kind: 'refused-own-pgid-unknown' }
  | { kind: 'already-dead' }
  | { kind: 'not-ours' }
  | { kind: 'start-time-mismatch' }
  | { kind: 'killed'; via: 'SIGTERM' | 'SIGKILL' }
  | { kind: 'kill-unconfirmed' }

export interface KillResult {
  pid: number
  /** Absent only for `outcome.kind === 'not-tracked'` — there is no recorded entry to show. */
  entry?: RunStateEntry
  outcome: KillOutcome
}

export interface KillOptions {
  /** Target one specific tracked pid. */
  pid?: number
  /** Target every tracked entry. */
  all?: boolean
  graceMs?: number
}

export interface KillDeps {
  checkAlive: (pid: number) => AliveCheck
  getIdentity: (pid: number) => ProcessIdentity | null
  getOwnPgid: () => number | null
  /** Raw `process.kill(target, signal)` — callers pass a NEGATIVE target for a process-GROUP signal, matching real POSIX `kill(2)` semantics; a positive target signals one pid (used for the descendant sweep). Must THROW on failure (ESRCH etc.) exactly like the real `process.kill` — callers catch per call site. */
  sendSignal: (target: number, signal: NodeJS.Signals) => void
  sleep: (ms: number) => Promise<void>
  /** Every live descendant pid of `rootPid`, transitively, via a ppid walk — belt-and-suspenders for a child that escaped the process group via `setsid()`/double-fork. Best-effort; `[]` on any failure. */
  listDescendants: (rootPid: number) => number[]
}

function realListDescendants(rootPid: number): number[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf-8' })
    const rows: Array<{ pid: number; ppid: number }> = []
    for (const line of out.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [pidStr, ppidStr] = trimmed.split(/\s+/)
      const pid = parseInt(pidStr, 10)
      const ppid = parseInt(ppidStr, 10)
      if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push({ pid, ppid })
    }
    const childrenOf = new Map<number, number[]>()
    for (const r of rows) {
      const list = childrenOf.get(r.ppid) ?? []
      list.push(r.pid)
      childrenOf.set(r.ppid, list)
    }
    const result: number[] = []
    const seen = new Set<number>([rootPid])
    const queue = [rootPid]
    while (queue.length) {
      const p = queue.shift() as number
      for (const c of childrenOf.get(p) ?? []) {
        if (seen.has(c)) continue
        seen.add(c)
        result.push(c)
        queue.push(c)
      }
    }
    return result
  } catch {
    return []
  }
}

export const realKillDeps: KillDeps = {
  checkAlive: (pid) => checkAlive(pid),
  getIdentity: (pid) => getProcessIdentity(pid),
  getOwnPgid: () => getOwnPgid(),
  sendSignal: (target, signal) => { process.kill(target, signal) },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  listDescendants: (rootPid) => realListDescendants(rootPid),
}

/**
 * Kill one tracked entry, running EVERY required safety check before the
 * first signal — see this module's header for why ambiguity always
 * resolves to refusal here, never to "proceed".
 *
 * Check order is deliberate: the two STATIC guards (pgid 0/1, own-pgid)
 * run first and need no OS query beyond `getOwnPgid()` — they gate "never
 * touch this target" unconditionally, before spending any effort on
 * whether the recorded process is even still alive. Liveness and identity
 * are re-derived FRESH every call — an entry's `stale` flag (if a PRIOR
 * kill attempt set one) is never consulted as a shortcut here, precisely
 * so a cached verdict can never substitute for a real check on THIS call.
 */
async function killOne(entry: RunStateEntry, graceMs: number, deps: KillDeps): Promise<KillOutcome> {
  if (entry.unverified) return { kind: 'unverified' }

  if (entry.pgid === 0 || entry.pgid === 1) {
    markEntryStaleIfMatches(entry.pid, entry.started_at, 'refused: recorded pgid is 0 or 1 — never a legitimate supervised group; entry is likely corrupt or tampered')
    return { kind: 'refused-pgid-0-or-1' }
  }

  const ownPgid = deps.getOwnPgid()
  if (ownPgid === null) return { kind: 'refused-own-pgid-unknown' }
  if (ownPgid === entry.pgid) return { kind: 'refused-own-pgid' }

  const alive = deps.checkAlive(entry.pid)
  if (alive === 'gone') {
    removeEntryIfMatches(entry.pid, entry.started_at)
    return { kind: 'already-dead' }
  }
  if (alive === 'not-ours') {
    // EPERM: something is alive at this pid but is not a process we can
    // signal. Could be legitimate identity match under an unusual
    // permission setup, more likely pid reuse by another user's process.
    // Never signal, never touch the file either way — this is exactly the
    // "cannot fully characterize" case the module header calls out.
    return { kind: 'not-ours' }
  }

  const current = deps.getIdentity(entry.pid)
  if (!current || !identitiesMatch(current, entry.identity)) {
    markEntryStaleIfMatches(entry.pid, entry.started_at, 'refused: start-time/identity no longer matches the recorded process — the pid was likely reused by a different process')
    return { kind: 'start-time-mismatch' }
  }

  // ── Escalation: SIGTERM to the group, poll the grace window, SIGKILL
  // only if still alive. Descendant sweep runs alongside the group signal
  // at both stages as belt-and-suspenders for a child that escaped the
  // group via setsid()/double-fork — see this module's own KillDeps doc
  // and the class-level v1-limitation note below. ──
  try {
    deps.sendSignal(-entry.pgid, 'SIGTERM')
  } catch {
    // Vanished between the liveness check above and this signal.
    removeEntryIfMatches(entry.pid, entry.started_at)
    return { kind: 'already-dead' }
  }
  for (const d of deps.listDescendants(entry.pid)) {
    try { deps.sendSignal(d, 'SIGTERM') } catch { /* already gone, or reaped by the group signal above */ }
  }

  const deadline = Date.now() + graceMs
  let stillAlive = deps.checkAlive(entry.pid) === 'alive'
  while (stillAlive && Date.now() < deadline) {
    await deps.sleep(Math.min(KILL_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
    stillAlive = deps.checkAlive(entry.pid) === 'alive'
  }

  if (!stillAlive) {
    removeEntryIfMatches(entry.pid, entry.started_at)
    return { kind: 'killed', via: 'SIGTERM' }
  }

  try {
    deps.sendSignal(-entry.pgid, 'SIGKILL')
  } catch {
    removeEntryIfMatches(entry.pid, entry.started_at)
    return { kind: 'killed', via: 'SIGTERM' }
  }
  // Re-enumerate rather than reusing the earlier list — new grandchildren
  // can appear during the grace window (documented v1 limitation: a
  // process that keeps re-forking faster than this sweep, or that
  // deliberately re-parents to pid 1 via a second setsid(), can still
  // fully escape both signals; closing that needs OS-level cgroups
  // (Linux-only) and is out of scope for this release).
  for (const d of deps.listDescendants(entry.pid)) {
    try { deps.sendSignal(d, 'SIGKILL') } catch { /* already gone */ }
  }

  // Confirm before declaring victory or clearing the entry — an
  // unconfirmed SIGKILL (zombie / uninterruptible sleep) must not be
  // reported as "killed", and must not lose the operator's ability to
  // retry by having its tracking entry deleted out from under them.
  const finalCheck = deps.checkAlive(entry.pid)
  if (finalCheck !== 'alive') {
    removeEntryIfMatches(entry.pid, entry.started_at)
    return { kind: 'killed', via: 'SIGKILL' }
  }
  return { kind: 'kill-unconfirmed' }
}

export interface KillRunResult {
  results: KillResult[]
  /** Set instead of `results` when more than one entry is tracked and the caller gave neither `pid` nor `all` — the caller (halt.ts) must list these and ask the operator to disambiguate rather than guessing "most recent". */
  ambiguous?: RunStateEntry[]
}

/**
 * Entry point from `keel halt --kill`. Never throws — every failure mode
 * is expressed as a `KillOutcome`/`ambiguous` value the caller renders.
 */
export async function killSupervisedRuns(options: KillOptions, deps: KillDeps = realKillDeps): Promise<KillRunResult> {
  const all = readAllRunState()
  const entries = Object.values(all)

  if (entries.length === 0) return { results: [] }

  let targets: RunStateEntry[]
  if (options.pid !== undefined) {
    const match = all[String(options.pid)]
    if (!match) return { results: [{ pid: options.pid, outcome: { kind: 'not-tracked' } }] }
    targets = [match]
  } else if (options.all) {
    targets = entries
  } else if (entries.length === 1) {
    targets = entries
  } else {
    return { results: [], ambiguous: entries }
  }

  const graceMs = options.graceMs ?? DEFAULT_KILL_GRACE_MS
  const results: KillResult[] = []
  for (const entry of targets) {
    results.push({ pid: entry.pid, entry, outcome: await killOne(entry, graceMs, deps) })
  }
  return { results }
}
