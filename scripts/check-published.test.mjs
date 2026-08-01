import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const checkPublished = join(root, 'scripts', 'check-published.mjs')
const npmCli = process.env.npm_execpath
if (!npmCli) {
  console.error('run via: npm run test:publish-check')
  process.exit(2)
}

const shimDir = mkdtempSync(join(tmpdir(), 'keel-shim-'))
const counter = join(shimDir, 'view-count')
writeFileSync(counter, '0')

const shim = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'view') {
  const counter = ${JSON.stringify(counter)}
  const n = Number(fs.readFileSync(counter, 'utf8'))
  fs.writeFileSync(counter, String(n + 1))
  const failFirst = Number(process.env.SHIM_FAIL_FIRST || 0)
  if (process.env.SHIM_FAIL_VIEW === '1' || n < failFirst) {
    process.stderr.write("npm error code E404\\nnpm error 404 '@get-keel/core@0.0.0' is not in this registry.\\n")
    process.exit(1)
  }
  const at = args[1].lastIndexOf('@')
  const version = args[1].slice(at + 1)
  process.stdout.write(version + '\\n')
  process.exit(0)
}
`
writeFileSync(join(shimDir, 'npm'), shim, { mode: 0o755 })

const baseEnv = {
  ...process.env,
  PATH: `${shimDir}${delimiter}${process.env.PATH}`,
  KEEL_RETRY_MAX_ATTEMPTS: '5',
  KEEL_RETRY_BASE_MS: '1',
  KEEL_SKIP_INSTALL_VERIFY: '1',
}

try {
  execFileSync(process.execPath, [checkPublished], {
    env: { ...baseEnv, SHIM_FAIL_FIRST: '2' }, encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000,
  })
} catch (error) {
  throw new Error(`retry path failed: ${error.message}`)
}
const attempts = Number(readFileSync(counter, 'utf8'))
if (attempts < 3) throw new Error(`expected >=3 view attempts after 2 forced failures, got ${attempts}`)
console.log(`retry path ok: recovered after ${attempts - 1} E404 failures`)

writeFileSync(counter, '0')
let failedClosed = false
try {
  execFileSync(process.execPath, [checkPublished], {
    env: { ...baseEnv, SHIM_FAIL_VIEW: '1' }, encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000,
  })
} catch {
  failedClosed = true
}
if (!failedClosed) throw new Error('expected check-published to fail when the registry never confirms')
console.log('fail-closed path ok: exits non-zero after max attempts')
rmSync(shimDir, { recursive: true, force: true })
