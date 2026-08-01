import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url)
const packageNames = ['core', 'cli', 'opencode-plugin']
const packages = packageNames.map(name => JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8')))

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const maxAttempts = Number(process.env.KEEL_RETRY_MAX_ATTEMPTS || 10)
const baseDelayMs = Number(process.env.KEEL_RETRY_BASE_MS || 5000)
let confirmed = false
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    for (const pkg of packages) {
      const published = execFileSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], { encoding: 'utf8' }).trim()
      if (published !== pkg.version) throw new Error(`${pkg.name}@${pkg.version} was not confirmed on npm`)
    }
    confirmed = true
    break
  } catch (err) {
    if (attempt === maxAttempts) throw err
    const delay = Math.min(60_000, baseDelayMs * 2 ** (attempt - 1))
    console.error(`npm registry propagation pending (attempt ${attempt}/${maxAttempts}); retrying in ${delay / 1000}s: ${err.message}`)
    sleepSync(delay)
  }
}
if (!confirmed) throw new Error(`Failed to confirm published versions after ${maxAttempts} attempts`)

const install = mkdtempSync(join(tmpdir(), 'keel-published-'))
execFileSync('npm', ['init', '-y', '--prefix', install], { cwd: root, stdio: 'ignore' })
execFileSync('npm', ['install', '--prefix', install, ...packages.map(pkg => `${pkg.name}@${pkg.version}`)], { cwd: root, stdio: 'ignore' })

const cli = execFileSync('node', [join(install, 'node_modules/@get-keel/cli/dist/index.js'), '--version'], { encoding: 'utf8' }).trim()
const expectedCli = packages.find(pkg => pkg.name === '@get-keel/cli').version
if (cli !== expectedCli) throw new Error(`Published CLI returned ${cli}; expected ${expectedCli}`)

execFileSync('node', ['-e', "import('@get-keel/opencode-plugin').then(m => { if (m.default?.id !== 'keel-enforce') process.exit(1) })"], {
  cwd: install,
  encoding: 'utf8',
})
execFileSync('npm', ['audit', '--prefix', install, '--omit=dev'], { cwd: root, stdio: 'inherit' })
console.log(`Published package verification passed: CLI ${cli}, plugin keel-enforce`)
