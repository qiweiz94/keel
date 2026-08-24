import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic, type LockOptions } from './file-lock.js'
import { stateDir } from './state-manager.js'

/**
 * One `type: budget` rule's persisted spend state, keyed by
 * `budget:{ruleId}:{sessionId}:{cwd}`. Written ONLY from
 * `BudgetTracker.record()` (called from a Stop/PostToolUse-equivalent
 * hook, OUTSIDE `EnforcementPipeline.evaluate()`'s PreToolUse path — see
 * types.ts's `max_tokens` comment for the full two-phase rationale). Read
 * from `BudgetTracker.checkDeny()`, which `evaluate()`'s `type: budget`
 * branch calls — that read is the ENTIRE blocking-path contract: it never
 * re-derives spend from a transcript, only from this file.
 */
export interface PersistedBudgetState {
  /** Set once a confirmed measurement crosses the rule's configured ceiling. The one field `checkDeny()` actually branches on. */
  overBudget: boolean
  /** Epoch ms of the measurement that produced this state. */
  measuredAt: number
  spendTokens: number
  /** null whenever the dollar figure is not fully confident — see claude-transcript.ts's model-normalization comment. Never a partial/undercounted guess. */
  spendDollars: number | null
  dollarsConfident: boolean
  /**
   * True when the LAST measurement attempt could not read its source at
   * all (missing/unreadable transcript, unreachable OpenCode db, ...).
   * When true, `overBudget`/`spendTokens`/`spendDollars` are carried over
   * UNCHANGED from whatever was last confirmed (never reset to 0/false —
   * see BudgetTracker.record()'s own comment for why a failed read must
   * never silently read as "0 spend, under budget"). This is the loud,
   * inspectable signal for a degraded measurement — never a swallowed
   * failure.
   */
  unavailable: boolean
  /** Human-readable reason, surfaced in the deny message and in `unavailable` diagnostics. */
  reason: string
}

interface BudgetStateFile {
  [key: string]: PersistedBudgetState
}

// Same ceiling role as stuck-store.ts's STUCK_STATE_MAX_WINDOW_MS / flow-
// store.ts's FLOW_TAG_TTL_MS: bounds how long a stale session's bucket can
// linger on disk regardless of whether anything ever explicitly cleared
// it. 24h matches StateManager's own TTL_MS convention.
export const BUDGET_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000

// Same role as stuck-store.ts's MAX_ENTRIES: caps total bucket count
// against many distinct cwds/sessions ever hooked through this machine.
const MAX_ENTRIES = 500

/**
 * PersistentBudgetStore — the disk-backed store `BudgetTracker` reads/
 * writes through, same shape as `PersistentStuckStore` (stuck-store.ts):
 * one JSON file under `stateDir()`, one `<file>.lock` lockfile, load ->
 * prune -> mutate -> persist entirely inside the lock for writers, a
 * lock-free read-only `get()` for the hot PreToolUse check.
 *
 * FAIL-SAFE: fails to "no state" (get() returns null) on any read/write
 * error, never throws — a corrupt or unreadable state file must not crash
 * enforcement; it just means the persisted flag can't be consulted, which
 * `checkDeny()` already treats as "nothing to deny" (the same direction
 * every other stateful tracker in this codebase fails).
 */
export class PersistentBudgetStore {
  private readonly dir: string
  private readonly lockOptions: LockOptions

  constructor(dir: string = stateDir(), lockOptions: LockOptions = {}) {
    this.dir = dir
    this.lockOptions = lockOptions
  }

  private filePath(): string {
    return join(this.dir, 'budget-tracker.json')
  }

  private lockPath(): string {
    return `${this.filePath()}.lock`
  }

  private load(): BudgetStateFile {
    try {
      const p = this.filePath()
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as BudgetStateFile
      }
    } catch { /* corrupt or unreadable — start fresh, never throw */ }
    return {}
  }

  private save(data: BudgetStateFile): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const p = this.filePath()
      writeFileAtomic(p, JSON.stringify(data))
    } catch { /* best-effort persistence — same posture as StateManager.saveFile */ }
  }

  private prune(data: BudgetStateFile, now: number): BudgetStateFile {
    const pruned: BudgetStateFile = {}
    for (const [key, state] of Object.entries(data)) {
      if (!state || typeof state.measuredAt !== 'number') continue
      if (now - state.measuredAt < BUDGET_STATE_MAX_AGE_MS) pruned[key] = state
    }
    const keys = Object.keys(pruned)
    if (keys.length > MAX_ENTRIES) {
      const byRecency = keys
        .map(k => ({ k, last: pruned[k].measuredAt }))
        .sort((a, b) => a.last - b.last)
      for (const { k } of byRecency.slice(0, keys.length - MAX_ENTRIES)) delete pruned[k]
    }
    return pruned
  }

  /**
   * Non-expired persisted state for `key`, or `null` — read-only, no lock,
   * no directory creation, never throws. `BudgetTracker.checkDeny()` calls
   * this on every evaluated tool call, not only ones being recorded — same
   * hot-path requirement as `PersistentStuckStore.get()`.
   */
  get(key: string): PersistedBudgetState | null {
    if (!key) return null
    const state = this.load()[key]
    if (!state || typeof state.measuredAt !== 'number') return null
    if (Date.now() - state.measuredAt >= BUDGET_STATE_MAX_AGE_MS) return null
    return state
  }

  /** Persist `state` for `key`, replacing whatever was there. Under the file lock so two concurrent measurement writers can't lose one's write to the other's. */
  set(key: string, state: PersistedBudgetState): void {
    if (!key) return
    this.ensureDir()
    withFileLock(this.lockPath(), () => {
      const now = Date.now()
      const data = this.prune(this.load(), now)
      data[key] = state
      this.save(data)
    }, this.lockOptions)
  }

  private ensureDir(): void {
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* save() also tries; best effort */ }
  }

  /** Clear one bucket — used by tests and by a future `keel budget reset`. */
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

  /** Clear every bucket — test isolation helper, mirrors PersistentStuckStore.clearAll(). */
  clearAll(): void {
    this.ensureDir()
    withFileLock(this.lockPath(), () => {
      this.save({})
    }, this.lockOptions)
  }
}
