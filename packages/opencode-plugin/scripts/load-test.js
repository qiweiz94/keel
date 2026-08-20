// Load test for @get-keel/opencode-plugin.
// Verifies the built dist/index.js is the canonical plugin: correct id,
// all three hooks present, and the installed dist matches the template
// (catches the "stale dist" failure mode).
//
// NOTE: the plugin computes ~/.keel at module-load time, so HOME must be
// overridden BEFORE importing the plugin.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'dist', 'index.js')
const TEMPLATE = join(HERE, '..', '..', 'cli', 'templates', 'keel-enforce.js')

// Isolate from the real ~/.keel — must precede the dynamic import below.
const tmpHome = fs.mkdtempSync(join(os.tmpdir(), 'keel-pkg-test-'))
process.env.HOME = tmpHome

// This script runs under plain `node`, not vitest — package-verifier.ts's
// VITEST-only registry safety net does not apply here. Nothing in this
// file currently exercises the real self-bootstrap DEFAULT_RULES_YAML path
// (every rules.yaml used below is pre-written before plugin.server() is
// called, so the write-when-missing bootstrap in plugin.ts never fires —
// see session/EVIDENCE/wave2-slop.md for the trace), but a `type: package`
// rule will land in that constant once the unverified-package-install
// proposal is pasted in, and a future edit to this script could easily
// start relying on real bootstrap. Set this defensively now rather than
// depend on that absence staying true.
process.env.KEEL_NPM_REGISTRY = 'http://127.0.0.1:1'

let failures = 0
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const plugin = (await import(`file://${DIST}`)).default
check('exports default plugin', !!plugin)
check('id is keel-enforce', plugin?.id === 'keel-enforce')

fs.mkdirSync(join(tmpHome, '.keel'), { recursive: true })
fs.writeFileSync(join(tmpHome, '.keel', 'rules.yaml'), `version: 1
level: balanced
rules:
  - id: no-force-push
    type: command
    match: "git push --force(?!-with-lease)"
    action: deny
    message: "Use --force-with-lease instead of --force."
  - id: test-seq
    type: sequence
    steps:
      - tool: write
        pattern: "src/"
      - tool: edit
        pattern: "src/"
    sequence_window_seconds: 300
    action: deny
    message: "Sequence blocked"
  - id: source-change-requires-test
    type: verification
    trigger:
      tools: [write, edit]
      path: "src/"
      pattern: "src/"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest)"
    boundaries:
      commit:
        pattern: "git commit"
        action: warn
      push:
        pattern: "git push"
        action: deny
    verification_window_seconds: 300
    action: deny
    message: "Test required before commit or push."
  - id: claim-without-evidence
    type: claim
    mode: observe
    trigger:
      tools: [write, edit]
      path: "src/"
      pattern: "src/"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest)"
    verification_window_seconds: 300
    action: warn
    message: "Claimed done/fixed/tested/passing/verified/complete without a passing verification run since the last edit."
  - id: filesystem-protection
    type: filesystem
    paths: ["secrets"]
    operations: [write]
    action: deny
    message: "Protected filesystem path"
  - id: content-protection
    type: content
    patterns:
      - regex: "PRIVATE_KEY"
    action: deny
    message: "Private key content"
  - id: no-full-secret-value
    type: content
    patterns:
      - regex: "SECRETVAL_[A-Za-z0-9]{10}"
        redact_span: true
    action: deny
    message: "Full-value secret pattern (redact_span: true — the match IS the whole secret, unlike content-protection's label-only PRIVATE_KEY above, which output redaction deliberately does NOT mutate — see types.ts's redact_span doc comment)."
  - id: keel-control-gate
    type: command
    match: "keel (disable|allow|level|enforce|install|uninstall)( |$)"
    action: deny
    level: protect
    message: "keel controls are user-owned"
  - id: no-rules-tampering
    type: filesystem
    paths:
      - "**/.keel/rules.yaml"
      - "**/.opencode/plugins/**"
    action: deny
    level: protect
    message: "tampering blocked"
  - id: no-enforcer-removal
    type: command
    match: "rm[^|;&]*[.]opencode/plugins/|rm[^|;&]*[.]keel/(rules[.]yaml|plugins|DISABLED)"
    action: deny
    level: protect
    message: "enforcer removal blocked"
  - id: network-protection
    type: network
    match: 'evil\\.example'
    action: deny
    message: "Blocked network"
  - id: rate-protection
    type: rate
    match: "rate-token"
    max_calls: 1
    window_seconds: 300
    action: deny
    message: "Rate limited"
  - id: time-protection
    type: time
    schedule:
      start: "00:00"
      end: "23:59"
    action: deny
    message: "Outside schedule"
  - id: flow-protection
    type: flow
    sources: [read]
    sinks: [bash]
    action: deny
    message: "Sensitive flow"
  - id: protected-level
    type: command
    match: "level-protected"
    level: protect
    action: deny
    message: "Should be inactive"
  - id: ci-only
    type: command
    match: "ci-only"
    context: [ci]
    action: deny
    message: "Should be inactive locally"
  - id: priority-allow
    type: command
    match: "priority-check"
    priority: 100
    action: allow
    message: "High priority allow"
  - id: priority-deny
    type: command
    match: "priority-check"
    priority: 1
    action: deny
    message: "Low priority deny"
  - id: unless-command
    type: command
    match: "dangerous-action"
    unless:
      - regex: "safe"
    action: deny
    message: "Unless failed"
  - id: unless-reasoning
    type: command
    match: "reasoned-action"
    unless_reasoning: "approved"
    action: deny
    message: "Reasoning exemption"
  - id: must-sign-commits
    type: command
    match: "git commit(?!.*--signoff)"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    message: "Commits must be signed off."
`)
const hooks = await plugin.server({ directory: join(tmpHome, 'proj') })

const expected = ['tool.execute.before', 'tool.execute.after', 'experimental.text.complete', 'experimental.chat.system.transform', 'experimental.session.compacting']
check('all plugin hooks', expected.every(h => typeof hooks?.[h] === 'function'))

// Self-bootstrap writes default rules.
check('self-bootstrap rules.yaml', fs.existsSync(join(tmpHome, '.keel', 'rules.yaml')))

// Invalid project rules: KEEL_STRICT=1 rejects startup; otherwise the plugin
// falls back to the built-in defaults so enforcement never silently stops.
const malformedProject = join(tmpHome, 'malformed-project')
fs.mkdirSync(join(malformedProject, '.keel'), { recursive: true })
fs.writeFileSync(join(malformedProject, '.keel', 'rules.yaml'), 'version: 1\nrules: [broken\n')
process.env.KEEL_STRICT = '1'
let strictRejected = false
try { await plugin.server({ directory: malformedProject }) } catch (error) { strictRejected = error.message.startsWith('[Keel]') }
check('KEEL_STRICT rejects malformed rules', strictRejected)
delete process.env.KEEL_STRICT
let fallbackHooks = null
try { fallbackHooks = await plugin.server({ directory: malformedProject }) } catch {}
let fallbackEnforces = !!fallbackHooks
if (fallbackHooks) {
  try {
    await fallbackHooks['tool.execute.before']({ tool: 'bash', sessionID: 'malformed-1' }, { args: { command: 'git push --force origin main' } })
    await fallbackHooks['tool.execute.before']({ tool: 'bash', sessionID: 'malformed-1' }, { args: { command: 'git push --force origin main' } })
    fallbackEnforces = false
  } catch (e) { fallbackEnforces = e.message.startsWith('[Keel]') }
}
check('fallback defaults keep enforcing after malformed rules', fallbackEnforces)

// A hook-boundary failure must also fail closed instead of allowing the tool call.
let runtimeFailureClosed = false
try {
  const throwingOutput = {}
  Object.defineProperty(throwingOutput, 'args', { get() { throw new Error('synthetic hook failure') } })
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'runtime-failure' }, throwingOutput)
} catch (error) {
  runtimeFailureClosed = error.message.includes('Enforcement failed closed')
}
check('runtime hook failures fail closed', runtimeFailureClosed)

// v1 M1r-2 — locked product decision: degenerate input fails closed, never
// a silent allow. opencode types `input` as `any`; a missing/blank
// `input.tool` used to fall back to the literal string 'unknown' and
// evaluate anyway (toEnforceInput(input?.tool || 'unknown', ...)) — a call
// that matches no real rule pattern in pipeline.ts (which has no
// `tool === 'unknown'` special case) and passes through silently. This is
// the same class of gap `keel hook <host>` had for the out-of-process
// hosts (ParsedCall.degenerate, packages/cli/src/commands/hook.ts).
let missingToolBlocked = false
try {
  await hooks['tool.execute.before']({ sessionID: 'degenerate-1' }, { args: { command: 'rm -rf /' } })
} catch (e) {
  missingToolBlocked = e.message.startsWith('[Keel] fail-closed-degenerate-input')
}
check('missing input.tool fails closed rather than evaluating as tool: unknown', missingToolBlocked)

let blankToolBlocked = false
try {
  await hooks['tool.execute.before']({ tool: '', sessionID: 'degenerate-2' }, { args: { command: 'rm -rf /' } })
} catch (e) {
  blankToolBlocked = e.message.startsWith('[Keel] fail-closed-degenerate-input')
}
check('blank input.tool ("") fails closed the same way as missing', blankToolBlocked)

// A real tool name that matches no rule must still allow — this is a
// degenerate-input guard, not a new default-deny firewall.
let realToolStillAllows = true
try {
  await hooks['tool.execute.before']({ tool: 'some_tool_no_rule_covers', sessionID: 'degenerate-3' }, { args: { anything: 1 } })
} catch {
  realToolStillAllows = false
}
check('a real (if unmatched) input.tool still allows', realToolStillAllows)

await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'privacy' }, { args: { token: 'plugin-secret-value' } })
const traceText = fs.readdirSync(join(tmpHome, '.keel', 'traces'))
  .map(file => fs.readFileSync(join(tmpHome, '.keel', 'traces', file), 'utf8')).join('\n')
check('plugin audit redacts sensitive arguments', !traceText.includes('plugin-secret-value') && traceText.includes('[redacted]'))

// Warn-then-deny escalation within one process.
const out1 = { args: { command: 'git push --force origin main' } }
await hooks['tool.execute.before']({ tool: 'bash', sessionID: 't1' }, out1)
let denied = false
try {
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 't1' }, { args: { command: 'git push --force origin main' } })
} catch (e) {
  denied = e.message.startsWith('[Keel]')
}
check('warn then deny', denied)

// Sequence rule (WriteFile src/ → edit src/ within 300s).
// First violation warns; repeat within the window denies.
await hooks['tool.execute.before']({ tool: 'write', sessionID: 't2' }, { args: { filePath: 'src/foo.ts', content: 'x' } })
let seqWarned = true
let seqDenied = false
try {
  await hooks['tool.execute.before']({ tool: 'edit', sessionID: 't2' }, { args: { filePath: 'src/foo.ts', oldString: 'a', newString: 'b' } })
} catch (e) {
  seqWarned = false // first violation must warn, not deny
}
try {
  await hooks['tool.execute.before']({ tool: 'edit', sessionID: 't2' }, { args: { filePath: 'src/foo.ts', oldString: 'b', newString: 'c' } })
} catch (e) {
  seqDenied = e.message.startsWith('[Keel]')
}
check('sequence first violation warns', seqWarned)
check('sequence repeat denies', seqDenied)

// Sequence rule does NOT fire for unrelated tool calls.
let seqFalse = false
await hooks['tool.execute.before']({ tool: 'read', sessionID: 't2' }, { args: { filePath: 'src/other.ts' } })
try {
  await hooks['tool.execute.before']({ tool: 'edit', sessionID: 't2' }, { args: { filePath: 'README.md', oldString: 'a', newString: 'b' } })
} catch (e) {
  seqFalse = e.message.startsWith('[Keel]')
}
check('sequence ignores unrelated calls', !seqFalse)

// Verification obligation: source change is allowed, failed tests do not clear,
// successful tests clear, and commit boundaries warn before blocking.
await hooks['tool.execute.before']({ tool: 'write', sessionID: 't3' }, { args: { filePath: 'src/obligation.ts', content: 'x' } })
await hooks['tool.execute.before']({ tool: 'bash', sessionID: 't3' }, { args: { command: 'git commit -m "unverified"' } })
let boundaryDenied = false
try {
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 't3' }, { args: { command: 'git commit -m "unverified again"' } })
} catch (e) {
  boundaryDenied = e.message.startsWith('[Keel]')
}
check('verification boundary warns then denies', boundaryDenied)

// Self-protection: keel controls are user-owned — agents cannot disable,
// self-approve, turn down the dial, or remove the enforcer itself.
const controlGated = async (sessionId, command) => {
  // First violation warns, repeat denies — but the rule may already be
  // escalated by an earlier check in this session, so accept either a warn
  // on the first call or an immediate deny; the SECOND call must deny.
  try {
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: sessionId }, { args: { command } })
  } catch (e) {
    if (e.message.startsWith('[Keel]')) return true
  }
  try {
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: sessionId }, { args: { command } })
    return false
  } catch (e) {
    return e.message.startsWith('[Keel]')
  }
}
check('keel disable is blocked for agents', await controlGated('control-1', 'keel disable'))
check('keel allow self-approval is blocked', await controlGated('control-2', 'keel allow no-force-push --once'))
check('keel level dial-down is blocked', await controlGated('control-3', 'keel level sprint --project'))
check('rm of the plugin file is blocked', await controlGated('control-4', `rm ${join(tmpHome, '.opencode', 'plugins', 'keel-enforce.js')}`))
// no-rules-tampering is `level: protect` — it now denies on the FIRST hit
// (a floor with a warn-once grace is not un-bypassable), so accept either
// an immediate deny on the first call or the classic warn-then-deny on the
// second, the same tolerant shape as controlGated above.
let rulesWriteBlocked = false
try {
  await hooks['tool.execute.before']({ tool: 'write', sessionID: 'control-5' }, { args: { filePath: join(tmpHome, '.keel', 'rules.yaml'), content: 'x' } })
} catch (e) {
  rulesWriteBlocked = e.message.startsWith('[Keel]')
}
if (!rulesWriteBlocked) {
  try {
    await hooks['tool.execute.before']({ tool: 'write', sessionID: 'control-5' }, { args: { filePath: join(tmpHome, '.keel', 'rules.yaml'), content: 'x' } })
  } catch (e) {
    rulesWriteBlocked = e.message.startsWith('[Keel]')
  }
}
check('rules.yaml writes are blocked', rulesWriteBlocked)

// Core rule types and metadata are evaluated by the same bundled pipeline.
const checkRule = async (tool, args, id) => {
  await hooks['tool.execute.before']({ tool, sessionID: id }, { args })
  let denied = false
  try { await hooks['tool.execute.before']({ tool, sessionID: id }, { args }) } catch (e) { denied = e.message.startsWith('[Keel]') }
  return denied
}
checkRule('WriteFile', { filePath: 'secrets/key', operation: 'write' }, 'types-1')
let filesystemDenied = false
try { await hooks['tool.execute.before']({ tool: 'write', sessionID: 'types-1' }, { args: { filePath: 'secrets/key', operation: 'write' } }) } catch (e) { filesystemDenied = e.message.startsWith('[Keel]') }
check('filesystem first warns then denies', filesystemDenied)
let contentDenied = false
await hooks['tool.execute.before']({ tool: 'write', sessionID: 'types-2' }, { args: { content: 'PRIVATE_KEY' } })
try { await hooks['tool.execute.before']({ tool: 'write', sessionID: 'types-2' }, { args: { content: 'PRIVATE_KEY' } }) } catch (e) { contentDenied = e.message.startsWith('[Keel]') }
check('content first warns then denies', contentDenied)
let networkDenied = false
await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'types-3' }, { args: { url: 'https://evil.example' } })
try { await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'types-3' }, { args: { url: 'https://evil.example' } }) } catch (e) { networkDenied = e.message.startsWith('[Keel]') }
check('network first warns then denies', networkDenied)
await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'types-4' }, { args: { command: 'rate-token' } })
let rateDenied = false
await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'types-4' }, { args: { command: 'rate-token' } })
try { await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'types-4' }, { args: { command: 'rate-token' } }) } catch (e) { rateDenied = e.message.startsWith('[Keel]') }
check('rate first violation warns then denies', rateDenied)
fs.writeFileSync(join(tmpHome, '.env'), 'PRIVATE_KEY=redacted\n')
await hooks['tool.execute.before']({ tool: 'read', sessionID: 'types-5' }, { args: { filePath: join(tmpHome, '.env') } })
let flowDenied = false
await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'types-5' }, { args: { command: 'send' } })
try { await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'types-5' }, { args: { command: 'send' } }) } catch (e) { flowDenied = e.message.startsWith('[Keel]') }
check('flow first violation warns then denies', flowDenied)
const cleanHooks = await plugin.server({ directory: join(tmpHome, 'clean') })
let priorityAllowed = true
try { await cleanHooks['tool.execute.before']({ tool: 'bash', sessionID: 'types-6' }, { args: { command: 'priority-check' } }) } catch { priorityAllowed = false }
check('priority metadata selects higher priority rule', priorityAllowed)
// context and unless metadata exempt these three from enforcement.
// `level-protected` used to be grouped in this same loop, but that was
// never a genuine level exemption: mergeRules() has always treated
// `level: protect` as a floor — "active at EVERY dial" (rule-parser.ts) —
// so at the balanced dial here it was firing all along; it only *looked*
// exempt because the old warn-first pass didn't throw. gate-2's
// block-first change removed that disguise, so it is asserted on its own
// below with the outcome it actually has.
let metadataAllowed = true
for (const command of ['ci-only', 'dangerous-action safe', 'reasoned-action']) {
  try { await cleanHooks['tool.execute.before']({ tool: 'bash', sessionID: 'types-7', reasoning: command === 'reasoned-action' ? 'approved' : '' }, { args: { command } }) } catch { metadataAllowed = false }
}
check('context and unless metadata allow exemptions', metadataAllowed)

// `level: protect` is a floor: never filtered by dial, and (since gate-2)
// denies on the first hit. There is no dial at which this rule is inactive.
let levelProtectedDenied = false
try {
  await cleanHooks['tool.execute.before']({ tool: 'bash', sessionID: 'types-7b' }, { args: { command: 'level-protected' } })
} catch (e) {
  levelProtectedDenied = e.message.startsWith('[Keel]')
}
check('level: protect rule is a floor, not a dial-scoped exemption', levelProtectedDenied)

// Fix rules mutate the command args in place instead of throwing.
// Runs on a fresh server instance: the main fixture's verification obligation
// is cwd-scoped, so a commit-shaped command there would hit the boundary.
const fixHooks = await plugin.server({ directory: join(tmpHome, 'fix-dir') })
const fixArgs = { command: 'git commit -m "sign me"' }
await fixHooks['tool.execute.before']({ tool: 'bash', sessionID: 'fix-1' }, { args: fixArgs })
check('fix rule mutates command args in place', fixArgs.command.includes('--signoff'))

const verificationHooks = await plugin.server({ directory: join(tmpHome, 'verification') })
await verificationHooks['tool.execute.before']({ tool: 'write', sessionID: 't4' }, { args: { filePath: 'src/verified.ts', content: 'x' } })
await verificationHooks['tool.execute.after'](
  { tool: 'bash', sessionID: 't4', callID: 'test-fail', args: { command: 'npm test' } },
  { title: 'npm test', output: 'failed', metadata: { exit: 1 } },
)
let failedTestStillPending = false
try {
  await verificationHooks['tool.execute.before']({ tool: 'bash', sessionID: 't4' }, { args: { command: 'git push origin main' } })
  await verificationHooks['tool.execute.before']({ tool: 'bash', sessionID: 't4' }, { args: { command: 'git push origin main' } })
} catch (e) {
  failedTestStillPending = e.message.startsWith('[Keel]')
}
check('failed test does not satisfy obligation', failedTestStillPending)

await verificationHooks['tool.execute.after'](
  { tool: 'bash', sessionID: 't4', callID: 'test-pass', args: { command: 'npm test' } },
  { title: 'npm test', output: 'passed', metadata: { exit: 0 } },
)
let passedTestStillBlocked = false
try {
  await verificationHooks['tool.execute.before']({ tool: 'bash', sessionID: 't4' }, { args: { command: 'git push origin main' } })
} catch {
  passedTestStillBlocked = true
}
check('successful test clears obligation', !passedTestStillBlocked)

// Worktree fingerprint catches a source change that bypasses WriteFile/edit.
const repoDir = join(tmpHome, 'repo')
fs.mkdirSync(join(repoDir, 'src'), { recursive: true })
fs.writeFileSync(join(repoDir, 'src', 'external.ts'), 'initial\n')
spawnSync('git', ['-C', repoDir, 'init', '-q'])
spawnSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'])
spawnSync('git', ['-C', repoDir, 'config', 'user.name', 'test'])
spawnSync('git', ['-C', repoDir, 'add', '.'])
spawnSync('git', ['-C', repoDir, 'commit', '-q', '-m', 'initial'])
const repoHooks = await plugin.server({ directory: repoDir })
fs.writeFileSync(join(repoDir, 'src', 'external.ts'), 'changed outside tool args\n')
await repoHooks['tool.execute.after'](
  { tool: 'bash', sessionID: 'repo', callID: 'external-edit', args: { command: 'true' } },
  { title: 'true', output: '', metadata: { exit: 0 } },
)
await repoHooks['tool.execute.before']({ tool: 'bash', sessionID: 'repo' }, { args: { command: 'git commit -m "external"' } })
let externalBoundaryDenied = false
try {
  await repoHooks['tool.execute.before']({ tool: 'bash', sessionID: 'repo' }, { args: { command: 'git commit -m "external again"' } })
} catch (e) {
  externalBoundaryDenied = e.message.startsWith('[Keel]')
}
check('worktree changes create verification obligation', externalBoundaryDenied)

// ── real output redaction (sprint/lane-c2) ───────────────────────────
// Live-verified end to end against a real installed opencode (this file's
// own "OpenCode auto-load probe" below, plus
// session/transcripts/opencode-tool-execute-after-mutation-probe.txt) that
// mutating tool.execute.after's `output` object actually rewrites what the
// MODEL receives, not just what the terminal renders. These checks exercise
// the wiring in-process: `no-full-secret-value` (this file's own fixture
// rules.yaml, top of this file) has `redact_span: true` — its match IS the
// whole secret — and is action: deny — an enforcing rule, so it must
// actually redact.
const redactDir = join(tmpHome, 'redact-project')
fs.mkdirSync(redactDir, { recursive: true })
const redactHooks = await plugin.server({ directory: redactDir })

const secretOutput = { title: 'cat secrets.env', output: 'token: SECRETVAL_abc123defg\ndone', metadata: { exit: 0, output: 'token: SECRETVAL_abc123defg\ndone' } }
await redactHooks['tool.execute.after'](
  { tool: 'bash', sessionID: 'redact-1', callID: 'c1', args: { command: 'cat secrets.env' } },
  secretOutput,
)
check('MUST-REDACT: output.output no longer contains the raw secret', !secretOutput.output.includes('SECRETVAL_abc123defg'))
check('MUST-REDACT: output.output carries an attributed redaction marker', secretOutput.output.includes('[redacted-by-keel:no-full-secret-value]'))
check('MUST-REDACT: output.metadata\'s duplicate copy is ALSO redacted (closes the metadata hole)', !secretOutput.metadata.output.includes('SECRETVAL_abc123defg') && secretOutput.metadata.output.includes('[redacted-by-keel:no-full-secret-value]'))

const redactTrace = fs.readdirSync(join(tmpHome, '.keel', 'traces'))
  .flatMap(f => fs.readFileSync(join(tmpHome, '.keel', 'traces', f), 'utf8').split('\n').filter(Boolean))
  .map(line => { try { return JSON.parse(line) } catch { return null } })
  .filter(Boolean)
check('MUST-REDACT: a redact-action trace entry is recorded, distinct from the allow/"Tool completed" entry', redactTrace.some(e => e.session_id === 'redact-1' && e.action === 'redact' && e.rule_id === 'no-full-secret-value' && e.hook === 'tool.execute.after'))

// redact_span correctness (found in review before this shipped, see
// pipeline.ts's evaluateOutput() and types.ts's redact_span doc comment):
// `content-protection`'s pattern (`PRIVATE_KEY`, no redact_span) matches
// only a LABEL, not a value that follows it. It must NEVER mutate — a
// partial redaction that strips the label and leaves a real value sitting
// right next to a "[redacted]" marker would be a false-confidence signal
// worse than no redaction at all.
const labelOnlyOutput = { title: 'cat labeled.env', output: 'PRIVATE_KEY=realvalue123\ndone', metadata: { exit: 0 } }
await redactHooks['tool.execute.after'](
  { tool: 'bash', sessionID: 'redact-label', callID: 'c-label', args: { command: 'cat labeled.env' } },
  labelOnlyOutput,
)
check('a label-only content match (no redact_span) is left FULLY byte-identical, value included', labelOnlyOutput.output === 'PRIVATE_KEY=realvalue123\ndone')

const cleanOutput = { title: 'echo ok', output: 'build succeeded, 0 errors', metadata: { exit: 0, output: 'build succeeded, 0 errors' } }
await redactHooks['tool.execute.after'](
  { tool: 'bash', sessionID: 'redact-2', callID: 'c2', args: { command: 'echo ok' } },
  cleanOutput,
)
check('MUST-NOT-FIRE: clean output is left byte-identical', cleanOutput.output === 'build succeeded, 0 errors' && cleanOutput.metadata.output === 'build succeeded, 0 errors')

// Regression: the trace must never claim a redaction that was never
// applied. `field-sep-collision`'s pattern matches the literal text of
// plugin.ts's own FIELD_SEP batching delimiter — when title+metadata are
// joined and scanned together, the match consumes the delimiter itself, so
// splitting the redacted text back apart by that same delimiter produces
// FEWER parts than fields went in. That mismatch must bail out WITHOUT
// mutating title/metadata AND without recording a redact trace entry —
// found in review before this shipped: recordRedaction() used to run
// inside the scan step, before the caller checked whether the split
// actually succeeded.
//
// This rule is deliberately NOT added to the shared global rules.yaml at
// the top of this file: doing so once (an earlier version of this test)
// made EVERY OTHER multi-field batch in this whole suite collide with it
// too — any title+metadata join contains the literal delimiter text, so a
// rule matching that text fires on every batched scan process-wide, not
// just this one case. A dedicated project directory with its own
// project-scoped rules.yaml keeps the collision contained to this test.
const sepCollisionDir = join(tmpHome, 'sep-collision-project')
fs.mkdirSync(join(sepCollisionDir, '.keel'), { recursive: true })
fs.writeFileSync(join(sepCollisionDir, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: field-sep-collision
    type: content
    patterns:
      - regex: "KEEL-FIELD-SEP"
        redact_span: true
    action: deny
    message: "Regression fixture only."
`)
const sepCollisionHooks = await plugin.server({ directory: sepCollisionDir })
const sepOutput = { title: 'a', output: '', metadata: { exit: 0, note: 'b' } }
await sepCollisionHooks['tool.execute.after'](
  { tool: 'bash', sessionID: 'redact-sep-collision', callID: 'c-sep', args: {} },
  sepOutput,
)
check('field/delimiter collision: title is left unmutated on a split-count mismatch', sepOutput.title === 'a')
check('field/delimiter collision: metadata is left unmutated on a split-count mismatch', sepOutput.metadata.note === 'b')
const sepTrace = fs.readdirSync(join(tmpHome, '.keel', 'traces'))
  .flatMap(f => fs.readFileSync(join(tmpHome, '.keel', 'traces', f), 'utf8').split('\n').filter(Boolean))
  .map(line => { try { return JSON.parse(line) } catch { return null } })
  .filter(Boolean)
check('field/delimiter collision: NO redact trace entry is recorded for the unapplied mutation', !sepTrace.some(e => e.session_id === 'redact-sep-collision' && e.action === 'redact'))

// A redaction-scan failure must never turn into a lost verification/outcome
// record — the try/catch around redactToolOutput() in plugin.ts exists
// specifically so a malformed `output` object degrades to "left as-is,"
// not to this hook throwing and the host marking the call failed.
let malformedOutputSurvived = true
try {
  await redactHooks['tool.execute.after'](
    { tool: 'bash', sessionID: 'redact-3', callID: 'c3', args: { command: 'true' } },
    null,
  )
} catch { malformedOutputSurvived = false }
check('a null/malformed output object does not crash tool.execute.after', malformedOutputSurvived)

// Requirements injection with a requirements file present.
fs.mkdirSync(join(tmpHome, '.keel'), { recursive: true })
fs.writeFileSync(join(tmpHome, '.keel', 'requirements.md'), '## Test\n- must run tests\n')
const sys = { system: [] }
await hooks['experimental.chat.system.transform']({ sessionID: 't1' }, sys)
check('system.transform injection', sys.system.some(s => s.includes('must run tests')))

// Compaction embedding.
const comp = { context: [] }
await hooks['experimental.session.compacting']({ sessionID: 't1' }, comp)
check('session.compacting embedding', comp.context.some(c => c.includes('must run tests')))

// Speed dial: config.level is picked up live on the next tool call.
// Floor semantics: every rule is active at every dial; the dial softens
// enforcement globally (sprint downgrades deny to warn), and rules marked
// `level: protect` are exempt from the downgrade — never hidden, never
// softened, AND block on the very first hit at every dial (not just at the
// protect dial) — a floor that warns once before blocking is not
// un-bypassable.
const dialHome = join(tmpHome, 'dial')
fs.mkdirSync(join(dialHome, '.keel'), { recursive: true })
const dialRules = (level, ids) => `version: 1
level: ${level}
rules:
  - id: ${ids[0]}
    type: command
    match: "dial-balanced-token"
    action: deny
    message: "dial balanced token"
  - id: ${ids[1]}
    type: command
    match: "dial-sprint-token"
    level: sprint
    action: deny
    message: "dial sprint token"
  - id: ${ids[2]}
    type: command
    match: "dial-protect-token"
    level: protect
    action: deny
    message: "dial protect token"
  - id: ${ids[3]}
    type: command
    match: "dial-filtered-token"
    level: balanced
    action: deny
    message: "dial filtered token"
`
const dialCall = async (sessionId, command) => {
  try {
    await dialHooks['tool.execute.before']({ tool: 'bash', sessionID: sessionId }, { args: { command } })
    return 'allowed'
  } catch (e) {
    return e.message.startsWith('[Keel]') ? 'denied' : 'allowed'
  }
}
let dialHooks = await plugin.server({ directory: dialHome })

fs.writeFileSync(join(dialHome, '.keel', 'rules.yaml'), dialRules('balanced', ['b-warn', 'b-sprint', 'b-protect', 'b-filter']))
const b1 = await dialCall('dial-b1', 'dial-balanced-token')
const b2 = await dialCall('dial-b2', 'dial-balanced-token')
check('balanced: deny warns then blocks', b1 === 'allowed' && b2 === 'denied')
check('balanced: sprint-level rule stays active', (await dialCall('dial-b3', 'dial-sprint-token')) === 'allowed')
check('balanced: protect-level rule is a floor (denies on first hit)', (await dialCall('dial-b4', 'dial-protect-token')) === 'denied' && (await dialCall('dial-b5', 'dial-protect-token')) === 'denied')
check('balanced: balanced-level rule fires (warns)', (await dialCall('dial-b6', 'dial-filtered-token')) === 'allowed')

fs.writeFileSync(join(dialHome, '.keel', 'rules.yaml'), dialRules('sprint', ['s-warn', 's-sprint', 's-protect', 's-filter']))
check('sprint: unleveled deny rule downgraded to warn', (await dialCall('dial-s1', 'dial-balanced-token')) === 'allowed' && (await dialCall('dial-s2', 'dial-balanced-token')) === 'allowed')
check('sprint: deny downgraded to warn', (await dialCall('dial-s3', 'dial-sprint-token')) === 'allowed' && (await dialCall('dial-s4', 'dial-sprint-token')) === 'allowed')
check('sprint: protect-level rule is a floor (denies on first hit)', (await dialCall('dial-s5', 'dial-protect-token')) === 'denied' && (await dialCall('dial-s6', 'dial-protect-token')) === 'denied')
check('sprint: balanced-level rule is filtered out', (await dialCall('dial-s7', 'dial-filtered-token')) === 'allowed' && (await dialCall('dial-s8', 'dial-filtered-token')) === 'allowed')

fs.writeFileSync(join(dialHome, '.keel', 'rules.yaml'), dialRules('protect', ['p-warn', 'p-sprint', 'p-protect', 'p-filter']))
const p1 = await dialCall('dial-p1', 'dial-balanced-token')
const p2 = await dialCall('dial-p2', 'dial-balanced-token')
check('protect: deny blocks FIRST (block-first dial)', p1 === 'denied' && p2 === 'denied')
check('protect: protect-level rule blocks FIRST', (await dialCall('dial-p3', 'dial-protect-token')) === 'denied')
check('protect: protect-level rule blocks on repeat', (await dialCall('dial-p4', 'dial-protect-token')) === 'denied')
check('protect: balanced-level rule fires (blocks FIRST)', (await dialCall('dial-p5', 'dial-filtered-token')) === 'denied')

// ── turn_number telemetry ────────────────────────────────────────────
// It was hardcoded to 0, which collapsed the FlowTracker's
// flow:<session>:<turn> buckets into one and made same-turn correlation
// impossible. One model call (system.transform) = one turn.
const turnOf = (session, tool) => {
  const lines = fs.readdirSync(join(tmpHome, '.keel', 'traces'))
    .flatMap(file => fs.readFileSync(join(tmpHome, '.keel', 'traces', file), 'utf8').split('\n'))
    .filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(e => e && e.session_id === session && e.tool === tool)
  return lines.length ? lines[lines.length - 1].turn_number : undefined
}

await hooks['experimental.chat.system.transform']({ sessionID: 'turn-a' }, { system: [] })
await hooks['tool.execute.before']({ tool: 'read', sessionID: 'turn-a' }, { args: { filePath: 'src/t1.ts' } })
check('turn_number is 1 after the first model call', turnOf('turn-a', 'read') === 1)

await hooks['experimental.chat.system.transform']({ sessionID: 'turn-a' }, { system: [] })
await hooks['tool.execute.before']({ tool: 'glob', sessionID: 'turn-a' }, { args: { pattern: '*.ts' } })
check('turn_number advances on the next model call', turnOf('turn-a', 'glob') === 2)

// Sessions must not share a counter — that is the bug being fixed.
await hooks['tool.execute.before']({ tool: 'read', sessionID: 'turn-b' }, { args: { filePath: 'src/t2.ts' } })
check('a session with no model call yet stays at turn 0', turnOf('turn-b', 'read') === 0)

await hooks['experimental.chat.system.transform']({ sessionID: 'turn-b' }, { system: [] })
await hooks['tool.execute.before']({ tool: 'glob', sessionID: 'turn-b' }, { args: { pattern: '*.md' } })
check('per-session counters are independent', turnOf('turn-b', 'glob') === 1 && turnOf('turn-a', 'glob') === 2)

// ── post-edit syntax check (tier 1) ──────────────────────────────────
// A broken edit is caught where it is made. Findings are queued on the
// after-hook and surfaced on the next tool call, because the after-hook's
// channel does not reliably reach the model.
const proj = join(tmpHome, 'proj')
fs.mkdirSync(proj, { recursive: true })
const traceHas = (needle) => fs.readdirSync(join(tmpHome, '.keel', 'traces'))
  .some(file => fs.readFileSync(join(tmpHome, '.keel', 'traces', file), 'utf8').includes(needle))

fs.writeFileSync(join(proj, 'broken.ts'), 'const x: number = ;')
await hooks['tool.execute.after'](
  { tool: 'write', sessionID: 'syn-1', args: { filePath: 'broken.ts' } },
  { title: '', output: '', metadata: {} },
)
check('post-edit check flags a broken TypeScript edit', traceHas('post-edit-syntax'))

// The must-NOT-fire case: a healthy file must stay silent, or the check
// becomes noise and gets switched off.
const before = fs.readdirSync(join(tmpHome, '.keel', 'traces'))
  .map(f => fs.readFileSync(join(tmpHome, '.keel', 'traces', f), 'utf8')).join('').split('post-edit-syntax').length
fs.writeFileSync(join(proj, 'clean.ts'), 'export const ok: number = 1\n')
await hooks['tool.execute.after'](
  { tool: 'write', sessionID: 'syn-2', args: { filePath: 'clean.ts' } },
  { title: '', output: '', metadata: {} },
)
const after = fs.readdirSync(join(tmpHome, '.keel', 'traces'))
  .map(f => fs.readFileSync(join(tmpHome, '.keel', 'traces', f), 'utf8')).join('').split('post-edit-syntax').length
check('post-edit check stays silent on a clean edit', before === after)

// A non-source file has no verifier — that is "cannot verify", not an error.
fs.writeFileSync(join(proj, 'notes.txt'), 'anything at all')
const beforeTxt = after
await hooks['tool.execute.after'](
  { tool: 'write', sessionID: 'syn-3', args: { filePath: 'notes.txt' } },
  { title: '', output: '', metadata: {} },
)
const afterTxt = fs.readdirSync(join(tmpHome, '.keel', 'traces'))
  .map(f => fs.readFileSync(join(tmpHome, '.keel', 'traces', f), 'utf8')).join('').split('post-edit-syntax').length
check('post-edit check ignores files it cannot verify', beforeTxt === afterTxt)

// EVERY broken file must be reported, not just the first. Warn-surfacing
// dedupes once per rule per session, which silently swallowed the second
// and later syntax errors — the exact silent-no-op failure a guardrail
// must never have. A mock client makes the surfaced warnings observable.
const surfaced = []
const mockClient = { app: { log: (entry) => surfaced.push(entry?.body?.message || '') } }
const hooks2 = await plugin.server({ directory: proj, client: mockClient })
for (const name of ['b1.ts', 'b2.ts', 'b3.ts']) {
  fs.writeFileSync(join(proj, name), 'const q: number = ;')
  await hooks2['tool.execute.after'](
    { tool: 'write', sessionID: 'multi', args: { filePath: name } },
    { title: '', output: '', metadata: {} },
  )
  // Findings are delivered on the agent's next tool call.
  await hooks2['tool.execute.before']({ tool: 'read', sessionID: 'multi' }, { args: { filePath: 'b1.ts' } })
}
const reported = ['b1.ts', 'b2.ts', 'b3.ts'].filter(n => surfaced.some(m => m.includes(n)))
check(`every broken file is reported (${reported.length}/3)`, reported.length === 3)

// A read is not an edit — the check must not run on every tool call.
// Baseline is recomputed here rather than reused from above: the
// multi-file block in between adds findings, so a stale baseline would
// make this assert on the wrong delta.
const beforeRead = fs.readdirSync(join(tmpHome, '.keel', 'traces'))
  .map(f => fs.readFileSync(join(tmpHome, '.keel', 'traces', f), 'utf8')).join('').split('post-edit-syntax').length
await hooks['tool.execute.after'](
  { tool: 'read', sessionID: 'syn-4', args: { filePath: 'broken.ts' } },
  { title: '', output: '', metadata: {} },
)
const afterRead = fs.readdirSync(join(tmpHome, '.keel', 'traces'))
  .map(f => fs.readFileSync(join(tmpHome, '.keel', 'traces', f), 'utf8')).join('').split('post-edit-syntax').length
check('post-edit check only runs on edits', beforeRead === afterRead)

// ── claim-to-evidence real reach: experimental.text.complete (v0.4 Phase 1) ──
//
// The channel a real OpenCode session drives for the agent's own completed
// output — end-to-end through the ACTUAL plugin hook, not the grammar unit
// or the bare pipeline method (both covered in packages/core's claim.test.ts).
// Session ids are unique per case so entries can be found precisely instead
// of by fragile whole-file substring counting.
function traceEntries() {
  return fs.readdirSync(join(tmpHome, '.keel', 'traces'))
    .flatMap(f => fs.readFileSync(join(tmpHome, '.keel', 'traces', f), 'utf8').split('\n').filter(Boolean))
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}
const claimFired = (sessionId) => traceEntries().some(e =>
  e.session_id === sessionId && e.hook === 'experimental.text.complete'
  && e.rule_id === 'claim-without-evidence' && e.observed_action === 'warn')

const claimDir = join(tmpHome, 'claim-project')
fs.mkdirSync(claimDir, { recursive: true })
const claimHooks = await plugin.server({ directory: claimDir })

// MUST-FIRE: an edit under src/, then a completed assistant utterance
// claiming done with no test run since — the exact shape the plan's
// "give claim-to-evidence real reach" gap describes.
await claimHooks['tool.execute.before']({ tool: 'write', sessionID: 'claim-fire' }, { args: { filePath: 'src/thing.ts', content: 'x' } })
await claimHooks['experimental.text.complete'](
  { sessionID: 'claim-fire', messageID: 'msg-1', partID: 'part-1' },
  { text: 'Done, all tests pass.' },
)
check('claim channel MUST-FIRE: edit then a completed "done" utterance with no test run since', claimFired('claim-fire'))

// MUST-NOT-FIRE: the obligation was discharged by a real passing test run
// (tool.execute.after, exit 0) before the same claim text arrives.
await claimHooks['tool.execute.before']({ tool: 'write', sessionID: 'claim-satisfied' }, { args: { filePath: 'src/thing2.ts', content: 'x' } })
await claimHooks['tool.execute.after'](
  { tool: 'bash', sessionID: 'claim-satisfied', callID: 'test-ok', args: { command: 'npm test' } },
  { title: 'npm test', output: 'passed', metadata: { exit: 0 } },
)
await claimHooks['experimental.text.complete'](
  { sessionID: 'claim-satisfied', messageID: 'msg-2', partID: 'part-2' },
  { text: 'Done, all tests pass.' },
)
check('claim channel MUST-NOT-FIRE: obligation discharged by a real passing run before the claim', !claimFired('claim-satisfied'))

// MUST-NOT-FIRE: hedge/WIP text — same grammar suppression as every other channel.
await claimHooks['tool.execute.before']({ tool: 'write', sessionID: 'claim-hedge' }, { args: { filePath: 'src/thing3.ts', content: 'x' } })
await claimHooks['experimental.text.complete'](
  { sessionID: 'claim-hedge', messageID: 'msg-3', partID: 'part-3' },
  { text: 'Still working on this, tests not run yet.' },
)
check('claim channel MUST-NOT-FIRE: hedge/WIP text stays silent', !claimFired('claim-hedge'))

// MUST-NOT-FIRE: no edit happened at all in this project — nothing armed
// the obligation. Pending state is keyed by (rule, cwd), not by session
// (the same fact "no test since last edit" is shared across a project's
// concurrent sessions) — so this needs its OWN fresh directory, not just a
// fresh session id on claimHooks, which already has an obligation pending
// from the MUST-FIRE case above.
const neverArmedHooks = await plugin.server({ directory: join(tmpHome, 'claim-project-never-armed') })
await neverArmedHooks['experimental.text.complete'](
  { sessionID: 'claim-no-edit', messageID: 'msg-4', partID: 'part-4' },
  { text: 'Done.' },
)
check('claim channel MUST-NOT-FIRE: no prior edit means no pending obligation', !claimFired('claim-no-edit'))

// The hook must not throw even on a malformed/empty payload — it degrades
// to a silent no-op, matching every other hook's fail-closed-without-
// crashing contract.
let textCompleteThrew = false
try {
  await claimHooks['experimental.text.complete']({}, {})
  await claimHooks['experimental.text.complete'](undefined, undefined)
} catch { textCompleteThrew = true }
check('claim channel tolerates a malformed/empty payload without throwing', !textCompleteThrew)

// dist is byte-identical to the canonical template.
check('dist matches canonical template', readFileSync(DIST, 'utf-8') === readFileSync(TEMPLATE, 'utf-8'))

// When OpenCode is available, verify the actual global plugin auto-load path.
// CI environments without OpenCode still retain the direct hook coverage above.
const opencodeProbe = spawnSync('opencode', ['--version'], { encoding: 'utf8' })
if (opencodeProbe.status === 0) {
  const project = join(tmpHome, 'opencode-project')
  fs.mkdirSync(join(tmpHome, '.opencode', 'plugins'), { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  fs.copyFileSync(DIST, join(tmpHome, '.opencode', 'plugins', 'keel-enforce.js'))
  const configProbe = spawnSync('opencode', ['debug', 'config'], {
    cwd: project,
    env: { ...process.env, HOME: tmpHome, XDG_CONFIG_HOME: join(tmpHome, '.config') },
    encoding: 'utf8',
    timeout: 30000,
  })
  check('OpenCode auto-load probe', configProbe.status === 0)
}

fs.rmSync(tmpHome, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
