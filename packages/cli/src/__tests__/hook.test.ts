import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Contract test for the canonical Claude Code PreToolUse hook
 * (packages/cli/templates/claude-pretooluse.sh, installed by
 * `keel install --claude-code`).
 *
 * Contract (modern Claude Code shell hooks):
 *   INPUT:  env vars TOOL_NAME (tool name) and TOOL_INPUT (JSON of tool args)
 *   OUTPUT: exit 0 = allow, exit 2 = deny (stderr shown to the model)
 *
 * The hook shells out to `keel evaluate` per call, so warn-then-deny
 * escalation is exercised across processes via the persisted state.
 *
 * Isolation: HOME is overridden to a temp dir so the test uses its own
 * ~/.keel (rules, state, audit) and never touches the real one. The
 * project's .keel/rules.yaml is the sole rule source.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const HOOK = join(REPO_ROOT, 'packages', 'cli', 'templates', 'claude-pretooluse.sh')
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

let testDir: string
let tempHome: string
let shimPath: string

const TEST_RULES = `version: 1
rules:
  - id: no-destructive-commands
    type: command
    match: "rm -rf /|rm -rf ~"
    action: deny
    message: "Destructive commands are blocked."

  - id: no-verify-commits
    type: command
    match: "git commit.*--no-verify"
    action: deny
    message: "No --no-verify."

  - id: must-sign-commits
    type: command
    match: "git commit"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    message: "Auto-adding --signoff to commits."
`

function runHook(toolName: string, toolInput: object): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`bash "${HOOK}"`, {
      encoding: 'utf-8',
      cwd: testDir,
      timeout: 10000,
      env: {
        ...process.env,
        HOME: tempHome,
        PATH: `${shimPath}:${process.env.PATH}`,
        TOOL_NAME: toolName,
        TOOL_INPUT: JSON.stringify(toolInput),
      },
    })
    return { stdout, stderr: '', code: 0 }
  } catch (err: any) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status ?? 1 }
  }
}

describePosixShim('Claude Code PreToolUse hook', () => {
  beforeAll(() => {
    testDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-hook-'))
    tempHome = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-home-'))
    execSync('git init', { cwd: testDir })

    // Project rules — the only rule source (temp HOME has no global rules).
    mkdirSync(join(testDir, '.keel'), { recursive: true })
    writeFileSync(join(testDir, '.keel', 'rules.yaml'), TEST_RULES, 'utf-8')

    // Shim `keel` so the hook exercises this working tree's CLI.
    shimPath = join(testDir, 'shim')
    mkdirSync(shimPath, { recursive: true })
    const shim = join(shimPath, 'keel')
    writeFileSync(shim, `#!/bin/bash\nexec node "${CLI}" "$@"\n`, 'utf-8')
    chmodSync(shim, 0o755)
  })

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('warns on the first destructive command, denies the repeat', () => {
    const first = runHook('Bash', { command: 'rm -rf /' })
    expect(first.code).toBe(0) // first violation: warn only

    const second = runHook('Bash', { command: 'rm -rf /' })
    expect(second.code).toBe(2)
    expect(second.stderr).toContain('Keel blocked')
  })

  it('denies a git hook bypass', () => {
    const first = runHook('Bash', { command: 'git commit --no-verify -m x' })
    expect(first.code).toBe(0) // first violation: warn only

    const second = runHook('Bash', { command: 'git commit --no-verify -m x' })
    expect(second.code).toBe(2)
  })

  it('allows an ordinary command', () => {
    const result = runHook('Bash', { command: 'ls -la' })
    expect(result.code).toBe(0)
  })

  it('allows a fix-rule command (fix is advisory in Claude Code hooks)', () => {
    // must-sign-commits is action: fix — Claude Code hooks cannot mutate
    // the input, so the hook allows the call (the message surfaces the fix).
    const result = runHook('Bash', { command: 'git commit -m wip' })
    expect(result.code).toBe(0)
  })

  it('does not let an embedded quote smuggle a command past the check', () => {
    // State for no-verify-commits may already be set by the earlier test,
    // so assert the eventual outcome rather than first-call semantics.
    runHook('Bash', { command: 'git commit -m "wip" --no-verify' })
    const second = runHook('Bash', { command: 'git commit -m "wip" --no-verify' })
    expect(second.code).toBe(2)
    expect(second.stderr).toContain('Keel blocked')
  })
})
