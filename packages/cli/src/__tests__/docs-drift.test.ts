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
