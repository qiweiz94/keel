import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
// Do NOT use `npm init --prefix <dir>` here — confirmed by reproduction
// (see session/v1/EVIDENCE/m5-release.md) that on npm 11.x, `npm init`
// ignores --prefix entirely and writes into the nearest ancestor
// package.json it can find via cwd, which, run with cwd: root from inside
// this workspaces repo, is this repo's OWN root package.json (npm's own
// output literally says "Wrote to <repo-root>/package.json"). That
// corrupted the real root package.json with npm-init's default fields
// plus a dependencies block absorbed from the surrounding workspace tree.
// Writing a trivial package.json directly into `install` sidesteps `npm
// init` entirely — `npm install --prefix` alone respects --prefix
// correctly once a package.json already exists there.
mkdirSync(install, { recursive: true })
writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'keel-tarball-install-sandbox', version: '1.0.0', private: true }) + '\n')
execFileSync('npm', ['install', '--prefix', install, ...tarballs.map(file => join(temporary, file))], { cwd: root, stdio: 'ignore' })

const cli = execFileSync('node', [join(install, 'node_modules/@get-keel/cli/dist/index.js'), '--version'], { encoding: 'utf8' }).trim()
if (!cli) throw new Error('Clean tarball CLI did not return a version')

execFileSync('node', ['-e', "import('@get-keel/opencode-plugin').then(m => { if (m.default?.id !== 'keel-enforce') process.exit(1) })"], {
  cwd: install,
  encoding: 'utf8',
})
execFileSync('npm', ['audit', '--prefix', install, '--omit=dev'], { cwd: root, stdio: 'inherit' })
console.log(`Clean tarball install passed: CLI ${cli}, plugin keel-enforce`)
