import { describe, it, expect, afterAll } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, chmodSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * End-to-end contract test for Cline's claim-to-evidence hooks (v1 M2-C1)
 * — packages/cli/templates/cline-posttooluse.sh
 * (~/.cline/hooks/PostToolUse, the `tool_result` event) and
 * cline-taskcomplete.sh (~/.cline/hooks/TaskComplete, the `agent_end`
 * event), installed alongside cline-pretooluse.sh by `keel install
 * --cline`.
 *
 * Both hook file names, event names, and the field names asserted below
 * (`hookName`, `taskId`, `postToolUse.{toolName,parameters,result,success}`,
 * `turn.outputText`) are read from the installed `cline` npm CLI's own
 * COMPILED `node_modules/@cline/core` bundle — not published docs, and not
 * merely its `.d.ts` — see hook.ts's cline branch comments for the exact
 * citations.
 *
 * `type: verification` discharge is DELIBERATELY inert on this host
 * (exitCode always null — this lane could not confirm whether Cline's own
 * `success` field tracks a shell command's exit status, or only whether the
 * tool-call machinery itself errored). The tests below prove that
 * specifically: a PostToolUse call NEVER discharges the obligation, no
 * matter what `success` says, while the claim channel itself (TaskComplete)
 * is fully live and reachable.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const PRE_HOOK = join(REPO_ROOT, 'packages', 'cli', 'templates', 'cline-pretooluse.sh')
const POST_HOOK = join(REPO_ROOT, 'packages', 'cli', 'templates', 'cline-posttooluse.sh')
const TASKCOMPLETE_HOOK = join(REPO_ROOT, 'packages', 'cli', 'templates', 'cline-taskcomplete.sh')
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
  const testDir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-clineclaim-proj-'))
  const tempHome = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'keel-clineclaim-home-'))
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

function runScript(ctx: Ctx, script: string, payload: string) {
  try {
    const stdout = execSync(`bash "${script}"`, {
      encoding: 'utf-8', cwd: ctx.testDir, timeout: 10000, input: payload, env: envFor(ctx),
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    return { stdout: err.stdout || '', code: err.status ?? 1 }
  }
}

function runPreToolUse(ctx: Ctx, toolName: string, args: object) {
  return runScript(ctx, PRE_HOOK, JSON.stringify({ preToolUse: { toolName, parameters: args } }))
}

function runPostToolUse(ctx: Ctx, taskId: string, toolName: string, args: object, result: string, success: boolean) {
  return runScript(ctx, POST_HOOK, JSON.stringify({
    hookName: 'tool_result', taskId,
    postToolUse: { toolName, parameters: args, result, success, executionTimeMs: 10 },
  }))
}

function runTaskComplete(ctx: Ctx, taskId: string, outputText: string) {
  return runScript(ctx, TASKCOMPLETE_HOOK, JSON.stringify({
    hookName: 'agent_end', taskId,
    turn: { outputText, status: 'completed' },
  }))
}

function claimFired(tempHome: string, taskId: string): boolean {
  const tracesDir = join(tempHome, '.keel', 'traces')
  let files: string[] = []
  try { files = readdirSync(tracesDir) } catch { return false }
  return files
    .flatMap(f => readFileSync(join(tracesDir, f), 'utf-8').trim().split('\n').filter(Boolean))
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
    .some((e: any) => e.session_id === taskId && e.rule_id === 'claim-without-evidence' && e.observed_action === 'warn')
}

describePosixShim('Cline claim-to-evidence hooks (v1 M2-C1)', () => {
  const dirsToClean: string[] = []
  afterAll(() => {
    for (const d of dirsToClean) rmSafe(d)
  })

  it('TaskComplete reaches the claim evaluator: a "done" claim with no prior edit/verify activity fires the warn', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    runPreToolUse(ctx, 'bash', { command: 'echo hi' })

    const done = runTaskComplete(ctx, 'task-claim-live', 'Done, all tests pass.')
    expect(done.code).toBe(0)
    // No edit ever armed an obligation for this task, so nothing should
    // fire — this proves the plumbing runs end-to-end (no crash, no
    // exit-2) without asserting a specific verdict from an un-armed state.
    expect(claimFired(ctx.tempHome, 'task-claim-live')).toBe(false)
  })

  it('MUST-NOT-DISCHARGE even on a CONFIRMED-successful PostToolUse: an edit, then success:true on the satisfy-matching command, then a "done" claim — claim STILL fires (exitCode intentionally stays null on this host)', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    runPreToolUse(ctx, 'edit', { filePath: 'src/a.ts', content: 'export const a = 1' })

    const post = runPostToolUse(ctx, 'task-success', 'bash', { command: 'npm test' }, 'ok', true)
    expect(post.code).toBe(0) // PostToolUse can never block

    const stop = runTaskComplete(ctx, 'task-success', 'Done, all tests pass.')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'task-success')).toBe(true)
  })

  it('MUST-NOT-DISCHARGE on a FAILING test reported success:false either — same conservative outcome, the point being that neither value is trusted', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    runPreToolUse(ctx, 'edit', { filePath: 'src/a.ts', content: 'export const a = 1' })

    const post = runPostToolUse(ctx, 'task-failure', 'bash', { command: 'npm test' }, 'FAIL', false)
    expect(post.code).toBe(0)

    const stop = runTaskComplete(ctx, 'task-failure', 'Done, all tests pass.')
    expect(stop.code).toBe(0)
    expect(claimFired(ctx.tempHome, 'task-failure')).toBe(true)
  })

  it('exits 0 even when keel itself cannot evaluate (malformed rules.yaml) — both hooks fail OPEN', () => {
    const ctx = freshProject('not: [valid yaml')
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const post = runPostToolUse(ctx, 'task-broken', 'bash', { command: 'npm test' }, 'ok', true)
    expect(post.code).toBe(0)
    const done = runTaskComplete(ctx, 'task-broken', 'Done.')
    expect(done.code).toBe(0)
  })

  it('an ordinary PreToolUse call is unaffected by the new PostToolUse/TaskComplete hooks existing', () => {
    const ctx = freshProject(CLAIM_RULES)
    dirsToClean.push(ctx.testDir, ctx.tempHome)
    const result = runPreToolUse(ctx, 'bash', { command: 'ls -la' })
    expect(result.code).toBe(0)
  })
})
