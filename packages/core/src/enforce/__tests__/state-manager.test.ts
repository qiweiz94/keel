import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StateManager } from '../state-manager.js'
import { rmSafe } from './helpers/fs-safe.js'

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
    rmSafe(dir)
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

/**
 * Reproduces the null-JSON constructor crash directly: `JSON.parse('null')`
 * parses successfully (it is legal JSON), so a plain try/catch around
 * JSON.parse does NOT catch it — every `load*` method immediately does
 * `Object.entries(raw)` on the result, OUTSIDE its own try/catch, so an
 * unguarded `loadFile()` throws a `TypeError` straight out of `load()`,
 * which the constructor calls unconditionally. Since `load()` calls all
 * five `load*` methods sequentially, corruption in ANY ONE of the five
 * files takes down the whole constructor — and daemon.ts's lazy
 * singleton means every subsequent call re-throws forever without a
 * process restart. `loadFile()` must treat a non-object parse result
 * (null, an array, a number, a string) the same as a parse failure: fall
 * back to the safe default instead of returning it.
 */
describe('StateManager — survives a literal `null` JSON state file', () => {
  const STATE_FILES = [
    'deny-first-time',
    'circuit-breaker',
    'rate-counts',
    'verification',
    'oracle-failures',
  ]

  it.each(STATE_FILES)('does not throw when %s.json contains the literal 4 bytes "null"', (name) => {
    const dir = freshDir()
    writeFileSync(join(dir, `${name}.json`), 'null')
    expect(() => new StateManager(dir)).not.toThrow()
    // Falls back to the safe empty default, not `null` itself — a caller
    // reading e.g. `sm.circuitBreaker[key]` must never dereference into a
    // null state slice.
    const sm = new StateManager(dir)
    expect(sm.denyFirstTime).toEqual({})
    expect(sm.circuitBreaker).toEqual({})
    expect(sm.rateCounts).toEqual({})
    expect(sm.verification).toEqual({})
    expect(sm.oracleFailures).toEqual({})
  })

  it('also survives an array or a bare primitive in place of a dictionary', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'deny-first-time.json'), '[]')
    writeFileSync(join(dir, 'circuit-breaker.json'), '42')
    writeFileSync(join(dir, 'rate-counts.json'), '"corrupt"')
    expect(() => new StateManager(dir)).not.toThrow()
    const sm = new StateManager(dir)
    expect(sm.denyFirstTime).toEqual({})
    expect(sm.circuitBreaker).toEqual({})
    expect(sm.rateCounts).toEqual({})
  })

  it('the state manager remains USABLE after recovering from a null state file (not just non-throwing)', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'circuit-breaker.json'), 'null')
    const sm = new StateManager(dir)
    // Fails closed correctly on the very next real call, rather than
    // being left in some half-initialized state.
    expect(sm.recordCircuitBreaker('rule-x', 'Bash')).toBe(false)
    expect(sm.recordCircuitBreaker('rule-x', 'Bash')).toBe(false)
    expect(sm.recordCircuitBreaker('rule-x', 'Bash')).toBe(true)
  })
})
