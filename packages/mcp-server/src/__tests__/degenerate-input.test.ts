import { describe, it, expect, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * v1 M1r-2 — the degenerate-input fail-closed sweep, mcp-server's slice.
 *
 * HISTORY: this file originally proved that `@get-keel/mcp-server`'s
 * `handleToolCallCommon` (src/index.ts) failed closed on degenerate
 * `keel_check` input (missing `action`/`target`, a `tools/call` with no
 * tool name at all) instead of silently reading back "POLICY OK". Two real
 * gaps were fixed and proven end-to-end through the real built binary
 * (dist/index.js) over its real JSON-RPC/stdio transport.
 *
 * SPRINT 2 UPDATE: `@get-keel/mcp-server` is deprecated (package.json,
 * AGENTS.md) and superseded by `keel serve` (packages/cli/src/mcp/server.ts).
 * Rather than keep patching bugs in a package that is going away, the entry
 * point (src/index.ts) now refuses to run at all — it writes a deprecation
 * message to stderr and calls `process.exit(1)` as the first thing that
 * executes, before `loadPolicy()`, before `startStdioServer()`, before
 * `handleToolCallCommon` is ever reachable. That fail-closed logic proven
 * below is now unreachable dead code, kept (not deleted) only so it survives
 * if this package is ever revived — see the comment block in src/index.ts.
 *
 * This file is NOT deleted, because it still proves something real: the
 * refusal is unconditional and fires BEFORE any of these previously
 * distinguishing input shapes are read or parsed — a degenerate `keel_check`
 * call, a complete `keel_check` call that would have blocked, a complete
 * call that would have allowed, and unparseable JSON-RPC all now produce
 * the IDENTICAL outcome (refusal, no stdout, exit 1), because the guard
 * fires ahead of `stdin` even being consumed. That "same outcome regardless
 * of payload" property is exactly what would break if a future edit moved
 * the guard below any per-request branching. A dedicated,
 * input-shape-agnostic version of this same assertion lives in
 * deprecation-guard.test.ts.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', '..', 'dist', 'index.js')

const dirs: string[] = []
/** A fresh temp dir doubling as HOME/cwd, with a `.keel.yaml` policy inside it. */
function policyHome(yaml: string): { dir: string; policyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'keel-mcp-degenerate-'))
  const policyPath = join(dir, '.keel.yaml')
  writeFileSync(policyPath, yaml, 'utf-8')
  dirs.push(dir)
  return { dir, policyPath }
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/**
 * Spawns the real built binary, writes one JSON-RPC request to its stdin,
 * and captures stdout/stderr/exit code. Since the deprecation guard exits
 * before ever reading stdin, the request body no longer changes the
 * outcome — it is still sent (rather than trimmed to an empty spawn) so
 * these tests keep proving that fact, not assuming it.
 */
function callServer(
  home: { dir: string; policyPath: string },
  request: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: home.dir,
      env: { ...process.env, HOME: home.dir, KEEL_POLICY: home.policyPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`mcp-server did not exit within 10s. stderr: ${stderr}`))
    }, 10_000)
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
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

describe('mcp-server: deprecation guard fires before degenerate-input handling (was: v1 M1r-2)', () => {
  it('keel_check with NEITHER action nor target: refuses to run, no POLICY OK/BLOCKED response is produced at all', async () => {
    const home = policyHome(POLICY_YAML)
    const { stdout, stderr, code } = await callServer(home, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'keel_check', arguments: {} },
    })
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('deprecated')
    expect(stderr).toContain('keel serve')
  })

  it('keel_check with action present but target MISSING: still refuses to run — the guard does not depend on which arg is missing', async () => {
    const home = policyHome(POLICY_YAML)
    const { stdout, stderr, code } = await callServer(home, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'keel_check', arguments: { action: 'bash' } },
    })
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('deprecated')
  })

  it('a tools/call with NO tool name at all (malformed params): still refuses to run — PolicyEngine\'s degenerate-tool_name guard is never reached', async () => {
    const home = policyHome(POLICY_YAML)
    const { stdout, stderr, code } = await callServer(home, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { arguments: { command: 'rm -rf /' } },
    })
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('deprecated')
  })

  it('a COMPLETE keel_check call that would have BLOCKED under the old policy engine: still just refuses to run, same as any other input', async () => {
    const home = policyHome(POLICY_YAML)
    const { stdout, stderr, code } = await callServer(home, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'keel_check', arguments: { action: 'bash', target: 'rm -rf /' } },
    })
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('deprecated')
  })

  it('a COMPLETE keel_check call that would have ALLOWED under the old policy engine: still just refuses to run — this is not a new global deny, it is a refusal to serve at all', async () => {
    const home = policyHome(POLICY_YAML)
    const { stdout, stderr, code } = await callServer(home, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'keel_check', arguments: { action: 'bash', target: 'ls -la' } },
    })
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('deprecated')
  })

  it('malformed JSON-RPC (unparseable line): still refuses to run — the guard fires before stdin is even read, so it is never reached as a parse error', async () => {
    const home = policyHome(POLICY_YAML)
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [SERVER], {
        cwd: home.dir,
        env: { ...process.env, HOME: home.dir, KEEL_POLICY: home.policyPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')) }, 10_000)
      child.stdout.on('data', (c) => { stdout += c.toString() })
      child.stderr.on('data', (c) => { stderr += c.toString() })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ stdout, stderr, code })
      })
      child.on('error', reject)
      child.stdin.write('not json at all {{{\n')
      child.stdin.end()
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('deprecated')
  })
})
