import { describe, it, expect, afterAll } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, chmodSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * End-to-end contract test for the Claude Code PostToolUse verify hook
 * (packages/cli/templates/claude-posttooluse-verify.sh, installed by
 * `keel install --claude-code` as a SECOND PostToolUse entry alongside
 * keel-reinject) — v1 M2-B1: give claim-to-evidence obligations real
 * reach on the exit-code hosts, the same discharge OpenCode's
 * tool.execute.after plugin handler already provides.
 *
 * Exercises the FULL loop through the real built CLI and shell scripts —
 * PreToolUse arms the obligation, Stop reads the claim, PostToolUse
 * discharges it — not a unit-level simulation. `KEEL_STATE_DIR` is what
 * actually carries the obligation across these three separate process
 * invocations (state-manager.ts persists `verification.json` to disk with
 * a file lock — see enforce/verification.ts's VerificationTracker); this
 * suite is the proof that a fresh `keel hook` process per call still sees
 * what an earlier one armed.
 *
 * The MUST-NOT-discharge cases below are the point of this file, not an
 * afterthought: a PostToolUse hook that discharges on ANY completed
 * satisfy-shaped command — pass or fail — would be worse than the gap it
 * replaces, clearing a verification obligation on a run that never
 * actually passed (the same "control that lies" class
 * VerificationTracker.isFakeSatisfy already guards on the trigger side).
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const PRE_HOOK = join(REPO_ROOT, 'packages', 'cli', 'templates', 'claude-pretooluse.sh')
const POST_VERIFY_HOOK = join(REPO_ROOT, 'packages', 'cli', 'templates', 'claude-posttooluse-verify.sh')
const STOP_HOOK = join(REPO_ROOT, 'packages', 'cli', 'templates', 'claude-stop.sh')
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

const CLAIM_RULES = `version: 1
rules:
  - id: claim-without-evidence
    type: claim
    mode: observe
    trigger:
      tools: [write, edit, apply_patch]
      path: "src/"
      pattern: "src/"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|pytest)"
    verification_window_seconds: 300
    action: warn
    message: "Claimed done/fixed/tested/passing/verified/complete without a passing verification run since the last edit."
`

function freshProject(rules: string): { testDir: string; tempHome: string; shimPath: string } {
  const testDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-postverify-proj-'))
  const tempHome = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-postverify-home-'))
  execSync('git init -q', { cwd: testDir })
  mkdirSync(join(testDir, '.keel'), { recursive: true })
  writeFileSync(join(testDir, '.keel', 'rules.yaml'), rules, 'utf-8')

  const shimPath = join(testDir, 'shim')
  mkdirSync(shimPath, { recursive: true })
  const shim = join(shimPath, 'keel')
  writeFileSync(shim, `#!/bin/bash\nexec node "${CLI}" "$@"\n`, 'utf-8')
  chmodSync(shim, 0o755)
  return { testDir, tempHome, shimPath }
}

type Ctx = { testDir: string; tempHome: string; shimPath: string }

function envFor(ctx: Ctx) {
  return { ...process.env, HOME: ctx.tempHome, PATH: `${ctx.shimPath}:${process.env.PATH}` }
}

function runPreToolUse(ctx: Ctx, toolName: string, toolInput: object) {
  try {
    const stdout = execSync(`bash "${PRE_HOOK}"`, {
      encoding: 'utf-8', cwd: ctx.testDir, timeout: 10000,
      env: { ...envFor(ctx), TOOL_NAME: toolName, TOOL_INPUT: JSON.stringify(toolInput) },
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    return { stdout: err.stdout || '', code: err.status ?? 1 }
  }
}

function runPostToolUse(ctx: Ctx, toolName: string, toolInput: object, toolResponse: object, sessionId: string) {
  const payload = JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: sessionId,
    tool_name: toolName, tool_input: toolInput, tool_response: toolResponse,
  })
  try {
    const stdout = execSync(`bash "${POST_VERIFY_HOOK}"`, {
      encoding: 'utf-8', cwd: ctx.testDir, timeout: 10000, input: payload, env: envFor(ctx),
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    return { stdout: err.stdout || '', code: err.status ?? 1 }
  }
}

function runStop(ctx: Ctx, lastAssistantMessage: string, sessionId: string) {
  const payload = JSON.stringify({
    hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: lastAssistantMessage,
  })
  try {
    const stdout = execSync(`bash "${STOP_HOOK}"`, {
      encoding: 'utf-8', cwd: ctx.testDir, timeout: 10000, input: payload, env: envFor(ctx),
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    return { stdout: err.stdout || '', code: err.status ?? 1 }
  }
}

function claimFired(tempHome: string, sessionId: string): boolean {
  const tracesDir = join(tempHome, '.keel', 'traces')
  let files: string[] = []
  try { files = readdirSync(tracesDir) } catch { return false }
  return files
    .flatMap(f => readFileSync(join(tracesDir, f), 'utf-8').trim().split('\n').filter(Boolean))
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
    .some((e: any) => e.session_id === sessionId && e.rule_id === 'claim-without-evidence' && e.observed_action === 'warn')
}

describePosixShim('Claude Code PostToolUse verify hook (claim-to-evidence discharge, v1 M2-B1)', () => {
  const dirsToClean: string[] = []
  afterAll(() => {
    for (const d of dirsToClean) rmSafe(d)
  })

  it('MUST-DISCHARGE: edit, then a CONFIRMED passing test via PostToolUse, then a "done" claim — claim does NOT fire (obligation was cleared)', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    runPreToolUse(ctx, 'Write', { filePath: 'src/a.ts', content: 'export const a = 1' })

    const post = runPostToolUse(ctx, 'Bash', { command: 'npm test' }, { exit_code: 0, stdout: 'ok' }, 'ses-discharge')
    expect(post.code).toBe(0)

    const stop = runStop(ctx, 'Done, all tests pass.', 'ses-discharge')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'ses-discharge')).toBe(false)
  })

  it('MUST-NOT-DISCHARGE: edit, then a CONFIRMED FAILING test via PostToolUse, then a "done" claim — claim STILL fires (a failing run must never clear the obligation)', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    runPreToolUse(ctx, 'Write', { filePath: 'src/a.ts', content: 'export const a = 1' })

    const post = runPostToolUse(ctx, 'Bash', { command: 'npm test' }, { exit_code: 1, stdout: 'FAIL' }, 'ses-failing')
    expect(post.code).toBe(0) // PostToolUse can never block

    const stop = runStop(ctx, 'Done, all tests pass.', 'ses-failing')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'ses-failing')).toBe(true)
  })

  it('MUST-NOT-DISCHARGE: edit, then a PostToolUse with NO determinable outcome, then a "done" claim — claim STILL fires (unconfirmed success is never treated as a pass)', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    runPreToolUse(ctx, 'Write', { filePath: 'src/a.ts', content: 'export const a = 1' })

    // No exit_code, no success/is_error/interrupted field — the honest
    // "Claude Code's real tool_response shape for Bash is unconfirmed"
    // case this whole hook is conservative about (see hook.ts's
    // postToolUseExitCode comment).
    const post = runPostToolUse(ctx, 'Bash', { command: 'npm test' }, { stdout: 'ok', stderr: '' }, 'ses-unknown')
    expect(post.code).toBe(0)

    const stop = runStop(ctx, 'Done, all tests pass.', 'ses-unknown')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'ses-unknown')).toBe(true)
  })

  it('a PostToolUse for a DIFFERENT command (not matching the satisfy pattern) does not discharge, even with a confirmed pass', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    runPreToolUse(ctx, 'Write', { filePath: 'src/a.ts', content: 'export const a = 1' })

    const post = runPostToolUse(ctx, 'Bash', { command: 'ls -la' }, { exit_code: 0 }, 'ses-nomatch')
    expect(post.code).toBe(0)

    const stop = runStop(ctx, 'Done, all tests pass.', 'ses-nomatch')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'ses-nomatch')).toBe(true)
  })

  it('exits 0 even when keel itself cannot evaluate (malformed rules.yaml) — PostToolUse fails OPEN, same contract as Stop', () => {
    const ctx = freshProject('not: [valid yaml')
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const post = runPostToolUse(ctx, 'Bash', { command: 'npm test' }, { exit_code: 0 }, 'ses-broken-rules')
    expect(post.code).toBe(0)
  })

  it('an ordinary PreToolUse Bash call is unaffected by the new PostToolUse branch existing', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const result = runPreToolUse(ctx, 'Bash', { command: 'ls -la' })
    expect(result.code).toBe(0)
  })
})
