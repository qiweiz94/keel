import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * The exit-code contract every shell hook depends on.
 *
 * `keel evaluate` used to exit 1 only for deny/block, so `prompt` — which
 * means "blocked, needs `keel allow <id> --once`" — exited 0 and the
 * Claude Code hook let it straight through. Five real rules are `prompt`:
 * no-db-destructive, no-push-to-main, no-remote-exec, git-history-rewrite,
 * publish-gate. Destructive SQL, protected-branch pushes, remote code
 * execution, history rewrites and publishing were all unenforced.
 *
 * These run the built CLI against a private rules file and HOME, so they
 * assert the contract a hook actually sees, and never touch ~/.keel.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js')

let home = ''

// The dial is `protect` so a deny blocks on the FIRST hit. At balanced,
// keel's warn-once-then-block ladder returns `warn` for the first
// violation — correct behaviour, but it would make this suite depend on
// persisted escalation state and pass or fail by run order.
const RULES = `version: 1
level: protect
rules:
  - id: t-deny
    type: command
    match: "rm -rf /"
    action: deny
    level: sprint
    message: "Destructive."
  - id: t-prompt
    type: command
    match: "git push .*(main|master)"
    action: prompt
    level: sprint
    message: "Approval required."
  - id: t-warn
    type: command
    match: "echo warnme"
    action: warn
    level: sprint
    message: "Just a warning."
`

function evaluate(command: string) {
  const result = spawnSync(process.execPath, [
    CLI, 'evaluate', '--tool', 'bash',
    '--args', JSON.stringify({ command }),
    '--agent', 'hook-contract-test',
    '--cwd', home,
  ], { encoding: 'utf-8', env: { ...process.env, HOME: home }, timeout: 30000 })
  return { status: result.status, out: result.stdout || '' }
}

describe('keel evaluate exit-code contract', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'keel-hookcontract-'))
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), RULES)
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('exits non-zero for a deny verdict', () => {
    const { status, out } = evaluate('rm -rf /')
    expect(out).toContain('"action":"deny"')
    expect(status).not.toBe(0)
  })

  it('exits non-zero for a PROMPT verdict — an approval gate must block', () => {
    // The regression. `prompt` blocks in keel's semantics; exiting 0 made
    // every approval gate a no-op in every shell-hook integration.
    const { status, out } = evaluate('git push --force origin main')
    expect(out).toContain('"action":"prompt"')
    expect(status).not.toBe(0)
  })

  it('exits 0 for a warn verdict — advisory must not start blocking', () => {
    // The other direction. "Blocks everything" is as bad as "blocks
    // nothing": it is what gets a guardrail uninstalled.
    const { status, out } = evaluate('echo warnme')
    expect(out).toContain('"action":"warn"')
    expect(status).toBe(0)
  })

  it('exits 0 for an ordinary allowed command', () => {
    const { status } = evaluate('ls -la')
    expect(status).toBe(0)
  })
})

/**
 * Each host hook, driven with a fake `keel` on PATH that returns a chosen
 * verdict. This is the only way to assert the host-specific output shape
 * without installing four agents: what matters is that a blocking verdict
 * produces that host's block, and an advisory one does not.
 */
describe('host hook scripts', () => {
  const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates')
  let bin = ''

  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'keel-fakebin-'))
    writeFileSync(join(bin, 'keel'), `#!/bin/sh
A="\${KEEL_FAKE_ACTION:-allow}"
printf '{"action":"%s","rule_id":"r1","message":"test message"}\\n' "$A"
case "$A" in deny|block|prompt|redirect|research) exit 1 ;; error) exit 2 ;; *) exit 0 ;; esac
`, { mode: 0o755 })
  })
  afterAll(() => rmSync(bin, { recursive: true, force: true }))

  const run = (script: string, action: string, payload: string) =>
    spawnSync('sh', [join(TEMPLATES, script)], {
      input: payload,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KEEL_FAKE_ACTION: action },
      timeout: 30000,
    })

  const CLINE_PAYLOAD = JSON.stringify({ preToolUse: { toolName: 'bash', parameters: { command: 'rm -rf /' } } })
  const CURSOR_PAYLOAD = JSON.stringify({ command: 'rm -rf /', cwd: '/tmp' })
  const CODEX_PAYLOAD = JSON.stringify({ tool_name: 'bash', tool_input: { command: 'rm -rf /' } })

  it('cline: cancels on every blocking verdict, stays silent otherwise', () => {
    // Contract from the installed @cline/core: a "HOOK_CONTROL<TAB>{json}"
    // line on stdout, where cancel:true stops the call.
    for (const action of ['deny', 'block', 'prompt', 'redirect', 'research']) {
      const out = run('cline-pretooluse.sh', action, CLINE_PAYLOAD).stdout
      expect(out).toContain('HOOK_CONTROL')
      expect(out).toContain('"cancel":true')
    }
    // Advisory verdicts must emit no control output at all.
    for (const action of ['allow', 'warn']) {
      expect(run('cline-pretooluse.sh', action, CLINE_PAYLOAD).stdout.trim()).toBe('')
    }
    // A keel that cannot start must fail CLOSED, not wave the call through.
    expect(run('cline-pretooluse.sh', 'error', CLINE_PAYLOAD).stdout).toContain('"cancel":true')
  })

  it('cursor: denies on block, asks on prompt, allows otherwise', () => {
    const permission = (action: string) =>
      JSON.parse(run('cursor-beforeshellexecution.sh', action, CURSOR_PAYLOAD).stdout).permission

    expect(permission('deny')).toBe('deny')
    expect(permission('redirect')).toBe('deny')
    // `ask` routes to Cursor's own approval UI — the closest match to
    // keel's `prompt`, and it still stops an unattended run.
    expect(permission('prompt')).toBe('ask')
    expect(permission('allow')).toBe('allow')
    expect(permission('warn')).toBe('allow')
    expect(permission('error')).toBe('deny')
  })

  it('codex: exits 2 on every blocking verdict, 0 otherwise', () => {
    // Codex blocks on exit 2 specifically; any other non-zero is treated
    // as "the hook failed" and execution continues.
    for (const action of ['deny', 'block', 'prompt', 'redirect', 'research', 'error']) {
      expect(run('codex-pretooluse.sh', action, CODEX_PAYLOAD).status).toBe(2)
    }
    for (const action of ['allow', 'warn']) {
      expect(run('codex-pretooluse.sh', action, CODEX_PAYLOAD).status).toBe(0)
    }
  })

  it('claude code: exits 2 on every blocking verdict, 0 otherwise', () => {
    const claude = (action: string) =>
      spawnSync('sh', [join(TEMPLATES, 'claude-pretooluse.sh')], {
        encoding: 'utf-8',
        env: {
          ...process.env, PATH: `${bin}:${process.env.PATH}`, KEEL_FAKE_ACTION: action,
          TOOL_NAME: 'bash', TOOL_INPUT: '{"command":"rm -rf /"}',
        },
        timeout: 30000,
      })
    // `prompt` is the regression: it used to exit 0 here and sail through.
    for (const action of ['deny', 'prompt', 'redirect', 'research', 'error']) {
      expect(claude(action).status).toBe(2)
    }
    expect(claude('allow').status).toBe(0)
    expect(claude('warn').status).toBe(0)
  })
})
