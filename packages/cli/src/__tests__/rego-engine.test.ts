import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RegoEngine, policyInitCommand } from '../rego-engine.js'

/**
 * SMOKE TEST, not a behavioral suite — this module is EXPERIMENTAL and
 * unsupported (see rego-engine.ts's own header comment and
 * docs/comparison.md / SPEC.md / ROADMAP.md for the decision and
 * rationale). It is not held to the same test bar as a YAML rule: there is
 * no `type: rego` in the shipped ruleset, and no host integration ever
 * constructs a `RegoEngine` during real enforcement.
 *
 * What this file DOES check, deliberately narrow: the module ships inside
 * `packages/cli` and its `keel policy` commands are real, reachable CLI
 * commands (`index.ts` registers them) — so it owes users at least
 * "does not crash, fails closed when misused" even though it owes them
 * nothing more than that today.
 */
describe('RegoEngine — experimental path, smoke coverage only', () => {
  it('evaluate() with no WASM module loaded fails closed (deny/block), not open', async () => {
    const engine = new RegoEngine()
    const result = await engine.evaluate({ tool: 'bash', command: 'rm -rf /' })
    expect(result.allow).toBe(false)
    expect(result.deny).toBe(true)
    expect(result.block).toBe(true)
    expect(result.errors).toBeDefined()
    expect(result.errors!.join(' ')).toContain('No WASM policy loaded')
  })

  it('loadWasm() rejects (does not crash the process) for a nonexistent file', async () => {
    const engine = new RegoEngine()
    await expect(engine.loadWasm('/nonexistent/path/policy.wasm')).rejects.toThrow('WASM file not found')
  })

  it('isOpaInstalled() returns a boolean without throwing, regardless of whether opa is on PATH', () => {
    expect(() => {
      const result = RegoEngine.isOpaInstalled()
      expect(typeof result).toBe('boolean')
    }).not.toThrow()
  })

  it('loadData() on a missing data file is a silent no-op, not a crash', () => {
    const engine = new RegoEngine()
    expect(() => engine.loadData('/nonexistent/data.json')).not.toThrow()
  })
})

describe('policyInitCommand — writes a real .rego file, no opa/opa-wasm required', () => {
  let dir: string
  let cwd: string

  afterEach(() => {
    process.chdir(cwd)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('writes policy.rego with the documented default-allow / deny shape', async () => {
    cwd = process.cwd()
    dir = mkdtempSync(join(tmpdir(), 'keel-rego-init-'))
    process.chdir(dir)
    await policyInitCommand()
    const written = join(dir, 'policy.rego')
    expect(existsSync(written)).toBe(true)
    const content = readFileSync(written, 'utf-8')
    expect(content).toContain('package keel_policy')
    expect(content).toContain('default allow := true')
    expect(content).toContain('deny if')
  })
})
