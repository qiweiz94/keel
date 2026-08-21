import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, type LockOptions } from './file-lock.js'
import { stateDir } from './state-manager.js'

/**
 * One session's composite trip state, keyed by `session:{ruleId}:{sessionId}`
 * — ALL FIVE dimensions of a `type: session` composite runaway-loop trip
 * live in this ONE record, mutated under ONE file lock per write. This is
 * deliberate, not an accident of convenience: five separately-locked
 * counters (mirroring, say, five `PersistentStuckStore` buckets) could race
 * across two concurrent `keel hook` processes such that a reader observes
 * dimension A already bumped for call N while dimension B still reflects
 * call N-1 — a torn composite read. A single record under a single lock
 * makes that structurally impossible: every read sees a state that some
 * single write actually produced.
 *
 * KEYED BY `{ruleId}:{sessionId}`, deliberately WITHOUT `cwd` (unlike
 * `stuck-store.ts`'s `stuck:{ruleId}:{cwd}:{fingerprint}` key): a stuck-loop
 * bucket is scoped to "this exact failing command in this exact directory"
 * on purpose, but a session's wall-clock duration and cumulative call counts
 * are properties of the SESSION, not the directory — an agent that `cd`s
 * partway through a long session must not have its tool-call count silently
 * reset to zero just because the cwd changed. Scoped per ruleId so two
 * different `type: session` rules (a conservative one and a looser one, say)
 * never share and double-bump the same underlying counters.
 */
export interface PersistedSessionState {
  /** First-seen timestamp for this session bucket (ms epoch) — duration_minutes is computed live as (now - sessionStart) / 60000, never persisted pre-computed, so a rule's thresholds apply retroactively to already-running sessions the moment they're edited. */
  sessionStart: number
  lastActivityAt: number
  toolCalls: number
  bashCalls: number
  /**
   * Bounded list of distinct file-write target paths seen this session —
   * capped at MAX_TRACKED_FILES_PER_SESSION so one very chatty session
   * cannot grow this record without limit. `fileWriteChurn` (below) is the
   * actual dimension value checked against a rule's threshold; it keeps
   * incrementing even once this list is capped (a brand-new path that can
   * no longer be stored still counts as churn) — see bumpActivity()'s own
   * comment for why that direction of imprecision is safe here.
   */
  filesWritten: string[]
  fileWriteChurn: number
  /** Consecutive FAILING (nonzero exit) attempts recorded via bumpFailure — the one dimension allowed to escalate to `halt` (see session-tracker.ts). Resets to 0 on any exit-0 outcome; a null/unreported exit code neither increments nor resets it (see bumpFailure's own comment — this is safety-load-bearing, not stylistic). */
  consecutiveFailures: number
  lastExit: number | null
}

interface SessionStateFile {
  [key: string]: PersistedSessionState
}

/**
 * Ceiling on how long a session bucket may be kept alive on disk before
 * this store's own pruning drops it, independent of anything a rule
 * declares. Same role as `stuck-store.ts`'s `STUCK_STATE_MAX_WINDOW_MS` —
 * bounds this file's growth against an abandoned/orphaned session that
 * never gets a final call. 24h matches `StateManager`'s own TTL_MS
 * convention (generous headroom for a genuinely long-running session,
 * still bounded).
 */
export const SESSION_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Per-session cap on tracked distinct file-write paths — see `filesWritten`'s own doc comment. Comfortably above any sane `file_write_churn` threshold (tens), so capping never masks a real trip. */
const MAX_TRACKED_FILES_PER_SESSION = 200

// Distinct sessions is bounded the same way stuck-store.ts bounds distinct
// cwd x rule x fingerprint buckets: many short-lived sessions across many
// projects on one machine, not one chatty session — cap the total bucket
// count and evict the least-recently-active first.
const MAX_ENTRIES = 500

/**
 * PersistentSessionStore — the disk-backed, cross-process-aware store
 * behind `SessionTracker` (session-tracker.ts), closing the SAME
 * fresh-process-per-call gap `PersistentStuckStore`/`PersistentFlowStore`
 * close for their own trackers: `keel hook <host>` spawns a new process per
 * tool call, so an in-memory-only composite trip could never see "this
 * session already made 400 tool calls" on the 401st call — the entire
 * point of a SESSION-scoped composite trip.
 *
 * READ/WRITE SHAPE mirrors `PersistentStuckStore`: `bumpActivity()` and
 * `bumpFailure()` each perform their own load -> prune -> mutate -> persist
 * cycle ENTIRELY inside the file lock and return the resulting state — a
 * separate load-then-mutate-then-set here would race two concurrent hook
 * processes into losing one of their increments the same way an unlocked
 * read-modify-write always does. `get()` stays read-only and lock-free — a
 * `check()` call that isn't recording anything must never take a lock or
 * write to disk just to look.
 *
 * FAIL-SAFE: fails to "record nothing new" on any read/write error, never
 * throws. This store's fail-safe direction only ever UNDER-counts (a lost
 * write means a later call sees fewer prior calls/failures than actually
 * happened, never more) — it can make the composite ladder escalate LATER
 * than it should, never earlier or falsely. That matters more here than for
 * `PersistentStuckStore`: this store backs a ladder whose terminal step can
 * trip `keel halt` (see session-tracker.ts / pipeline.ts's session-trip
 * branch) — a store that could ever OVER-count would risk a false halt from
 * a storage glitch alone, which this direction structurally cannot do.
 */
export class PersistentSessionStore {
  private readonly dir: string
  private readonly lockOptions: LockOptions

  constructor(dir: string = stateDir(), lockOptions: LockOptions = {}) {
    this.dir = dir
    this.lockOptions = lockOptions
  }

  private filePath(): string {
    return join(this.dir, 'session-tracker.json')
  }

  private lockPath(): string {
    return `${this.filePath()}.lock`
  }

  private load(): SessionStateFile {
    try {
      const p = this.filePath()
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as SessionStateFile
      }
    } catch { /* corrupt or unreadable — start fresh, never throw */ }
    return {}
  }

  private save(data: SessionStateFile): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const p = this.filePath()
      const tmp = `${p}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, p)
    } catch { /* best-effort persistence — same posture as StateManager.saveFile */ }
  }

  private ensureDir(): void {
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* save() also tries; best effort */ }
  }

  /** Drop entries older than SESSION_STATE_MAX_AGE_MS, then, if still over MAX_ENTRIES, evict the least-recently-active. */
  private prune(data: SessionStateFile, now: number): SessionStateFile {
    const pruned: SessionStateFile = {}
    for (const [key, state] of Object.entries(data)) {
      if (!state || typeof state.sessionStart !== 'number' || typeof state.lastActivityAt !== 'number') continue
      if (now - state.lastActivityAt < SESSION_STATE_MAX_AGE_MS) pruned[key] = state
    }
    const keys = Object.keys(pruned)
    if (keys.length > MAX_ENTRIES) {
      const byRecency = keys
        .map(k => ({ k, last: pruned[k].lastActivityAt }))
        .sort((a, b) => a.last - b.last)
      for (const { k } of byRecency.slice(0, keys.length - MAX_ENTRIES)) delete pruned[k]
    }
    return pruned
  }

  /**
   * Non-expired persisted state for `key`, or `null` — read-only, no lock,
   * no directory creation, never throws. Called on every evaluated call for
   * a `type: session` rule, not only ones being recorded, so this must stay
   * lock-free (mirrors PersistentStuckStore.get / PersistentFlowStore.getTags).
   */
  get(key: string): PersistedSessionState | null {
    if (!key) return null
    const state = this.load()[key]
    if (!state || typeof state.sessionStart !== 'number') return null
    if (Date.now() - state.lastActivityAt >= SESSION_STATE_MAX_AGE_MS) return null
    return state
  }

  /**
   * Record one more tool call against `key` — bumps `toolCalls`, `bashCalls`
   * (when `opts.isBash`), and file-write churn (when `opts.writePath` is
   * given and not already tracked this session) — and return the resulting
   * state. A fresh or expired bucket starts `sessionStart`/`lastActivityAt`
   * at `now`.
   *
   * `fileWriteChurn` keeps incrementing on a genuinely new path even once
   * `filesWritten` hits MAX_TRACKED_FILES_PER_SESSION and can no longer
   * dedupe it — the alternative (silently stop counting churn past the cap)
   * would understate the one dimension this exists to measure, right when a
   * session is already chatty enough to have hit the cap. The cap is 200;
   * every shipped `file_write_churn` threshold is well under that, so this
   * can only ever slightly OVER-count once a session is already far past
   * any sane threshold — and `file_write_churn` is a volume-only dimension,
   * barred by construction (rule-parser.ts's validateRules) from ever
   * escalating past `prompt`, so a slight over-count here cannot reach
   * `keel halt`.
   */
  bumpActivity(key: string, opts: { isBash: boolean; writePath?: string }): PersistedSessionState {
    const now = Date.now()
    if (!key) {
      return {
        sessionStart: now, lastActivityAt: now, toolCalls: 1, bashCalls: opts.isBash ? 1 : 0,
        filesWritten: opts.writePath ? [opts.writePath] : [], fileWriteChurn: opts.writePath ? 1 : 0,
        consecutiveFailures: 0, lastExit: null,
      }
    }
    this.ensureDir()
    return withFileLock(this.lockPath(), () => {
      const data = this.prune(this.load(), now)
      const existing = data[key]
      const base: PersistedSessionState = existing || {
        sessionStart: now, lastActivityAt: now, toolCalls: 0, bashCalls: 0,
        filesWritten: [], fileWriteChurn: 0, consecutiveFailures: 0, lastExit: null,
      }
      const next: PersistedSessionState = {
        ...base,
        lastActivityAt: now,
        toolCalls: base.toolCalls + 1,
        bashCalls: base.bashCalls + (opts.isBash ? 1 : 0),
      }
      if (opts.writePath && !base.filesWritten.includes(opts.writePath)) {
        next.fileWriteChurn = base.fileWriteChurn + 1
        next.filesWritten = base.filesWritten.length < MAX_TRACKED_FILES_PER_SESSION
          ? [...base.filesWritten, opts.writePath]
          : base.filesWritten
      }
      data[key] = next
      this.save(data)
      return next
    }, this.lockOptions)
  }

  /**
   * Record one more attempt OUTCOME against `key` for the consecutive-
   * failures dimension — the ONLY dimension allowed to escalate to `halt`
   * (see session-tracker.ts / pipeline.ts's session-trip branch).
   *
   * Mirrors `PersistentStuckStore.bump`'s reset/increment/no-op shape
   * exactly, and for the identical safety reason: `exitCode === 0` resets
   * the streak to 0 (progress un-sticks it); a nonzero exit increments it;
   * `exitCode === null` (no exit code reported at all) neither increments
   * NOR resets — it is a no-op that returns the state UNCHANGED. That last
   * case is safety-load-bearing, not a stylistic default: if a host that
   * never reports exit codes counted a null as a failure, a perfectly
   * healthy session on that host would march toward `keel halt` on
   * apparent "failures" that were never actually failures — exactly the
   * false-positive class this whole feature exists to avoid (see this
   * store's own header). A host that never calls the after-hook at all
   * (never invokes bumpFailure) can therefore never reach the halt step
   * through this dimension — consecutiveFailures simply stays at whatever
   * it last was, forever 0 if it never ran.
   */
  bumpFailure(key: string, exitCode: number | null): PersistedSessionState | null {
    if (!key) return null
    this.ensureDir()
    return withFileLock(this.lockPath(), () => {
      const now = Date.now()
      const data = this.prune(this.load(), now)
      const existing = data[key]
      const base: PersistedSessionState = existing || {
        sessionStart: now, lastActivityAt: now, toolCalls: 0, bashCalls: 0,
        filesWritten: [], fileWriteChurn: 0, consecutiveFailures: 0, lastExit: null,
      }
      if (exitCode === null) {
        // No-op — see this method's own header. Still persist a touched
        // lastActivityAt only if we already have a record; do not fabricate
        // one purely from a null-exit-code after-hook call with no prior
        // activity (there is nothing meaningful to record).
        if (!existing) return base
        data[key] = { ...base, lastActivityAt: now }
        this.save(data)
        return data[key]
      }
      const next: PersistedSessionState = {
        ...base,
        lastActivityAt: now,
        consecutiveFailures: exitCode === 0 ? 0 : base.consecutiveFailures + 1,
        lastExit: exitCode,
      }
      data[key] = next
      this.save(data)
      return next
    }, this.lockOptions)
  }

  /** Clear one session's bucket — used by tests and by an explicit session-end signal, if one is ever added. */
  delete(key: string): void {
    if (!key) return
    this.ensureDir()
    withFileLock(this.lockPath(), () => {
      const data = this.load()
      if (key in data) {
        delete data[key]
        this.save(data)
      }
    }, this.lockOptions)
  }

  /** Clear every bucket. */
  clearAll(): void {
    this.ensureDir()
    withFileLock(this.lockPath(), () => {
      this.save({})
    }, this.lockOptions)
  }
}
