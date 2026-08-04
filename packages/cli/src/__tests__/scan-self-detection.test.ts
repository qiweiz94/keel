import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * `keel scan` reports which agent hosts are installed and unprotected. If
 * keel's OWN installer creates the directory scan uses to detect a host,
 * then running `keel install` makes scan claim the host exists — a false
 * positive on the single claim the command is built to make.
 *
 * `cline`, `openclaw` and `hermes` were fixed for this once, and the guard
 * written alongside them asserted exactly those three names. It stayed green
 * while `gemini-cli` and `codex` kept detecting on `~/.gemini` and `~/.codex`
 * — the very directories `install.ts` creates hooks inside. A guard shaped
 * around the bugs you already found cannot find the next one.
 *
 * So this asserts the PROPERTY, behaviourally, for every host the installer
 * supports: install it into an empty HOME, then scan, and it must still be
 * reported absent. Source inspection was tried first and could not tell a
 * path keel reads (`~/.config/opencode`) from one it writes.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js')

/** Host flags `keel install --<flag>` accepts, read from the registration. */
function installFlags(): string[] {
  const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')
  const block = src.slice(src.indexOf(".command('install')"))
  return [...block.slice(0, block.indexOf('.action(')).matchAll(/\.option\('--([a-z-]+)'/g)]
    .map(m => m[1])
    .filter(f => !['project', 'mcp', 'all'].includes(f))
}

/** `--gemini` installs the host `keel scan` calls `gemini-cli`. */
const SCAN_KEY: Record<string, string> = { gemini: 'gemini-cli' }

function run(args: string[], home: string, cwd: string): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf-8',
  })
}

describe('keel install must not make keel scan hallucinate a host', () => {
  it.each(installFlags())('installing --%s does not make scan report it present', (flag) => {
    const home = mkdtempSync(join(tmpdir(), 'keel-selfdetect-home-'))
    const project = mkdtempSync(join(tmpdir(), 'keel-selfdetect-proj-'))
    try {
      try {
        run(['install', `--${flag}`], home, project)
      } catch {
        // An installer that fails outright still must not fool scan.
      }
      const out = run(['scan', '--dir', project, '--json'], home, project)
      const report = JSON.parse(out) as { tools: Array<{ name: string; installed: boolean }> }
      const host = report.tools.find(t => t.name === (SCAN_KEY[flag] ?? flag))
      // A host with no scan entry at all is fine here — that is the drift
      // test's business. What must never happen is `installed: true`.
      expect(host?.installed ?? false).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    }
  })
})
