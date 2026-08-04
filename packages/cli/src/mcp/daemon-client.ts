import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { loadDaemonState, daemonTokenPath } from '../commands/daemon.js'
import type { EnforceInput, EnforceResult } from '../core/types.js'

/**
 * Thin client for the keel daemon — the ONLY way integrations should talk
 * to the enforcement engine. If the daemon is not running, `ensureDaemon`
 * spawns it detached (auto-spawn: zero-config lifecycle) and waits for
 * health.
 */

function cliEntry(): string {
  if (process.env.KEEL_CLI_ENTRY) return process.env.KEEL_CLI_ENTRY
  const argv1 = process.argv[1]
  if (argv1 && argv1.endsWith('index.js') && !argv1.includes('vitest')) return argv1
  return 'keel'
}

export async function daemonHealth(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    })
    return res.status === 200
  } catch {
    return false
  }
}

let pendingSpawn: Promise<{ port: number; token: string }> | null = null

/**
 * Ensure the daemon is running. Concurrent callers share ONE spawn: the
 * token file is created atomically (wx — the loser reads the winner's
 * token), and a single in-flight spawn promise is awaited by everyone, so
 * back-to-back checks never race the token file or spawn two daemons.
 */
export function ensureDaemon(): Promise<{ port: number; token: string }> {
  if (!pendingSpawn) {
    pendingSpawn = doEnsureDaemon().finally(() => {
      pendingSpawn = null
    })
  }
  return pendingSpawn
}

async function doEnsureDaemon(): Promise<{ port: number; token: string }> {
  const tokenPath = daemonTokenPath()
  if (!existsSync(tokenPath)) {
    // Atomic exclusive create: only one caller wins; the loser falls
    // through to read the winner's token (never two tokens for one file).
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { randomBytes } = await import('node:crypto')
    mkdirSync(join(homedir(), '.keel'), { recursive: true })
    try {
      writeFileSync(tokenPath, randomBytes(24).toString('hex') + '\n', { flag: 'wx', mode: 0o600 })
    } catch { /* already created by a concurrent caller — read it below */ }
  }
  const token = readFileSync(tokenPath, 'utf-8').trim()

  const state = loadDaemonState()
  if (state && (await daemonHealth(state.port, token))) return { port: state.port, token }

  // Auto-spawn detached on a dynamic port (avoids collisions with a stale
  // daemon); the daemon writes ~/.keel/daemon.json with its real port and
  // pid, which we verify before trusting it. A .js entry is executed via
  // node (the file may lack the executable bit); a PATH binary runs
  // directly.
  let childPid: number | undefined
  try {
    const entry = cliEntry()
    const isScript = entry.endsWith('.js') || entry.endsWith('.mjs')
    const command = isScript ? process.execPath : entry
    const args = isScript ? [entry, 'daemon', '--port', '0'] : ['daemon', '--port', '0']
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {}) // swallowed; the health loop below reports failure
    child.unref()
    childPid = child.pid
  } catch {}
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const current = loadDaemonState()
    if (current && (childPid === undefined || current.pid === childPid) && (await daemonHealth(current.port, token))) {
      return { port: current.port, token }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('keel daemon did not start (run `keel daemon` in a terminal and check ~/.keel/daemon.json)')
}

export async function daemonCheck(input: Partial<EnforceInput> & { cwd?: string }): Promise<EnforceResult> {
  const { port, token } = await ensureDaemon()
  const res = await fetch(`http://127.0.0.1:${port}/v1/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`keel daemon check failed (${res.status})`)
  return (await res.json()) as EnforceResult
}

export async function daemonRequirements(cwd: string): Promise<string> {
  const { port, token } = await ensureDaemon()
  const res = await fetch(`http://127.0.0.1:${port}/v1/requirements?cwd=${encodeURIComponent(cwd)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`keel daemon requirements failed (${res.status})`)
  const body = (await res.json()) as { content: string }
  return body.content
}
