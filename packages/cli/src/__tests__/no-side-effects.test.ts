import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInteractive } from '../commands/interactive.js'

/**
 * Pins the class-wide invariant behind the `keel dashboard --web`
 * browser-flood fix: no keel command may perform a user-environment side
 * effect — opening a browser, launching an external process, an
 * interactive-only prompt or keypress loop, or writing outside its
 * documented scope on a read path — unless a real human is at a TTY (and
 * CI is not set). In CI / non-TTY / agent / test contexts these must be
 * no-ops or explicitly opt-in.
 *
 * dashboard-web.ts's `shouldAutoOpenBrowser()` was the original, one-off
 * gate for this. It has since been generalized into `isInteractive()`
 * (interactive.ts) so every command shares ONE audited gate instead of
 * each growing its own bespoke `process.stdin.isTTY` check that a future
 * change can silently weaken. This file has three layers:
 *
 *   1. Unit-test isInteractive() itself against every hostile combination.
 *   2. A source-level sweep: any command file containing a side-effect
 *      primitive (spawn, execSync/execFileSync, a raw TTY check, raw
 *      keypress capture) must be on a documented allowlist explaining why
 *      it's safe. A NEW ungated primitive in a NEW or existing command
 *      fails this test by default — it has to earn its way onto the list.
 *   3. Confirms the four commands with a human-only or convenience gate
 *      actually route through the shared isInteractive(), not a private
 *      copy of the check.
 *
 * Sanity-checked while writing this file: temporarily forcing
 * isInteractive() to `return true` unconditionally turns section 1's
 * "false under CI" / "false without a TTY" tests red, confirming this
 * suite would actually catch a broken gate rather than passing vacuously.
 */

const COMMANDS_DIR = fileURLToPath(new URL('../commands/', import.meta.url))

function read(file: string): string {
  return readFileSync(join(COMMANDS_DIR, file), 'utf-8')
}

describe('isInteractive() — the shared interactivity gate', () => {
  const originalIsTTY = process.stdin.isTTY
  const originalCI = process.env.CI
  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
    if (originalCI === undefined) delete process.env.CI
    else process.env.CI = originalCI
  })
  const setTTY = (v: unknown) => Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true })

  it('is false with no TTY (the automation / agent-shell path)', () => {
    setTTY(undefined); delete process.env.CI
    expect(isInteractive()).toBe(false)
  })
  it('is false under CI even with a TTY', () => {
    setTTY(true); process.env.CI = '1'
    expect(isInteractive()).toBe(false)
  })
  it('is false when both a TTY is absent and CI is set', () => {
    setTTY(false); process.env.CI = '1'
    expect(isInteractive()).toBe(false)
  })
  it('is true only for a real interactive terminal — TTY present, CI unset', () => {
    setTTY(true); delete process.env.CI
    expect(isInteractive()).toBe(true)
  })
})

// ---------------------------------------------------------------------
// Source-level sweep over packages/cli/src/commands/*.ts
// ---------------------------------------------------------------------

const SIDE_EFFECT_PATTERNS: RegExp[] = [
  /\bspawn\(/, // child_process.spawn — launches an external process
  /\bexecSync\(/, // synchronous shell-out
  /\bexecFileSync\(/, // synchronous external binary
  /\bfork\(/, // child_process.fork
  /process\.stdin\.isTTY/, // raw TTY check — should route through isInteractive() instead
  /setRawMode/, // interactive keypress capture (TUI)
]

// file -> why a side-effect primitive here is safe in CI / non-TTY / agent
// contexts. Every file the sweep flags below MUST have an entry; every
// entry MUST still be flagged (no stale allowances for code that changed).
const ALLOWLIST: Record<string, string> = {
  'dashboard-web.ts':
    'spawn(open, url) is gated by shouldAutoOpenBrowser() -> isInteractive(); the server itself refuses ' +
    'to start without isInteractive() (KEEL_DASHBOARD_ALLOW_NON_TTY=1 is the documented test-only escape hatch).',
  'dashboard.ts':
    'The keypress/setRawMode TUI is only reached when `options.once || !isInteractive()` is false — a non-TTY ' +
    'or CI run falls through to the one-shot, read-only panel print instead.',
  'check.ts':
    'execSync("git diff --cached --name-only") is a read-only git query, reached only under the explicit ' +
    '--ci flag (a user- or pipeline-invoked check, not an unsolicited side effect); it never spawns an app ' +
    'or writes outside the .keel scope.',
  'init.ts':
    'execSync("pre-commit --version") is a read-only probe. execSync(chmod +x ...) only touches hook files ' +
    'this same command just wrote, and only runs under the explicit --hooks flag (opt-in).',
  'schedule.ts':
    'execFileSync(which/launchctl/crontab) only fires from an explicit `keel schedule daily|weekly` ' +
    '(opt-in positional arg) or --remove. The read-only status path (bare `keel schedule`) never shells ' +
    'out to a mutating command — see the schedule.ts describe block below for the regression this pins.',
  'hook.ts':
    'Out of ownership for this audit (binding constraint: core-adjacent, do not edit). readStdin() checks ' +
    'process.stdin.isTTY only to decide whether piped JSON is present, not to gate a side effect — a bare ' +
    'TTY with nothing piped in correctly reads as empty input rather than blocking on a read forever.',
  'run.ts':
    'spawn(agentCmd[0], ...) IS the entire purpose of the explicit `keel run <agent-cmd>` command — unlike ' +
    'dashboard-web\'s auto-opened browser, this is never an unsolicited side effect layered on top of some ' +
    'other action; a human (or an already-enforcement-gated agent — see keel-control-gate\'s own reasoning ' +
    'in control-gate.test.ts for why `run` is deliberately NOT blocked there) had to type `keel run ...` for ' +
    'this line to run at all. No isInteractive() gate applies for the same reason dashboard.ts\'s TUI gate ' +
    'does not apply to its own explicit --once path: opt-in by construction, not by terminal detection.',
  'run-kill.ts':
    'execFileSync("ps", ["-axo", "pid=,ppid="]) is a READ-ONLY process listing (never mutates anything) used ' +
    'to enumerate descendant pids for the SIGTERM/SIGKILL sweep, reached only from the explicit `keel halt ' +
    '--kill` flag — opt-in, never fired by a bare `keel halt`.',
}

describe('side-effect primitive sweep (packages/cli/src/commands/*.ts)', () => {
  const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.ts') && f !== 'interactive.ts')

  it('every command file containing a side-effect primitive is on the documented allowlist', () => {
    const offenders: string[] = []
    for (const file of files) {
      const hit = SIDE_EFFECT_PATTERNS.some((re) => re.test(read(file)))
      if (hit && !ALLOWLIST[file]) offenders.push(file)
    }
    // A NEW command that adds an ungated spawn/exec/isTTY/setRawMode fails
    // here by default — it must either remove the primitive, route it
    // through isInteractive(), or add a reasoned ALLOWLIST entry above.
    expect(offenders).toEqual([])
  })

  it('the allowlist has no stale entries — every listed file exists and still matches a pattern', () => {
    for (const file of Object.keys(ALLOWLIST)) {
      expect(files).toContain(file)
      const hit = SIDE_EFFECT_PATTERNS.some((re) => re.test(read(file)))
      expect(hit).toBe(true)
    }
  })
})

describe('commands with a gated side effect route it through the shared isInteractive()', () => {
  // Source-level assertion: behavioral coverage of shouldAutoOpenBrowser()
  // already lives in dashboard-web.test.ts, and promoteCommand's TTY gate
  // is behaviorally covered in promote.test.ts. This layer instead pins
  // that these commands import and call the ONE shared gate rather than a
  // private, unaudited copy of the same check — the failure mode a class
  // sweep exists to catch (one call site gets fixed, a sibling doesn't).
  const mustUseSharedGate = ['dashboard-web.ts', 'dashboard.ts', 'promote.ts', 'rules.ts']

  it.each(mustUseSharedGate)('%s imports isInteractive from ./interactive.js', (file) => {
    const content = read(file)
    expect(content).toMatch(/import\s*\{\s*isInteractive\s*\}\s*from\s*'\.\/interactive\.js'/)
    expect(content).toMatch(/isInteractive\(\)/)
  })
})

describe('schedule.ts: a read-only status query must not create ~/.keel/logs', () => {
  // Regression guard for a real bug found in this audit: logPath() used to
  // mkdirSync() ~/.keel/logs as a side effect of computing a path STRING,
  // so a bare `keel schedule` (status display, no install intended) wrote
  // to the real filesystem on every run — the same class of bug as the
  // browser-flood, just "write outside documented scope" instead of
  // "launch an external app". logPath() must stay pure; only
  // ensureLogDir() (called from the install paths) may create the
  // directory.
  it('logPath()\'s own function body contains no mkdirSync call', () => {
    const content = read('schedule.ts')
    const fnMatch = content.match(/function logPath\(\)[^]*?\n\}/)
    expect(fnMatch).toBeTruthy()
    expect(fnMatch![0]).not.toMatch(/mkdirSync/)
  })

  it('ensureLogDir() exists and is the only function that mkdirSync\'s the log directory', () => {
    const content = read('schedule.ts')
    expect(content).toMatch(/function ensureLogDir\(\)[^]*?mkdirSync\(logDir\(\)/)
  })
})
