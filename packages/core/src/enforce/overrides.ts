import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface RuleOverride {
  expires_at: number
}

export interface RuleOverrideStore {
  consume(ruleId: string): boolean
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
