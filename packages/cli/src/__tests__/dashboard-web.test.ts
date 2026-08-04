import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `keel dashboard --web` security and function tests:
 * - the server refuses to start without a TTY (agent shells have none)
 * - /api/state and /api/dial require the one-time token
 * - a token-authed dial switch actually writes the rules.yaml level
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

/**
 * These tests spawn a real node process that loads the entire CLI bundle.
 * On a cold macOS CI runner that regularly exceeds vitest's 5s default —
 * and worse, 5s is BELOW startServer()'s own 10s timeout, so vitest killed
 * the test before the helper could report why the server never came up.
 */
const SPAWN_TIMEOUT_MS = 30_000

let dir: string
let home: string

beforeEach(() => {
  dir = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
  home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
  mkdirSync(join(home, '.keel'), { recursive: true })
  writeFileSync(join(home, '.keel', 'rules.yaml'), `version: 1
level: balanced
rules:
  - id: sample
    type: command
    match: "sample-token"
    action: deny
    message: "Sample rule"
`, 'utf-8')
})

afterEach(() => {
  execSync(`rm -rf "${dir}" "${home}"`)
})

function startServer(): Promise<{ port: number; token: string; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'dashboard', '--web'], {
      cwd: dir,
      env: { ...process.env, HOME: home, KEEL_DASHBOARD_ALLOW_NON_TTY: '1' },
    })
    let out = ''
    // Must stay BELOW the per-test timeout below, or vitest kills the test
    // first and this descriptive message ("server did not start: <stdout>")
    // is replaced by a bare "Test timed out in 5000ms" that says nothing.
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/#token=([a-f0-9]+)/)
      if (m) {
        clearTimeout(timer)
        resolve({ port: Number(m[1]), token: m[2], kill: () => child.kill() })
      }
    })
    child.on('exit', (code) => clearTimeout(timer) && reject(new Error(`server exited ${code}: ${out}`)))
  })
}

describe('keel dashboard --web', () => {
  it('refuses to start without a TTY', () => {
    let output = ''
    try {
      output = execSync(`node "${CLI}" dashboard --web`, { cwd: dir, env: { ...process.env, HOME: home }, encoding: 'utf-8' })
    } catch (err: any) {
      output = (err.stdout || '') + (err.stderr || '')
    }
    expect(output).toMatch(/own terminal/)
  })

  it('requires the token for /api/state and /api/dial', async () => {
    const server = await startServer()
    try {
      const noAuth = await fetch(`http://127.0.0.1:${server.port}/api/state`)
      expect(noAuth.status).toBe(401)
      const badAuth = await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: { Authorization: 'Bearer wrong' } })
      expect(badAuth.status).toBe(401)
      const good = await fetch(`http://127.0.0.1:${server.port}/api/state`, { headers: { Authorization: `Bearer ${server.token}` } })
      expect(good.status).toBe(200)
      const state = await good.json()
      expect(state.dial).toBe('balanced')
      // The page itself is a static shell and needs no token (it carries
      // the hash-fragment token on API calls instead).
      const page = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(page.status).toBe(200)
    } finally {
      server.kill()
    }
  }, SPAWN_TIMEOUT_MS)

  it('switches the dial through the API and persists it to rules.yaml', async () => {
    const server = await startServer()
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/dial`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: 'protect', target: 'global' }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(readFileSync(join(home, '.keel', 'rules.yaml'), 'utf-8')).toMatch(/^level: protect$/m)
    } finally {
      server.kill()
    }
  }, SPAWN_TIMEOUT_MS)

  it('rejects dial changes without the token', async () => {
    const server = await startServer()
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/dial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: 'protect' }),
      })
      expect(res.status).toBe(401)
    } finally {
      server.kill()
    }
  }, SPAWN_TIMEOUT_MS)
})
