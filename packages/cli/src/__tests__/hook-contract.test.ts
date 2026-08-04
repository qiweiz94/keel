import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
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
 * Each host hook script, driven end-to-end through the REAL built CLI.
 *
 * The scripts are now one-liners that `exec keel hook <host>`, so a fake
 * keel would only prove the fake works. A shim puts the built dist on
 * PATH as `keel` and a private rules file supplies the verdicts, which
 * makes this an integration test of the whole chain: script -> keel hook
 * -> pipeline -> host-specific output.
 */
describePosixShim('host hook scripts (end-to-end)', () => {
  const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates')
  let shim = ''
  let hookHome = ''

  // A message with a quote in it: the sed-based scripts truncated this to
  // "Use \\" while still emitting valid JSON, so nothing ever failed.
  const QUOTED = 'Use "--force-with-lease" instead of --force.'

  beforeAll(() => {
    shim = mkdtempSync(join(tmpdir(), 'keel-shim-'))
    writeFileSync(join(shim, 'keel'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 })

    hookHome = mkdtempSync(join(tmpdir(), 'keel-hookhome-'))
    mkdirSync(join(hookHome, '.keel'), { recursive: true })
    writeFileSync(join(hookHome, '.keel', 'rules.yaml'), `version: 1
level: protect
rules:
  - id: h-deny
    type: command
    match: "git push .*--force"
    action: deny
    level: sprint
    message: '${QUOTED}'
  - id: h-prompt
    type: command
    match: "git push .*(main|master)"
    action: prompt
    level: sprint
    message: "Approval required."
`)
  })
  afterAll(() => {
    rmSync(shim, { recursive: true, force: true })
    rmSync(hookHome, { recursive: true, force: true })
  })

  const run = (script: string, payload: string, env: Record<string, string> = {}) =>
    spawnSync('sh', [join(TEMPLATES, script)], {
      input: payload,
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, HOME: hookHome, ...env },
      timeout: 30000,
    })

  const DENY = 'git push --force origin release'   // matches h-deny only
  const OK = 'ls -la'

  it('cline: cancels on a blocking verdict and keeps the message intact', () => {
    const out = run('cline-pretooluse.sh',
      JSON.stringify({ preToolUse: { toolName: 'bash', parameters: { command: DENY } } })).stdout
    expect(out).toContain('HOOK_CONTROL')
    const control = JSON.parse(out.replace(/^HOOK_CONTROL\t/, '').trim())
    expect(control.cancel).toBe(true)
    // The regression: this used to arrive truncated at the first quote.
    expect(control.errorMessage).toContain(QUOTED)
  })

  it('cline: stays silent on an allowed call', () => {
    const out = run('cline-pretooluse.sh',
      JSON.stringify({ preToolUse: { toolName: 'bash', parameters: { command: OK } } })).stdout
    expect(out.trim()).toBe('')
  })

  it('cursor: denies with the full message, asks on prompt, allows otherwise', () => {
    const denied = JSON.parse(run('cursor-beforeshellexecution.sh', JSON.stringify({ command: DENY })).stdout)
    expect(denied.permission).toBe('deny')
    expect(denied.userMessage).toContain(QUOTED)

    const gated = JSON.parse(run('cursor-beforeshellexecution.sh', JSON.stringify({ command: 'git push origin main' })).stdout)
    expect(gated.permission).toBe('ask')

    const allowed = JSON.parse(run('cursor-beforeshellexecution.sh', JSON.stringify({ command: OK })).stdout)
    expect(allowed.permission).toBe('allow')
  })

  it('codex: exits 2 on a blocking verdict, 0 otherwise', () => {
    const blocked = run('codex-pretooluse.sh', JSON.stringify({ tool_name: 'bash', tool_input: { command: DENY } }))
    expect(blocked.status).toBe(2)
    expect(blocked.stderr).toContain(QUOTED)

    expect(run('codex-pretooluse.sh',
      JSON.stringify({ tool_name: 'bash', tool_input: { command: OK } })).status).toBe(0)
  })

  it('claude code: reads the call from the environment and exits 2 when blocked', () => {
    const blocked = run('claude-pretooluse.sh', '', {
      TOOL_NAME: 'bash', TOOL_INPUT: JSON.stringify({ command: DENY }),
    })
    expect(blocked.status).toBe(2)
    expect(blocked.stderr).toContain(QUOTED)

    const allowed = run('claude-pretooluse.sh', '', {
      TOOL_NAME: 'bash', TOOL_INPUT: JSON.stringify({ command: OK }),
    })
    expect(allowed.status).toBe(0)
  })

  it('every host blocks an approval gate — the fail-open regression', () => {
    // `prompt` exited 0 before, so approval gates on destructive SQL,
    // protected-branch pushes and publishing were all no-ops.
    const gate = 'git push origin main'
    expect(run('codex-pretooluse.sh',
      JSON.stringify({ tool_name: 'bash', tool_input: { command: gate } })).status).toBe(2)
    const cline = run('cline-pretooluse.sh',
      JSON.stringify({ preToolUse: { toolName: 'bash', parameters: { command: gate } } })).stdout
    expect(cline).toContain('"cancel":true')
  })
})
