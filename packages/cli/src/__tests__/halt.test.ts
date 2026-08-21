import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '')
}

let dir: string
let home: string
let shim: string

function run(args: string, opts: { cwd?: string; home?: string } = {}) {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      encoding: 'utf-8',
      cwd: opts.cwd ?? dir,
      timeout: 10000,
      env: { ...process.env, HOME: opts.home ?? home, PATH: `${shim}:${process.env.PATH}` },
    })
    return { stdout: stripAnsi(stdout), code: 0 }
  } catch (err: any) {
    return { stdout: stripAnsi((err.stdout || '') + (err.stderr || '')), code: err.status ?? 1 }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-halt-test-'))
  home = mkdtempSync(join(tmpdir(), 'keel-halt-test-home-'))
  mkdirSync(join(dir, '.keel'), { recursive: true })
  shim = join(dir, 'shim')
  mkdirSync(shim, { recursive: true })
  writeFileSync(join(shim, 'keel'), `#!/bin/bash\nexec node "${CLI}" "$@"\n`, 'utf-8')
  chmodSync(shim, 0o755)
})

afterEach(() => {
  rmSafe(dir); rmSafe(home)
})

describePosixShim('keel halt / keel resume (the lockdown latch)', () => {
  it('writes the HALTED sentinel with no expires_at field and auto_clear_on_restart: false', () => {
    const out = run('halt --reason "testing the latch"')
    expect(out.stdout).toContain('HALTED')
    const haltPath = join(home, '.keel', 'HALTED')
    expect(existsSync(haltPath)).toBe(true)
    const state = JSON.parse(readFileSync(haltPath, 'utf-8'))
    expect(state.reason).toBe('testing the latch')
    expect(state.auto_clear_on_restart).toBe(false)
    // No TTL field of any kind — a halt is not `keel disable`'s timed
    // sentinel wearing a different name.
    expect(state.expires_at).toBeUndefined()
    expect(state.until).toBeUndefined()
  })

  it('defaults the reason when --reason is omitted', () => {
    run('halt')
    const state = JSON.parse(readFileSync(join(home, '.keel', 'HALTED'), 'utf-8'))
    expect(state.reason).toBe('Manual halt')
  })

  it('keel resume clears the sentinel', () => {
    run('halt --reason "will be cleared"')
    expect(existsSync(join(home, '.keel', 'HALTED'))).toBe(true)
    const out = run('resume')
    expect(out.stdout).toContain('resumed')
    expect(existsSync(join(home, '.keel', 'HALTED'))).toBe(false)
  })

  it('keel resume when not halted says so and does not error', () => {
    const out = run('resume')
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('not halted')
  })

  it('keel status shows HALTED distinctly from the kill switch', () => {
    run('halt --reason "status check"')
    const out = run('status')
    expect(out.stdout).toContain('HALTED')
    expect(out.stdout).toContain('status check')
    expect(out.stdout).toContain('keel resume')
  })

  it('keel dashboard --json reports halted state', () => {
    run('halt --reason "dashboard check"')
    const out = run('dashboard --once --json')
    const state = JSON.parse(out.stdout)
    expect(state.halted.active).toBe(true)
    expect(state.halted.reason).toBe('dashboard check')
  })

  it('keel enable does not clear a halt and says so honestly', () => {
    run('halt --reason "enable should not touch this"')
    const out = run('enable')
    expect(out.stdout).toContain('HALTED')
    expect(existsSync(join(home, '.keel', 'HALTED'))).toBe(true)
  })
})

/**
 * In-process unit tests against the exported functions directly — the
 * deterministic way to exercise the corrupt-sentinel fail-closed edge case
 * (writing malformed JSON straight to the file, no CLI round trip needed).
 * Mirrors the pattern in fail-closed.test.ts's in-process describe block:
 * point HOME at a private tmp dir for the duration, restore it after.
 */
describe('halt.ts exports (in-process)', () => {
  let unitHome = ''
  const originalHome = process.env.HOME
  const originalKeelHome = process.env.KEEL_HOME

  beforeAll(() => {
    unitHome = mkdtempSync(join(tmpdir(), 'keel-halt-unit-'))
    process.env.HOME = unitHome
    delete process.env.KEEL_HOME
  })

  afterAll(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalKeelHome === undefined) delete process.env.KEEL_HOME
    else process.env.KEEL_HOME = originalKeelHome
    rmSafe(unitHome)
  })

  afterEach(() => {
    const haltPath = join(unitHome, '.keel', 'HALTED')
    if (existsSync(haltPath)) rmSafe(haltPath)
  })

  it('isHalted() is false when the sentinel is absent', async () => {
    const { isHalted } = await import('../commands/halt.js')
    expect(isHalted()).toBe(false)
  })

  it('haltSession() is idempotent and callable outside haltCommand', async () => {
    const { haltSession, isHalted } = await import('../commands/halt.js')
    haltSession('first reason')
    expect(isHalted()).toBe(true)
    // Calling again while already halted must not throw or un-halt.
    haltSession('second reason')
    expect(isHalted()).toBe(true)
  })

  it('isHalted() fails closed (stays true) on a corrupt sentinel — opposite polarity of isDisabled()', async () => {
    const { isHalted } = await import('../commands/halt.js')
    mkdirSync(join(unitHome, '.keel'), { recursive: true })
    writeFileSync(join(unitHome, '.keel', 'HALTED'), '{not-valid-json')
    expect(isHalted()).toBe(true)
  })

  it('haltReason() never throws on a corrupt sentinel and returns a safe default', async () => {
    const { haltReason } = await import('../commands/halt.js')
    mkdirSync(join(unitHome, '.keel'), { recursive: true })
    writeFileSync(join(unitHome, '.keel', 'HALTED'), '{not-valid-json')
    expect(() => haltReason()).not.toThrow()
    expect(haltReason()).toContain('corrupt')
  })
})
