import { describe, it, expect, afterAll } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, chmodSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * End-to-end contract test for Cursor's claim-to-evidence hooks (v1
 * M2-C1) — all three (postToolUse, postToolUseFailure, afterAgentResponse)
 * are the SAME installed script, packages/cli/templates/
 * cursor-beforeshellexecution.sh (`exec keel hook cursor`), registered
 * under multiple `.cursor/hooks.json` keys by `installCursor()`. See that
 * script's own header comment.
 *
 * The event names, payload shapes, and — critically — the
 * `createSuccessOutput({output, exitCode})` JSON-stringified `tool_output`
 * shape for a shell command specifically are read from the INSTALLED
 * Cursor.app's own bundled `cursor-agent-exec` extension on this machine
 * (`/Applications/Cursor.app/Contents/Resources/app/extensions/
 * cursor-agent-exec/dist/main.js`), not published docs — see hook.ts's
 * cursor branch comments for the exact citations.
 *
 * Unlike Cline, Cursor's postToolUse payload DOES carry a confirmed
 * numeric exit code for a shell command (embedded inside `tool_output`),
 * so `type: verification` discharge IS live here — the MUST-DISCHARGE /
 * MUST-NOT-DISCHARGE pair below is the proof, mirroring Claude Code's own
 * PostToolUse verify-hook suite.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const HOOK_SCRIPT = join(REPO_ROOT, 'packages', 'cli', 'templates', 'cursor-beforeshellexecution.sh')
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
  const testDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-cursorclaim-proj-'))
  const tempHome = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-cursorclaim-home-'))
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

function run(ctx: Ctx, payload: string) {
  try {
    const stdout = execSync(`bash "${HOOK_SCRIPT}"`, {
      encoding: 'utf-8', cwd: ctx.testDir, timeout: 10000, input: payload, env: envFor(ctx),
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    return { stdout: err.stdout || '', code: err.status ?? 1 }
  }
}

function runBeforeShellExecution(ctx: Ctx, command: string, conversationId: string) {
  return run(ctx, JSON.stringify({ command, conversation_id: conversationId }))
}

function runPostToolUse(ctx: Ctx, conversationId: string, command: string, output: string, exitCode: number) {
  return run(ctx, JSON.stringify({
    conversation_id: conversationId, tool_name: 'bash', tool_input: { command },
    tool_output: JSON.stringify({ output, exitCode }), duration: 500, tool_use_id: 'tu_1',
  }))
}

function runAfterAgentResponse(ctx: Ctx, conversationId: string, text: string) {
  return run(ctx, JSON.stringify({
    conversation_id: conversationId, generation_id: 'gen_1', model: 'gpt-5',
    text, input_tokens: 10, output_tokens: 5,
  }))
}

function claimFired(tempHome: string, conversationId: string): boolean {
  const tracesDir = join(tempHome, '.keel', 'traces')
  let files: string[] = []
  try { files = readdirSync(tracesDir) } catch { return false }
  return files
    .flatMap(f => readFileSync(join(tracesDir, f), 'utf-8').trim().split('\n').filter(Boolean))
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
    .some((e: any) => e.session_id === conversationId && e.rule_id === 'claim-without-evidence' && e.observed_action === 'warn')
}

describePosixShim('Cursor claim-to-evidence hooks (v1 M2-C1)', () => {
  const dirsToClean: string[] = []
  afterAll(() => {
    for (const d of dirsToClean) rmSafe(d)
  })

  it('MUST-DISCHARGE: edit, then a CONFIRMED passing test via postToolUse (exitCode:0 inside tool_output), then a "done" claim — claim does NOT fire', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    runBeforeShellExecution(ctx, 'echo start', 'conv-discharge')
    // Arm the obligation via an edit — beforeMCPExecution-shaped write.
    run(ctx, JSON.stringify({
      conversation_id: 'conv-discharge', tool_name: 'write', tool_input: { filePath: 'src/a.ts', content: 'export const a = 1' },
    }))

    const post = runPostToolUse(ctx, 'conv-discharge', 'npm test', 'ok', 0)
    expect(post.code).toBe(0)

    const stop = runAfterAgentResponse(ctx, 'conv-discharge', 'Done, all tests pass.')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'conv-discharge')).toBe(false)
  })

  it('MUST-NOT-DISCHARGE: edit, then a CONFIRMED FAILING test via postToolUse (exitCode:1), then a "done" claim — claim STILL fires', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    run(ctx, JSON.stringify({
      conversation_id: 'conv-failing', tool_name: 'write', tool_input: { filePath: 'src/a.ts', content: 'export const a = 1' },
    }))

    const post = runPostToolUse(ctx, 'conv-failing', 'npm test', 'FAIL', 1)
    expect(post.code).toBe(0)

    const stop = runAfterAgentResponse(ctx, 'conv-failing', 'Done, all tests pass.')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'conv-failing')).toBe(true)
  })

  it('MUST-NOT-DISCHARGE: a postToolUseFailure (infra-level — e.g. timeout) never discharges, even though the command string matches the satisfy pattern', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    run(ctx, JSON.stringify({
      conversation_id: 'conv-timeout', tool_name: 'write', tool_input: { filePath: 'src/a.ts', content: 'export const a = 1' },
    }))

    const post = run(ctx, JSON.stringify({
      conversation_id: 'conv-timeout', tool_name: 'bash', tool_input: { command: 'npm test' },
      error_message: 'Command timed out after 60000ms', failure_type: 'timeout', duration: 60000,
    }))
    expect(post.code).toBe(0)

    const stop = runAfterAgentResponse(ctx, 'conv-timeout', 'Done, all tests pass.')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'conv-timeout')).toBe(true)
  })

  it('a postToolUse for a DIFFERENT command (not matching the satisfy pattern) does not discharge, even with a confirmed pass', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    run(ctx, JSON.stringify({
      conversation_id: 'conv-nomatch', tool_name: 'write', tool_input: { filePath: 'src/a.ts', content: 'export const a = 1' },
    }))

    const post = runPostToolUse(ctx, 'conv-nomatch', 'ls -la', '', 0)
    expect(post.code).toBe(0)

    const stop = runAfterAgentResponse(ctx, 'conv-nomatch', 'Done, all tests pass.')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'conv-nomatch')).toBe(true)
  })

  it('exits 0 even when keel itself cannot evaluate (malformed rules.yaml) — postToolUse and afterAgentResponse fail OPEN', () => {
    const ctx = freshProject('not: [valid yaml')
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const post = runPostToolUse(ctx, 'conv-broken', 'npm test', 'ok', 0)
    expect(post.code).toBe(0)
    const stop = runAfterAgentResponse(ctx, 'conv-broken', 'Done.')
    expect(stop.code).toBe(0)
  })

  it('the pre-existing beforeShellExecution block path is unaffected by the new branches', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const result = runBeforeShellExecution(ctx, 'ls -la', 'conv-unaffected')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).permission).toBe('allow')
  })
})
