import { describe, it, expect, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * Sprint 2 — `@get-keel/mcp-server` is deprecated (package.json,
 * AGENTS.md: "Never publish MCP; packages/mcp-server is private and
 * deprecated") and superseded by `keel serve`
 * (packages/cli/src/mcp/server.ts). Rather than keep patching real,
 * reachable bugs in a package that is supposed to be going away
 * (fail-closed drift vs the CLI, fake success on unknown tool names, a
 * broken HTTP transport, a path-traversal oracle in `keel_check`), the
 * entry point (src/index.ts) now refuses to run at all.
 *
 * This file proves that refusal directly and minimally — no JSON-RPC
 * payload, no stdin interaction, nothing sent to the process at all —
 * because the guard fires before any of that would matter. It is deliberately
 * independent of degenerate-input.test.ts, which proves the SAME refusal is
 * unconditional across a sweep of previously-meaningful input shapes; this
 * file is the direct "does the entry point refuse to run" check called for
 * by the deprecation fix itself.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', '..', 'dist', 'index.js')

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keel-mcp-deprecation-'))
  dirs.push(dir)
  return dir
}

/** Spawns the real built binary with a closed stdin and captures the result. */
function spawnServer(cwd: string, extraArgs: string[] = []): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, ...extraArgs], {
      cwd,
      env: { ...process.env, HOME: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`mcp-server did not exit within 10s. stdout: ${stdout} stderr: ${stderr}`))
    }, 10_000)
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
    child.on('error', reject)
  })
}

describe('mcp-server entry point: refuses to run (deprecation guard)', () => {
  it('exits non-zero with no stdout and a stderr message pointing at `keel serve`, with no input at all', async () => {
    const home = tempHome()
    const { stdout, stderr, code } = await spawnServer(home)
    expect(code).not.toBe(0)
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('deprecated')
    expect(stderr).toContain('keel serve')
    expect(stderr).toContain('@get-keel/mcp-server')
  })

  it('refuses to run even when a valid `.keel.yaml` is present — the guard fires ahead of policy loading, not because policy is missing', async () => {
    const home = tempHome()
    writeFileSync(
      join(home, '.keel.yaml'),
      "version: '1.0'\ncommand_rules: []\n",
      'utf-8'
    )
    const { stdout, stderr, code } = await spawnServer(home)
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('deprecated')
  })

  it('refuses to run under `--transport http` too — the guard is not stdio-only', async () => {
    const home = tempHome()
    const { stdout, stderr, code } = await spawnServer(home, ['--transport', 'http'])
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('deprecated')
  })

  it('the stderr message is a single well-formed line, not a stack trace or partial write', async () => {
    const home = tempHome()
    const { stderr } = await spawnServer(home)
    const lines = stderr.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^packages\/@get-keel\/mcp-server is deprecated/)
  })
})
