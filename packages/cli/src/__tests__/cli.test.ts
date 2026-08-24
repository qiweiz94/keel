import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `check` now routes through the same EnforcementPipeline/.keel/rules.yaml
 * path as `keel hook`/`keel evaluate`/`keel daemon` (the legacy PolicyEngine
 * default policy no longer applies), so these tests need a real rules
 * fixture to evaluate against — same self-written fixture approach as
 * hook.test.ts's own TEST_RULES, curated to just the rules these tests
 * exercise rather than shelling out to the full `keel install` (which does
 * host-detection this fixture doesn't need).
 *
 * `no-destructive-commands` and `no-secrets-in-code` are pinned to
 * `level: protect` here — a deliberate DIVERGENCE from their real shipped
 * level (`protect` / `sprint` respectively, see install.ts) — so they block
 * on the very first match instead of warning once and blocking on the
 * repeat (dialAction()'s protect-floor rule in pipeline.ts). Every test
 * below shares one HOME/KEEL_STATE_DIR for the whole file (beforeAll, not
 * beforeEach), so a rule without that pin would warn on whichever test
 * happens to hit it first and only deny on a later repeat — an ordering
 * dependency the original PolicyEngine-backed tests never had to think
 * about, since it always blocked immediately with no warn-first grace.
 * `no-verify-bypass`/`broad-privilege-escalation` need no such pin: their
 * real shipped `action: warn` never escalates regardless of level (see
 * pipeline.ts's `enforcedAction()` — the warn-once-then-block ladder is
 * `deny`/`block`-only).
 */
const TEST_RULES = `version: 1
rules:
  - id: no-destructive-commands
    type: command
    match: "rm -rf /|rm -rf ~"
    action: deny
    level: protect
    message: "Destructive commands (including fork bombs) are blocked."

  - id: no-verify-bypass
    type: command
    match: "git commit.*--no-verify|git commit( [^ ]+)* -n( |$)"
    action: warn
    message: "AI agents must not bypass git hooks with --no-verify."

  - id: broad-privilege-escalation
    type: command
    match: "(?<![A-Za-z])sudo(?![A-Za-z])"
    action: warn
    message: "Broad privilege/ownership change (sudo, chmod -R, or chown -R) — double-check the scope."

  - id: no-secrets-in-code
    type: content
    patterns:
      - regex: "AKIA[0-9A-Z]{16}"
      - regex: "OPENAI_API_KEY="
    action: deny
    level: protect
    message: "Hardcoded credentials must not be written to files."
`

// Resolve from this file's own location, NOT process.cwd(). `npm test` runs
// vitest with cwd=packages/cli, where a cwd-relative path resolves to
// packages/cli/packages/cli/dist/... and every test fails on a missing binary.
const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')
let testDir: string
let tempHome: string

interface RunResult {
  stdout: string
  /** Process exit code. Non-zero is meaningful — do not discard it. */
  code: number
}

function run(args: string): RunResult {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      encoding: 'utf-8',
      cwd: testDir,
      timeout: 10000,
      // Isolate ~/.keel (state, rules, audit): several tests below run
      // `check --command "rm -rf /"` / `--no-verify` repeatedly to exercise
      // warn-then-deny escalation. Without an isolated HOME (and
      // KEEL_STATE_DIR, which state-manager.ts's stateDir() prefers over
      // the HOME-derived path — see the same isolation note in
      // hook.test.ts) those calls hit the developer's REAL
      // ~/.keel/state/deny-first-time.json and friends.
      env: {
        ...process.env,
        HOME: tempHome,
        KEEL_STATE_DIR: join(tempHome, '.keel', 'state'),
      },
    })
    return { stdout, code: 0 }
  } catch (err: any) {
    // execSync throws on non-zero exit; err.status carries the code.
    return { stdout: err.stdout || err.message, code: err.status ?? 1 }
  }
}

describe('CLI Integration', () => {
  beforeAll(() => {
    // Create temp git repo
    testDir = mkdtempSync(join(tmpdir(), 'keel-test-'))
    tempHome = mkdtempSync(join(tmpdir(), 'keel-test-home-'))
    execSync('git init', { cwd: testDir })
    execSync('git config user.email test@test.com', { cwd: testDir })
    execSync('git config user.name test', { cwd: testDir })

    mkdirSync(join(testDir, '.keel'), { recursive: true })
    writeFileSync(join(testDir, '.keel', 'rules.yaml'), TEST_RULES, 'utf-8')
  })

  afterAll(() => {
    rmSafe(testDir)
    rmSafe(tempHome)
  })

  it('shows version', () => {
    const { stdout: out } = run('--version')
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('init creates config and hooks', () => {
    const { stdout: out } = run('init --hooks')
    expect(out).toContain('Created .keel.yaml')
    expect(out).toContain('Installed git hooks')
    expect(existsSync(join(testDir, '.keel.yaml'))).toBe(true)
    expect(existsSync(join(testDir, '.git', 'hooks', 'pre-commit'))).toBe(true)
  })

  it('check --command blocks dangerous commands', () => {
    const { stdout: out } = run('check --command "rm -rf /"')
    expect(out).toContain('BLOCKED')
  })

  it('check --command warns (not blocks) on no-verify', () => {
    // Accepted severity change: no-verify-bypass ships at action: warn, not
    // deny/block — a genuinely broken hook needs an escape hatch. check.ts
    // used to hard-block this unconditionally via a check-local re-escalation
    // that no longer exists; it now reports whatever the rule itself says.
    const { stdout: out, code } = run('check --command "git commit --no-verify -m x"')
    expect(out).toContain('WARN')
    expect(out).not.toContain('BLOCKED')
    expect(code).toBe(0)
  })

  it('check --command warns (not blocks) on sudo', () => {
    // Accepted severity change: broad-privilege-escalation ships at action:
    // warn, not deny/block — sudo has too high a legitimate-use rate to
    // hard-block by default.
    const { stdout: out, code } = run('check --command "sudo rm file"')
    expect(out).toContain('WARN')
    expect(out).not.toContain('BLOCKED')
    expect(code).toBe(0)
  })

  it('check --command blocks pkill python', () => {
    const { stdout: out } = run('check --command "pkill -f python"')
    expect(out).toContain('BLOCKED')
  })

  it('check --command allows safe commands', () => {
    const { stdout: out } = run('check --command "npm install express"')
    expect(out).toContain('OK')
  })

  it('check --command blocks secret exposure', () => {
    const { stdout: out } = run(`check --command "echo \\$OPENAI_API_KEY"`)
    expect(out).toContain('BLOCKED')
  })

  it('check detects secrets in file', () => {
    // --write is required now: content-based secret scanning is write-side
    // only (matching every other host's read/write split) — a plain read
    // (no --write) no longer scans file content at all.
    writeFileSync(join(testDir, 'test.txt'), 'OPENAI_API_KEY=sk-test123-test-test-test-abcdefgh', 'utf-8')
    const { stdout: out } = run('check test.txt --write')
    expect(out).toContain('BLOCKED')
  })

  // `keel audit`/`keel audit --json` render `.keel/audit/audit.log` — the
  // legacy PolicyEngine's own signed, hash-chained log (packages/core/src/
  // policy-engine.ts's private `audit()` method is its only writer; see
  // signing.ts/receipts.ts). `keel check` never fed this file after this
  // migration — but neither does `keel hook`/`keel evaluate`/`keel daemon`,
  // which never fed it either; they all write to the modern, unsigned
  // `AuditLog` (`~/.keel/traces/`, rendered by `keel enforce --audit`)
  // instead. `check` losing this write is consistency with the rest of the
  // platform, not a fresh regression. These two tests were only ever
  // exercising `auditCommand`'s own rendering, with `check` as an
  // incidental producer — seed the log file directly so that coverage
  // survives without depending on `check` to (no longer) write it.
  it('audit shows log', () => {
    mkdirSync(join(testDir, '.keel', 'audit'), { recursive: true })
    writeFileSync(
      join(testDir, '.keel', 'audit', 'audit.log'),
      JSON.stringify({ timestamp: new Date().toISOString(), action: 'block', rule_name: 'no-destructive-commands', tool_name: 'bash', message: 'Destructive commands are blocked.' }) + '\n',
      'utf-8',
    )
    const { stdout: out } = run('audit')
    expect(out).toContain('BLOCKED')
  })

  it('audit --json outputs JSON', () => {
    const { stdout: out } = run('audit --json')
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it('template lists available templates', () => {
    const { stdout: out } = run('template --list')
    expect(out).toContain('default')
    expect(out).toContain('strict')
    expect(out).toContain('minimal')
    expect(out).toContain('security')
  })

  it('rules atr imports ATR rules', () => {
    const { stdout: out } = run('rules atr')
    expect(out).toContain('ATR')
    expect(out).toContain('Prompt Injection')
  })

  it('scan detects tools', () => {
    const { stdout: out } = run('scan')
    expect(out).toContain('keel scan')
  })

  it('verify shows help with no args', () => {
    const { stdout: out } = run('verify')
    expect(out).toContain('receipt')
  })

  it('init idempotent when already exists', () => {
    const { stdout: out } = run('init')
    expect(out).toContain('already exists')
  })

  it('check --ci with no staged changes succeeds', () => {
    const { stdout: out, code } = run('check --ci')
    expect(out).toContain('No staged changes')
    expect(code).toBe(0)
  })

  // ---------------------------------------------------------------------
  // Exit-code contract.
  //
  // Every test above asserts only on stdout. That cannot detect a CLI that
  // prints the right words and returns the wrong status — which is exactly
  // how `check --ci` and the git hook it installs are consumed. The four
  // tests below assert the status itself.
  // ---------------------------------------------------------------------

  it('check --ci exits 0 when a benign staged file has no violations', () => {
    // A clean file that trips no rule. Only a `block` should fail CI —
    // an advisory warning must not, or every commit is rejected.
    writeFileSync(join(testDir, 'benign.txt'), 'just some ordinary text\n', 'utf-8')
    execSync('git add benign.txt', { cwd: testDir })
    const { stdout: out, code } = run('check --ci')
    expect(out).not.toContain('BLOCKED')
    expect(code).toBe(0)
  })

  it('check --ci exits non-zero when a staged file contains a secret', () => {
    // The other half of the contract: a real violation must fail CI.
    writeFileSync(join(testDir, 'leak.txt'), 'AKIAIOSFODNN7EXAMPLE\n', 'utf-8')
    execSync('git add leak.txt', { cwd: testDir })
    const { stdout: out, code } = run('check --ci')
    expect(out).toContain('BLOCKED')
    expect(code).not.toBe(0)
    execSync('git reset leak.txt', { cwd: testDir })
  })

  it('check --command exits non-zero on a blocked command', () => {
    // Callers that key on exit status (CI steps, wrapper scripts, hooks)
    // currently see success for a blocked command.
    const { stdout: out, code } = run('check --command "rm -rf /"')
    expect(out).toContain('BLOCKED')
    expect(code).not.toBe(0)
  })

  it('check --command warns on --no-verify given after other flags', () => {
    // `git commit -n` is still caught when `-n` trails other flags — and,
    // per the accepted severity change, warns rather than blocks.
    const { stdout: out, code } = run('check --command "git commit -m msg -n"')
    expect(out).toContain('WARN')
    expect(code).toBe(0)
  })
})
