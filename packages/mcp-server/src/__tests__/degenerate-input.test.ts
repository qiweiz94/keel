import { describe, it, expect, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * v1 M1r-2 — the degenerate-input fail-closed sweep, mcp-server's slice.
 *
 * `@get-keel/mcp-server` is a live enforcement entry path — the "mcp" host
 * adapter — distinct from `keel hook <host>` (packages/cli/src/commands/
 * hook.ts, covered by fail-closed.test.ts). An agent calls its `keel_check`
 * tool, or any external tool name, over JSON-RPC on stdio; `handleToolCallCommon`
 * (src/index.ts) evaluates the call through the SAME `PolicyEngine` used by
 * `keel check` (.keel.yaml, not .keel/rules.yaml).
 *
 * Two independent gaps existed here, both silent-allow on degenerate input:
 *
 *   1. `PolicyEngine.evaluate()` matched every check
 *      (`event.tool_name === 'bash'`, `... === 'write_file'`, ...) by exact
 *      string equality. An empty/missing tool_name (a malformed `tools/call`
 *      with no `name`, or `keel_check` called with no `action`) matched
 *      NONE of them, so `results` stayed `[]` — read by every caller as
 *      "allowed". Fixed in packages/core/src/policy-engine.ts's evaluate()
 *      with a degenerate-tool_name guard (see policy-engine.test.ts for the
 *      in-process proof).
 *   2. `keel_check`'s own arg contract requires BOTH `action` and `target`
 *      (see getToolDefinitions' inputSchema below), but nothing enforced
 *      that before this lane — a missing `target` alone slipped past #1
 *      (action was still a real, non-empty tool_name) and produced
 *      `command: '', filePath: ''`, which matches no real rule pattern:
 *      a check that checked nothing read back "POLICY OK". Fixed with an
 *      MCP-specific guard in src/index.ts, ahead of `engine.evaluate()`.
 *
 * These are proven here end-to-end, through the REAL built binary
 * (dist/index.js) over its real JSON-RPC/stdio transport — not by importing
 * index.ts directly, which would trigger its top-level `startStdioServer()`
 * side effect (a live `process.stdin.on('data', ...)` listener) outside a
 * real subprocess boundary.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', '..', 'dist', 'index.js')

const dirs: string[] = []
function policyHome(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'keel-mcp-degenerate-'))
  const policyPath = join(dir, '.keel.yaml')
  writeFileSync(policyPath, yaml, 'utf-8')
  dirs.push(dir)
  return policyPath
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** Sends one JSON-RPC request over stdin and reads the one response line back. */
function callServer(policyPath: string, request: Record<string, unknown>): Promise<{ raw: string; parsed: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, KEEL_POLICY: policyPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`mcp-server did not respond within 10s. stderr: ${stderr}`))
    }, 10_000)
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.trim().split('\n').find(Boolean) || ''
      try {
        resolve({ raw: stdout, parsed: JSON.parse(line) })
      } catch (err) {
        reject(new Error(`mcp-server produced non-JSON stdout: ${stdout} (stderr: ${stderr})`))
      }
    })
    child.on('error', reject)
    child.stdin.write(JSON.stringify(request) + '\n')
    child.stdin.end()
  })
}

const POLICY_YAML = `version: '1.0'
command_rules:
  - name: block rm
    patterns:
      - regex: "rm -rf /"
    action: block
    message: "blocked rm -rf /"
`

describe('mcp-server: degenerate input fails closed (v1 M1r-2)', () => {
  it('keel_check with NEITHER action nor target: POLICY BLOCKED, not POLICY OK', async () => {
    const home = policyHome(POLICY_YAML)
    const { parsed } = await callServer(home, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'keel_check', arguments: {} },
    })
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.content[0].text).toContain('POLICY BLOCKED')
    expect(parsed.result.content[0].text).toContain('requires both "action" and "target"')
  })

  it('keel_check with action present but target MISSING: still POLICY BLOCKED — isolates the gap to the missing field, not a broken action', async () => {
    const home = policyHome(POLICY_YAML)
    const { parsed } = await callServer(home, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'keel_check', arguments: { action: 'bash' } },
    })
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.content[0].text).toContain('POLICY BLOCKED')
  })

  it('a tools/call with NO tool name at all (malformed params): POLICY BLOCKED via PolicyEngine\'s own degenerate-tool_name guard', async () => {
    const home = policyHome(POLICY_YAML)
    const { parsed } = await callServer(home, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { arguments: { command: 'rm -rf /' } },
    })
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.content[0].text).toContain('POLICY BLOCKED')
    expect(parsed.result.content[0].text).toContain('No tool identity')
  })

  it('the SAME rule set, a COMPLETE keel_check call, still blocks the normal way — proves this is a degenerate-input guard, not a new global deny', async () => {
    const home = policyHome(POLICY_YAML)
    const { parsed } = await callServer(home, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'keel_check', arguments: { action: 'bash', target: 'rm -rf /' } },
    })
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.content[0].text).toContain('blocked rm -rf /')
  })

  it('a COMPLETE keel_check call for a SAFE command still allows — this does not turn every check into a block', async () => {
    const home = policyHome(POLICY_YAML)
    const { parsed } = await callServer(home, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'keel_check', arguments: { action: 'bash', target: 'ls -la' } },
    })
    expect(parsed.result.isError).toBeUndefined()
    expect(parsed.result.content[0].text).toContain('POLICY OK')
  })

  it('malformed JSON-RPC (unparseable line) gets a JSON-RPC parse error, not a silently-allowed tool call', async () => {
    const home = policyHome(POLICY_YAML)
    const result = await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, [SERVER], {
        env: { ...process.env, KEEL_POLICY: home },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')) }, 10_000)
      child.stdout.on('data', (c) => { stdout += c.toString() })
      child.on('close', () => {
        clearTimeout(timer)
        resolve(JSON.parse(stdout.trim().split('\n').find(Boolean) || '{}'))
      })
      child.on('error', reject)
      child.stdin.write('not json at all {{{\n')
      child.stdin.end()
    })
    expect(result.error).toBeDefined()
    expect(result.error.code).toBe(-32700)
  })
})
