import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const readPackage = name => JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'))
const core = readPackage('core')
const cli = readPackage('cli')
const plugin = readPackage('opencode-plugin')
const tag = process.argv[2] || process.env.GITHUB_REF_NAME || ''

if (tag && tag !== `v${cli.version}`) {
  throw new Error(`Release tag ${tag} must match CLI version v${cli.version}`)
}

const coreRange = cli.dependencies?.['@get-keel/core'] || ''
if (!coreRange.includes(core.version.replace(/^\^|~/, ''))) {
  throw new Error(`CLI dependency ${coreRange} does not include core ${core.version}`)
}

for (const pkg of [core, cli, plugin]) {
  if (pkg.engines?.node !== '>=22.12.0') {
    throw new Error(`${pkg.name} must declare engines.node >=22.12.0`)
  }
}

for (const pkg of [core, cli, plugin]) {
  try {
    execFileSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'version'], { stdio: 'pipe' })
    console.log(`Note: ${pkg.name}@${pkg.version} already exists on npm; publish will be skipped`)
  } catch (error) {
    const stderr = String(error?.stderr || '')
    if (!stderr.includes('E404') && !stderr.includes('404')) throw error
  }
}

console.log(`Release metadata valid: ${core.name}@${core.version}, ${cli.name}@${cli.version}, ${plugin.name}@${plugin.version}`)
