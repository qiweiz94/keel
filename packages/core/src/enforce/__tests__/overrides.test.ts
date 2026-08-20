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
    // A short timeoutMs (well under the 5s production default, and well
    // under this lockfile's own staleMs) so this deliberately-held,
    // fresh lock makes withFileLock give up and hit its fail-safe fast,
    // instead of this single test burning the whole 5s production
    // acquire window (and risking vitest's own default per-test
    // timeout) to prove the same thing.
    const store = new FileRuleOverrideStore(home, { timeoutMs: 200, staleMs: 60000 })
    expect(store.consume('rule')).toBe(false)
    // Fail-safe per file-lock.ts: consume() still RUNS unlocked on a
    // timed-out acquire rather than skipping the operation — it does not
    // touch the lockfile at all (no token was ever written into it, so
    // there is nothing for release to conditionally unlink), which is
    // the property this test exists to check: another process's live
    // lock survives untouched.
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

  it('survives a literal `null` overrides.json — consume() returns false and grant() still writes', () => {
    // Same crash class as StateManager.loadFile: `JSON.parse('null')`
    // parses successfully (legal JSON), so a plain try/catch around
    // JSON.parse alone does not catch it. `read()` guards this
    // explicitly (see its comment) — this exercises it end to end
    // through the public methods, not just the private read() shape.
    const home = mkdtempSync(join(tmpdir(), 'keel-overrides-null-'))
    const directory = join(home, '.keel')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'overrides.json'), 'null')
    const store = new FileRuleOverrideStore(home)
    expect(() => store.consume('rule')).not.toThrow()
    expect(store.consume('rule')).toBe(false)
    expect(store.peek('rule')).toBeNull()
    expect(store.list()).toEqual({})
    expect(() => store.grant('rule', { expires_at: Date.now() + 60000, mode: 'window' })).not.toThrow()
    expect(store.consume('rule')).toBe(true)
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

  describe('session-scoped overrides (mode: session)', () => {
    function storeWith(entry: Record<string, unknown>) {
      const home = mkdtempSync(join(tmpdir(), 'keel-overrides-session-'))
      const directory = join(home, '.keel')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'overrides.json'), JSON.stringify(entry))
      return new FileRuleOverrideStore(home)
    }

    it('grants across repeated calls carrying the same session_id — never spent like --once', () => {
      const store = storeWith({
        'rule-a': { expires_at: Date.now() + 60000, mode: 'session', session_id: 'ses_abc' },
      })
      expect(store.consume('rule-a', 'ses_abc')).toBe(true)
      expect(store.consume('rule-a', 'ses_abc')).toBe(true)
      expect(store.consume('rule-a', 'ses_abc')).toBe(true)
    })

    it('does NOT leak to a different session_id, even while unexpired and armed', () => {
      const store = storeWith({
        'rule-a': { expires_at: Date.now() + 60000, mode: 'session', session_id: 'ses_abc' },
      })
      expect(store.consume('rule-a', 'ses_other')).toBe(false)
      // The mismatch must not have consumed or damaged the entry — the
      // right session can still use it right after.
      expect(store.consume('rule-a', 'ses_abc')).toBe(true)
    })

    it('does not match a call carrying no session_id at all', () => {
      const store = storeWith({
        'rule-a': { expires_at: Date.now() + 60000, mode: 'session', session_id: 'ses_abc' },
      })
      expect(store.consume('rule-a')).toBe(false)
    })

    it('expires like any other override once past expires_at, regardless of session_id match', () => {
      const store = storeWith({
        'rule-a': { expires_at: Date.now() - 1, mode: 'session', session_id: 'ses_abc' },
      })
      expect(store.consume('rule-a', 'ses_abc')).toBe(false)
    })

    it('clears an expired session entry from disk on the next lookup — from ANY session, not just the owner', () => {
      // Lifecycle: a session override is not actively torn down when its
      // owning session ends (there is no "session ended" signal to react
      // to — see resolveCurrentSessionId's own comment on why). It clears
      // lazily, the same way `once`/`window` entries already do: the next
      // consume() call for this rule id, from ANYONE, finds expires_at in
      // the past and deletes it. A mismatched session_id triggers this
      // exactly like the owner would.
      const home = mkdtempSync(join(tmpdir(), 'keel-overrides-session-expiry-'))
      const directory = join(home, '.keel')
      const file = join(directory, 'overrides.json')
      mkdirSync(directory, { recursive: true })
      writeFileSync(file, JSON.stringify({
        'rule-a': { expires_at: Date.now() - 1, mode: 'session', session_id: 'ses_abc' },
      }))
      const store = new FileRuleOverrideStore(home)
      expect(store.consume('rule-a', 'ses_unrelated')).toBe(false)
      expect(readFileSync(file, 'utf8')).not.toContain('rule-a')
    })

    it('peek reports the session mode and the scoped session_id (for `keel status`)', () => {
      const store = storeWith({
        'rule-a': { expires_at: Date.now() + 60000, mode: 'session', session_id: 'ses_abc' },
      })
      const peeked = store.peek('rule-a')
      expect(peeked?.mode).toBe('session')
      expect(peeked?.session_id).toBe('ses_abc')
    })
  })
})
