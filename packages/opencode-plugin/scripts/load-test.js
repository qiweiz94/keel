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
`)
const hooks = await plugin.server({ directory: join(tmpHome, 'proj') })

const expected = ['tool.execute.before', 'tool.execute.after', 'experimental.chat.system.transform', 'experimental.session.compacting']
check('all plugin hooks', expected.every(h => typeof hooks?.[h] === 'function'))

// Self-bootstrap writes default rules.
check('self-bootstrap rules.yaml', fs.existsSync(join(tmpHome, '.keel', 'rules.yaml')))

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

await hooks['tool.execute.before']({ tool: 'WriteFile', sessionID: 't4' }, { args: { filePath: 'src/verified.ts', content: 'x' } })
await hooks['tool.execute.after'](
  { tool: 'Bash', sessionID: 't4', callID: 'test-fail', args: { command: 'npm test' } },
  { title: 'npm test', output: 'failed', metadata: { exit: 1 } },
)
let failedTestStillPending = false
try {
  await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 't4' }, { args: { command: 'git push origin main' } })
} catch (e) {
  failedTestStillPending = e.message.startsWith('[Keel]')
}
check('failed test does not satisfy obligation', failedTestStillPending)

await hooks['tool.execute.after'](
  { tool: 'Bash', sessionID: 't4', callID: 'test-pass', args: { command: 'npm test' } },
  { title: 'npm test', output: 'passed', metadata: { exit: 0 } },
)
let passedTestStillBlocked = false
try {
  await hooks['tool.execute.before']({ tool: 'Bash', sessionID: 't4' }, { args: { command: 'git push origin main' } })
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

// dist is byte-identical to the canonical template.
check('dist matches canonical template', readFileSync(DIST, 'utf-8') === readFileSync(TEMPLATE, 'utf-8'))

fs.rmSync(tmpHome, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll checks passed')
