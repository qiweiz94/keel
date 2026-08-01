import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const temporary = mkdtempSync(join(tmpdir(), 'keel-release-'))
const packages = ['core', 'cli', 'opencode-plugin']
const tarballs = packages.map(name => execFileSync('npm', ['pack', '--silent', '--pack-destination', temporary, '-w', `@get-keel/${name}`], {
  cwd: root,
  encoding: 'utf8',
}).trim().split('\n').at(-1))

const install = join(temporary, 'install')
execFileSync('npm', ['init', '-y', '--prefix', install], { cwd: root, stdio: 'ignore' })
execFileSync('npm', ['install', '--prefix', install, ...tarballs.map(file => join(temporary, file))], { cwd: root, stdio: 'ignore' })

const cli = execFileSync('node', [join(install, 'node_modules/@get-keel/cli/dist/index.js'), '--version'], { encoding: 'utf8' }).trim()
if (!cli) throw new Error('Clean tarball CLI did not return a version')

execFileSync('node', ['-e', "import('@get-keel/opencode-plugin').then(m => { if (m.default?.id !== 'keel-enforce') process.exit(1) })"], {
  cwd: install,
  encoding: 'utf8',
})
execFileSync('npm', ['audit', '--prefix', install, '--omit=dev'], { cwd: root, stdio: 'inherit' })
console.log(`Clean tarball install passed: CLI ${cli}, plugin keel-enforce`)
