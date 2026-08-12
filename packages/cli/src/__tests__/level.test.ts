import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

let dir: string
let home: string
let shim: string

// chalk colors its output in this test environment regardless of TTY
// (execSync's captured pipe isn't a terminal, but chalk still detects
// color support from the environment), so raw stdout is interleaved with
// ANSI escapes — e.g. "level: \x1b[37mbalanced\x1b[39m\x1b[7m →
// \x1b[27m\x1b[37mprotect". Assertions like `toContain('balanced →
// protect')` then fail even though the text is right there, just split
// by color codes. Stripping escapes here (not in the CLI) keeps these
// tests correct in BOTH color and NO_COLOR environments without changing
// what the CLI actually prints.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '')
}

function run(args: string, opts: { cwd?: string; path?: string; home?: string } = {}) {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      encoding: 'utf-8',
      cwd: opts.cwd ?? dir,
      timeout: 10000,
      env: { ...process.env, HOME: opts.home ?? home, PATH: opts.path ?? `${shim}:${process.env.PATH}` },
    })
    return { stdout: stripAnsi(stdout), code: 0 }
  } catch (err: any) {
    return { stdout: stripAnsi((err.stdout || '') + (err.stderr || '')), code: err.status ?? 1 }
  }
}

const PROJECT_RULES = `# test rules
version: 1
level: balanced
rules:
  - id: sample
    type: command
    match: "sample-token"
    action: deny
    level: sprint
    message: "Sample rule"
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-test-'))
  home = mkdtempSync(join(tmpdir(), 'keel-test-'))
  mkdirSync(join(dir, '.keel'), { recursive: true })
  shim = join(dir, 'shim')
  mkdirSync(shim, { recursive: true })
  writeFileSync(join(shim, 'keel'), `#!/bin/bash\nexec node "${CLI}" "$@"\n`, 'utf-8')
  chmodSync(shim, 0o755)
})

afterEach(() => {
  rmSafe(dir); rmSafe(home)
})

describePosixShim('keel level (the speed dial)', () => {
  it('rejects an invalid level', () => {
    const out = run('level turbo')
    expect(out.stdout).toContain('Invalid level')
  })

  it('sets the project level and preserves comments and rule-level fields', () => {
    writeFileSync(join(dir, '.keel', 'rules.yaml'), PROJECT_RULES)

    const out = run('level protect --project')
    expect(out.stdout).toContain('project level: balanced → protect')

    const written = readFileSync(join(dir, '.keel', 'rules.yaml'), 'utf-8')
    expect(written).toContain('# test rules')
    expect(written).toMatch(/^level: protect$/m)
    expect(written).toContain('level: sprint') // per-rule level untouched
  })

  it('reports the current level when no argument is given', () => {
    writeFileSync(join(dir, '.keel', 'rules.yaml'), PROJECT_RULES)
    const out = run('level')
    expect(out.stdout).toContain('balanced')
    expect(out.stdout).toContain('project:')
  })

  it('sets the global level under HOME', () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), PROJECT_RULES)

    const out = run('level sprint')
    expect(out.stdout).toContain('global level: balanced → sprint')
    expect(readFileSync(join(home, '.keel', 'rules.yaml'), 'utf-8')).toMatch(/^level: sprint$/m)
  })

  it('refuses when the target rules file does not exist', () => {
    const out = run('level protect')
    expect(out.stdout).toContain('No global rules file found')
    expect(existsSync(join(home, '.keel', 'rules.yaml'))).toBe(false)
  })

  it('enforce --level persists to the project rules', () => {
    writeFileSync(join(dir, '.keel', 'rules.yaml'), PROJECT_RULES)
    const out = run('enforce --level=protect --persist')
    expect(out.stdout).toContain('Persisted project level: protect')
    expect(readFileSync(join(dir, '.keel', 'rules.yaml'), 'utf-8')).toMatch(/^level: protect$/m)
  })

  it('enforce --level without --persist applies the dial for this invocation only, and says so', () => {
    // Was: refused outright ("has no effect without --persist") and never
    // showed status at all. Now: --level is honest about what it does — it
    // previews the named dial for THIS run (rule count / conflicts /
    // "Level:" line all reflect it), and says plainly that nothing was
    // written, rather than either silently no-opping or blocking the whole
    // command on a flag that has real, scoped effect.
    writeFileSync(join(dir, '.keel', 'rules.yaml'), PROJECT_RULES)
    const out = run('enforce --level=protect')
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('Level: protect')
    expect(out.stdout).toMatch(/preview.*not persisted/i)
    // Nothing was actually written to the rules file.
    expect(readFileSync(join(dir, '.keel', 'rules.yaml'), 'utf-8')).toMatch(/^level: balanced$/m)
  })

  it('bare `keel enforce` (no --level at all) shows status instead of refusing', () => {
    // Regression: the commander option used to default --level to
    // 'balanced', which made options.level truthy even when the user never
    // typed --level — so EVERY bare `keel enforce` hit the "no effect
    // without --persist" refusal and exited 1 before printing anything.
    writeFileSync(join(dir, '.keel', 'rules.yaml'), PROJECT_RULES)
    const out = run('enforce')
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('Ready. Connect your agent')
    expect(out.stdout).not.toMatch(/preview/i)
  })

  it('bare `keel enforce` reflects the real persisted dial, not a hardcoded balanced', () => {
    writeFileSync(join(dir, '.keel', 'rules.yaml'), PROJECT_RULES.replace('level: balanced', 'level: protect'))
    const out = run('enforce')
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('Level: protect')
  })

  it('enforce --persist without --level refuses — nothing to persist', () => {
    writeFileSync(join(dir, '.keel', 'rules.yaml'), PROJECT_RULES)
    const out = run('enforce --persist')
    expect(out.code).toBe(1)
    expect(out.stdout).toMatch(/--persist requires --level/i)
    expect(readFileSync(join(dir, '.keel', 'rules.yaml'), 'utf-8')).toMatch(/^level: balanced$/m)
  })

  it('setting sprint records sprint_started_at next to level (the expiry clock)', () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), PROJECT_RULES)

    const before = Date.now()
    run('level sprint')
    const written = readFileSync(join(home, '.keel', 'rules.yaml'), 'utf-8')
    const match = written.match(/^sprint_started_at:\s*(\S+)$/m)
    expect(match).not.toBeNull()
    const startedAt = Date.parse(match![1])
    expect(startedAt).toBeGreaterThanOrEqual(before - 1000)
    expect(startedAt).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('switching away from sprint clears a leftover sprint_started_at', () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), PROJECT_RULES)
    run('level sprint')
    expect(readFileSync(join(home, '.keel', 'rules.yaml'), 'utf-8')).toMatch(/^sprint_started_at:/m)

    run('level balanced')
    expect(readFileSync(join(home, '.keel', 'rules.yaml'), 'utf-8')).not.toMatch(/^sprint_started_at:/m)
  })

  it('prints a dial diff derived from the real merged ruleset, and never lists the protect-floor rule as softened', () => {
    // PROJECT_RULES has one unleveled `action: deny` rule ("sample") plus
    // its own per-rule `level: sprint` field (unrelated field, same name
    // as the dial) — add a real `level: protect` floor rule so the
    // "floors never soften" claim has something concrete to check.
    const rulesWithFloor = PROJECT_RULES + `  - id: floor-rule
    type: command
    match: "floor-token"
    action: deny
    level: protect
    message: "floor"
`
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), rulesWithFloor)

    const out = run('level sprint')
    expect(out.stdout).toMatch(/Dial diff \(balanced → sprint\)/)
    expect(out.stdout).toMatch(/soften deny\/block → warn/)
    expect(out.stdout).toContain('sample')
    // The floor is reported as unchanged, not as one of the softened ids.
    expect(out.stdout).toMatch(/floor\(s\) unchanged.*floor-rule/)
    const softenedLine = out.stdout.split('\n').find(l => l.includes('soften deny/block'))
    expect(softenedLine).toBeDefined()
    expect(softenedLine).not.toContain('floor-rule')
  })
})

describePosixShim('keel dashboard', () => {
  it('--once prints the dial panel', () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), PROJECT_RULES)
    const out = run('dashboard --once')
    expect(out.stdout).toMatch(/Speed dial:/)
    expect(out.stdout).toMatch(/balanced/i)
    expect(out.stdout).toMatch(/Kill switch:/)
  })

  it('--json dumps machine-readable state', () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), PROJECT_RULES.replace('level: balanced', 'level: protect'))
    const out = run('dashboard --json')
    const state = JSON.parse(out.stdout)
    expect(state.dial).toBe('protect')
    expect(Array.isArray(state.rules)).toBe(true)
    expect(typeof state.killSwitch.state).toBe('string')
  })
})

describePosixShim('keel status (enforcement health)', () => {
  it('reports the dial, kill switch, and rule counts', () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), PROJECT_RULES)
    const out = run('status')
    expect(out.stdout).toMatch(/Speed dial:\s*balanced/i)
    expect(out.stdout).toMatch(/Kill switch:\s*enabled/i)
    expect(out.stdout).toMatch(/rules/)
  })

  it('reflects the dial set in the global rules', () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), PROJECT_RULES.replace('level: balanced', 'level: protect'))
    const out = run('status')
    expect(out.stdout).toMatch(/Speed dial:\s*protect/i)
  })

  it('flags a corrupt kill-switch sentinel instead of treating it as armed', () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'DISABLED'), 'not-json', 'utf-8')
    const out = run('status')
    expect(out.stdout).toMatch(/corrupt|invalid/i)
  })

  it('keel allow refuses an unknown rule id', () => {
    const out = run('allow no-such-rule --once')
    expect(out.stdout).toMatch(/Unknown rule|unknown/i)
    expect(out.code).toBe(1)
  })

  it('announces an expired sprint reverting to balanced, with the resolved dial (not the raw file value)', () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    const expiredSprint = PROJECT_RULES.replace('level: balanced', 'level: sprint')
      + `sprint_started_at: ${new Date(Date.now() - 5 * 3_600_000).toISOString()}\n`
    writeFileSync(join(home, '.keel', 'rules.yaml'), expiredSprint)

    const out = run('status')
    // The resolved dial is what enforcement actually uses — balanced, not
    // the raw "sprint" still sitting in the file.
    expect(out.stdout).toMatch(/Speed dial:\s*balanced/i)
    expect(out.stdout).toMatch(/sprint expired.*balanced.*hours? ago/i)
  })

  it('does not announce expiry for a sprint that is still within its window', () => {
    mkdirSync(join(home, '.keel'), { recursive: true })
    const freshSprint = PROJECT_RULES.replace('level: balanced', 'level: sprint')
      + `sprint_started_at: ${new Date(Date.now() - 1 * 3_600_000).toISOString()}\n`
    writeFileSync(join(home, '.keel', 'rules.yaml'), freshSprint)

    const out = run('status')
    expect(out.stdout).toMatch(/Speed dial:\s*sprint/i)
    expect(out.stdout).not.toMatch(/sprint expired/i)
  })
})
