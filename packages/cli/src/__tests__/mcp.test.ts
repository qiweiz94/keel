import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { execSync, spawn, ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stage 2: the MCP layer is a thin client of the keel daemon.
 *
 * - `keel serve` (stdio MCP) auto-spawns the daemon, exposes keel_check /
 *   keel_audit / keel_requirements, and returns the SAME warn-once /
 *   deny-repeat escalation the OpenCode plugin gives (shared state).
 * - `keel gateway` enforces every forwarded MCP tool call through the
 *   daemon before the upstream server runs it.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI = join(HERE, '..', '..', 'dist', 'index.js')

let home: string
let project: string
let previousHome: string | undefined

const RULES = `version: 1
level: balanced
rules:
  - id: demo-deny
    type: command
    match: "demo-token"
    action: deny
    message: "Demo deny rule"
`

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'keel-test-'))
  project = mkdtempSync(join(tmpdir(), 'keel-test-'))
  mkdirSync(join(project, '.keel'), { recursive: true })
  writeFileSync(join(project, '.keel', 'rules.yaml'), RULES, 'utf-8')
  previousHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true })
})

afterAll(() => {
  // A detached daemon may have been auto-spawned by the tests; stop it.
  try {
    if (home) {
      const { loadDaemonState, daemonStatePath } = require('../commands/daemon.js')
      const { readFileSync } = require('node:fs')
      const path = daemonStatePath()
      const state = JSON.parse(readFileSync(path, 'utf-8'))
      if (state?.pid) process.kill(state.pid, 'SIGTERM')
    }
  } catch {}
})

/** Speak newline-delimited JSON-RPC over a child's stdio. */
function rpcClient(child: ChildProcess, messages: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const responses: Array<Record<string, unknown>> = []
    const expected = messages.length
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          responses.push(JSON.parse(line))
          if (responses.length === expected) {
            child.stdout!.off('data', onData)
            resolve(responses)
          }
        } catch {
          // non-JSON banner lines (CLI startup output) are ignored
        }
      }
    }
    child.stdout!.on('data', onData)
    child.on('error', reject)
    child.stderr!.on('data', () => {})
    for (const msg of messages) child.stdin!.write(JSON.stringify(msg) + '\n')
  })
}

describe('keel serve (MCP stdio, thin client of the daemon)', () => {
  it('handshakes, lists tools, and enforces with shared escalation state', async () => {
    const child = spawn(process.execPath, [CLI, 'serve'], { cwd: project, env: { ...process.env, HOME: home } })
    const responses = await rpcClient(child, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'keel_check', arguments: { tool: 'Bash', args: { command: 'demo-token' }, cwd: project, session_id: 'mcp-1' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'keel_check', arguments: { tool: 'Bash', args: { command: 'demo-token' }, cwd: project, session_id: 'mcp-1' } } },
    ])
    expect(responses[0].result?.serverInfo?.name).toBe('keel')
    const tools = (responses[1].result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    expect(tools).toContain('keel_check')
    expect(tools).toContain('keel_audit')
    expect(tools).toContain('keel_requirements')
    expect(tools).toContain('keel_research')
    expect(tools).toContain('keel_fetch')
    expect(tools).toContain('keel_search_cache')
    expect(tools).toContain('keel_hypothesis')

    const first = (responses[2].result as { content: Array<{ text: string }> }).content[0].text
    expect(first).toMatch(/VERDICT: warn/)
    const second = (responses[3].result as { content: Array<{ text: string }> }).content[0].text
    expect(second).toMatch(/VERDICT: deny/)
    child.kill()
  }, 20000)
})

describe('keel gateway (enforcement proxy on the daemon contract)', () => {
  it('blocks policy-violating tool calls before they reach the upstream', async () => {
    const upstreamLog = join(home, 'upstream.log')
    const upstreamScript = join(home, 'upstream.cjs')
    writeFileSync(upstreamScript, `const readline = require('node:readline')
const fs = require('node:fs')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  fs.appendFileSync(${JSON.stringify(upstreamLog)}, msg.method + (msg.params && msg.params.name ? ':' + msg.params.name : '') + '\\n')
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }) + '\\n')
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'danger', description: 'dangerous', inputSchema: { type: 'object', properties: {} } }, { name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n')
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'FORWARDED:' + msg.params.name }] } }) + '\\n')
  }
})
`, 'utf-8')

    const child = spawn(process.execPath, [CLI, 'gateway', '--command', `node ${upstreamScript}`], {
      cwd: project,
      env: { ...process.env, HOME: home },
    })
    const responses = await rpcClient(child, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      // Balanced dial: the FIRST violation warns (and forwards), the repeat
      // is blocked before it reaches the upstream.
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'danger', arguments: { command: 'demo-token' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'danger', arguments: { command: 'demo-token' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: {} } },
    ])

    const listed = (responses[1].result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    expect(listed).toContain('danger')

    const first = (responses[2].result as { content: Array<{ text: string }> }).content[0].text
    expect(first).toMatch(/FORWARDED:danger/)

    const second = (responses[3].result as { content: Array<{ text: string }> }).content[0].text
    expect(second).toMatch(/POLICY BLOCKED/)
    expect(second).toMatch(/Demo deny rule/)

    const echo = (responses[4].result as { content: Array<{ text: string }> }).content[0].text
    expect(echo).toMatch(/FORWARDED:echo/)

    // The upstream saw the warning-pass only — the blocked repeat never ran.
    await new Promise((r) => setTimeout(r, 300))
    const log = existsSync(upstreamLog) ? readFileSync(upstreamLog, 'utf-8') : ''
    expect((log.match(/tools\/call:danger/g) || [])).toHaveLength(1)
    expect(log).toContain('tools/call:echo')
    child.kill()
  }, 20000)
})

describe('keel install --mcp', () => {
  it('prints ready-to-paste MCP config snippets', () => {
    const out = execSync(`node "${CLI}" install --mcp`, { cwd: project, env: { ...process.env, HOME: home }, encoding: 'utf-8' })
    expect(out).toContain('keel serve')
    expect(out).toContain('mcp_servers')
    expect(out).toContain('openclaw mcp set')
  })
})
