import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const root = fileURLToPath(new URL('..', import.meta.url))
const workspace = process.argv[2]
if (!workspace) throw new Error('usage: node scripts/publish-if-missing.mjs <workspace-path>')

const pkg = JSON.parse(readFileSync(new URL(`../${workspace}/package.json`, import.meta.url), 'utf8'))
const spec = `${pkg.name}@${pkg.version}`

try {
  const published = execFileSync('npm', ['view', spec, 'version'], { encoding: 'utf8' }).trim()
  if (published === pkg.version) {
    console.log(`${spec} already published; skipping`)
    process.exit(0)
  }
  console.log(`${spec} not confirmed on registry (npm reported "${published}"); proceeding to publish`)
} catch {
  console.log(`${spec} not found on registry; proceeding to publish`)
}

execFileSync('npm', ['publish', '--workspace', workspace, '--access', 'public', '--provenance'], { cwd: root, stdio: 'inherit' })
console.log(`published ${spec}`)
