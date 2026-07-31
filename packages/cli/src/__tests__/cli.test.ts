import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve from this file's own location, NOT process.cwd(). `npm test` runs
// vitest with cwd=packages/cli, where a cwd-relative path resolves to
// packages/cli/packages/cli/dist/... and every test fails on a missing binary.
const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')
let testDir: string

interface RunResult {
  stdout: string
  /** Process exit code. Non-zero is meaningful — do not discard it. */
  code: number
}

function run(args: string): RunResult {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      encoding: 'utf-8',
      cwd: testDir,
      timeout: 10000,
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    // execSync throws on non-zero exit; err.status carries the code.
    return { stdout: err.stdout || err.message, code: err.status ?? 1 }
  }
}

describe('CLI Integration', () => {
  beforeAll(() => {
    // Create temp git repo
    testDir = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    execSync('git init', { cwd: testDir })
    execSync('git config user.email test@test.com', { cwd: testDir })
    execSync('git config user.name test', { cwd: testDir })
  })

  afterAll(() => {
    execSync(`rm -rf "${testDir}"`)
  })

  it('shows version', () => {
    const { stdout: out } = run('--version')
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('init creates config and hooks', () => {
    const { stdout: out } = run('init --hooks')
    expect(out).toContain('Created .keel.yaml')
    expect(out).toContain('Installed git hooks')
    expect(existsSync(join(testDir, '.keel.yaml'))).toBe(true)
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-commit'))).toBe(true)
  })

  it('check --command blocks dangerous commands', () => {
    const { stdout: out } = run('check --command "rm -rf /"')
    expect(out).toContain('BLOCKED')
  })

  it('check --command blocks no-verify', () => {
    const { stdout: out } = run('check --command "git commit --no-verify -m x"')
    expect(out).toContain('BLOCKED')
  })

  it('check --command blocks sudo', () => {
    const { stdout: out } = run('check --command "sudo rm file"')
    expect(out).toContain('BLOCKED')
  })

  it('check --command blocks pkill python', () => {
    const { stdout: out } = run('check --command "pkill -f python"')
    expect(out).toContain('BLOCKED')
  })

  it('check --command allows safe commands', () => {
    const { stdout: out } = run('check --command "npm install express"')
    expect(out).toContain('OK')
  })

  it('check --command blocks secret exposure', () => {
    const { stdout: out } = run(`check --command "echo \\$OPENAI_API_KEY"`)
    expect(out).toContain('BLOCKED')
  })

  it('check detects secrets in file', () => {
    writeFileSync(join(testDir, 'test.txt'), 'OPENAI_API_KEY=sk-test123-test-test-test-abcdefgh', 'utf-8')
    const { stdout: out } = run('check test.txt')
    expect(out).toContain('BLOCKED')
  })

  it('audit shows log', () => {
    // Run a command first to generate audit entry
    run('check --command "rm -rf /"')
    const { stdout: out } = run('audit')
    expect(out).toContain('BLOCKED')
  })

  it('audit --json outputs JSON', () => {
    const { stdout: out } = run('audit --json')
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it('template lists available templates', () => {
    const { stdout: out } = run('template --list')
    expect(out).toContain('default')
    expect(out).toContain('strict')
    expect(out).toContain('minimal')
    expect(out).toContain('security')
  })

  it('rules atr imports ATR rules', () => {
    const { stdout: out } = run('rules atr')
    expect(out).toContain('ATR')
    expect(out).toContain('Prompt Injection')
  })

  it('scan detects tools', () => {
    const { stdout: out } = run('scan')
    expect(out).toContain('keel scan')
  })

  it('verify shows help with no args', () => {
    const { stdout: out } = run('verify')
    expect(out).toContain('receipt')
  })

  it('init idempotent when already exists', () => {
    const { stdout: out } = run('init')
    expect(out).toContain('already exists')
  })

  it('check --ci with no staged changes succeeds', () => {
    const { stdout: out, code } = run('check --ci')
    expect(out).toContain('No staged changes')
    expect(code).toBe(0)
  })

  // ---------------------------------------------------------------------
  // Exit-code contract.
  //
  // Every test above asserts only on stdout. That cannot detect a CLI that
  // prints the right words and returns the wrong status — which is exactly
  // how `check --ci` and the git hook it installs are consumed. The four
  // tests below assert the status itself.
  // ---------------------------------------------------------------------

  it('check --ci exits 0 when a benign staged file has no violations', () => {
    // A clean file that trips no rule. Only a `block` should fail CI —
    // an advisory warning must not, or every commit is rejected.
    writeFileSync(join(testDir, 'benign.txt'), 'just some ordinary text\n', 'utf-8')
    execSync('git add benign.txt', { cwd: testDir })
    const { stdout: out, code } = run('check --ci')
    expect(out).not.toContain('BLOCKED')
    expect(code).toBe(0)
  })

  it('check --ci exits non-zero when a staged file contains a secret', () => {
    // The other half of the contract: a real violation must fail CI.
    writeFileSync(join(testDir, 'leak.txt'), 'AKIAIOSFODNN7EXAMPLE\n', 'utf-8')
    execSync('git add leak.txt', { cwd: testDir })
    const { stdout: out, code } = run('check --ci')
    expect(out).toContain('BLOCKED')
    expect(code).not.toBe(0)
    execSync('git reset leak.txt', { cwd: testDir })
  })

  it('check --command exits non-zero on a blocked command', () => {
    // Callers that key on exit status (CI steps, wrapper scripts, hooks)
    // currently see success for a blocked command.
    const { stdout: out, code } = run('check --command "rm -rf /"')
    expect(out).toContain('BLOCKED')
    expect(code).not.toBe(0)
  })

  it('check --command blocks --no-verify given after other flags', () => {
    // `git commit -n` is caught, but the pattern requires `commit` and `-n`
    // to be adjacent, so moving the flag past -m evades it.
    const { stdout: out } = run('check --command "git commit -m msg -n"')
    expect(out).toContain('BLOCKED')
  })
})
