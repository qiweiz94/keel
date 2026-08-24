import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic, type LockOptions } from './file-lock.js'
import { stateDir } from './state-manager.js'

/** One recorded command fingerprint in an oscillation window, oldest-first order within the bucket's `entries` array. */
export interface OscillationEntry {
  fp: string
  at: number             // ms epoch
  exit: number | null
}

/**
 * One session's rolling-window bucket, keyed by `osc:{ruleId}:{sessionId}`
 * — see oscillation-tracker.ts's header for why this is keyed by session_id
 * (like session-store.ts) rather than by cwd+fingerprint (like
 * stuck-store.ts): oscillation is a property of ONE live conversation's
 * recent activity, not "this exact failing command in this exact
 * directory," so two different sessions in the same cwd must never share a
 * window.
 */
export interface PersistedOscillationState {
  entries: OscillationEntry[]
  /** The rule's `window_seconds * 1000` at the time this bucket was last written, capped at OSCILLATION_STATE_MAX_WINDOW_MS. Used ONLY to prune this store's own file (bucket-level garbage collection) — OscillationTracker.check() always re-derives which entries are still fresh from the CALLING rule's current window_seconds, the same "never trust the stored value alone" posture stuck-store.ts's own PersistedStuckState.windowMs documents. */
  windowMs: number
}

interface OscillationStateFile {
  [key: string]: PersistedOscillationState
}

/**
 * Ceiling on how long a session bucket may be kept alive on disk, regardless
 * of what a rule's own `window_seconds` claims. Same role as
 * stuck-store.ts's STUCK_STATE_MAX_WINDOW_MS / session-store.ts's
 * SESSION_STATE_MAX_AGE_MS.
 */
export const OSCILLATION_STATE_MAX_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Hard ceiling on entries kept in ONE session's bucket, regardless of what a
 * rule's own `oscillation_window_size` claims — bounds a single write's cost
 * (and this store file's growth) against a typo'd or pathological config.
 * Comfortably above any sane oscillation_window_size (the shipped default is
 * 8; the whole point of this detector is a SHORT rolling window).
 */
const MAX_BUFFER_LENGTH = 32

// Distinct sessions is bounded the same way stuck-store.ts bounds distinct
// cwd x rule x fingerprint buckets and session-store.ts bounds distinct
// sessions: many short-lived sessions across many projects on one machine,
// not one chatty session — cap the total bucket count and evict the
// least-recently-active first.
const MAX_ENTRIES = 500

/**
 * PersistentOscillationStore — the disk-backed, cross-process-aware
 * companion to OscillationTracker's in-memory rolling window, closing the
 * SAME fresh-process-per-call gap PersistentStuckStore/PersistentSessionStore
 * close for their own trackers: `keel hook <host>` spawns a new process per
 * tool call, so an in-memory-only rolling window could never see "the last
 * few calls before this process started" — the entire point of a LOCAL
 * cycle detector that only looks at the last 4-8 calls is defeated if every
 * call restarts the window from empty.
 *
 * READ/WRITE SHAPE — mirrors PersistentStuckStore's `bump()`, not
 * flow-store.ts's `get()`/`set()`: `append()` performs the load -> prune ->
 * push -> trim -> persist cycle ENTIRELY inside the file lock and returns
 * the resulting bucket. A separate load-then-push-then-set (mirroring a
 * caller's own in-memory array mutation) would race exactly the way
 * PersistentStuckStore's own header comment explains: two concurrent hook
 * processes could both read a 3-entry window and both persist a 4-entry
 * result from DIFFERENT calls, losing one entry the same way an unlocked
 * read-modify-write always does. `get()` stays read-only and lock-free
 * (mirrors PersistentStuckStore.get()) — OscillationTracker.check() calls
 * this on every evaluated command, not only ones being recorded.
 *
 * BOUNDED two ways, not one: `MAX_BUFFER_LENGTH` caps entries WITHIN one
 * bucket (defends a single write's cost and this file's per-bucket size
 * against a pathological oscillation_window_size), and `MAX_ENTRIES` caps
 * the total bucket COUNT (defends against many distinct sessions) the same
 * way stuck-store.ts/session-store.ts already do for their own axes.
 *
 * FAIL-SAFE: fails to "no window" on any read/write error, never throws —
 * `get()` returns `null`, `append()` still returns a fresh single-entry
 * bucket (the same "start over" behavior a lock-timeout already produces
 * via file-lock.ts's own fail-safe). This store's fail-safe direction only
 * ever UNDER-counts (a lost write means a later call sees a shorter window
 * than actually happened, never a longer or fabricated one) — the same safe
 * direction stuck-store.ts's own header comment documents for the same
 * reason: this detector is `mode: observe` today and even once promoted
 * would sit behind the same warn-once-then-escalate ladder every other
 * deny-capable rule uses, so under-counting can only delay a real
 * escalation, never fabricate one.
 */
export class PersistentOscillationStore {
  private readonly dir: string
  private readonly lockOptions: LockOptions

  constructor(dir: string = stateDir(), lockOptions: LockOptions = {}) {
    this.dir = dir
    this.lockOptions = lockOptions
  }

  private filePath(): string {
    return join(this.dir, 'oscillation-tracker.json')
  }

  private lockPath(): string {
    return `${this.filePath()}.lock`
  }

  private load(): OscillationStateFile {
    try {
      const p = this.filePath()
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as OscillationStateFile
      }
    } catch { /* corrupt or unreadable — start fresh, never throw */ }
    return {}
  }

  private save(data: OscillationStateFile): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const p = this.filePath()
      writeFileAtomic(p, JSON.stringify(data))
    } catch { /* best-effort persistence — same posture as StateManager.saveFile */ }
  }

  /** Effective (capped) window for a stored/incoming windowMs value. */
  private cap(windowMs: number): number {
    return Math.min(windowMs > 0 ? windowMs : OSCILLATION_STATE_MAX_WINDOW_MS, OSCILLATION_STATE_MAX_WINDOW_MS)
  }

  /** Drop buckets whose newest entry has aged past their OWN stored windowMs, then, if still over MAX_ENTRIES, evict the least-recently-active. */
  private prune(data: OscillationStateFile, now: number): OscillationStateFile {
    const pruned: OscillationStateFile = {}
    for (const [key, state] of Object.entries(data)) {
      if (!state || !Array.isArray(state.entries) || typeof state.windowMs !== 'number') continue
      const newest = state.entries.reduce((max, e) => Math.max(max, e.at), 0)
      if (state.entries.length > 0 && now - newest < this.cap(state.windowMs)) pruned[key] = state
    }
    const keys = Object.keys(pruned)
    if (keys.length > MAX_ENTRIES) {
      const byRecency = keys
        .map(k => ({ k, last: pruned[k].entries.reduce((max, e) => Math.max(max, e.at), 0) }))
        .sort((a, b) => a.last - b.last)
      for (const { k } of byRecency.slice(0, keys.length - MAX_ENTRIES)) delete pruned[k]
    }
    return pruned
  }

  /**
   * Non-expired persisted bucket for `key`, or `null` — read-only, no lock,
   * no directory creation, never throws. Returns the RAW stored entries,
   * unfiltered by any live TTL: see PersistedOscillationState.windowMs's own
   * comment for why the caller (OscillationTracker.check()) is the one that
   * re-derives freshness against the CALLING rule's current window_seconds,
   * not this stored value.
   */
  get(key: string): PersistedOscillationState | null {
    if (!key) return null
    const state = this.load()[key]
    if (!state || !Array.isArray(state.entries)) return null
    return state
  }

  /**
   * Append one more fingerprint entry to `key`'s rolling window and return
   * the resulting bucket — load -> prune -> filter this bucket's own
   * entries to those still within `windowMs` -> push -> trim to
   * `maxBufferLength` -> persist, all under the file lock (see this class's
   * header for why append-under-lock, not read-then-set). `windowMs` is the
   * CALLING rule's current `window_seconds * 1000`; a fresh or fully-expired
   * bucket starts with just the new entry.
   */
  append(key: string, entry: OscillationEntry, windowMs: number, maxBufferLength: number): PersistedOscillationState {
    const boundedWindowMs = this.cap(windowMs)
    const cappedLength = Math.max(1, Math.min(maxBufferLength, MAX_BUFFER_LENGTH))
    if (!key) {
      return { entries: [entry], windowMs: boundedWindowMs }
    }
    this.ensureDir()
    return withFileLock(this.lockPath(), () => {
      const now = Date.now()
      const data = this.prune(this.load(), now)
      const existing = data[key]
      const fresh = (existing?.entries || []).filter(e => now - e.at < boundedWindowMs)
      const nextEntries = [...fresh, entry].slice(-cappedLength)
      const next: PersistedOscillationState = { entries: nextEntries, windowMs: boundedWindowMs }
      data[key] = next
      this.save(data)
      return next
    }, this.lockOptions)
  }

  private ensureDir(): void {
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* save() also tries; best effort */ }
  }

  /** Clear one session's bucket — the persisted counterpart of resetting a session's oscillation window. */
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

  /** Clear every bucket whose key encodes session `sessionId` — OscillationTracker.clear(sessionId)'s persisted counterpart. */
  deleteBySession(sessionId: string): void {
    if (!sessionId) return
    this.ensureDir()
    withFileLock(this.lockPath(), () => {
      const data = this.load()
      let changed = false
      for (const key of Object.keys(data)) {
        if (key.endsWith(`:${sessionId}`)) { delete data[key]; changed = true }
      }
      if (changed) this.save(data)
    }, this.lockOptions)
  }

  /** Clear every bucket — OscillationTracker.clear() with no argument. */
  clearAll(): void {
    this.ensureDir()
    withFileLock(this.lockPath(), () => {
      this.save({})
    }, this.lockOptions)
  }
}
