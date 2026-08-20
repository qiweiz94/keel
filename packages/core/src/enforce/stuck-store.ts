import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, type LockOptions } from './file-lock.js'
import { stateDir } from './state-manager.js'

/** One stuck-loop bucket's persisted state, keyed by `stuck:{ruleId}:{cwd}:{fingerprint}`. */
export interface PersistedStuckState {
  count: number
  windowStart: number
  lastAttemptAt: number
  lastExit: number | null
  /** The rule's `window_seconds * 1000` at the time this bucket was last written, capped at STUCK_STATE_MAX_WINDOW_MS. Used ONLY to prune this store's own file — StuckTracker.check() always re-derives the live escalation decision from the CALLING rule's current window_seconds, not from this stored value. */
  windowMs: number
}

interface StuckStateFile {
  [key: string]: PersistedStuckState
}

/**
 * Ceiling on how long a single bucket may be kept alive on disk, regardless
 * of what a rule's own `window_seconds` claims. Same role as flow-store.ts's
 * `FLOW_TAG_TTL_MS`: bounds this file's growth against a typo'd or
 * pathological `window_seconds` pinning a bucket (and the disk write it
 * costs on every attempt) alive far longer than any real stuck-loop
 * detection window needs. The shipped `no-repeat-loops` rule uses 900s (15
 * minutes — install.ts); 24h matches StateManager's own TTL_MS convention
 * (state-manager.ts) for "generous headroom, still bounded," not a value
 * tuned to this rule specifically.
 */
export const STUCK_STATE_MAX_WINDOW_MS = 24 * 60 * 60 * 1000

// Distinct cwds × rule ids × fingerprints is NOT bounded the way flow-store's
// per-session tag count is (many short sessions vs one chatty session) —
// here the failure mode is many distinct PROJECT DIRECTORIES ever hooked
// through this machine. Cap the total bucket count and evict the
// least-recently-active first, same shape as flow-store's MAX_SESSIONS.
const MAX_ENTRIES = 500

/**
 * PersistentStuckStore — the disk-backed, cross-process-aware companion to
 * StuckTracker's in-memory `counts` Map, closing the SAME gap flow-store.ts
 * (`PersistentFlowStore`) closed for `FlowTracker`: `keel hook <host>`
 * (Claude Code, Cursor, Codex, Gemini CLI, cline, generic) spawns a FRESH
 * process per tool call, so an in-memory-only StuckTracker resets to empty
 * on every call and can never see "this exact command already failed twice
 * in the last 15 minutes" — the entire point of the stuck-loop detector.
 *
 * UNLIKE flow-store.ts, this is keyed by `stuck:{ruleId}:{cwd}:{fingerprint}`
 * — the SAME key StuckTracker's in-memory map already used, with no
 * session_id added. That is deliberate, not an oversight: `no-repeat-loops`
 * is the only rule of `type: stuck` shipped today and its escalation ladder
 * needs the TOTAL count across whatever called it, not a per-session slice
 * — and adding session-scoping now would change behavior nothing asked to
 * change. The consequence worth stating plainly: persisted escalation state
 * now crosses SESSIONS within one cwd (two different Claude Code
 * conversations in the same repo directory can share and advance the same
 * bucket), a slightly wider surface than the pure in-memory version this
 * replaces on `keel daemon` (which stays in-memory — see enforce.ts). The
 * per-entry window (15 minutes by default) bounds how long that surface
 * stays open.
 *
 * READ/WRITE SHAPE — deliberately NOT the "read via get(), write via set()"
 * shape flow-store.ts uses: `bump()` performs the load -> prune -> increment
 * -> persist cycle ENTIRELY inside the file lock and returns the resulting
 * state. A separate load-then-increment-then-set (mirroring the caller's own
 * in-memory `existing.count += 1`) would race: two concurrent hook processes
 * could both read count=2 and both persist count=3, losing an attempt the
 * same way an unlocked read-modify-write always does. `get()` stays
 * read-only and lock-free (mirrors `PersistentFlowStore.getTags`) — a
 * `check()` call that isn't recording anything must never take a lock or
 * write to disk just to look.
 *
 * BOUNDED: each entry expires against ITS OWN stored `windowMs` (capped at
 * `STUCK_STATE_MAX_WINDOW_MS`) rather than one flat TTL — more precise than
 * flow-store's single `FLOW_TAG_TTL_MS`, since stuck-loop windows are
 * per-rule (`window_seconds`) already. `MAX_ENTRIES` caps the total bucket
 * count so many distinct cwds can't grow this file without limit even
 * inside the window.
 *
 * FAIL-SAFE: fails to "not stuck" on any read/write error, never throws —
 * `get()` returns `null`, `bump()` still returns a fresh count-1 state (the
 * same "start a new bucket" behavior a lock-timeout already produces via
 * file-lock.ts's own fail-safe: `withFileLock` runs the callback unlocked
 * rather than skipping or hanging). Unlike flow-store.ts's warn/observe-tier
 * rule, `no-repeat-loops` DOES escalate to `action: deny` at its 5-attempt
 * step — but that deny sits behind an unlevelled `priority: -10` workflow
 * rule, not a `level: protect` floor, and this store's fail-safe direction
 * only ever UNDER-counts (a lost write means a later call sees fewer prior
 * attempts than actually happened, never more) — it can make the ladder
 * escalate later than it should, never earlier or falsely. That is the
 * opposite failure direction from a floor that must never fail open, so
 * reusing this posture here does not reintroduce the hazard flow-store.ts's
 * own comment warns against.
 */
export class PersistentStuckStore {
  private readonly dir: string
  private readonly lockOptions: LockOptions

  constructor(dir: string = stateDir(), lockOptions: LockOptions = {}) {
    this.dir = dir
    this.lockOptions = lockOptions
  }

  private filePath(): string {
    return join(this.dir, 'stuck-tracker.json')
  }

  private lockPath(): string {
    return `${this.filePath()}.lock`
  }

  private load(): StuckStateFile {
    try {
      const p = this.filePath()
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as StuckStateFile
      }
    } catch { /* corrupt or unreadable — start fresh, never throw */ }
    return {}
  }

  private save(data: StuckStateFile): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const p = this.filePath()
      const tmp = `${p}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, p)
    } catch { /* best-effort persistence — same posture as StateManager.saveFile */ }
  }

  /** Effective (capped) window for a stored/incoming windowMs value. */
  private cap(windowMs: number): number {
    return Math.min(windowMs > 0 ? windowMs : STUCK_STATE_MAX_WINDOW_MS, STUCK_STATE_MAX_WINDOW_MS)
  }

  /** Drop entries expired against their OWN stored windowMs, then, if still over MAX_ENTRIES, evict the least-recently-active. */
  private prune(data: StuckStateFile, now: number): StuckStateFile {
    const pruned: StuckStateFile = {}
    for (const [key, state] of Object.entries(data)) {
      if (!state || typeof state.windowStart !== 'number' || typeof state.count !== 'number') continue
      if (now - state.windowStart < this.cap(state.windowMs)) pruned[key] = state
    }
    const keys = Object.keys(pruned)
    if (keys.length > MAX_ENTRIES) {
      const byRecency = keys
        .map(k => ({ k, last: pruned[k].lastAttemptAt }))
        .sort((a, b) => a.last - b.last)
      for (const { k } of byRecency.slice(0, keys.length - MAX_ENTRIES)) delete pruned[k]
    }
    return pruned
  }

  /**
   * Non-expired persisted state for `key`, or `null` — read-only, no lock,
   * no directory creation, never throws. See this class's header for why
   * this must stay lock-free: `StuckTracker.check()` calls this on every
   * evaluated command, not only ones being recorded.
   */
  get(key: string): PersistedStuckState | null {
    if (!key) return null
    const state = this.load()[key]
    if (!state || typeof state.windowStart !== 'number') return null
    if (Date.now() - state.windowStart >= this.cap(state.windowMs)) return null
    return state
  }

  /**
   * Record one more (failing) attempt for `key` and return the resulting
   * state — load -> prune -> apply the SAME window/increment logic
   * StuckTracker's in-memory branch uses -> persist, all under the file
   * lock, so two concurrent hook processes can't both increment off the
   * same stale read (see this class's header). `windowMs` is the CALLING
   * rule's current `window_seconds * 1000`; a fresh or expired bucket
   * starts at count 1.
   */
  bump(key: string, windowMs: number, exitCode: number | null): PersistedStuckState {
    const boundedWindowMs = this.cap(windowMs)
    if (!key) {
      const now = Date.now()
      return { count: 1, windowStart: now, lastAttemptAt: now, lastExit: exitCode, windowMs: boundedWindowMs }
    }
    this.ensureDir()
    return withFileLock(this.lockPath(), () => {
      const now = Date.now()
      const data = this.prune(this.load(), now)
      const existing = data[key]
      const next: PersistedStuckState = (!existing || now - existing.windowStart >= boundedWindowMs)
        ? { count: 1, windowStart: now, lastAttemptAt: now, lastExit: exitCode, windowMs: boundedWindowMs }
        : { count: existing.count + 1, windowStart: existing.windowStart, lastAttemptAt: now, lastExit: exitCode, windowMs: boundedWindowMs }
      data[key] = next
      this.save(data)
      return next
    }, this.lockOptions)
  }

  private ensureDir(): void {
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* save() also tries; best effort */ }
  }

  /** Clear one bucket — the persisted counterpart of a success resetting the in-memory loop. */
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

  /** Clear every bucket whose key encodes cwd `cwd` — StuckTracker.clear(cwd)'s persisted counterpart. */
  deleteByCwd(cwd: string): void {
    if (!cwd) return
    this.ensureDir()
    withFileLock(this.lockPath(), () => {
      const data = this.load()
      let changed = false
      for (const key of Object.keys(data)) {
        if (key.includes(`:${cwd}:`)) { delete data[key]; changed = true }
      }
      if (changed) this.save(data)
    }, this.lockOptions)
  }

  /** Clear every bucket — StuckTracker.clear() with no argument. */
  clearAll(): void {
    this.ensureDir()
    withFileLock(this.lockPath(), () => {
      this.save({})
    }, this.lockOptions)
  }
}
