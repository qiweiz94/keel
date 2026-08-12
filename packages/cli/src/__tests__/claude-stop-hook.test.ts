import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, chmodSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Contract test for the Claude Code Stop hook
 * (packages/cli/templates/claude-stop.sh, installed by
 * `keel install --claude-code` alongside PreToolUse/PostToolUse) — v0.4
 * Phase 1's claim-to-evidence real-reach channel.
 *
 * Unlike claude-pretooluse.sh (before a tool runs, exit 2 blocks),
 * this hook fires ONCE PER ASSISTANT TURN, after the model has already
 * finished, carrying `last_assistant_message` (the agent's own completed
 * text — code.claude.com/docs/en/hooks, "docs" confidence: not yet
 * exercised against a live Claude Code session, see
 * session/v04/EVIDENCE/phase-1.md). `type: claim` ships `mode: observe`
 * and never blocks, so this hook structurally cannot interrupt the Stop
 * event — every case below asserts exit code 0, including when keel's own
 * evaluation fails internally (fail OPEN here is deliberate, the inverse
 * of the PreToolUse hook's fail-closed contract, because a non-zero exit
 * on Stop tells Claude Code to keep the agent going for a detector that
 * isn't allowed to block anyway).
 *
 * Isolation: HOME is overridden to a temp dir so the test uses its own
 * ~/.keel (rules, state, audit) and never touches the real one.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const PRE_HOOK = join(REPO_ROOT, 'packages', 'cli', 'templates', 'claude-pretooluse.sh')
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
  const testDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-stophook-proj-'))
  const tempHome = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-stophook-home-'))
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

function runPreToolUse(ctx: { testDir: string; tempHome: string; shimPath: string }, toolName: string, toolInput: object) {
  try {
    const stdout = execSync(`bash "${PRE_HOOK}"`, {
      encoding: 'utf-8',
      cwd: ctx.testDir,
      timeout: 10000,
      env: {
        ...process.env, HOME: ctx.tempHome, PATH: `${ctx.shimPath}:${process.env.PATH}`,
        TOOL_NAME: toolName, TOOL_INPUT: JSON.stringify(toolInput),
      },
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    return { stdout: err.stdout || '', code: err.status ?? 1 }
  }
}

function runStop(ctx: { testDir: string; tempHome: string; shimPath: string }, lastAssistantMessage: string, sessionId = 'stop-ses-1') {
  const payload = JSON.stringify({
    hook_event_name: 'Stop', session_id: sessionId, last_assistant_message: lastAssistantMessage,
  })
  try {
    const stdout = execSync(`bash "${STOP_HOOK}"`, {
      encoding: 'utf-8',
      cwd: ctx.testDir,
      timeout: 10000,
      input: payload,
      env: { ...process.env, HOME: ctx.tempHome, PATH: `${ctx.shimPath}:${process.env.PATH}` },
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

describePosixShim('Claude Code Stop hook (claim-to-evidence real reach)', () => {
  const dirsToClean: string[] = []
  afterAll(() => {
    for (const d of dirsToClean) rmSync(d, { recursive: true, force: true })
  })

  it('MUST-FIRE: an edit via PreToolUse, then Stop claims done — always exits 0, and the claim lands in the audit trace', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    runPreToolUse(ctx, 'Write', { filePath: 'src/a.ts', content: 'export const a = 1' })
    const stop = runStop(ctx, 'Done, all tests pass.', 'ses-fire')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'ses-fire')).toBe(true)
  })

  it('MUST-NOT-FIRE: a hedge/WIP utterance while pending — same grammar suppression as every other channel', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    runPreToolUse(ctx, 'Write', { filePath: 'src/a.ts', content: 'export const a = 1' })
    const stop = runStop(ctx, 'Still working on this, tests not run yet.', 'ses-hedge')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'ses-hedge')).toBe(false)
  })

  it('MUST-NOT-FIRE: no prior edit means nothing armed the obligation', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const stop = runStop(ctx, 'Done, all tests pass.', 'ses-no-edit')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'ses-no-edit')).toBe(false)
  })

  it('exits 0 even when keel itself cannot evaluate (malformed rules.yaml) — the Stop path fails OPEN, never blocking the agent for an internal keel error', () => {
    const ctx = freshProject('not: [valid yaml')
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const stop = runStop(ctx, 'Done, all tests pass.', 'ses-broken-rules')
    expect(stop.code).toBe(0)
  })

  it('a PreToolUse Bash call with no hook_event_name still parses as an ordinary tool call, not a Stop event', () => {
    // Regression guard for the hook_event_name-gated branch in
    // hook.ts's parsePayload: a normal PreToolUse payload must never be
    // misread as a Stop-shaped claim event.
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const result = runPreToolUse(ctx, 'Bash', { command: 'ls -la' })
    expect(result.code).toBe(0)
  })

  it('v1 M1r-2 regression guard: a Stop payload with last_assistant_message MISSING still exits 0, never the exit-2 block a fall-through to the PreToolUse branch would now produce', () => {
    // Before this lane, hook_event_name === 'Stop' was gated on the
    // message ALSO being a valid string; a malformed Stop payload (message
    // missing/null) fell through to the ordinary tool-call branch, where an
    // absent tool_name produced `tool: 'unknown'` — harmless only because
    // 'unknown' matched no real rule. Once a missing tool identity fails
    // closed (degenerate-input sweep), that same fall-through would have
    // turned a Stop event into an exit-2 block: Stop's own contract says it
    // can NEVER block (see hookVerdict's header comment — exit 2 on Stop
    // tells Claude Code to keep going with keel's own failure as the
    // reason, a self-inflicted loop). parsePayload now gates on
    // hook_event_name alone, so every Stop-shaped payload — valid message
    // or not — stays on the structurally-can't-block claim path.
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'ses-no-message' })
    let result: { stdout: string; code: number }
    try {
      const stdout = execSync(`bash "${STOP_HOOK}"`, {
        encoding: 'utf-8', cwd: ctx.testDir, timeout: 10000, input: payload,
        env: { ...process.env, HOME: ctx.tempHome, PATH: `${ctx.shimPath}:${process.env.PATH}` },
      })
      result = { stdout, code: 0 }
    } catch (err: any) {
      result = { stdout: err.stdout || '', code: err.status ?? 1 }
    }
    expect(result.code).toBe(0)
  })
})
