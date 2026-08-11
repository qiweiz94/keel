import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateToolCall, initEnforce } from '../commands/enforce.js'

/**
 * `pipeline.ts`'s `checkRuleVersion()` keeps enforcing on the last-known-
 * good ruleset when a mid-session rules.yaml edit fails to validate (fail-
 * safe, correct) and calls `this.config.onRulesError?.(errors)` to say so
 * — but until now `packages/cli/src/commands/enforce.ts`'s `initEnforce()`
 * never passed `onRulesError` when constructing the `EnforcementPipeline`,
 * so for any process where the pipeline outlives a single call (`keel
 * test`, `keel allow`, an embedded/long-lived host — NOT `keel hook`,
 * which is fresh per call and never reaches this path, per session/v04/
 * EVIDENCE/a3-failclosed.md finding 3), a typo'd rules.yaml was silently
 * absorbed: correct behavior, zero signal. This asserts the callback now
 * fires (and lands on stderr) on an invalid reload, and stays silent on a
 * valid one.
 *
 * Isolation: HOME/KEEL_STATE_DIR point at a private temp dir so this never
 * touches the real ~/.keel; the project rules live under a separate temp
 * project dir, mutated in place to trigger `checkRuleVersion`'s file-hash
 * based reload.
 */

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'keel-rules-error-project-'))
}

describe('onRulesError surfaced from the CLI pipeline', () => {
  let tempHome: string
  let previousHome: string | undefined
  let previousStateDir: string | undefined

  beforeAll(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'keel-rules-error-home-'))
    previousHome = process.env.HOME
    previousStateDir = process.env.KEEL_STATE_DIR
    process.env.HOME = tempHome
    process.env.KEEL_STATE_DIR = join(tempHome, '.keel', 'state')
  })

  afterAll(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousStateDir === undefined) delete process.env.KEEL_STATE_DIR
    else process.env.KEEL_STATE_DIR = previousStateDir
    rmSync(tempHome, { recursive: true, force: true })
  })

  let errSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
  })

  it('surfaces validation errors on stderr when a mid-session reload is invalid, and keeps enforcing the last-known-good rule', async () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    const rulesPath = join(project, '.keel', 'rules.yaml')
    // `level: protect` makes this rule block-first (no warn-once grace —
    // see pipeline.ts's `blockFirst`), so a single call is enough to
    // observe 'deny' without needing a warm-up call to burn the first-
    // warning escalation.
    writeFileSync(rulesPath, `version: 1
rules:
  - id: last-known-good
    type: command
    match: "dangerous-command"
    level: protect
    action: deny
    message: "blocked"
`)
    initEnforce(project)

    // First call: hash matches what the pipeline was constructed with, no
    // reload attempted yet.
    const before = await evaluateToolCall('Bash', { command: 'dangerous-command' }, { cwd: project })
    expect(before.action).toBe('deny')
    expect(errSpy).not.toHaveBeenCalled()

    // Break the file: this must trigger a reload attempt on the next call.
    writeFileSync(rulesPath, 'version: 1\nrules: [broken\n')
    const during = await evaluateToolCall('Bash', { command: 'dangerous-command' }, { cwd: project })

    // Last-known-good: the previously-valid rule still fires.
    expect(during.action).toBe('deny')
    // And the failure is no longer silent.
    expect(errSpy).toHaveBeenCalled()
    const message = errSpy.mock.calls.map(call => String(call[0])).join('\n')
    expect(message).toContain('rules reload failed')
  })

  it('does not call onRulesError when a mid-session reload is valid', async () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    const rulesPath = join(project, '.keel', 'rules.yaml')
    writeFileSync(rulesPath, `version: 1
rules:
  - id: first-rule
    type: command
    match: "first-command"
    level: protect
    action: deny
    message: "blocked"
`)
    initEnforce(project)
    const before = await evaluateToolCall('Bash', { command: 'first-command' }, { cwd: project })
    expect(before.action).toBe('deny')
    expect(errSpy).not.toHaveBeenCalled()

    // A valid edit — a second rule added — must reload cleanly with no
    // error surfaced.
    writeFileSync(rulesPath, `version: 1
rules:
  - id: first-rule
    type: command
    match: "first-command"
    level: protect
    action: deny
    message: "blocked"
  - id: second-rule
    type: command
    match: "second-command"
    level: protect
    action: deny
    message: "also blocked"
`)
    const after = await evaluateToolCall('Bash', { command: 'second-command' }, { cwd: project })
    expect(after.action).toBe('deny')
    expect(errSpy).not.toHaveBeenCalled()
  })
})
