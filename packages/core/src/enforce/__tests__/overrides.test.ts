import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileRuleOverrideStore } from '../overrides.js'

describe('rule overrides', () => {
  it('consumes an active override exactly once and ignores expired entries', () => {
    const home = mkdtempSync(join(tmpdir(), 'keel-overrides-'))
    const directory = join(home, '.keel')
    const file = join(directory, 'overrides.json')
    const now = Date.now()
    mkdirSync(directory, { recursive: true })
    writeFileSync(file, JSON.stringify({ active: { expires_at: now + 60000 }, expired: { expires_at: now - 1 } }))

    const store = new FileRuleOverrideStore(home)
    expect(store.consume('active')).toBe(true)
    expect(store.consume('active')).toBe(false)
    expect(store.consume('expired')).toBe(false)
    expect(readFileSync(file, 'utf8')).not.toContain('active')
  })

  it('does not remove a lock owned by another process', () => {
    const home = mkdtempSync(join(tmpdir(), 'keel-override-lock-'))
    const directory = join(home, '.keel')
    mkdirSync(directory, { recursive: true })
    const lock = join(directory, 'overrides.json.lock')
    writeFileSync(lock, 'active lock')
    const store = new FileRuleOverrideStore(home)
    expect(store.consume('rule')).toBe(false)
    expect(existsSync(lock)).toBe(true)
  })
})
