import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import { ProblemLedger } from '../problem-ledger.js'
import type { EnforceInput } from '../../types.js'

/**
 * Match-surface repair (Wave-1 Lane-1).
 *
 * Command-adjacent rules (`command`, `rate`, `diagnosis`, ...) match a rule's
 * `match` regex against a "haystack" built from the tool call. Building that
 * haystack from `JSON.stringify(input.args)` corrupts the match in two ways:
 *   1. JSON-escaping distorts the text a pattern targets (a literal `"` in
 *      the real command becomes `\"` in the haystack).
 *   2. End-of-string anchors (`$`) in a pattern can never match, because the
 *      JSON string always continues past the command with a closing quote
 *      and brace (`..."}`).
 *
 * `commandString` (arg-utils.ts) already extracts the real command text for
 * `type: command` matching (and for time/stuck/env/research). This suite:
 *   - locks in that `type: command` matching is correct for the standard
 *     shapes (characterization tests — these were already green);
 *   - adds coverage for a ONE-LEVEL-NESTED command shape that `commandString`
 *     did NOT previously handle outside the `mcp__` naming convention (this
 *     WAS red before the arg-utils.ts fix in this lane);
 *   - proves `type: rate` matching was using the raw JSON.stringify surface
 *     and silently failing to match anchored/quoted command patterns (RED
 *     before the pipeline.ts fix in this lane, GREEN after);
 *   - proves `type: diagnosis` matching keeps its existing content-matching
 *     behavior (it intentionally matches file CONTENT, not a command, so it
 *     must not be switched to commandString) while additively gaining the
 *     ability to match an anchored command pattern too.
 */

const SHIPPED_NO_DESTRUCTIVE_MATCH =
  'rm -rf /(?!tmp|var/tmp)|rm -rf ~|rm -rf [.]( |$)|rm -rf [.][.]( |/|$)|rm -rf [.][/](([*])?( |$))|rm -rf [*]( |$)|rm -rf /tmp/[^ ]*[.][.]([/ ]|$)|chmod -R 777 ([/~][^ ]*|[.])( |$)|mkfs[.0-9]*( |$)|mke2fs( |$)|shred( |$)|wipefs( |$)|blkdiscard( |$)|dd if=[^ ]+ of=/dev/[^ ]+'

// EnforcementPipeline defaults `overrideStore` to a FileRuleOverrideStore
// rooted at the real `homedir()` when none is supplied, and every deny/block
// verdict calls `overrideStore.consume()` — which touches real ~/.keel
// (mkdir + lock file) even when no override is ever armed. An in-memory
// stub keeps this suite's deny/prompt scenarios off the real filesystem.
const noopOverrideStore = { consume: () => false, peek: () => null, list: () => ({}) }

function makePipeline(yaml: string, ledger?: ProblemLedger): EnforcementPipeline {
  const rules = parseRulesContent(yaml, '/tmp/match-surface-rules.md')
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    overrideStore: noopOverrideStore,
    ruleHierarchy: { global: null, user: null, project: rules, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
    ledger,
  })
}

function input(tool: string, args: Record<string, unknown>, session = 'match-surface'): EnforceInput {
  return {
    tool,
    args,
    cwd: '/tmp',
    session_id: session,
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
  }
}

describe('command match surface (type: command)', () => {
  const rule = `version: 1
rules:
  - id: no-destructive-commands
    type: command
    match: "${SHIPPED_NO_DESTRUCTIVE_MATCH}"
    action: deny
    level: sprint
    message: "Destructive commands (including fork bombs) are blocked."
`

  // The pipeline dial (level: 'balanced' here) warns on the first hit of a
  // `deny` rule and blocks on the second (warn-once escalation) — this is
  // orthogonal to whether the pattern MATCHED, so a genuine match surfaces
  // as 'warn' then 'deny' across two calls in the same session, never
  // 'allow'. This helper isolates "did it match" from "warn vs deny".
  async function expectMatchAndBlock(pipeline: EnforcementPipeline, tool: string, args: Record<string, unknown>, session: string) {
    const first = await pipeline.evaluate(input(tool, args, session))
    expect(first.action).not.toBe('allow')
    expect(first.rule_id).toBe('no-destructive-commands')
    const second = await pipeline.evaluate(input(tool, args, session))
    expect(second.action).toBe('deny')
    expect(second.rule_id).toBe('no-destructive-commands')
  }

  // Characterization: commandString(arg-utils.ts) already extracts the plain
  // command string for this shape, so this was already green — it locks in
  // that correctness rather than demonstrating a new fix.
  it('matches args = {"command": "rm -rf /"} (characterization — already correct)', async () => {
    await expectMatchAndBlock(makePipeline(rule), 'Bash', { command: 'rm -rf /' }, 'cmd-plain')
  })

  // Characterization: a JSON-serialized haystack would turn the trailing `"`
  // after an embedded double quote into `\"`, and the trailing `~` would be
  // followed by `\"}` instead of end-of-string — either could defeat the
  // anchored alternatives in the shipped pattern. commandString sidesteps
  // this by matching the raw command text, so this is already correct.
  it('matches a command containing double quotes despite JSON-escaping risk (characterization)', async () => {
    await expectMatchAndBlock(makePipeline(rule), 'Bash', { command: 'echo "x" && rm -rf ~' }, 'cmd-quoted')
  })

  // Characterization: args.command as an array (some integrations pass argv
  // arrays rather than a shell string).
  it('matches args.command as an array (characterization)', async () => {
    await expectMatchAndBlock(makePipeline(rule), 'Bash', { command: ['rm', '-rf', '.'] }, 'cmd-array')
  })

  // This WAS red before the arg-utils.ts fix in this lane: commandString
  // only unwrapped a nested `args.args.command` shape for MCP-named tools
  // (`mcp__...`). A plain tool with the same nested shape fell through to
  // JSON.stringify(args) = `{"args":{"command":"rm -rf ."}}`, and the
  // shipped pattern's `( |$)` anchor after `rm -rf .` could never match
  // (the JSON string continues with `"}}`, not a space or end-of-string).
  it('matches a one-level-nested args.args.command shape (was red before the fix)', async () => {
    await expectMatchAndBlock(makePipeline(rule), 'Bash', { args: { command: 'rm -rf .' } }, 'cmd-nested')
  })

  // Must-allow: a benign command must never be caught by an over-broad
  // haystack (e.g. matching against unrelated JSON structure/keys).
  it('does not match a benign command (must-allow)', async () => {
    const pipeline = makePipeline(rule)
    const result = await pipeline.evaluate(input('Bash', { command: 'rm -rf node_modules' }, 'cmd-benign'))
    expect(result.action).toBe('allow')
  })
})

describe('rate rule match surface (type: rate)', () => {
  // This WAS red before the pipeline.ts fix: rate-rule matching built its
  // haystack as `${tool} ${JSON.stringify(input.args)}` (pipeline.ts ~line
  // 260), so an anchored/quoted command pattern silently never matched and
  // the rate limit never engaged — a false-negative that disables the rule
  // without ever surfacing an error.
  it('matches a quoted command against an end-anchored pattern (was red before the fix)', async () => {
    const pipeline = makePipeline(`version: 1
rules:
  - id: rate-danger
    type: rate
    match: "rm -rf ~$"
    window_seconds: 300
    max_calls: 1
    action: deny
    message: "Too many destructive calls"
`)
    const first = await pipeline.evaluate(input('Bash', { command: 'echo "x" && rm -rf ~' }, 'rate-quoted'))
    expect(first.action).toBe('allow')
    const second = await pipeline.evaluate(input('Bash', { command: 'echo "x" && rm -rf ~' }, 'rate-quoted'))
    // Before the fix this stayed 'allow' forever — the pattern never matched
    // so the rate window was never engaged at all.
    expect(second.action).not.toBe('allow')
    expect(second.rule_id).toBe('rate-danger')
  })

  // Regression guard: rate rules may match the TOOL NAME itself (existing
  // shipped behavior, e.g. `match: "Bash"`), not only command text. The
  // command-string surface must be tried additively, never replacing the
  // tool-name/JSON fallback.
  it('still matches against the bare tool name (regression guard)', async () => {
    const pipeline = makePipeline(`version: 1
rules:
  - id: bash-storm
    type: rate
    match: "Bash"
    window_seconds: 60
    max_calls: 3
    action: warn
    message: "Too many calls"
`)
    const r1 = await pipeline.evaluate(input('Bash', { command: 'echo 1' }, 'rate-tool'))
    const r2 = await pipeline.evaluate(input('Bash', { command: 'echo 2' }, 'rate-tool'))
    const r3 = await pipeline.evaluate(input('Bash', { command: 'echo 3' }, 'rate-tool'))
    const r4 = await pipeline.evaluate(input('Bash', { command: 'echo 4' }, 'rate-tool'))
    expect([r1.action, r2.action, r3.action]).toEqual(['allow', 'allow', 'allow'])
    expect(r4.action).toBe('warn')
    expect(r4.rule_id).toBe('bash-storm')
  })

  // Must-allow: a benign, non-matching command must not spuriously engage
  // the rate window.
  it('does not engage the rate window for a non-matching command (must-allow)', async () => {
    const pipeline = makePipeline(`version: 1
rules:
  - id: rate-danger-2
    type: rate
    match: "rm -rf ~$"
    window_seconds: 300
    max_calls: 1
    action: deny
    message: "Too many destructive calls"
`)
    const r1 = await pipeline.evaluate(input('Bash', { command: 'npm test' }, 'rate-benign'))
    const r2 = await pipeline.evaluate(input('Bash', { command: 'npm test' }, 'rate-benign'))
    expect(r1.action).toBe('allow')
    expect(r2.action).toBe('allow')
  })
})

describe('diagnosis rule match surface (type: diagnosis)', () => {
  // Guard against a naive fix: diagnosis rules intentionally match the
  // CONTENT of a write (e.g. "refactor" inside the new file body), not a
  // shell command. Switching this surface to commandString (which strips
  // content-bearing keys) would silently blind the gate — this must keep
  // passing after the lane's fix, unchanged from its pre-fix behavior.
  const withLedger = () => {
    const home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    const previousHome = process.env.HOME
    process.env.HOME = home
    const ledger = new ProblemLedger()
    return {
      ledger,
      cleanup: () => {
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
        execSync(`rm -rf "${home}"`)
      },
    }
  }

  it('still matches file CONTENT, not a command (regression guard — must not regress)', async () => {
    const { ledger, cleanup } = withLedger()
    try {
      const pipeline = makePipeline(`version: 1
rules:
  - id: diagnose-before-refactor
    type: diagnosis
    match: "(refactor|rewrite|migrat|delet|remov|drop)"
    hypothesis_window_seconds: 900
    action: redirect
    message: "Complex change without a stated root cause."
`, ledger)
      pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'diag-content'), 1)
      const result = await pipeline.evaluate(input('write', { filePath: '/tmp/src/x.ts', content: 'refactor' }, 'diag-content'))
      expect(result.action).toBe('redirect')
      expect(result.redirect?.kind).toBe('diagnosis')
    } finally {
      cleanup()
    }
  })

  // New, additive capability from the fix: an anchored command pattern
  // (which the old JSON.stringify surface could defeat via escaping) now
  // also matches, without giving up the content-matching case above.
  it('also matches a quoted command via the additive command surface', async () => {
    const { ledger, cleanup } = withLedger()
    try {
      const pipeline = makePipeline(`version: 1
rules:
  - id: diagnose-destructive-bash
    type: diagnosis
    match: "rm -rf ~$"
    hypothesis_window_seconds: 900
    action: redirect
    message: "Destructive command without a stated root cause."
`, ledger)
      pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'diag-cmd'), 1)
      const result = await pipeline.evaluate(input('Bash', { command: 'echo "x" && rm -rf ~' }, 'diag-cmd'))
      expect(result.action).toBe('redirect')
      expect(result.redirect?.kind).toBe('diagnosis')
    } finally {
      cleanup()
    }
  })

  it('does not match unrelated content or commands (must-allow)', async () => {
    const { ledger, cleanup } = withLedger()
    try {
      const pipeline = makePipeline(`version: 1
rules:
  - id: diagnose-before-refactor-2
    type: diagnosis
    match: "(refactor|rewrite|migrat|delet|remov|drop)"
    hypothesis_window_seconds: 900
    action: redirect
    message: "Complex change without a stated root cause."
`, ledger)
      pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'diag-benign'), 1)
      const result = await pipeline.evaluate(input('write', { filePath: '/tmp/src/y.ts', content: 'add a helper' }, 'diag-benign'))
      expect(result.action).toBe('allow')
    } finally {
      cleanup()
    }
  })
})
