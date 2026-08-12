import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Install-time and fail-closed behaviour.
 *
 * Each test here corresponds to a way enforcement could be silently disabled:
 * by clobbering the hooks it was meant to protect, by exiting 0 when it could
 * not run, or by treating a broken policy file as "no policy, carry on".
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

let dir: string
let shim: string

function run(args: string, opts: { cwd?: string; path?: string; home?: string; keelHome?: string } = {}) {
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: opts.home ?? process.env.HOME,
      PATH: opts.path ?? `${shim}:${process.env.PATH}`,
    }
    if (opts.keelHome) {
      env.KEEL_HOME = opts.keelHome
    } else {
      delete env.KEEL_HOME
    }
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-test-'))
  execSync('git init', { cwd: dir })
  execSync('git config user.email t@t.com', { cwd: dir })
  execSync('git config user.name t', { cwd: dir })
  shim = join(dir, 'shim')
  mkdirSync(shim, { recursive: true })
  writeFileSync(join(shim, 'keel'), `#!/bin/bash\nexec node "${CLI}" "$@"\n`, 'utf-8')
  chmodSync(join(shim, 'keel'), 0o755)
})

afterEach(() => {
  rmSafe(dir)
})

describePosixShim('init --hooks', () => {
  it('preserves an existing hook instead of overwriting it', () => {
    const hook = join(dir, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/bash\necho PROJECT-LINT-RAN\n', 'utf-8')
    chmodSync(hook, 0o755)

    run('init --hooks')

    expect(existsSync(join(dir, '.git', 'hooks', 'pre-commit.keel-backup'))).toBe(true)
    expect(readFileSync(join(dir, '.git', 'hooks', 'pre-commit.keel-backup'), 'utf-8'))
      .toContain('PROJECT-LINT-RAN')

    // And it must actually run at commit time, not merely sit in a backup file.
    writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf-8')
    execSync('git add a.txt', { cwd: dir })
    const out = execSync('git commit -m x 2>&1', {
      cwd: dir, encoding: 'utf-8',
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
    })
    expect(out).toContain('PROJECT-LINT-RAN')
  })

  it('still fails the commit when the preserved hook rejects', () => {
    const hook = join(dir, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/bash\necho LINT-FAIL\nexit 1\n', 'utf-8')
    chmodSync(hook, 0o755)
    run('init --hooks')

    writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf-8')
    execSync('git add a.txt', { cwd: dir })
    let code = 0
    try {
      execSync('git commit -m x', {
        cwd: dir, stdio: 'pipe',
        env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
      })
    } catch (err: any) {
      code = err.status ?? 1
    }
    expect(code).not.toBe(0)
  })

  it('generates a hook that fails closed when the binary is missing', () => {
    run('init --hooks')
    const hookBody = readFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'utf-8')
    // The old hook did `|| { echo ...; exit 0; }` — uninstalling the package
    // silently disabled enforcement.
    expect(hookBody).not.toMatch(/command -v ai-enforce[^\n]*exit 0/)

    let code = 0
    try {
      execSync(`bash "${join(dir, '.git', 'hooks', 'pre-commit')}"`, {
        cwd: dir, stdio: 'pipe', env: { PATH: '/usr/bin:/bin' },
      })
    } catch (err: any) {
      code = err.status ?? 1
    }
    expect(code).not.toBe(0)
  })
})

describePosixShim('policy loading fails closed', () => {
  it('denies when the policy file is empty', () => {
    // parseYaml("") returns null without throwing, so this must be checked
    // explicitly — it used to throw a TypeError and crash the CLI.
    writeFileSync(join(dir, '.keel.yaml'), '', 'utf-8')
    const { stdout, code } = run('check --command "ls -la"')
    expect(stdout).toContain('BLOCKED')
    expect(code).not.toBe(0)
  })

  it('denies when the policy file is malformed', () => {
    writeFileSync(join(dir, '.keel.yaml'), 'not: [valid yaml\n', 'utf-8')
    const { stdout, code } = run('check --command "ls -la"')
    expect(stdout).toContain('BLOCKED')
    expect(code).not.toBe(0)
  })

  it('uses defaults — not fail-closed — when no policy file exists', () => {
    const { stdout, code } = run('check --command "ls -la"')
    expect(stdout).not.toContain('BLOCKED')
    expect(code).toBe(0)
  })
})

describePosixShim('the policy protects its own configuration', () => {
  const protectedPaths = [
    '.keel.yaml',
    '.keel/audit/audit.log',
    '.claude/settings.json',
    '.git/hooks/pre-commit',
  ]

  for (const p of protectedPaths) {
    it(`blocks writes to ${p}`, () => {
      run('init')
      const { stdout } = run(`check --file "${p}" --write`)
      expect(stdout).toContain('BLOCKED')
    })
  }

  it('does not block writes to ordinary source files', () => {
    run('init')
    const { stdout, code } = run('check --file "src/index.ts" --write')
    expect(stdout).not.toContain('BLOCKED')
    expect(code).toBe(0)
  })
})

describe('install --opencode creates the global rules', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'keel-test-'))
  })

  afterEach(() => {
    rmSafe(home)
  })

  it('creates ~/.keel/rules.yaml with the current defaults', () => {
    const out = run('install --opencode', { home })
    expect(out.stdout).toContain('Created ~/.keel/rules.yaml')
    const rules = readFileSync(join(home, '.keel', 'rules.yaml'), 'utf-8')
    expect(rules).toContain('keel-control-gate')
    expect(rules).toContain('no-destructive-commands')
    expect(rules).not.toContain('verify-before-irreversible')
  })

  it('leaves an existing rules.yaml untouched', () => {
    run('install --opencode', { home })
    writeFileSync(join(home, '.keel', 'rules.yaml'), '# custom\nversion: 1\n', 'utf-8')
    const out = run('install --opencode', { home })
    expect(out.stdout).toContain('already exists (skipping)')
    expect(readFileSync(join(home, '.keel', 'rules.yaml'), 'utf-8')).toBe('# custom\nversion: 1\n')
  })
})

describe('install honors KEEL_HOME over HOME', () => {
  // Two DISTINCT tmp dirs. os.homedir() on POSIX reads $HOME, so a test that
  // only overrides HOME (or only checks KEEL_HOME's contents) could pass by
  // accident even if install.ts still called bare homedir(). Using separate
  // dirs for HOME and KEEL_HOME, and asserting the HOME side stays empty,
  // is what makes this test actually exercise the KEEL_HOME override.
  let sysHome: string
  let keelHome: string

  beforeEach(() => {
    sysHome = mkdtempSync(join(tmpdir(), 'keel-test-syshome-'))
    keelHome = mkdtempSync(join(tmpdir(), 'keel-test-keelhome-'))
  })

  afterEach(() => {
    rmSafe(sysHome)
    rmSafe(keelHome)
  })

  it('writes global install targets under KEEL_HOME, never under HOME', () => {
    const out = run('install --opencode', { home: sysHome, keelHome })
    expect(out.stdout).toContain('Created ~/.keel/rules.yaml')

    // KEEL_HOME received the writes.
    expect(existsSync(join(keelHome, '.keel', 'rules.yaml'))).toBe(true)
    expect(existsSync(join(keelHome, '.opencode', 'plugins', 'keel-enforce.js'))).toBe(true)

    // The real/system HOME must be untouched.
    expect(existsSync(join(sysHome, '.keel'))).toBe(false)
    expect(existsSync(join(sysHome, '.opencode'))).toBe(false)
  })

  it('falls back to HOME when KEEL_HOME is unset', () => {
    const out = run('install --opencode', { home: sysHome })
    expect(out.stdout).toContain('Created ~/.keel/rules.yaml')
    expect(existsSync(join(sysHome, '.keel', 'rules.yaml'))).toBe(true)
  })

  // `install --opencode` alone only exercises 4 of the 10 resolveHome() call
  // sites (~/.keel, ~/.opencode, ~/.keel/requirements.md; upgradePluginConfig
  // is an upgrade path that no-ops unless ~/.config/opencode/opencode.json
  // already exists, so it's seeded below). `--all` additionally reaches the
  // Cline, Codex, Hermes, OpenClaw, and Gemini host installers, covering
  // every global target install.ts writes. Everything else `--all` touches
  // (project plugin, Claude Code hooks, Cursor) is cwd-scoped, so it cannot
  // leak into sysHome by a different route.
  it('install --all writes every global target under KEEL_HOME, nothing under HOME', () => {
    // upgradePluginConfig() only rewrites an EXISTING opencode.json — seed
    // one under keelHome (never under sysHome) so this run actually
    // exercises that resolveHome() call site instead of silently no-op'ing.
    const ocConfigDir = join(keelHome, '.config', 'opencode')
    mkdirSync(ocConfigDir, { recursive: true })
    const ocConfigPath = join(ocConfigDir, 'opencode.json')
    writeFileSync(ocConfigPath, JSON.stringify({ plugin: ['old/keel-enforce.js'] }), 'utf-8')

    run('install --all', { home: sysHome, keelHome })

    for (const p of [
      join(keelHome, '.keel', 'rules.yaml'),
      join(keelHome, '.opencode', 'plugins', 'keel-enforce.js'),
      join(keelHome, '.keel', 'requirements.md'),
      join(keelHome, '.cline', 'hooks', 'PreToolUse'),
      join(keelHome, '.codex', 'hooks', 'keel-enforce.sh'),
      join(keelHome, '.hermes', 'plugins', 'keel', 'keel_plugin.py'),
      join(keelHome, '.openclaw', 'plugins', 'keel', 'index.mjs'),
      join(keelHome, '.gemini', 'hooks', 'PreToolUse'),
    ]) {
      expect(existsSync(p)).toBe(true)
    }

    // The seeded opencode.json was rewritten in place (old keel-enforce
    // entry filtered out) — proves upgradePluginConfig() resolved keelHome,
    // not a bare homedir().
    const rewritten = JSON.parse(readFileSync(ocConfigPath, 'utf-8'))
    expect(rewritten.plugin).toEqual([])

    // sysHome must stay completely empty — nothing install.ts writes should
    // route to homedir() when KEEL_HOME is set.
    expect(existsSync(sysHome)).toBe(true) // the tmp dir itself still exists
    expect(readdirSync(sysHome)).toEqual([])
  })
})
