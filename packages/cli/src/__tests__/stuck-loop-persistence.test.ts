import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Proves the gap a deep audit found in last night's `no-repeat-loops`
 * promotion: `keel hook <host>` is a FRESH PROCESS per tool call (Claude
 * Code, Cursor, Codex, Gemini CLI, cline, generic all spawn one), so an
 * in-memory-only `StuckTracker` reset to empty on every single invocation
 * and could never see "this exact command already failed N times" — the
 * entire point of the stuck-loop detector. `enforce.ts`'s `initEnforce()`
 * (the actual choke point for `keel hook`) never wired a `stuckTracker`
 * into `PipelineConfig` at all before this fix; only `daemon.ts`'s
 * long-lived process did, which never exercises the cross-process gap.
 *
 * `stuck.test.ts` (packages/core) already proves the ESCALATION MATH is
 * correct within one process/one `StuckTracker` instance — not the gap.
 * This suite proves the thing that was actually broken: real,
 * separately-spawned `keel hook claude-code` OS processes, sharing only a
 * HOME (hence the same on-disk `PersistentStuckStore`) and a cwd, converge
 * on the SAME escalation state a single long-lived tracker would have
 * reached — matching install.ts's real shipped `no-repeat-loops` rule
 * shape (`window_seconds: 900`, `max_attempts: 3`, `escalation: [{at: 3,
 * action: redirect}]`) as closely as a private rules file can.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js')

const RULES = `version: 1
level: protect
rules:
  - id: t-stuck-loop
    type: stuck
    match: "npm test"
    category: workflow
    severity: medium
    confidence: high
    priority: -10
    window_seconds: 900
    max_attempts: 3
    fingerprint: auto
    require_failure: true
    reset_on_success: true
    escalation:
      - at: 3
        action: redirect
        message: "STUCK_LOOP_REDIRECT: npm test has failed 3 times."
  - id: t-stuck-loop-other
    type: stuck
    match: "npm run lint"
    window_seconds: 900
    max_attempts: 3
    fingerprint: auto
    require_failure: true
    reset_on_success: true
    escalation:
      - at: 3
        action: redirect
        message: "STUCK_LOOP_REDIRECT_OTHER: npm run lint has failed 3 times."
`

let home = ''

/** One `keel hook claude-code` PreToolUse invocation — a brand-new OS process. */
function preToolUse(command: string, sessionId = 'persist-session') {
  return spawnSync(process.execPath, [CLI, 'hook', 'claude-code', '--cwd', home], {
    input: JSON.stringify({ tool_name: 'bash', tool_input: { command }, session_id: sessionId }),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
    timeout: 30000,
  })
}

/** One `keel hook claude-code` PostToolUse invocation — a SEPARATE, later OS process. */
function postToolUse(command: string, exitCode: number, sessionId = 'persist-session') {
  return spawnSync(process.execPath, [CLI, 'hook', 'claude-code', '--cwd', home], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'bash',
      tool_input: { command },
      tool_response: { exit_code: exitCode },
      session_id: sessionId,
    }),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
    timeout: 30000,
  })
}

describe('cross-process stuck-loop persistence (`keel hook claude-code`)', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'keel-stuckpersist-'))
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), RULES)
  })
  afterAll(() => rmSafe(home))

  it('THREE separately-spawned failing attempts of the same command accumulate across process boundaries, and the next fresh process redirects', () => {
    // Attempt 1: pre-check in a fresh process — no prior failures anywhere
    // yet, so this must allow (exit 0, non-blocking).
    const pre1 = preToolUse('npm test')
    expect(pre1.status, `pre1 stderr: ${pre1.stderr}`).toBe(0)

    // The command "runs" and fails; a SEPARATE, later process records that
    // outcome — exactly what a real host's PostToolUse hook does.
    const post1 = postToolUse('npm test', 1)
    expect(post1.status).toBe(0) // PostToolUse never blocks

    // Attempt 2: a THIRD distinct process. If StuckTracker were still
    // in-memory-only, this process's tracker would be empty and see zero
    // failures — the bug this suite exists to catch. With persistence
    // wired in, it must see the ONE failure process 1/2 already recorded,
    // still under the max_attempts:3 threshold, so still allow.
    const pre2 = preToolUse('npm test')
    expect(pre2.status, `pre2 stderr: ${pre2.stderr}`).toBe(0)

    const post2 = postToolUse('npm test', 1)
    expect(post2.status).toBe(0)

    // Attempt 3: fourth process. Two failures recorded so far (still < 3)
    // — must still allow, not redirect early.
    const pre3 = preToolUse('npm test')
    expect(pre3.status, `pre3 stderr: ${pre3.stderr}`).toBe(0)

    const post3 = postToolUse('npm test', 1)
    expect(post3.status).toBe(0)

    // The proof: a SIXTH, entirely fresh process, sharing nothing with any
    // of the five before it but this HOME directory (hence the same
    // PersistentStuckStore file on disk) and the cwd/session, now sees
    // count=3 — the escalation.at:3 threshold — and redirects. This is the
    // exact accumulated state a single long-lived tracker would have
    // reached; the only thing under test is that it survives process
    // death in between.
    const pre4 = preToolUse('npm test')
    expect(pre4.status, `pre4 should redirect (blocking); stdout: ${pre4.stdout} stderr: ${pre4.stderr}`).toBe(2)
    expect(pre4.stderr).toContain('STUCK_LOOP_REDIRECT')
  })

  it('bucket contamination: two DIFFERENT failing commands interleaved across processes do not share a fail-streak', () => {
    // Regression coverage for the bucketOf() fix at the cross-process
    // level (the in-process version lives in stuck.test.ts). Drive two
    // unrelated stuck-loop rules to the edge of their OWN thresholds,
    // interleaved process-by-process, and confirm neither bleeds into the
    // other's count.
    const session = 'contamination-session'

    // A: 1 failure, B: 1 failure, A: 1 failure, B: 1 failure — interleaved,
    // each in its own process. If A's bucket ever contaminated B's (or vice
    // versa), one of them would hit count=3 and redirect one attempt early.
    expect(preToolUse('npm test', session).status).toBe(0)
    expect(postToolUse('npm test', 1, session).status).toBe(0)

    expect(preToolUse('npm run lint', session).status).toBe(0)
    expect(postToolUse('npm run lint', 1, session).status).toBe(0)

    expect(preToolUse('npm test', session).status).toBe(0)
    expect(postToolUse('npm test', 1, session).status).toBe(0)

    expect(preToolUse('npm run lint', session).status).toBe(0)
    expect(postToolUse('npm run lint', 1, session).status).toBe(0)

    // Each command has now failed exactly twice — under its own threshold.
    // One more failure of EITHER should redirect only that command's rule,
    // not the other one's, and not before its own third failure.
    const preTestStillAllowed = preToolUse('npm test', session)
    expect(preTestStillAllowed.status, `npm test should still be allowed at 2 failures: ${preTestStillAllowed.stderr}`).toBe(0)
    const preLintStillAllowed = preToolUse('npm run lint', session)
    expect(preLintStillAllowed.status, `npm run lint should still be allowed at 2 failures: ${preLintStillAllowed.stderr}`).toBe(0)

    // Push "npm test" to its 3rd failure — only ITS bucket should escalate.
    expect(postToolUse('npm test', 1, session).status).toBe(0)
    const testRedirect = preToolUse('npm test', session)
    expect(testRedirect.status).toBe(2)
    expect(testRedirect.stderr).toContain('STUCK_LOOP_REDIRECT: npm test')

    // "npm run lint" is still only at 2 failures — must NOT have been
    // dragged along by "npm test"'s escalation.
    const lintStillAllowed = preToolUse('npm run lint', session)
    expect(lintStillAllowed.status, `lint bucket must be unaffected by npm test's escalation: ${lintStillAllowed.stderr}`).toBe(0)
  })
})
