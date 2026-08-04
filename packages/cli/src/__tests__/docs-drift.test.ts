import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOSTS } from '../commands/hook.js'

/**
 * Three surfaces advertise which hosts keel supports: the README, the
 * postinstall banner, and the CLI's own --help. They drifted apart once
 * already — `gemini`, `openclaw` and `hermes` shipped working installers
 * while appearing in NONE of the user-facing text, so as far as any reader
 * was concerned the feature did not exist.
 *
 * Documentation drift is invisible to every other test in this repo, which
 * is exactly why it needs its own.
 */

const REPO = join(__dirname, '..', '..', '..', '..')
const CLI = join(__dirname, '..', '..')

const read = (p: string) => readFileSync(p, 'utf-8')

/** Hosts `keel install --<flag>` accepts, read from the command registration. */
function installFlags(): string[] {
  const src = read(join(CLI, 'src', 'index.ts'))
  const block = src.slice(src.indexOf(".command('install')"))
  const end = block.indexOf('.action(')
  return [...block.slice(0, end).matchAll(/\.option\('--([a-z-]+)'/g)]
    .map(m => m[1])
    .filter(f => !['project', 'mcp', 'all', 'force', 'global'].includes(f))
}

/** Host keys `keel scan` can detect, read from its AGENT_PATHS table. */
function scanHosts(): string[] {
  const src = read(join(CLI, 'src', 'commands', 'scan.ts'))
  const start = src.indexOf('const AGENT_PATHS')
  const end = src.indexOf('function parseMCPConfig')
  return [...src.slice(start, end).matchAll(/^ {2}'([a-z0-9-]+)':/gm)].map(m => m[1])
}

/** `--gemini` installs to the host `keel scan` calls `gemini-cli`. */
const SCAN_KEY: Record<string, string> = { gemini: 'gemini-cli' }

describe('user-facing docs match the shipped install flags', () => {
  const flags = installFlags()

  it('finds the install flags at all (guards the parser itself)', () => {
    // If this regex ever stops matching, every assertion below would pass
    // vacuously — the classic way a drift test rots into a no-op.
    expect(flags.length).toBeGreaterThanOrEqual(6)
    expect(flags).toContain('opencode')
    expect(flags).toContain('gemini')
  })

  it.each(installFlags())('README documents --%s', (flag) => {
    expect(read(join(REPO, 'README.md'))).toContain(`--${flag}`)
  })

  it.each(installFlags())('postinstall banner documents --%s', (flag) => {
    expect(read(join(CLI, 'src', 'postinstall.ts'))).toContain(`--${flag}`)
  })

  it('the hook command help lists every host it accepts', () => {
    const src = read(join(CLI, 'src', 'index.ts'))
    const help = src.slice(src.indexOf(".command('hook')"))
    const argLine = help.slice(help.indexOf(".argument('<host>'"), help.indexOf('.option('))
    for (const host of HOSTS) {
      expect(argLine).toContain(host)
    }
  })

  // `keel scan` reports "N agent hosts can run tools with no enforcement".
  // A host missing from its detection table is silently excluded from that
  // count — the tool under-reports on the one claim it exists to make, and
  // says nothing to indicate it did. cline, openclaw and hermes shipped
  // working installers while being invisible to scan for exactly this reason.
  it.each(installFlags())('keel scan can detect the --%s host', (flag) => {
    expect(scanHosts()).toContain(SCAN_KEY[flag] ?? flag)
  })

  it('finds scan’s host table at all (guards the parser itself)', () => {
    const hosts = scanHosts()
    expect(hosts.length).toBeGreaterThanOrEqual(8)
    expect(hosts).toContain('opencode')
  })

  // `keel install --cline` creates ~/.cline/hooks/ and `--openclaw` creates
  // ~/.openclaw/plugins/keel/. If scan's installCheck were the bare parent
  // directory, installing keel would make scan report the host as present —
  // a false positive on the very claim scan exists to make. installCheck
  // must name something only the HOST writes.
  it.each(['cline', 'openclaw', 'hermes'])(
    'scan detects %s by a host-owned file, not the directory keel installs into',
    (host) => {
      const src = read(join(CLI, 'src', 'commands', 'scan.ts'))
      const start = src.indexOf(`  '${host}': {`)
      expect(start).toBeGreaterThan(-1)
      const open = src.indexOf('installCheck', start)
      const checks = src.slice(src.indexOf('[', open) + 1, src.indexOf(']', open))

      // Every entry must reach BELOW ~/.<host>, i.e. carry a path segment
      // after the host directory. `join(HOME, '.cline')` alone is the bug:
      // keel's own installer creates that directory.
      const entries = [...checks.matchAll(/join\(([^)]*)\)/g)].map(m => m[1].trim())
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        const segments = entry.split(',').map(s => s.trim()).filter(Boolean)
        expect(segments[0]).toBe('HOME')
        expect(segments[1]).toBe(`'.${host}'`)
        // HOME + '.host' + at least one more segment.
        expect(segments.length).toBeGreaterThanOrEqual(3)
      }
    },
  )

  it('README does not promise commands the CLI does not register', () => {
    const index = read(join(CLI, 'src', 'index.ts'))
    const registered = new Set(
      [...index.matchAll(/\.command\('([a-z-]+)'/g)].map(m => m[1]),
    )
    // Commands the README tells a stranger to run. `keel mcp` was documented
    // for weeks; the command is `keel serve`.
    for (const cmd of ['scan', 'serve', 'install', 'validate', 'audit', 'level', 'allow', 'retrospective', 'dashboard', 'evaluate', 'gather', 'verify']) {
      expect(registered).toContain(cmd)
    }
  })
})
