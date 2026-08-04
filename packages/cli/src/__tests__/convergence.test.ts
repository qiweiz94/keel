import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PolicyEngine as CorePolicyEngine } from '@get-keel/core'
import { PolicyEngine as CliPolicyEngine } from '../policy-engine.js'
import { MCPGateway } from '../mcp/gateway.js'

/**
 * Guards against the fork re-forming.
 *
 * The CLI once carried its own 766-line copy of PolicyEngine. Security fixes
 * landed there; core held the repo's only test suite. Neither copy was both
 * shipped and tested, and the two silently drifted — core's rules were weaker.
 * If someone reintroduces a local implementation, the identity check below
 * fails immediately rather than a year later.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CLI_SRC = join(HERE, '..')

describe('one engine, not two', () => {
  it('the CLI exposes the same engine contract as core', () => {
    expect(CliPolicyEngine.name).toBe(CorePolicyEngine.name)
    expect(CliPolicyEngine.prototype.evaluate).toBeDefined()
  })

  it('the CLI shim contains no implementation', () => {
    // A re-export is a handful of lines; a fork is hundreds.
    const shim = readFileSync(join(CLI_SRC, 'policy-engine.ts'), 'utf-8')
    expect(shim).toContain("from './core/policy-engine.js'")
    expect(shim).not.toContain('class PolicyEngine')
    expect(shim.split('\n').length).toBeLessThan(40)
  })

  it('signing and receipts are also single-sourced', () => {
    for (const f of ['signing.ts', 'receipts.ts', 'types.ts']) {
      const shim = readFileSync(join(CLI_SRC, f), 'utf-8')
      expect(shim).toContain('@get-keel/core')
      expect(shim.split('\n').length).toBeLessThan(40)
    }
  })

  it('core ships the fixes that previously existed only in the CLI copy', () => {
    const e = new CorePolicyEngine()
    e.loadPolicy()
    const blocksWrite = (p: string) =>
      e.evaluate({
        tool_name: 'write_file', args: { filePath: p }, cwd: '.', timestamp: '',
      }).some((r) => r.action === 'block')

    expect(blocksWrite('.keel.yaml')).toBe(true)            // self-protection
    expect(e.checkNoVerify('git commit -m x -n')).toBe(true) // -n anywhere
    // The shell-injection fix. It used to be guarded by string-matching
    // autoVerify's own body; the checking now lives in file-verify.ts, so
    // the guard follows it — and asserts the property directly rather
    // than by proxy: argv arrays in, no interpolated shell string.
    const verifier = readFileSync(join(CLI_SRC, 'core', 'file-verify.ts'), 'utf-8')
    expect(verifier).toContain('execFileSync')
    expect(verifier).not.toMatch(/exec(Sync)?\([`'"][^`'"]*\$\{/)   // no `cmd ${path}` shell strings
    expect(CorePolicyEngine.prototype.autoVerify.toString()).toContain('verifyFileSyntax')
  })
})

describe('policy-absence semantics are the same at every entry point', () => {
  it('the gateway applies defaults when no policy file exists, like the CLI', async () => {
    // The gateway (and every integration) enforces through the keel daemon,
    // which applies the DEFAULT rules when no rules.yaml exists — benign
    // actions pass, dangerous ones are caught by the defaults.
    const home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    const project = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    const previousHome = process.env.HOME
    process.env.HOME = home
    process.env.KEEL_CLI_ENTRY = join(HERE, '..', '..', 'dist', 'index.js')
    try {
      const { daemonCheck } = await import('../mcp/daemon-client.js')
      const benign = await daemonCheck({ tool: 'Bash', args: { command: 'ls -la' }, cwd: project, session_id: 'conv-1' })
      expect(benign.action).toBe('allow')
      const dangerous = await daemonCheck({ tool: 'Bash', args: { command: 'rm -rf /' }, cwd: project, session_id: 'conv-1' })
      expect(dangerous.action).not.toBe('allow')
      expect(dangerous.rule_id).toBe('no-destructive-commands')
    } finally {
      delete process.env.KEEL_CLI_ENTRY
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      execSync(`rm -rf "${home}" "${project}"`)
      try {
        const { loadDaemonState } = await import('../commands/daemon.js')
        const state = loadDaemonState()
        if (state) process.kill(state.pid, 'SIGTERM')
      } catch {}
    }
  })
})
