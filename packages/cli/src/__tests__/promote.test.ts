import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeRuleMode, promoteCommand } from '../commands/promote.js'
import { parseRulesContent, validateRules } from '../core/enforce/rule-parser.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `keel promote <rule-id>` advances a rule's `mode` one rung up the
 * observe → warn → block ladder — the payoff of the whole promotion
 * pipeline (retrospective's would-block rate feeds the human's decision,
 * this command is what they run once they've made it). Three properties
 * matter more than the happy path, the same three harness-append.test.ts
 * cares about for the sibling `--append` control surface:
 *   - it is idempotent (re-running with the same target is a no-op)
 *   - it never corrupts rules.yaml (comment-preserving, surgical)
 *   - it is human-only (TTY-gated, on the keel-control-gate deny list)
 */

const RULES_YAML = `# my rules file
# a leading comment that must survive
version: 1
level: balanced
rules:
  - id: keep-me
    type: command
    match: "x"
    action: warn
    message: "unrelated rule"

  - id: no-repeat-loops
    type: stuck
    match: "npm test"
    mode: observe
    # an inline comment on a field that must survive too
    window_seconds: 900
    action: warn
    message: "Identical failing command repeated."

  - id: already-block
    type: command
    match: "y"
    action: deny
    message: "no mode field at all — full enforcement by default"
`

let dir: string
let rulesPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-promote-'))
  mkdirSync(join(dir, '.keel'), { recursive: true })
  rulesPath = join(dir, '.keel', 'rules.yaml')
  writeFileSync(rulesPath, RULES_YAML, 'utf-8')
})

afterEach(() => {
  rmSafe(dir)
})

describe('writeRuleMode (surgical, comment-preserving rules.yaml writer)', () => {
  it('flips mode: observe -> warn for the target rule only, preserving comments and unrelated rules', () => {
    const result = writeRuleMode(rulesPath, 'no-repeat-loops', 'warn')
    expect(result?.previousMode).toBe('observe')
    expect(result?.newMode).toBe('warn')

    const written = readFileSync(rulesPath, 'utf-8')
    expect(written).toContain('# a leading comment that must survive')
    expect(written).toContain('# an inline comment on a field that must survive too')
    expect(written).toContain('mode: warn')
    expect(written).not.toContain('mode: observe')

    const parsed = parseRulesContent(written, rulesPath)
    expect(parsed.errors ?? []).toEqual([])
    expect(validateRules(parsed.rules)).toEqual([])
    expect(parsed.rules.find((r) => r.id === 'no-repeat-loops')?.mode).toBe('warn')
    // The unrelated rule (declared before the target in the file) must be
    // untouched — no field drift from a mis-scoped block boundary.
    const other = parsed.rules.find((r) => r.id === 'keep-me')
    expect(other?.action).toBe('warn')
    expect(other?.mode).toBeUndefined()
    // And the rule declared AFTER the target must also be untouched — the
    // block-end scanner must stop at the target's own boundary, not bleed
    // into the next list item.
    const after = parsed.rules.find((r) => r.id === 'already-block')
    expect(after?.mode).toBeUndefined()
    expect(after?.action).toBe('deny')
  })

  it('inserts a mode: field when the rule had none (full enforcement, mode absent)', () => {
    const result = writeRuleMode(rulesPath, 'already-block', 'warn')
    expect(result?.previousMode).toBeUndefined()
    expect(result?.newMode).toBe('warn')
    const written = readFileSync(rulesPath, 'utf-8')
    const parsed = parseRulesContent(written, rulesPath)
    expect(validateRules(parsed.rules)).toEqual([])
    expect(parsed.rules.find((r) => r.id === 'already-block')?.mode).toBe('warn')
  })

  it('is idempotent — writing the same mode twice produces a byte-identical file', () => {
    writeRuleMode(rulesPath, 'no-repeat-loops', 'warn')
    const once = readFileSync(rulesPath, 'utf-8')
    writeRuleMode(rulesPath, 'no-repeat-loops', 'warn')
    const twice = readFileSync(rulesPath, 'utf-8')
    expect(twice).toBe(once)
  })

  it('returns null (and touches nothing) for a rule id not present in the file', () => {
    const before = readFileSync(rulesPath, 'utf-8')
    const result = writeRuleMode(rulesPath, 'does-not-exist', 'warn')
    expect(result).toBeNull()
    expect(readFileSync(rulesPath, 'utf-8')).toBe(before)
  })
})

describe('promoteCommand — TTY gate (never auto-promotes, never agent-runnable)', () => {
  const originalIsTTY = process.stdin.isTTY
  const originalEnv = process.env.KEEL_ALLOW_NON_TTY
  const originalCI = process.env.CI
  let originalExitCode: number | undefined

  beforeEach(() => {
    originalExitCode = process.exitCode
    process.exitCode = undefined
    // promoteCommand's gate now runs through the shared isInteractive()
    // (TTY && !CI, see interactive.ts) instead of a bare TTY check. Pin the
    // ambient CI var so these tests read the same under a real CI runner
    // (where a TTY-mocking test SHOULD still behave the same as it does on
    // a developer's own machine) as they do locally — without this, a
    // "runs when stdin genuinely is a TTY" test would flip to blocked the
    // moment it runs under CI=1, which is exactly the silent, environment-
    // dependent flake this whole audit exists to prevent.
    delete process.env.CI
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
    if (originalEnv === undefined) delete process.env.KEEL_ALLOW_NON_TTY
    else process.env.KEEL_ALLOW_NON_TTY = originalEnv
    if (originalCI === undefined) delete process.env.CI
    else process.env.CI = originalCI
    process.exitCode = originalExitCode
  })

  it('refuses to run without a TTY and without the escape hatch — the file is untouched', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    delete process.env.KEEL_ALLOW_NON_TTY
    const before = readFileSync(rulesPath, 'utf-8')

    await promoteCommand('no-repeat-loops', { cwd: dir })

    expect(process.exitCode).toBe(1)
    expect(readFileSync(rulesPath, 'utf-8')).toBe(before)
  })

  it('runs when KEEL_ALLOW_NON_TTY=1 is set — the same documented escape hatch `keel rules harness --append` uses', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    process.env.KEEL_ALLOW_NON_TTY = '1'

    await promoteCommand('no-repeat-loops', { cwd: dir })

    expect(process.exitCode).toBeUndefined()
    const written = readFileSync(rulesPath, 'utf-8')
    expect(written).toContain('mode: warn')
  })

  it('runs when stdin genuinely is a TTY, with no escape hatch needed', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    delete process.env.KEEL_ALLOW_NON_TTY

    await promoteCommand('no-repeat-loops', { cwd: dir })

    expect(process.exitCode).toBeUndefined()
    expect(readFileSync(rulesPath, 'utf-8')).toContain('mode: warn')
  })
})

describe('promoteCommand — ladder + idempotency + error handling', () => {
  const originalCI = process.env.CI
  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    // See the TTY-gate describe block above: isInteractive() checks CI too.
    delete process.env.CI
  })
  afterEach(() => {
    if (originalCI === undefined) delete process.env.CI
    else process.env.CI = originalCI
  })

  it('advances observe -> warn by default (next rung), not straight to block', async () => {
    await promoteCommand('no-repeat-loops', { cwd: dir })
    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    expect(parsed.rules.find((r) => r.id === 'no-repeat-loops')?.mode).toBe('warn')
  })

  it('honors an explicit --to target, e.g. jumping straight to block', async () => {
    await promoteCommand('no-repeat-loops', { cwd: dir, to: 'block' })
    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    expect(parsed.rules.find((r) => r.id === 'no-repeat-loops')?.mode).toBe('block')
  })

  it('is idempotent at the command level too — promoting to the current mode is a no-op, not an error', async () => {
    await promoteCommand('no-repeat-loops', { cwd: dir, to: 'warn' })
    const once = readFileSync(rulesPath, 'utf-8')
    await promoteCommand('no-repeat-loops', { cwd: dir, to: 'warn' })
    expect(readFileSync(rulesPath, 'utf-8')).toBe(once)
    expect(process.exitCode).toBeUndefined()
  })

  it('refuses an unknown rule id rather than silently doing nothing', async () => {
    const before = readFileSync(rulesPath, 'utf-8')
    await promoteCommand('totally-unknown-rule', { cwd: dir })
    expect(process.exitCode).toBe(1)
    expect(readFileSync(rulesPath, 'utf-8')).toBe(before)
  })

  it('reports nothing to promote for a rule already at full enforcement (no mode field, no --to)', async () => {
    const before = readFileSync(rulesPath, 'utf-8')
    await promoteCommand('already-block', { cwd: dir })
    // No --to given and already-block has no `mode` (== full enforcement,
    // the top of the ladder) — nextMode() returns null, nothing to do.
    expect(readFileSync(rulesPath, 'utf-8')).toBe(before)
  })
})
