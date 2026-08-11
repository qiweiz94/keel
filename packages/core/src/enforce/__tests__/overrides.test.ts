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

  // Wave-2 Lane-3 cleanup: the DEFAULT construction site
  // (`new FileRuleOverrideStore()`, used by pipeline.ts whenever no
  // overrideStore is supplied) used to always resolve to the real
  // homedir(), so every deny/prompt verdict in a test that forgot to stub
  // it touched real ~/.keel. KEEL_OVERRIDES_DIR redirects that default
  // construction site without changing what an explicit `home` argument
  // does (existing callers above are unaffected).
  it('KEEL_OVERRIDES_DIR redirects the default construction site, off real ~/.keel', () => {
    const overridesDir = mkdtempSync(join(tmpdir(), 'keel-overrides-env-'))
    const previous = process.env.KEEL_OVERRIDES_DIR
    process.env.KEEL_OVERRIDES_DIR = overridesDir
    try {
      const now = Date.now()
      mkdirSync(overridesDir, { recursive: true })
      writeFileSync(join(overridesDir, 'overrides.json'), JSON.stringify({ 'my-rule': { expires_at: now + 60000 } }))
      const store = new FileRuleOverrideStore()  // no `home` arg — the default site
      expect(store.consume('my-rule')).toBe(true)
      expect(existsSync(join(overridesDir, 'overrides.json'))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.KEEL_OVERRIDES_DIR
      else process.env.KEEL_OVERRIDES_DIR = previous
    }
  })

  it('an explicit `home` argument still wins when KEEL_OVERRIDES_DIR is unset (existing behavior unchanged)', () => {
    const home = mkdtempSync(join(tmpdir(), 'keel-overrides-explicit-'))
    const directory = join(home, '.keel')
    mkdirSync(directory, { recursive: true })
    const now = Date.now()
    writeFileSync(join(directory, 'overrides.json'), JSON.stringify({ 'explicit-rule': { expires_at: now + 60000 } }))
    const store = new FileRuleOverrideStore(home)
    expect(store.consume('explicit-rule')).toBe(true)
  })
})
