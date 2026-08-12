import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * The adoption hook end to end: `keel scan` finds a genuine, real risk on a
 * machine, tells the user how to fix it (`keel install`), and — once fixed —
 * confirms the fix actually landed on the NEXT scan. Each step is asserted
 * against the real CLI (spawned, not called in-process) because the thing
 * under test is exactly what a first-time user sees on their terminal.
 *
 * The three-part loop this pins:
 *   1. scan on an unprotected host reports it unprotected + cites evidence
 *   2. install actually wires the host AND tells the user to verify it
 *   3. scan on the now-protected host reports it enforced, drops the
 *      agent-unprotected finding, and points at `keel report`
 *
 * A regression in any step breaks the "10-second scan that finds something
 * real, then a low-friction fix" promise the whole command exists for.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js')

function run(args: string[], home: string, cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf-8',
    timeout: 120000,
  })
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'keel-flow-home-'))
  const project = mkdtempSync(join(tmpdir(), 'keel-flow-proj-'))
  // A real risk shape: claude-code's actual on-disk config format
  // (~/.claude.json's `projects.<path>.mcpServers`), carrying one unpinned
  // npx server. This is the exact false negative Format 5's parser fix
  // exists to catch — using a fabricated/simplified shape here would test
  // nothing real.
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      projects: {
        [project]: {
          mcpServers: {
            weather: { command: 'npx', args: ['-y', 'weather-mcp-server'] },
          },
        },
      },
    }),
    'utf-8',
  )
  mkdirSync(join(home, '.claude'), { recursive: true })
  return { home, project, cleanup: () => { rmSafe(home); rmSafe(project) } }
}

describe('scan -> install -> scan happy path', () => {
  it('reports unprotected with evidence, then enforced after install, then points at report', () => {
    const { home, project, cleanup } = fixture()
    try {
      // ── 1. Before install: scan surfaces a real, actionable finding ──
      const before = run(['scan', '--dir', project], home, project)
      expect(before.status).toBe(0)
      expect(before.stdout).toMatch(/unprotected/)
      expect(before.stdout).toMatch(/agent host.*run tools with no enforcement/)
      expect(before.stdout).toMatch(/keel install --all/)
      // The unpinned-package finding must cite its own evidence, not just assert severity.
      expect(before.stdout).toMatch(/weather-mcp-server/)
      // Not protected yet, so the report pointer must not appear — it would be a dangling promise.
      expect(before.stdout).not.toMatch(/keel report/)

      // ── 2. Install wires the host AND tells the user how to verify it ──
      const install = run(['install', '--claude-code'], home, project)
      expect(install.status).toBe(0)
      expect(existsSync(join(project, '.claude', 'hooks', 'PreToolUse', 'keel-enforce'))).toBe(true)
      expect(install.stdout).toMatch(/keel scan.*again/)

      // ── 3. After install: the SAME finding flips, the loop visibly closes ──
      const after = run(['scan', '--dir', project], home, project)
      expect(after.status).toBe(0)
      expect(after.stdout).toMatch(/enforced/)
      expect(after.stdout).not.toMatch(/agent host.*run tools with no enforcement/)
      // The unrelated MCP finding (unpinned package) is not fixed by install
      // and must still be reported — install must not appear to fix
      // something it did not touch.
      expect(after.stdout).toMatch(/weather-mcp-server/)
      // Now that a host is actually enforced, the report pointer should land.
      expect(after.stdout).toMatch(/keel report/)
    } finally {
      cleanup()
    }
  })

  it('keel report has nothing to say before any traces exist, and says so honestly', () => {
    const home = mkdtempSync(join(tmpdir(), 'keel-flow-report-home-'))
    const project = mkdtempSync(join(tmpdir(), 'keel-flow-report-proj-'))
    try {
      const result = run(['report'], home, project)
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/No enforcement traces in this window/)
      // Must not fabricate a zero-looking-like-a-real-summary table when there is nothing to show.
      expect(result.stdout).not.toMatch(/blocked/)
    } finally {
      rmSafe(home)
      rmSafe(project)
    }
  })

  it('a bare `keel install` (no flags) wires no host and must not claim scan will now show one enforced', () => {
    // commander does NOT default `--all` to true despite the option's
    // description saying "(default)" — a bare `keel install` only creates
    // ~/.keel/rules.yaml and traces/. The "run keel scan again, it should
    // now show this host as enforced" line is exactly the promise that
    // breaks here if it fires unconditionally: the user follows it,
    // re-scans, and finds themselves still unprotected.
    const home = mkdtempSync(join(tmpdir(), 'keel-flow-bare-home-'))
    const project = mkdtempSync(join(tmpdir(), 'keel-flow-bare-proj-'))
    try {
      const result = run(['install'], home, project)
      expect(result.status).toBe(0)
      expect(existsSync(join(project, '.claude', 'hooks'))).toBe(false)
      expect(existsSync(join(home, '.opencode', 'plugins'))).toBe(false)
      expect(result.stdout).not.toMatch(/keel scan.*again/)
    } finally {
      rmSafe(home)
      rmSafe(project)
    }
  })
})
