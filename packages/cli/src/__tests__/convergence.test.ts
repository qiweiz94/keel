import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PolicyEngine as CorePolicyEngine } from '@keel/core'
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
  it('the CLI re-exports core\'s class rather than defining its own', () => {
    expect(CliPolicyEngine).toBe(CorePolicyEngine)
  })

  it('the CLI shim contains no implementation', () => {
    // A re-export is a handful of lines; a fork is hundreds.
    const shim = readFileSync(join(CLI_SRC, 'policy-engine.ts'), 'utf-8')
    expect(shim).toContain("from '@keel/core'")
    expect(shim).not.toContain('class PolicyEngine')
    expect(shim.split('\n').length).toBeLessThan(40)
  })

  it('signing and receipts are also single-sourced', () => {
    for (const f of ['signing.ts', 'receipts.ts', 'types.ts']) {
      const shim = readFileSync(join(CLI_SRC, f), 'utf-8')
      expect(shim).toContain('@keel/core')
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

    expect(blocksWrite('.ai-enforce.yaml')).toBe(true)      // self-protection
    expect(e.checkNoVerify('git commit -m x -n')).toBe(true) // -n anywhere
    expect(CorePolicyEngine.prototype.autoVerify.toString()).toContain('execFileSync')
  })
})

describe('policy-absence semantics are the same at every entry point', () => {
  it('the gateway applies defaults when no policy file exists, like the CLI', () => {
    // Previously the gateway skipped loadPolicy() when the file was missing,
    // leaving policy null so evaluate() fail-closed and denied EVERY tool call
    // — while `keel check` applied defaults for the same project.
    const gateway = new MCPGateway({ command: 'true', args: [] })
    const engine = (gateway as any).engine as InstanceType<typeof CorePolicyEngine>

    const results = engine.evaluate({
      tool_name: 'bash', args: { command: 'ls -la' }, cwd: '.', timestamp: '',
    })
    expect(results.some((r) => r.rule_name === 'fail-closed')).toBe(false)

    // ...and a genuinely dangerous command is still blocked by the defaults.
    const bad = engine.evaluate({
      tool_name: 'bash', args: { command: 'rm -rf /' }, cwd: '.', timestamp: '',
    })
    expect(bad.some((r) => r.action === 'block')).toBe(true)
  })
})
