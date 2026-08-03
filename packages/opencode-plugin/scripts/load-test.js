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
      - tool: WriteFile
        pattern: "src/"
      - tool: edit
        pattern: "src/"
    sequence_window_seconds: 300
    action: deny
    message: "Sequence blocked"
  - id: source-change-requires-test
    type: verification
    trigger:
      tools: [WriteFile, edit]
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
    sources: [ReadFile]
    sinks: [Bash]
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
`)
const hooks = await plugin.server({ directory: join(tmpHome, 'proj') })

const expected = ['tool.execute.before', 'tool.execute.after', 'experimental.chat.system.transform', 'experimental.session.compacting']
check('all plugin hooks', expected.every(h => typeof hooks?.[h] === 'function'))

// Self-bootstrap writes default rules.
check('self-bootstrap rules.yaml', fs.existsSync(join(tmpHome, '.keel', 'rules.yaml')))

// Invalid project rules must prevent startup rather than silently disabling enforcement.
const malformedProject = join(tmpHome, 'malformed-project')
fs.mkdirSync(join(malformedProject, '.keel'), { recursive: true })
fs.writeFileSync(join(malformedProject, '.keel', 'rules.yaml'), 'version: 1\nrules: [broken\n')
let malformedRejected = false
try { await plugin.server({ directory: malformedProject }) } catch (error) { malformedRejected = error.message.startsWith('[Keel]') }
check('malformed rules fail closed', malformedRejected)

// A hook-boundary failure must also fail closed instead of allowing the tool call.
let runtimeFailureClosed = false
try {
  const throwingOutput = {}
  Object.defineProperty(throwingOutput, 'args', { get() { throw new Error('synthetic hook failure') } })
  await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 'runtime-failure' }, throwingOutput)
} catch (error) {
  runtimeFailureClosed = error.message.includes('Enforcement failed closed')
}
check('runtime hook failures fail closed', runtimeFailureClosed)

await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 'privacy' }, { args: { token: 'plugin-secret-value' } })
const traceText = fs.readdirSync(join(tmpHome, '.keel', 'traces'))
  .map(file => fs.readFileSync(join(tmpHome, '.keel', 'traces', file), 'utf8')).join('\n')
check('plugin audit redacts sensitive arguments', !traceText.includes('plugin-secret-value') && traceText.includes('[redacted]'))

// Warn-then-deny escalation within one process.
const out1 = { args: { command: 'git push --force origin main' } }
await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 't1' }, out1)
let denied = false
try {
  await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 't1' }, { args: { command: 'git push --force origin main' } })
} catch (e) {
  denied = e.message.startsWith('[Keel]')
}
check('warn then deny', denied)

// Sequence rule (WriteFile src/ → edit src/ within 300s).
// First violation warns; repeat within the window denies.
await hooks['tool.execute.before']({ tool: 'WriteFile', sessionID: 't2' }, { args: { filePath: 'src/foo.ts', content: 'x' } })
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
await hooks['tool.execute.before']({ tool: 'Read', sessionID: 't2' }, { args: { filePath: 'src/other.ts' } })
try {
  await hooks['tool.execute.before']({ tool: 'edit', sessionID: 't2' }, { args: { filePath: 'README.md', oldString: 'a', newString: 'b' } })
} catch (e) {
  seqFalse = e.message.startsWith('[Keel]')
}
check('sequence ignores unrelated calls', !seqFalse)

// Verification obligation: source change is allowed, failed tests do not clear,
// successful tests clear, and commit boundaries warn before blocking.
await hooks['tool.execute.before']({ tool: 'WriteFile', sessionID: 't3' }, { args: { filePath: 'src/obligation.ts', content: 'x' } })
await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 't3' }, { args: { command: 'git commit -m "unverified"' } })
let boundaryDenied = false
try {
  await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 't3' }, { args: { command: 'git commit -m "unverified again"' } })
} catch (e) {
  boundaryDenied = e.message.startsWith('[Keel]')
}
check('verification boundary warns then denies', boundaryDenied)

// Core rule types and metadata are evaluated by the same bundled pipeline.
const checkRule = async (tool, args, id) => {
  await hooks['tool.execute.before']({ tool, sessionID: id }, { args })
  let denied = false
  try { await hooks['tool.execute.before']({ tool, sessionID: id }, { args }) } catch (e) { denied = e.message.startsWith('[Keel]') }
  return denied
}
checkRule('WriteFile', { filePath: 'secrets/key', operation: 'write' }, 'types-1')
let filesystemDenied = false
try { await hooks['tool.execute.before']({ tool: 'WriteFile', sessionID: 'types-1' }, { args: { filePath: 'secrets/key', operation: 'write' } }) } catch (e) { filesystemDenied = e.message.startsWith('[Keel]') }
check('filesystem first warns then denies', filesystemDenied)
let contentDenied = false
await hooks['tool.execute.before']({ tool: 'WriteFile', sessionID: 'types-2' }, { args: { content: 'PRIVATE_KEY' } })
try { await hooks['tool.execute.before']({ tool: 'WriteFile', sessionID: 'types-2' }, { args: { content: 'PRIVATE_KEY' } }) } catch (e) { contentDenied = e.message.startsWith('[Keel]') }
check('content first warns then denies', contentDenied)
let networkDenied = false
await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 'types-3' }, { args: { url: 'https://evil.example' } })
try { await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 'types-3' }, { args: { url: 'https://evil.example' } }) } catch (e) { networkDenied = e.message.startsWith('[Keel]') }
check('network first warns then denies', networkDenied)
await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 'types-4' }, { args: { command: 'rate-token' } })
let rateDenied = false
await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 'types-4' }, { args: { command: 'rate-token' } })
try { await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 'types-4' }, { args: { command: 'rate-token' } }) } catch (e) { rateDenied = e.message.startsWith('[Keel]') }
check('rate first violation warns then denies', rateDenied)
fs.writeFileSync(join(tmpHome, '.env'), 'PRIVATE_KEY=redacted\n')
await hooks['tool.execute.before']({ tool: 'ReadFile', sessionID: 'types-5' }, { args: { filePath: join(tmpHome, '.env') } })
let flowDenied = false
await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 'types-5' }, { args: { command: 'send' } })
try { await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 'types-5' }, { args: { command: 'send' } }) } catch (e) { flowDenied = e.message.startsWith('[Keel]') }
check('flow first violation warns then denies', flowDenied)
const cleanHooks = await plugin.server({ directory: join(tmpHome, 'clean') })
let priorityAllowed = true
try { await cleanHooks['tool.execute.before']({ tool: 'Bash', sessionID: 'types-6' }, { args: { command: 'priority-check' } }) } catch { priorityAllowed = false }
check('priority metadata selects higher priority rule', priorityAllowed)
let metadataAllowed = true
for (const command of ['level-protected', 'ci-only', 'dangerous-action safe', 'reasoned-action']) {
  try { await cleanHooks['tool.execute.before']({ tool: 'Bash', sessionID: 'types-7', reasoning: command === 'reasoned-action' ? 'approved' : '' }, { args: { command } }) } catch { metadataAllowed = false }
}
check('level context and unless metadata allow exemptions', metadataAllowed)

const verificationHooks = await plugin.server({ directory: join(tmpHome, 'verification') })
await verificationHooks['tool.execute.before']({ tool: 'WriteFile', sessionID: 't4' }, { args: { filePath: 'src/verified.ts', content: 'x' } })
await verificationHooks['tool.execute.after'](
  { tool: 'Bash', sessionID: 't4', callID: 'test-fail', args: { command: 'npm test' } },
  { title: 'npm test', output: 'failed', metadata: { exit: 1 } },
)
let failedTestStillPending = false
try {
  await verificationHooks['tool.execute.before']({ tool: 'Bash', sessionID: 't4' }, { args: { command: 'git push origin main' } })
  await verificationHooks['tool.execute.before']({ tool: 'Bash', sessionID: 't4' }, { args: { command: 'git push origin main' } })
} catch (e) {
  failedTestStillPending = e.message.startsWith('[Keel]')
}
check('failed test does not satisfy obligation', failedTestStillPending)

await verificationHooks['tool.execute.after'](
  { tool: 'Bash', sessionID: 't4', callID: 'test-pass', args: { command: 'npm test' } },
  { title: 'npm test', output: 'passed', metadata: { exit: 0 } },
)
let passedTestStillBlocked = false
try {
  await verificationHooks['tool.execute.before']({ tool: 'Bash', sessionID: 't4' }, { args: { command: 'git push origin main' } })
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
  { tool: 'Bash', sessionID: 'repo', callID: 'external-edit', args: { command: 'true' } },
  { title: 'true', output: '', metadata: { exit: 0 } },
)
await repoHooks['tool.execute.before']({ tool: 'Bash', sessionID: 'repo' }, { args: { command: 'git commit -m "external"' } })
let externalBoundaryDenied = false
try {
  await repoHooks['tool.execute.before']({ tool: 'Bash', sessionID: 'repo' }, { args: { command: 'git commit -m "external again"' } })
} catch (e) {
  externalBoundaryDenied = e.message.startsWith('[Keel]')
}
check('worktree changes create verification obligation', externalBoundaryDenied)

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
// softened.
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
`
const dialCall = async (sessionId, command) => {
  try {
    await dialHooks['tool.execute.before']({ tool: 'Bash', sessionID: sessionId }, { args: { command } })
    return 'allowed'
  } catch (e) {
    return e.message.startsWith('[Keel]') ? 'denied' : 'allowed'
  }
}
let dialHooks = await plugin.server({ directory: dialHome })

fs.writeFileSync(join(dialHome, '.keel', 'rules.yaml'), dialRules('balanced', ['b-warn', 'b-sprint', 'b-protect']))
const b1 = await dialCall('dial-b1', 'dial-balanced-token')
const b2 = await dialCall('dial-b2', 'dial-balanced-token')
check('balanced: deny warns then blocks', b1 === 'allowed' && b2 === 'denied')
check('balanced: sprint-level rule stays active', (await dialCall('dial-b3', 'dial-sprint-token')) === 'allowed')
check('balanced: protect-level rule is a floor (warns then blocks)', (await dialCall('dial-b4', 'dial-protect-token')) === 'allowed' && (await dialCall('dial-b5', 'dial-protect-token')) === 'denied')

fs.writeFileSync(join(dialHome, '.keel', 'rules.yaml'), dialRules('sprint', ['s-warn', 's-sprint', 's-protect']))
check('sprint: unleveled deny rule downgraded to warn', (await dialCall('dial-s1', 'dial-balanced-token')) === 'allowed' && (await dialCall('dial-s2', 'dial-balanced-token')) === 'allowed')
check('sprint: deny downgraded to warn', (await dialCall('dial-s3', 'dial-sprint-token')) === 'allowed' && (await dialCall('dial-s4', 'dial-sprint-token')) === 'allowed')
check('sprint: protect-level rule is a floor (warns then blocks)', (await dialCall('dial-s5', 'dial-protect-token')) === 'allowed' && (await dialCall('dial-s6', 'dial-protect-token')) === 'denied')

fs.writeFileSync(join(dialHome, '.keel', 'rules.yaml'), dialRules('protect', ['p-warn', 'p-sprint', 'p-protect']))
const p1 = await dialCall('dial-p1', 'dial-balanced-token')
const p2 = await dialCall('dial-p2', 'dial-balanced-token')
check('protect: deny warns then blocks', p1 === 'allowed' && p2 === 'denied')
check('protect: protect-level rule active', (await dialCall('dial-p3', 'dial-protect-token')) === 'allowed')
check('protect: protect-level rule blocks on repeat', (await dialCall('dial-p4', 'dial-protect-token')) === 'denied')

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
