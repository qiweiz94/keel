import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { describePosixShim } from './helpers/platform.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { hookVerdict } from '../commands/hook.js'

/**
 * v0.4 M1/A3 — the fail-closed audit lane.
 *
 * keel's entire value proposition is "the agent can't ignore it." That
 * breaks the moment an internal keel failure reads to the host as
 * permission to proceed. This suite enumerates every place `keel hook
 * <host>` could plausibly fail OPEN (a call sails through) instead of
 * CLOSED (the host sees a block, or at minimum a loud, unambiguous error —
 * never a silent exit-0 allow) and proves each one, end to end, through the
 * REAL built CLI (`dist/index.js`) — the same binary a host actually
 * spawns. One case (the stdin-stream-error regression below) uses the
 * exported `hookVerdict` directly instead: it is the only deterministic way
 * to simulate a stream error without depending on OS pipe-error timing, and
 * it is a pure function with no `process.exit` to fight — see its own
 * header comment in hook.ts for why that split exists.
 *
 * Every temp HOME/KEEL_STATE_DIR below is unique per test file (mkdtemp) —
 * never the real ~/.keel.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js')

function runHook(
  host: string,
  home: string,
  input: string,
  extraEnv: Record<string, string> = {},
) {
  // `--cwd <home>` pins the project-scope rule lookup (`loadRuleHierarchy`
  // reads `<cwd>/.keel/rules.yaml`, `<cwd>/AGENTS.md`, `<cwd>/CLAUDE.md`) to
  // the same temp dir as HOME's global scope, instead of letting the child
  // inherit this process's real cwd (`packages/cli`). Without this, these
  // tests were only hermetic by accident — correct today because
  // packages/cli has no AGENTS.md/CLAUDE.md/.keel/rules.yaml of its own,
  // but silently wrong the moment a sibling lane adds one.
  const result = spawnSync(process.execPath, [CLI, 'hook', host, '--cwd', home], {
    input,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, KEEL_STATE_DIR: join(home, '.keel', 'state'), ...extraEnv },
    timeout: 30_000,
  })
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function tempHome(rulesYaml?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'keel-failclosed-'))
  if (rulesYaml !== undefined) {
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), rulesYaml, 'utf-8')
  }
  return home
}

const homes: string[] = []
function newHome(rulesYaml?: string): string {
  const h = tempHome(rulesYaml)
  homes.push(h)
  return h
}

afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

describePosixShim('fail-closed: real built CLI, real error paths', () => {
  describe('(b) a rules file that fails to parse', () => {
    // Deliberately unterminated flow sequence — a real typo shape, not a
    // contrived edge case.
    const home = newHome('not: [valid yaml\nrules: []\n')

    it('claude-code: exits 2 (blocked), never a silent exit 0', () => {
      const r = runHook('claude-code', home, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('Keel could not evaluate')
      expect(r.stderr.toLowerCase()).toContain('keel validate')
    })

    it('cursor: denies via the stdout envelope, not a silent allow', () => {
      const r = runHook('cursor', home, JSON.stringify({ command: 'ls -la' }))
      const payload = JSON.parse(r.stdout)
      expect(payload.permission).toBe('deny')
      expect(payload.userMessage).toContain('Keel could not evaluate')
    })

    it('generic: exits 2, the same fail-closed floor as the exit-code hosts', () => {
      const r = runHook('generic', home, JSON.stringify({ tool: 'bash', args: { command: 'ls -la' } }))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('Keel could not evaluate')
    })

    it('SECURITY.md verification: cold-start `keel hook` has no prior state to fall back to — every call blocks (stronger than "last-known-good", not the same claim)', () => {
      // checkRuleVersion()'s last-known-good behavior in pipeline.ts is real
      // (verified separately, see EVIDENCE), but it only matters for a
      // LONG-LIVED pipeline (the daemon / opencode plugin) that already
      // loaded a good hierarchy before the file went bad. `keel hook` is a
      // fresh process per call — initEnforce() throws on the very first
      // load, with nothing to fall back to — so a typo wedges every call
      // until the file is fixed, not just the one that introduced it.
      const first = runHook('claude-code', home, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }))
      const second = runHook('claude-code', home, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }))
      expect(first.status).toBe(2)
      expect(second.status).toBe(2)
    })
  })

  describe('(c) formerly an exception thrown mid-evaluation, now closed at load time', () => {
    // `unless[].regex` (KeelRule.unless, used at pipeline.ts:631 via a bare
    // `new RegExp(u.regex, 'i')`) used to be the one pattern field
    // rule-parser.ts's validateRules() did NOT check for regex validity
    // (match/match_regex/unless_reasoning/steps/trigger/satisfy/boundaries
    // patterns all were). A rule with an invalid `unless[].regex` used to
    // LOAD successfully and only throw once a call reached line 631, i.e.
    // once `rule.match` actually matched — a genuine mid-evaluation throw,
    // distinct from (b)'s load-time rejection. That gap is now closed
    // (rule-parser.ts's pattern-validity loop includes `...(rule.unless ||
    // []).map(u => u.regex)`), so this scenario is now case (b): the whole
    // rules file is rejected at load, before any command is evaluated —
    // stronger, not weaker, since a non-matching command is now ALSO
    // blocked instead of sailing through on a silently-broken rule.
    const home = newHome(`version: 1
level: protect
rules:
  - id: t-broken-unless
    type: command
    match: "rm -rf /tmp/keel-fail-closed-marker"
    action: deny
    level: sprint
    message: "test marker command blocked"
    unless:
      - regex: "(unclosed"
`)

    it('rejected at load — even a non-matching command is blocked (this is now case (b), not a mid-eval throw)', () => {
      const r = runHook('claude-code', home, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('Keel could not evaluate')
    })

    it('claude-code: a matching command is blocked the same way — exit 2, COULD_NOT_EVALUATE (not "Invalid Keel rules")', () => {
      const r = runHook('claude-code', home, JSON.stringify({
        tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/keel-fail-closed-marker' },
      }))
      expect(r.status).toBe(2)
      // The discriminator: COULD_NOT_EVALUATE proves the rules file loaded
      // and the throw happened AT EVALUATION TIME. "Invalid Keel rules"
      // would mean validateRules caught it at load time instead — that
      // would be case (b), not this one.
      expect(r.stderr).toContain('Keel could not evaluate')
      expect(r.stderr).not.toContain('Invalid Keel rules')
    })

    it('cline: cancels on the same matching command, via the stdout HOOK_CONTROL envelope', () => {
      const r = runHook('cline', home, JSON.stringify({
        preToolUse: { toolName: 'bash', parameters: { command: 'rm -rf /tmp/keel-fail-closed-marker' } },
      }))
      expect(r.stdout).toContain('HOOK_CONTROL')
      const control = JSON.parse(r.stdout.replace(/^HOOK_CONTROL\t/, '').trim())
      expect(control.cancel).toBe(true)
    })
  })

  describe('(d) a missing/corrupt state dir', () => {
    // KEEL_STATE_DIR points at a plain FILE, not a directory — mkdirSync
    // inside StateManager fails, and its own catch swallows that (state
    // persistence is best-effort, documented as "non-critical" in
    // state-manager.ts). The base command-match decision does not depend
    // on state, so this must still block — proving state corruption cannot
    // be used to defeat a `deny` rule, only to reset ESCALATION counters.
    const home = tempHome(`version: 1
level: protect
rules:
  - id: t-state-corrupt
    type: command
    match: "rm -rf /tmp/keel-state-corrupt-marker"
    action: deny
    level: sprint
    message: "blocked despite corrupt state dir"
`)
    afterAll(() => rmSync(home, { recursive: true, force: true }))
    const stateDirAsFile = join(home, 'not-a-directory')
    beforeAll(() => writeFileSync(stateDirAsFile, 'this is a file, not a directory', 'utf-8'))

    it('still blocks a matching command — state corruption does not silently disable rule matching', () => {
      const r = runHook('claude-code', home, JSON.stringify({
        tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/keel-state-corrupt-marker' },
      }), { KEEL_STATE_DIR: stateDirAsFile })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('blocked despite corrupt state dir')
    })
  })

  describe('(e) an unknown host name', () => {
    // Not one of HOSTS — hookCommand/hookVerdict fall back to 'generic'
    // parsing rather than skipping enforcement or crashing.
    const home = newHome(`version: 1
level: protect
rules:
  - id: t-unknown-host
    type: command
    match: "rm -rf /tmp/keel-unknown-host-marker"
    action: deny
    level: sprint
    message: "blocked under an unrecognized host name"
`)

    it('falls back to generic parsing and still blocks a matching command', () => {
      const r = runHook('totally-not-a-real-host', home, JSON.stringify({
        tool: 'bash', args: { command: 'rm -rf /tmp/keel-unknown-host-marker' },
      }))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('blocked under an unrecognized host name')
    })

    it('still allows an ordinary command under the same unrecognized host — not an always-block bug', () => {
      const r = runHook('totally-not-a-real-host', home, JSON.stringify({ tool: 'bash', args: { command: 'ls -la' } }))
      expect(r.status).toBe(0)
    })
  })

  describe('(a) malformed/unparseable input JSON — documented graceful degrade, characterized here (not changed by this lane)', () => {
    // parsePayload() catches JSON.parse failures and degrades to an
    // `unknown` tool rather than throwing (hook.ts's own comment: "a hook
    // that crashes is a hook the host skips"). The invariant this lane
    // owns is narrower than "must block": it is "must not crash into an
    // undefined exit code" (exit 1, an uncaught-exception artifact, was the
    // real bug — fixed above). Whether an `unknown`-tool call then matches
    // some rule is a property of the loaded ruleset, not of this error
    // path, so this test only asserts the process produces a well-formed,
    // non-crash verdict.
    const home = newHome(`version: 1\nrules: []\n`)

    it('does not crash — produces a defined exit code, not the exit-1 signature of an uncaught exception', () => {
      const r = runHook('claude-code', home, 'not json at all {{{')
      expect([0, 2]).toContain(r.status)
      expect(r.stderr).not.toContain('at Object')   // no raw JS stack trace
      expect(r.stderr).not.toContain('Unhandled')
    })
  })

  describe('(a2) empty stdin — the highest-risk variant of (a): a MISCONFIGURED hook, not a garbled payload — FIXED in v1 M1r-2', () => {
    // A one-off malformed byte stream (above) is defensible degrade. A hook
    // wired to send NOTHING (empty stdin — e.g. a host integration bug that
    // never writes the payload) used to hit the `tool: 'unknown'`, empty-
    // args path on every single call, forever, evaluated as an ordinary
    // (if unmatched) call — no rule written for a SPECIFIC dangerous
    // command (real rules do not deny `.*`) can ever match a synthetic
    // `unknown` tool, so the call sailed through silently. v1 M1r-2 locked
    // the product decision that degenerate input (including this one) must
    // fail closed: parsePayload now marks this shape `degenerate: true`,
    // and hookVerdict renders it exactly like an internal keel failure
    // (block/deny/exit 2 per host) BEFORE it ever reaches rule evaluation,
    // rather than letting it match nothing.
    const home = newHome(`version: 1
level: protect
rules:
  - id: t-empty-stdin
    type: command
    match: "rm -rf /"
    action: deny
    level: sprint
    message: "would have blocked a real rm -rf /, had the payload survived"
`)

    it('empty stdin now fails CLOSED — exit 2, COULD_NOT_EVALUATE — instead of the silent allow this gap used to produce', () => {
      const r = runHook('claude-code', home, '')
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('Keel could not evaluate')
    })

    it('the SAME rule, same host, still blocks the normal way when the payload actually arrives — proves the fix did not turn matching into the ONLY path to a block', () => {
      const r = runHook('claude-code', home, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('would have blocked a real rm -rf /')
    })

    it('a non-empty, well-formed payload for an UNMATCHED command still allows — this is fail-closed on degenerate input, not fail-closed on everything', () => {
      const r = runHook('claude-code', home, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }))
      expect(r.status).toBe(0)
    })
  })

  describe('(a3) truncated TOOL_INPUT env var — the same silent-payload-loss class as (a2), through the OTHER input door — FIXED in v1 M1r-2', () => {
    // hookVerdict's env-var branch (claude-code/gemini with TOOL_NAME set —
    // the real contract `templates/claude-pretooluse.sh` uses, and the one
    // `hook.test.ts`/`hook-contract.test.ts` already drive) calls
    // safeJson(process.env.TOOL_INPUT). Truncated JSON used to silently
    // become `{}` with no trace of the loss — a payload that LOOKS
    // well-formed (a real tool name, empty args) is indistinguishable from
    // a genuine zero-arg call. safeJson() now reports `corrupt: true` when
    // TOOL_INPUT was PRESENT but failed to parse (an ABSENT TOOL_INPUT
    // stays non-degenerate — many real tools take no arguments, see the
    // next describe block), and hookVerdict marks the call degenerate on
    // that signal alone, failing it closed before evaluation.
    const home = newHome(`version: 1
level: protect
rules:
  - id: t-truncated-tool-input
    type: command
    match: "rm -rf /"
    action: deny
    level: sprint
    message: "would have blocked a real rm -rf /, had TOOL_INPUT survived"
`)

    it('a truncated TOOL_INPUT now fails CLOSED — exit 2, COULD_NOT_EVALUATE — instead of a payload that silently looked legitimate', () => {
      const r = runHook('claude-code', home, '', {
        TOOL_NAME: 'Bash',
        TOOL_INPUT: '{"command":"rm -rf /"',   // truncated mid-string — invalid JSON
      })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('Keel could not evaluate')
    })

    it('the SAME rule, same host, DOES block when TOOL_INPUT is complete — isolates the gap to "the value was truncated", not "the rule is broken"', () => {
      const r = runHook('claude-code', home, '', {
        TOOL_NAME: 'Bash',
        TOOL_INPUT: JSON.stringify({ command: 'rm -rf /' }),
      })
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('would have blocked a real rm -rf /')
    })
  })

  describe('(a4) TOOL_INPUT genuinely ABSENT (not truncated) — the deliberate line: missing args is legitimate, corrupt args is degenerate', () => {
    // A zero-argument tool call is a normal shape — TOOL_INPUT simply never
    // being set is not evidence of data loss the way a present-but-broken
    // value is. This proves the (a3) fix did not overreach into blocking
    // every call with no TOOL_INPUT.
    const home = newHome(`version: 1
level: protect
rules:
  - id: t-absent-tool-input
    type: command
    match: "rm -rf /"
    action: deny
    level: sprint
    message: "should not fire — command text was never rm -rf / here"
`)

    it('TOOL_NAME set, TOOL_INPUT entirely absent still allows — an empty-args call is legitimate, not degenerate', () => {
      const r = runHook('claude-code', home, '', { TOOL_NAME: 'Bash' })
      expect(r.status).toBe(0)
    })
  })

  describe('(a5) valid JSON, missing required tool-identity field — "unparseable" and "missing a required field" are different bugs and both must fail closed', () => {
    // (a)/(a2) cover JSON that does not parse at all. This is the other
    // half of the locked decision's list: the JSON parses FINE, but the one
    // field every rule matches against — the tool identity — is absent, so
    // there is nothing to evaluate. Exercised across every host's own
    // identity field (tool_name / tool / command|tool_name) to prove the
    // fix is uniform (toolField() in hook.ts), not a claude-code special
    // case.
    const home = newHome(`version: 1
level: protect
rules:
  - id: t-missing-identity
    type: command
    match: "rm -rf /"
    action: deny
    level: sprint
    message: "would have blocked a real rm -rf /, had the tool identity survived"
`)

    it('claude-code: tool_input present but tool_name absent — exit 2, COULD_NOT_EVALUATE', () => {
      const r = runHook('claude-code', home, JSON.stringify({ tool_input: { command: 'rm -rf /' } }))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('Keel could not evaluate')
    })

    it('claude-code: tool_name explicitly null — same as absent, still degenerate', () => {
      const r = runHook('claude-code', home, JSON.stringify({ tool_name: null, tool_input: { command: 'rm -rf /' } }))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('Keel could not evaluate')
    })

    it('generic: tool absent — exit 2, the same fail-closed floor as the exit-code hosts', () => {
      const r = runHook('generic', home, JSON.stringify({ args: { command: 'rm -rf /' } }))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('Keel could not evaluate')
    })

    it('cursor: neither `command` nor `tool_name` present — denies via the stdout envelope, not a silent allow', () => {
      const r = runHook('cursor', home, JSON.stringify({ tool_input: { x: 1 } }))
      const payload = JSON.parse(r.stdout)
      expect(payload.permission).toBe('deny')
      expect(payload.userMessage).toContain('Keel could not evaluate')
    })

    it('cursor: `command` present but BLANK — the literal "empty string" case from the locked decision\'s own list. Unlike every other host, command IS the identity here, not an optional argument alongside one — so a blank command is lost data, not a legitimate zero-arg call, and denies the same way', () => {
      const r = runHook('cursor', home, JSON.stringify({ command: '' }))
      const payload = JSON.parse(r.stdout)
      expect(payload.permission).toBe('deny')
      expect(payload.userMessage).toContain('Keel could not evaluate')
    })

    it('cline: preToolUse.toolName absent — cancels via the HOOK_CONTROL envelope', () => {
      const r = runHook('cline', home, JSON.stringify({ preToolUse: { parameters: { command: 'rm -rf /' } } }))
      const control = JSON.parse(r.stdout.replace(/^HOOK_CONTROL\t/, '').trim())
      expect(control.cancel).toBe(true)
    })

    it('the SAME rule, same host, still blocks the normal way once the tool identity is present — proves this is a degenerate-input guard, not a new global deny', () => {
      const r = runHook('claude-code', home, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }))
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('would have blocked a real rm -rf /')
    })
  })
})

describe('fail-closed: stdin stream error (deterministic, in-process)', () => {
  // The core bug this lane fixed: `readStdin()` and `parsePayload()` used
  // to run BEFORE hookCommand's only try/catch. A stream error out of
  // `for await (const chunk of process.stdin)` — a real host closing its
  // write end mid-read, an ECONNRESET, not a contrived case — escaped as an
  // unhandled promise rejection. `index.ts` calls `program.parse()`, not
  // `parseAsync`, so nothing awaits hookCommand's returned promise, and
  // Node's default unhandled-rejection behavior exits the process with
  // code 1. Every exit-code host in renderVerdict blocks ONLY on exit 2
  // (Codex's own docs: any OTHER non-zero code means "the hook failed,
  // continue") and the stdout-signaling hosts never got a stdout envelope
  // at all — a crash before evaluation began was a silent ALLOW.
  //
  // Reproduced empirically against the pre-fix build (git-stashed hook.ts,
  // rebuilt, driven with this exact fake stdin): exit code 1, uncaught
  // "Error: simulated ECONNRESET on stdin" — the fail-open. Against the
  // fix below: exit code 2, "Keel could not evaluate this action, so it
  // was blocked." See EVIDENCE for the full before/after transcript.
  //
  // This is an in-process test against the exported `hookVerdict` (not a
  // subprocess) because it is the only DETERMINISTIC way to simulate a
  // stream error — OS pipe-error timing from a parent process is not
  // reliable enough to assert on. No `process.exit` mocking: `hookVerdict`
  // is a pure function (see its header comment in hook.ts for why that
  // split exists), so this reads its return value directly, the same way
  // hook-command.test.ts already asserts on `renderVerdict`/`parsePayload`.
  let home = ''
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'keel-failclosed-stream-'))
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), 'version: 1\nrules: []\n', 'utf-8')
    process.env.HOME = home
    process.env.KEEL_STATE_DIR = join(home, '.keel', 'state')
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  function withThrowingStdin<T>(run: () => Promise<T>): Promise<T> {
    const real = Object.getOwnPropertyDescriptor(process, 'stdin')!
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: {
        isTTY: false,
        [Symbol.asyncIterator]() {
          return { next: () => Promise.reject(new Error('simulated ECONNRESET on stdin')) }
        },
      },
    })
    return run().finally(() => Object.defineProperty(process, 'stdin', real))
  }

  it('claude-code: a stdin stream error blocks (exit 2), never the exit-1 crash signature of an unhandled rejection', async () => {
    const verdict = await withThrowingStdin(() => hookVerdict('claude-code', {}))
    expect(verdict.blocked).toBe(true)
    expect(verdict.exitCode).toBe(2)
    expect(verdict.stderr).toContain('Keel could not evaluate')
  })

  it('cursor: the same stream error denies via the stdout envelope, not a silent allow', async () => {
    const verdict = await withThrowingStdin(() => hookVerdict('cursor', {}))
    expect(verdict.blocked).toBe(true)
    const payload = JSON.parse(verdict.stdout)
    expect(payload.permission).toBe('deny')
  })

  it('generic: exits 2 on the same stream error', async () => {
    const verdict = await withThrowingStdin(() => hookVerdict('generic', {}))
    expect(verdict.blocked).toBe(true)
    expect(verdict.exitCode).toBe(2)
  })
})
