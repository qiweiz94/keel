import { execFileSync } from 'node:child_process'

const root = new URL('..', import.meta.url)
const packages = ['core', 'cli', 'opencode-plugin']

for (const name of packages) {
  const cwd = new URL(`../packages/${name}/`, import.meta.url)
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd, encoding: 'utf8' })
  const metadata = JSON.parse(output)[0]
  const bad = metadata.files
    .map(file => file.path)
    .filter(file => file.includes('__tests__') || file.includes('dist/core/dist') || file.includes('dist/core/src'))
  if (bad.length) throw new Error(`${metadata.name} contains forbidden release files: ${bad.join(', ')}`)
  console.log(`${metadata.name}@${metadata.version}: ${metadata.entryCount} clean files`)
}
