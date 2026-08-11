import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StateManager } from '../state-manager.js'

/**
 * STATE_DIR must be read PER CONSTRUCTION, not once at module import —
 * mirrors the fix already applied to AuditLog (KEEL_TRACES_DIR) and
 * FileRuleOverrideStore (KEEL_OVERRIDES_DIR). A module-level const is
 * fixed at first import of this file (whichever test happens to import it
 * first, process-wide), which defeats a test that sets KEEL_STATE_DIR in
 * its own test body after some other file already triggered the import.
 */

const tmpDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keel-state-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.KEEL_STATE_DIR
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('StateManager — KEEL_STATE_DIR read per construction', () => {
  it('writes under the KEEL_STATE_DIR set BEFORE construction (baseline)', () => {
    const dir = freshDir()
    process.env.KEEL_STATE_DIR = dir
    const sm = new StateManager()
    sm.markFirstTime('rule-a')
    expect(existsSync(join(dir, 'deny-first-time.json'))).toBe(true)
  })

  it('a SECOND StateManager picks up a CHANGED KEEL_STATE_DIR in the same process', () => {
    // This is the case a module-level `const STATE_DIR = process.env...`
    // (read once at import) cannot satisfy: by the time this test runs,
    // state-manager.ts has already been imported (by the test above, or
    // by whichever file the test runner imported first). If STATE_DIR
    // were a module-level const, this second construction would still
    // write to the FIRST test's directory (or the real ~/.keel/state),
    // not this one.
    const dirA = freshDir()
    process.env.KEEL_STATE_DIR = dirA
    const smA = new StateManager()
    smA.markFirstTime('rule-a')
    expect(existsSync(join(dirA, 'deny-first-time.json'))).toBe(true)

    const dirB = freshDir()
    process.env.KEEL_STATE_DIR = dirB
    const smB = new StateManager()
    smB.markFirstTime('rule-b')
    expect(existsSync(join(dirB, 'deny-first-time.json'))).toBe(true)
    // The second construction's write must NOT have landed in the first
    // directory — proves the env var was re-read, not cached.
    expect(existsSync(join(dirA, 'deny-first-time.json'))).toBe(true) // still there from smA
    const dirAContents: Record<string, unknown> = JSON.parse(readFileSync(join(dirA, 'deny-first-time.json'), 'utf-8'))
    expect(dirAContents).not.toHaveProperty('rule-b')
  })

  it('an explicit constructor arg takes precedence over the env var', () => {
    const envDir = freshDir()
    const explicitDir = freshDir()
    process.env.KEEL_STATE_DIR = envDir
    const sm = new StateManager(explicitDir)
    sm.markFirstTime('rule-c')
    expect(existsSync(join(explicitDir, 'deny-first-time.json'))).toBe(true)
    expect(existsSync(join(envDir, 'deny-first-time.json'))).toBe(false)
  })
})
