import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

  constructor(home = homedir()) {
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
    // exactly as before.
    this.directory = process.env.KEEL_OVERRIDES_DIR || join(home, '.keel')
    this.file = join(this.directory, 'overrides.json')
    this.lock = `${this.file}.lock`
  }

  consume(ruleId: string, sessionId?: string): boolean {
    let descriptor: number | undefined
    let acquired = false
    try {
      mkdirSync(this.directory, { recursive: true })
      try {
        descriptor = openSync(this.lock, 'wx')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(this.lock).mtimeMs > 60000) unlinkSync(this.lock)
        } catch {}
        descriptor = openSync(this.lock, 'wx')
      }
      acquired = true
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
    } catch {
      return false
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (acquired) {
        try { unlinkSync(this.lock) } catch {}
      }
    }
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
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
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
