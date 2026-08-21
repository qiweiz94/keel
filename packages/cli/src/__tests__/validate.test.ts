import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `keel validate` used to read `process.env.HOME || '~'` directly for its
 * file-existence/listing section while `loadRuleHierarchy(dir)` — used for
 * the conflict check and the "Current protection" dial line just below —
 * correctly called resolveHome() (KEEL_HOME > HOME > os.homedir()). Under a
 * sandboxed KEEL_HOME session those two disagreed: the listing reported on
 * the real ~/.keel/rules.yaml while the dial reflected a totally different
 * (KEEL_HOME) ruleset in the same command's output.
 *
 * Both tests below set HOME and KEEL_HOME to two DISTINCT temp dirs — never
 * relying on KEEL_HOME alone — so a fix that only partially replaced the
 * bad `home` variable can't pass by accident.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

let dir: string

function run(args: string, opts: { cwd?: string; home?: string; keelHome?: string } = {}) {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: opts.home ?? process.env.HOME }
    if (opts.keelHome) env.KEEL_HOME = opts.keelHome
    else delete env.KEEL_HOME
    const stdout = execSync(`node "${CLI}" ${args}`, {
      encoding: 'utf-8',
      cwd: opts.cwd ?? dir,
      timeout: 10000,
      env,
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    return { stdout: (err.stdout || '') + (err.stderr || ''), code: err.status ?? 1 }
  }
}

const GLOBAL_PROTECT_RULES = `version: 1
level: protect
rules:
  - id: global-sample
    type: command
    match: "global-token"
    action: deny
    message: "blocked"
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-validate-test-'))
})

afterEach(() => {
  rmSafe(dir)
})

describe('keel validate honors KEEL_HOME over HOME', () => {
  let sysHome: string
  let keelHome: string

  beforeEach(() => {
    sysHome = mkdtempSync(join(tmpdir(), 'keel-validate-syshome-'))
    keelHome = mkdtempSync(join(tmpdir(), 'keel-validate-keelhome-'))
  })

  afterEach(() => {
    rmSafe(sysHome); rmSafe(keelHome)
  })

  it('lists the global rules file under KEEL_HOME, not under HOME', () => {
    mkdirSync(join(keelHome, '.keel'), { recursive: true })
    writeFileSync(join(keelHome, '.keel', 'rules.yaml'), GLOBAL_PROTECT_RULES)
    // A DIFFERENT file under HOME, so a pass here can't be an accident of
    // both paths resolving to the same content.
    mkdirSync(join(sysHome, '.keel'), { recursive: true })
    writeFileSync(join(sysHome, '.keel', 'rules.yaml'), 'version: 1\nrules: []\n')

    const out = run('validate', { home: sysHome, keelHome })
    expect(out.stdout).toContain(`Global rules: ${join(keelHome, '.keel', 'rules.yaml')}`)
    expect(out.stdout).not.toContain(join(sysHome, '.keel', 'rules.yaml'))
  })

  it('does not contradict itself: the "found/not found" listing and the dial agree on the same (KEEL_HOME) ruleset', () => {
    // Global rules exist ONLY under KEEL_HOME, at level: protect. Under the
    // old bug, the listing section (reading HOME) would say "not found"
    // while the dial section (reading via resolveHome()) still reported
    // "protect" from the KEEL_HOME file — a self-contradictory report.
    mkdirSync(join(keelHome, '.keel'), { recursive: true })
    writeFileSync(join(keelHome, '.keel', 'rules.yaml'), GLOBAL_PROTECT_RULES)
    expect(existsSync(join(sysHome, '.keel'))).toBe(false)

    const out = run('validate', { home: sysHome, keelHome })
    expect(out.stdout).toMatch(/✓\s+Global rules:.*\(1 rules\)/)
    expect(out.stdout).toContain('Current protection: protect')
  })

  it('falls back to HOME when KEEL_HOME is unset', () => {
    mkdirSync(join(sysHome, '.keel'), { recursive: true })
    writeFileSync(join(sysHome, '.keel', 'rules.yaml'), GLOBAL_PROTECT_RULES)

    const out = run('validate', { home: sysHome })
    expect(out.stdout).toContain(`Global rules: ${join(sysHome, '.keel', 'rules.yaml')}`)
    expect(out.stdout).toContain('Current protection: protect')
  })
})
