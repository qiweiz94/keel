import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHome } from '../home.js'
import { withFileLock, type LockOptions } from './file-lock.js'

export type OverrideMode = 'once' | 'window' | 'session'

export interface RuleOverride {
  expires_at: number
  /** `once`: consumed on the first matching violation. `window`: all
   *  violations are allowed until expiry. `session`: all violations are
   *  allowed until expiry, but ONLY for calls carrying the exact
   *  `session_id` recorded in `session_id` below — a different session's
   *  call does not match, even while this entry is unexpired. Absent/legacy
   *  entries are treated as `once` (the conservative reading). */
  mode?: OverrideMode
  /** Set when `mode === 'session'`. The one session_id this override is
   *  scoped to — set by `keel allow <id> --session`, which resolves "the
   *  current session" from the most recent audit trail entry (this CLI
   *  never runs inside the agent's own process, so it cannot read a
   *  session_id off a live call). */
  session_id?: string
}

export interface RuleOverrideStore {
  /**
   * Returns true when a matching violation is covered by an override.
   *
   * Semantics:
   *   - `once`  — the override is deleted on first match (single use).
   *   - `window` — the override is kept until `expires_at` (all violations
   *     allowed, every one still audited by the pipeline).
   *   - `session` — kept until `expires_at`, but only matches when
   *     `sessionId` equals the override's own `session_id`. A call from a
   *     different (or missing) session_id does not consume or clear it.
   *   - expired — deleted, returns false.
   * Never throws: enforcement must not depend on the override store.
   */
  consume(ruleId: string, sessionId?: string): boolean
  /** Non-destructive check — does an unexpired override exist? */
  peek(ruleId: string): RuleOverride | null
  /** Snapshot of all overrides (for `keel status`). */
  list(): Record<string, RuleOverride>
}

export class FileRuleOverrideStore implements RuleOverrideStore {
  private readonly directory: string
  private readonly file: string
  private readonly lock: string
  private readonly lockOptions: LockOptions

  /**
   * `lockOptions` overrides file-lock.ts's default wait/stale-reclaim
   * bounds — same purpose as the matching parameter on StateManager and
   * ProblemLedger's constructors: production code never needs this, but
   * a test deliberately creating heavy artificial contention (or one that
   * wants a SHORT bound so an intentionally-held lock fails fast instead
   * of eating the 5s production default) needs a value the production
   * default doesn't have to grow to accommodate.
   */
  constructor(home = resolveHome(), lockOptions: LockOptions = {}) {
    // KEEL_OVERRIDES_DIR isolates the DEFAULT construction site
    // (pipeline.ts: `new FileRuleOverrideStore()`, used whenever a caller
    // does not supply its own overrideStore) from the real ~/.keel —
    // deny/block verdicts call `consume()` unconditionally, which touches
    // disk even when no override is ever armed. Deliberately a SEPARATE
    // env var from KEEL_STATE_DIR, not the same one. `keel allow` (the real
    // writer, packages/cli/src/commands/allow.ts) now honors this same
    // KEEL_OVERRIDES_DIR too (wave-3 warnsurface lane) — it did not
    // originally, which meant an isolated/test environment could arm an
    // override the pipeline's default store would never see (reader and
    // writer on different files). This constructor's explicit `home`
    // parameter (used by existing callers/tests) still takes precedence,
    // exactly as before. The default itself is now resolveHome() (KEEL_HOME
    // > HOME > homedir()) rather than a bare homedir(), so a caller that
    // relies on the default (no explicit `home` and no KEEL_OVERRIDES_DIR)
    // still agrees with `keel install` under KEEL_HOME.
    this.directory = process.env.KEEL_OVERRIDES_DIR || join(home, '.keel')
    this.file = join(this.directory, 'overrides.json')
    this.lock = `${this.file}.lock`
    this.lockOptions = lockOptions
  }

  /**
   * `consume`/`grant` share ONE lock (`overrides.json.lock`) via the
   * shared `withFileLock`/`acquireLock` primitive from file-lock.ts —
   * NOT a hand-rolled `openSync(path, 'wx')` + unconditional `unlinkSync`
   * in `finally`, which this class used to do. That hand-rolled version
   * reproduced the exact stale-lock reclaim-cascade file-lock.ts's own
   * header comment warns against: no ownership token written into the
   * lockfile, so a holder that stalls past the 60s staleness check, gets
   * reclaimed by a waiter, then wakes up and reaches its own `finally`,
   * unconditionally unlinks — deleting the RECLAIMER's live lock, not its
   * own, letting a third writer in while the reclaimer still believes it
   * holds it. `withFileLock`/`acquireLock` close this with a per-acquire
   * token: release only unlinks when the lockfile still contains the
   * exact token this call wrote (see file-lock.ts's header for the full
   * mechanism). Same fail-safe contract as StateManager/ProblemLedger: on
   * a timed-out acquire, the callback still runs UNLOCKED rather than the
   * write being silently skipped or the caller hanging — losing an
   * override write is worse than a rare unlocked window.
   */
  private ensureDir(): void {
    try { mkdirSync(this.directory, { recursive: true }) } catch { /* write() would also fail loudly; consume/grant catch around this */ }
  }

  consume(ruleId: string, sessionId?: string): boolean {
    try {
      this.ensureDir()
      return withFileLock(this.lock, () => {
        const overrides = this.read()
        const override = overrides[ruleId]
        if (!override || override.expires_at <= Date.now()) {
          if (override) delete overrides[ruleId]
          this.write(overrides)
          return false
        }
        if (override.mode === 'session') {
          // Scoped to one exact session_id. A different (or absent) caller
          // session_id does not match — and, importantly, does NOT delete or
          // otherwise disturb the entry, so the owning session can still use
          // it on a later call.
          return sessionId !== undefined && override.session_id === sessionId
        }
        if (override.mode === 'window') return true
        delete overrides[ruleId]
        this.write(overrides)
        return true
      }, this.lockOptions)
    } catch {
      return false
    }
  }

  /**
   * Persist a new/updated override for `ruleId` — the only production
   * WRITER of new entries (`keel allow`, packages/cli/src/commands/
   * allow.ts). Locked exactly like `consume()`, against the same file:
   * without this, a concurrent `keel allow` call (two terminals) or a
   * `consume()` mid-violation on another process is a real lost-update
   * race against this read-modify-write, same hazard class as
   * StateManager/ProblemLedger were fixed for.
   */
  grant(ruleId: string, override: RuleOverride): void {
    this.ensureDir()
    withFileLock(this.lock, () => {
      const overrides = this.read()
      overrides[ruleId] = override
      this.write(overrides)
    }, this.lockOptions)
  }

  peek(ruleId: string): RuleOverride | null {
    try {
      const override = this.read()[ruleId]
      if (!override || override.expires_at <= Date.now()) return null
      return override
    } catch {
      return null
    }
  }

  list(): Record<string, RuleOverride> {
    try {
      return this.read()
    } catch {
      return {}
    }
  }

  private read(): Record<string, RuleOverride> {
    if (!existsSync(this.file)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      // Guards the same non-object-but-legally-parses shapes as
      // StateManager.loadFile (bare `null`, an array, a number/string) —
      // `typeof null === 'object'` and `typeof [] === 'object'` both pass
      // a bare `typeof parsed === 'object'` check, so callers indexing
      // into the "dictionary" (consume/grant's `overrides[ruleId] = ...`)
      // would otherwise crash on legal-but-wrong-shaped JSON, not just a
      // syntax error.
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, RuleOverride>
      }
      return {}
    } catch {
      return {}
    }
  }

  private write(overrides: Record<string, RuleOverride>): void {
    const temporary = `${this.file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(overrides, null, 2))
    renameSync(temporary, this.file)
  }
}
