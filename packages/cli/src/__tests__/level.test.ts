import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

let dir: string
let home: string
let shim: string

function run(args: string, opts: { cwd?: string; path?: string; home?: string } = {}) {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      encoding: 'utf-8',
      cwd: opts.cwd ?? dir,
      timeout: 10000,
      env: { ...process.env, HOME: opts.home ?? home, PATH: opts.path ?? `${shim}:${process.env.PATH}` },
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    return { stdout: (err.stdout || '') + (err.stderr || ''), code: err.status ?? 1 }
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
  dir = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
  home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
  mkdirSync(join(dir, '.keel'), { recursive: true })
  shim = join(dir, 'shim')
  execSync(`mkdir -p "${shim}"`)
  writeFileSync(join(shim, 'keel'), `#!/bin/bash\nexec node "${CLI}" "$@"\n`, 'utf-8')
  execSync(`chmod +x "${shim}"`)
})

afterEach(() => {
  execSync(`rm -rf "${dir}" "${home}"`)
})

describe('keel level (the speed dial)', () => {
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

  it('enforce --level without --persist refuses instead of silently doing nothing', () => {
    const out = run('enforce --level=protect')
    expect(out.stdout).toMatch(/without --persist|--persist/i)
    expect(out.code).toBe(1)
  })
})

describe('keel status (enforcement health)', () => {
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
})
