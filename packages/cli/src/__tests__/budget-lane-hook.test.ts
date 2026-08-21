import { describe, it, expect, afterAll } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, chmodSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * End-to-end contract test for `type: budget` through the REAL built CLI
 * and shell hook templates — not a unit-level simulation. Exercises the
 * design audit's point 4 (SAFETY-CRITICAL, two-phase enforcement) directly
 * against the actual `keel hook claude-code` process boundary:
 *
 *   1. The Stop hook (claude-stop.sh) — carrying `transcript_path` pointed
 *      at a SYNTHETIC over-budget transcript — MUST exit 0 (never block),
 *      even though the session it just measured is grossly over budget.
 *      This is the architectural constraint itself: Claude Code's Stop
 *      hook fires after the turn already completed, so there is no tool
 *      call left to deny.
 *   2. The VERY NEXT PreToolUse call (claude-pretooluse.sh, a fresh
 *      process, same session) reads the persisted flag Stop's measurement
 *      just wrote and — following this ruleset's existing warn-once-then-
 *      block ladder (docs/integration-guides/claude-code.md) — WARNS on
 *      its first hit (exit 0, advisory) and DENIES (exit 2) on the second.
 *      Neither call re-reads the transcript; both only ever consult
 *      `~/.keel/state/budget-tracker.json`.
 *
 * `KEEL_STATE_DIR` is not set here on purpose — this suite isolates via a
 * fresh `HOME` per test (same pattern as claude-posttooluse-verify-hook.
 * test.ts), which is what makes the persisted flag actually carry across
 * these three separate process invocations: proof this is disk state, not
 * an in-memory artifact of one process.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const PRE_HOOK = join(REPO_ROOT, 'packages', 'cli', 'templates', 'claude-pretooluse.sh')
const STOP_HOOK = join(REPO_ROOT, 'packages', 'cli', 'templates', 'claude-stop.sh')

const BUDGET_RULES = `version: 1
rules:
  - id: session-cap
    type: budget
    max_tokens: 100
    action: deny
    message: "This session is over its token budget."
`

function freshProject(rules: string): { testDir: string; tempHome: string; shimPath: string } {
  const testDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-budget-hook-proj-'))
  const tempHome = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-budget-hook-home-'))
  execSync('git init -q', { cwd: testDir })
  mkdirSync(join(testDir, '.keel'), { recursive: true })
  writeFileSync(join(testDir, '.keel', 'rules.yaml'), rules, 'utf-8')

  const shimPath = join(testDir, 'shim')
  mkdirSync(shimPath, { recursive: true })
  const shim = join(shimPath, 'keel')
  writeFileSync(shim, `#!/bin/bash\nexec node "${join(HERE, '..', '..', 'dist', 'index.js')}" "$@"\n`, 'utf-8')
  chmodSync(shim, 0o755)
  return { testDir, tempHome, shimPath }
}

type Ctx = { testDir: string; tempHome: string; shimPath: string }

function envFor(ctx: Ctx) {
  return { ...process.env, HOME: ctx.tempHome, PATH: `${ctx.shimPath}:${process.env.PATH}` }
}

function writeSyntheticTranscript(ctx: Ctx, totalInputTokens: number): string {
  const path = join(ctx.testDir, 'transcript.jsonl')
  const line = JSON.stringify({
    type: 'assistant',
    sessionId: 'ses-budget-e2e',
    message: { model: 'claude-sonnet-5', usage: { input_tokens: totalInputTokens, output_tokens: 0 } },
  })
  writeFileSync(path, line + '\n')
  return path
}

function runStop(ctx: Ctx, sessionId: string, transcriptPath: string) {
  const payload = JSON.stringify({
    hook_event_name: 'Stop', session_id: sessionId,
    last_assistant_message: 'working on it', transcript_path: transcriptPath,
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

function runPreToolUse(ctx: Ctx, sessionId: string) {
  const payload = JSON.stringify({
    session_id: sessionId, tool_name: 'Bash', tool_input: { command: 'echo hi' },
  })
  try {
    const stdout = execSync(`bash "${PRE_HOOK}"`, {
      encoding: 'utf-8', cwd: ctx.testDir, timeout: 10000, input: payload, env: envFor(ctx),
    })
    return { stdout, stderr: '', code: 0 }
  } catch (err: any) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status ?? 1 }
  }
}

/**
 * Point 5's "loud" half — see `recordClaudeCodeBudgetSnapshot`'s own
 * comment (enforce.ts): a measurement that could not read its transcript
 * must leave a DISTINCT, discoverable trace entry, not merely a silent
 * no-op. Mirrors claude-posttooluse-verify-hook.test.ts's `claimFired()`
 * helper — same "read every trace file under this test's isolated
 * tempHome, parse each JSONL line" shape.
 */
function unavailableMeasurementFired(tempHome: string): boolean {
  const tracesDir = join(tempHome, '.keel', 'traces')
  let files: string[] = []
  try { files = readdirSync(tracesDir) } catch { return false }
  return files
    .flatMap(f => readFileSync(join(tracesDir, f), 'utf-8').trim().split('\n').filter(Boolean))
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
    .some((e: any) => e.tool === 'budget-measurement' && e.action === 'report')
}

describePosixShim('type: budget — two-phase enforcement through the real Claude Code hooks (point 4)', () => {
  const dirsToClean: string[] = []
  afterAll(() => {
    for (const d of dirsToClean) rmSafe(d)
  })

  it('Stop hook measures a grossly-over-budget session and STILL exits 0 (never blocks) — then the NEXT PreToolUse call warns, and the ONE AFTER THAT denies', () => {
    const ctx = freshProject(BUDGET_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const sessionId = 'ses-budget-e2e'
    const transcriptPath = writeSyntheticTranscript(ctx, 5000) // 5000 > max_tokens: 100

    const stop = runStop(ctx, sessionId, transcriptPath)
    expect(stop.code).toBe(0) // architectural constraint: Stop can NEVER block

    // First PreToolUse after the measurement: warn-once ladder means this
    // is a first hit — advisory, exit 0, never a hard block on the first
    // violation of a deny rule (docs/integration-guides/claude-code.md).
    const first = runPreToolUse(ctx, sessionId)
    expect(first.code).toBe(0)

    // Second PreToolUse: the SAME persisted over-budget flag, now on its
    // second hit — this is where the deny actually lands. Neither call
    // touched the transcript again; both only read
    // ~/.keel/state/budget-tracker.json.
    const second = runPreToolUse(ctx, sessionId)
    expect(second.code).toBe(2)
    expect(second.stderr).toContain('session-cap')
  })

  it('a session comfortably under budget is never denied, across repeated PreToolUse calls', () => {
    const ctx = freshProject(BUDGET_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const sessionId = 'ses-budget-under'
    const transcriptPath = writeSyntheticTranscript(ctx, 10) // well under max_tokens: 100

    const stop = runStop(ctx, sessionId, transcriptPath)
    expect(stop.code).toBe(0)

    for (let i = 0; i < 3; i++) {
      const call = runPreToolUse(ctx, sessionId)
      expect(call.code).toBe(0)
    }
  })

  it('a Stop event with NO transcript_path (missing/older Claude Code) never fabricates a deny — point 5', () => {
    const ctx = freshProject(BUDGET_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const sessionId = 'ses-budget-no-transcript'

    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: 'hi' })
    let stopCode = 1
    try {
      execSync(`bash "${STOP_HOOK}"`, { encoding: 'utf-8', cwd: ctx.testDir, timeout: 10000, input: payload, env: envFor(ctx) })
      stopCode = 0
    } catch (err: any) {
      stopCode = err.status ?? 1
    }
    expect(stopCode).toBe(0)

    // Point 5, the "loud" half: a distinct, discoverable trace entry for
    // the failed measurement attempt — never a silent no-op.
    expect(unavailableMeasurementFired(ctx.tempHome)).toBe(true)

    const call = runPreToolUse(ctx, sessionId)
    expect(call.code).toBe(0) // nothing to deny — no confirmed over-budget state exists
  })
})
