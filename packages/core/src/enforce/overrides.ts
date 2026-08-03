import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type OverrideMode = 'once' | 'window'

export interface RuleOverride {
  expires_at: number
  /** `once`: consumed on the first matching violation. `window`: all
   *  violations are allowed until expiry. Absent/legacy entries are treated
   *  as `once` (the conservative reading). */
  mode?: OverrideMode
}

export interface RuleOverrideStore {
  /**
   * Returns true when a matching violation is covered by an override.
   *
   * Semantics:
   *   - `once`  — the override is deleted on first match (single use).
   *   - `window` — the override is kept until `expires_at` (all violations
   *     allowed, every one still audited by the pipeline).
   *   - expired — deleted, returns false.
   * Never throws: enforcement must not depend on the override store.
   */
  consume(ruleId: string): boolean
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
    this.directory = join(home, '.keel')
    this.file = join(this.directory, 'overrides.json')
    this.lock = `${this.file}.lock`
  }

  consume(ruleId: string): boolean {
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
