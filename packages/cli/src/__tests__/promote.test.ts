import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeRuleMode, promoteCommand } from '../commands/promote.js'
import { parseRulesContent, validateRules } from '../core/enforce/rule-parser.js'
import type { TraceEntry } from '../commands/retrospective.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `keel promote <rule-id>` advances a rule's `mode` one rung up the
 * observe → warn → block ladder — the payoff of the whole promotion
 * pipeline (retrospective's would-block rate feeds the human's decision,
 * this command is what they run once they've made it). Four properties
 * matter more than the happy path, the same three harness-append.test.ts
 * cares about for the sibling `--append` control surface, plus the
 * evidence gate this file adds:
 *   - it is idempotent (re-running with the same target is a no-op)
 *   - it never corrupts rules.yaml (comment-preserving, surgical)
 *   - it is human-only (TTY-gated, on the keel-control-gate deny list)
 *   - promoting FROM `mode: observe` requires the rule's measured
 *     would-block rate to actually clear `promotion_fp_threshold` — the
 *     same computePromotionReport() pipeline `keel retrospective` and
 *     `keel report` already surface — unless `--force` overrides it
 *
 * Isolation: KEEL_TRACES_DIR points at a private temp dir, and HOME/
 * KEEL_HOME point at an empty one with no `.keel/rules.yaml`, so this
 * suite's evidence checks are never accidentally satisfied (or
 * contradicted) by whatever real trace history or installed rules happen
 * to sit in the machine actually running this suite — the same isolation
 * allow.test.ts and level.test.ts already use, extended here to also
 * blind loadRuleHierarchy() to a real global/user rules.yaml, since
 * collectObserveRuleIds() (new to this test's dependency chain) reads
 * that too.
 */

// `promotion_fp_threshold: 0.5` (minEvaluations = ceil(1/0.5) = 2) keeps
// every evidence fixture below to a handful of synthetic trace entries
// instead of the real default's 1,000-evaluation floor — the default
// value itself is rule-parser.ts's own concern (DEFAULT_PROMOTION_FP_THRESHOLD),
// not something this file needs to re-verify.
const RULES_YAML = `# my rules file
# a leading comment that must survive
version: 1
level: balanced
promotion_fp_threshold: 0.5
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
let tracesDir: string
let homeDir: string
let previousHome: string | undefined
let previousKeelHome: string | undefined
let previousTracesDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-promote-'))
  mkdirSync(join(dir, '.keel'), { recursive: true })
  rulesPath = join(dir, '.keel', 'rules.yaml')
  writeFileSync(rulesPath, RULES_YAML, 'utf-8')

  tracesDir = mkdtempSync(join(tmpdir(), 'keel-promote-traces-'))
  homeDir = mkdtempSync(join(tmpdir(), 'keel-promote-home-'))
  previousHome = process.env.HOME
  previousKeelHome = process.env.KEEL_HOME
  previousTracesDir = process.env.KEEL_TRACES_DIR
  process.env.HOME = homeDir
  process.env.KEEL_HOME = homeDir
  process.env.KEEL_TRACES_DIR = tracesDir

  // Default seed: 2 evaluations (minEvaluations at threshold 0.5), 0
  // would-blocks — `no-repeat-loops` clears the bar out of the box, so
  // every PRE-EXISTING test below (TTY gate, ladder, idempotency) keeps
  // exercising exactly what it exercised before this file gained an
  // evidence gate, with no --force needed. The evidence-gate-specific
  // describe block below overwrites this per test as needed.
  seedObserveEvidence('no-repeat-loops', 2, 0)
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousKeelHome === undefined) delete process.env.KEEL_HOME
  else process.env.KEEL_HOME = previousKeelHome
  if (previousTracesDir === undefined) delete process.env.KEEL_TRACES_DIR
  else process.env.KEEL_TRACES_DIR = previousTracesDir
  rmSafe(dir)
  rmSafe(tracesDir)
  rmSafe(homeDir)
})

/**
 * Writes `total` synthetic `tool.execute.before` trace entries into
 * `tracesDir`, the first `wouldBlocks` of them recording `ruleId` as a
 * would-block observe-match (`observed_matches`, mirroring the real
 * plugin's shadow-record shape — see retrospective.test.ts/report.test.ts
 * for the same fixture convention) and the rest recording it as a
 * non-blocking `allow`. `cwd: dir` matches the project this rule's
 * rules.yaml lives in, so computePromotionReport's project-scoping
 * (this rule is `scoped: true`, declared in `dir/.keel/rules.yaml`)
 * actually counts them.
 */
function seedObserveEvidence(ruleId: string, total: number, wouldBlocks: number) {
  const lines: string[] = []
  for (let i = 0; i < total; i++) {
    const entry: TraceEntry = {
      t: 1_700_000_000_000 + i,
      agent: 'opencode-plugin',
      session_id: 's1',
      tool: 'Bash',
      args: { command: 'npm test' },
      rule_id: null,
      action: 'allow',
      hook: 'tool.execute.before',
      cwd: dir,
      observed_matches: [{ rule_id: ruleId, observed_action: i < wouldBlocks ? 'redirect' : 'allow' }],
    }
    lines.push(JSON.stringify(entry))
  }
  writeFileSync(join(tracesDir, 'evidence.jsonl'), lines.length ? lines.join('\n') + '\n' : '', 'utf-8')
}

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

describe('promoteCommand — evidence gate (promotion_fp_threshold, wired for the first time)', () => {
  const originalCI = process.env.CI
  let logSpy: string[] = []
  let originalLog: typeof console.log

  beforeEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    delete process.env.CI
    // A prior describe block's test (e.g. "refuses an unknown rule id")
    // can leave process.exitCode set to 1 with no afterEach that clears
    // it — reset here too, not just in this block's own afterEach, so
    // `expect(process.exitCode).toBe(1)` below actually proves THIS call
    // set it rather than reading a stale value left over from elsewhere.
    process.exitCode = undefined
    logSpy = []
    originalLog = console.log
    console.log = (...args: unknown[]) => { logSpy.push(args.map(String).join(' ')) }
  })
  afterEach(() => {
    console.log = originalLog
    if (originalCI === undefined) delete process.env.CI
    else process.env.CI = originalCI
    process.exitCode = undefined
  })

  it('blocks promotion when there is not enough recorded traffic yet (insufficient_data)', async () => {
    seedObserveEvidence('no-repeat-loops', 1, 0) // below minEvaluations (2) at threshold 0.5
    await promoteCommand('no-repeat-loops', { cwd: dir })

    expect(process.exitCode).toBe(1)
    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    expect(parsed.rules.find((r) => r.id === 'no-repeat-loops')?.mode).toBe('observe')
    const out = logSpy.join('\n')
    expect(out).toMatch(/not enough recorded hits/i)
    expect(out).toMatch(/keel retrospective/)
    expect(out).toMatch(/--force/)
  })

  it('blocks promotion when the measured false-positive rate has not cleared the threshold (stay_observe)', async () => {
    seedObserveEvidence('no-repeat-loops', 2, 1) // 2 evals, 1 would-block => rate 0.5, not < 0.5
    await promoteCommand('no-repeat-loops', { cwd: dir })

    expect(process.exitCode).toBe(1)
    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    expect(parsed.rules.find((r) => r.id === 'no-repeat-loops')?.mode).toBe('observe')
    const out = logSpy.join('\n')
    expect(out).toMatch(/false-positive.*rate/i)
    expect(out).toMatch(/promotion_fp_threshold/)
  })

  it('allows promotion with no --force once evidence clears the threshold (eligible)', async () => {
    seedObserveEvidence('no-repeat-loops', 2, 0) // 2 evals, 0 would-blocks => rate 0 < 0.5
    await promoteCommand('no-repeat-loops', { cwd: dir })

    expect(process.exitCode).toBeUndefined()
    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    expect(parsed.rules.find((r) => r.id === 'no-repeat-loops')?.mode).toBe('warn')
  })

  it('--force bypasses insufficient evidence, with a distinct honest warning instead of the earned-promotion message', async () => {
    seedObserveEvidence('no-repeat-loops', 0, 0) // zero traffic at all
    await promoteCommand('no-repeat-loops', { cwd: dir, force: true })

    expect(process.exitCode).toBeUndefined()
    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    expect(parsed.rules.find((r) => r.id === 'no-repeat-loops')?.mode).toBe('warn')
    const out = logSpy.join('\n')
    expect(out).toMatch(/forcing promotion without evidence/i)
    expect(out).toMatch(/may not be ready/i)
  })

  it('--force on a rule that already meets the bar does not print the forcing warning (it was never needed)', async () => {
    seedObserveEvidence('no-repeat-loops', 2, 0) // eligible on its own
    await promoteCommand('no-repeat-loops', { cwd: dir, force: true })

    expect(process.exitCode).toBeUndefined()
    const out = logSpy.join('\n')
    expect(out).not.toMatch(/forcing promotion without evidence/i)
  })

  it('does not gate warn -> block: no evidence pipeline exists for a real (non-shadow) enforcement rung', async () => {
    // Promote observe -> warn first (evidence clears), then warn -> block:
    // the second hop must never require evidence, since mode: warn is
    // real enforcement with no observed_matches stream to measure.
    seedObserveEvidence('no-repeat-loops', 2, 0)
    await promoteCommand('no-repeat-loops', { cwd: dir })
    expect(process.exitCode).toBeUndefined()

    // Zero remaining trace evidence — a naive gate keyed on rule id alone
    // (rather than "only when currentMode === observe") would block this.
    seedObserveEvidence('no-repeat-loops', 0, 0)
    await promoteCommand('no-repeat-loops', { cwd: dir })

    expect(process.exitCode).toBeUndefined()
    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    expect(parsed.rules.find((r) => r.id === 'no-repeat-loops')?.mode).toBe('block')
  })
})
