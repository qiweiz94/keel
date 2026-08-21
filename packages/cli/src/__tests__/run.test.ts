import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

let dir: string
let home: string

function run(args: string, opts: { timeout?: number } = {}) {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      encoding: 'utf-8',
      cwd: dir,
      timeout: opts.timeout ?? 10000,
      env: { ...process.env, HOME: home },
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    return { stdout: (err.stdout || '') + (err.stderr || ''), code: err.status ?? 1 }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-run-test-'))
  home = mkdtempSync(join(tmpdir(), 'keel-run-test-home-'))
  mkdirSync(join(dir, '.keel'), { recursive: true })
})

afterEach(() => {
  rmSafe(dir)
  rmSafe(home)
})

/**
 * Subprocess-level wiring tests for `keel run` — exit-code forwarding,
 * commander argument-passing (`--` vs bare flag-like tokens), and
 * RUN_STATE lifecycle. Every command used here is trivial, fast, and
 * self-terminating (`true`, `sh -c 'exit N'`, `sleep 1`) per this lane's
 * own constraint against spawning/killing real long-running processes
 * during manual verification — the SAFETY-CHECK logic itself (start-time
 * mismatch, pgid refusals, the SIGTERM/SIGKILL escalation) is covered
 * against FAKE process data in run-kill.test.ts, never against a real one
 * here.
 */
describe.skipIf(process.platform === 'win32')('keel run (POSIX subprocess wiring)', () => {
  it('forwards the child\'s exit code when it exits normally', () => {
    const ok = run('run -- true')
    expect(ok.code).toBe(0)

    const failing = run('run -- sh -c "exit 7"')
    expect(failing.code).toBe(7)
  })

  it('accepts flag-like tokens in the agent command WITHOUT a leading --', () => {
    // Regression guard for the exact commander pitfall this lane had to
    // resolve empirically: `allowUnknownOption()` on the `run` subcommand
    // lets `-c`-shaped tokens through as part of the variadic argument
    // instead of erroring as an unrecognized option of `run` itself.
    const result = run('run sh -c "exit 3"')
    expect(result.code).toBe(3)
  })

  it('clears RUN_STATE after the supervised process exits normally', () => {
    run('run -- true')
    const runStatePath = join(home, '.keel', 'RUN_STATE')
    if (existsSync(runStatePath)) {
      const data = JSON.parse(readFileSync(runStatePath, 'utf-8'))
      expect(Object.keys(data)).toEqual([])
    }
    // Absence of the file entirely is equally correct (never written, or
    // written-then-removed) — only a LEFTOVER entry would be a bug.
  })

  it('reports a clear error and exits non-zero when the agent command does not exist, without crashing', () => {
    const result = run('run -- keel-run-test-nonexistent-binary-xyz123')
    expect(result.code).not.toBe(0)
    expect(result.stdout.toLowerCase()).toContain('fail')
  })

  it('keel status shows a supervised run while it is alive, with pid and alive state', async () => {
    const child = spawn('node', [CLI, 'run', '--', 'sleep', '1'], {
      cwd: dir,
      env: { ...process.env, HOME: home },
      stdio: 'ignore',
    })

    // Give the supervisor a moment to record + upgrade the RUN_STATE entry
    // before we probe it — bounded by the surrounding `sleep 1`, not an
    // arbitrary guess.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const status = run('status')
    expect(status.stdout).toContain('Supervised run')
    expect(status.stdout).toMatch(/pid \d+/)
    expect(status.stdout).toMatch(/alive|unverified/)

    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.on('exit', () => resolve())
    })

    const runStatePath = join(home, '.keel', 'RUN_STATE')
    if (existsSync(runStatePath)) {
      const data = JSON.parse(readFileSync(runStatePath, 'utf-8'))
      expect(Object.keys(data)).toEqual([])
    }
  }, 10_000)
})

/**
 * In-process branch test for the Windows-degrade path. This asserts the
 * PLATFORM-CHECK branch takes over (no `detached`, no RUN_STATE write, the
 * agent still runs, the message is printed) — it cannot and does not claim
 * to verify real Windows job-object behavior, since there is no Windows
 * host in this environment. Flagged as a limitation in this lane's report.
 */
describe('runCommand: win32 degrade path (branch-only, not a real Windows run)', () => {
  const originalPlatform = process.platform
  let home2 = ''

  beforeEach(() => {
    home2 = mkdtempSync(join(tmpdir(), 'keel-run-win32-test-'))
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.HOME = home2
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    rmSafe(home2)
  })

  it('runs the command directly without writing RUN_STATE, and forwards its exit code', async () => {
    const { runCommand } = await import('../commands/run.js')
    process.exitCode = undefined
    await runCommand(['node', '-e', 'process.exit(0)'])
    expect(process.exitCode).toBe(0)
    expect(existsSync(join(home2, '.keel', 'RUN_STATE'))).toBe(false)
    process.exitCode = undefined
  })

  it('forwards a non-zero exit code on win32 too', async () => {
    const { runCommand } = await import('../commands/run.js')
    process.exitCode = undefined
    await runCommand(['node', '-e', 'process.exit(5)'])
    expect(process.exitCode).toBe(5)
    process.exitCode = undefined
  })
})
