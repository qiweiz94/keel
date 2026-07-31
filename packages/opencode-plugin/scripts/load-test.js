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

const hooks = await plugin.server({ directory: join(tmpHome, 'proj') })

const expected = ['tool.execute.before', 'experimental.chat.system.transform', 'experimental.session.compacting']
check('all three hooks', expected.every(h => typeof hooks?.[h] === 'function'))

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
