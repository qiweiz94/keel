import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The OpenClaw adapter is a standalone ES module, so it is imported
 * directly. These checks are daemon-free and therefore deterministic; the
 * live daemon path is exercised by hand, because a test that starts a
 * server is a test that flakes.
 *
 * The contract asserted here comes from the SDK installed on this machine
 * (openclaw 2026.4.15, dist/plugin-sdk/src/plugins/hook-types.d.ts), not
 * from the published docs — the docs describe a richer before_tool_call
 * event than the runtime actually passes.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'openclaw')
const plugin = await import(join(DIR, 'index.mjs'))

describe('openclaw adapter', () => {
  it('declares the entry point the way OpenClaw discovers it', () => {
    const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf-8'))
    expect(pkg.type).toBe('module')
    expect(pkg.openclaw.extensions).toContain('./index.mjs')
    expect(existsSync(join(DIR, 'index.mjs'))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(DIR, 'openclaw.plugin.json'), 'utf-8'))
    expect(manifest.id).toBe('keel')
    // OpenClaw validates the manifest without executing plugin code, so a
    // missing configSchema is a load-time failure rather than a runtime one.
    expect(manifest.configSchema.type).toBe('object')
  })

  it('exports the shape definePluginEntry produces, without importing the SDK', () => {
    // definePluginEntry is effectively identity — it returns
    // { id, name, description, register }. Building that literal directly
    // keeps this a single file with no bundle step, which is what kept the
    // OpenCode plugin from accidentally inlining a whole compiler.
    expect(plugin.default.id).toBe('keel')
    expect(typeof plugin.default.register).toBe('function')
  })

  it('maps keel verdicts onto the real before_tool_call result type', () => {
    const say = () => {}
    expect(plugin.translate({ action: 'deny', message: 'no', rule_id: 'r' }, say))
      .toMatchObject({ block: true })
    expect(plugin.translate({ action: 'block', message: 'no', rule_id: 'r' }, say))
      .toMatchObject({ block: true })

    // Advisory verdicts must never interrupt.
    for (const action of ['allow', 'warn', 'report', 'mask']) {
      expect(plugin.translate({ action, message: 'm', rule_id: 'r' }, say)).toBeUndefined()
    }
  })

  it('fails an unanswered approval CLOSED, not open', () => {
    // requireApproval.timeoutBehavior exists in the installed SDK. Leaving
    // it unset would let an approval nobody answers become an allow —
    // exactly the fail-open shape this plugin exists to prevent.
    const result = plugin.translate({ action: 'prompt', message: 'gate', rule_id: 'publish-gate' }, () => {})
    expect(result.requireApproval.timeoutBehavior).toBe('deny')
    expect(result.requireApproval.title).toContain('publish-gate')
    expect(result.requireApproval.severity).toBe('critical')
  })

  it('rewrites arguments for a fix rule — OpenClaw can, unlike Hermes', () => {
    const said: string[] = []
    const result = plugin.translate(
      { action: 'fix', message: 'prefer rg', rule_id: 'use-rg', fix_result: { fixed: 'rg foo' } },
      (t: string) => said.push(t),
    )
    expect(result).toEqual({ params: { command: 'rg foo' } })
    expect(said[0]).toContain('rewritten')
  })

  it('surfaces a warning to the human without interrupting the agent', () => {
    // keel's ladder is warn-once-then-block, so the FIRST violation of
    // every deny rule arrives as `warn`. Dropping it silently would show
    // the user nothing, then a hard block on the repeat.
    const said: string[] = []
    const result = plugin.translate(
      { action: 'warn', message: 'first violation', rule_id: 'no-destructive-commands' },
      (t: string) => said.push(t),
    )
    expect(result).toBeUndefined()
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('no-destructive-commands')
  })

  it('blocks only catastrophic commands when the daemon is unreachable', async () => {
    // OpenClaw fails open — a plugin that throws is skipped and the call
    // proceeds unguarded. Point the client at a dead port so the circuit
    // breaker is what answers.
    process.env.KEEL_DAEMON_PORT = '1'      // nothing listens on port 1
    process.env.KEEL_TIMEOUT_MS = '300'
    const fresh = await import(`${join(DIR, 'index.mjs')}?offline`)

    const calls: Array<{ block?: boolean }> = []
    const api = {
      on: (name: string, handler: Function) => {
        if (name === 'before_tool_call') (api as never as { h: Function }).h = handler
      },
    }
    fresh.default.register(api)
    const run = (command: string) =>
      (api as never as { h: Function }).h({ toolName: 'bash', params: { command } }, {})

    for (const cmd of ['rm -rf /', 'git push --force origin main', 'DROP TABLE users;']) {
      calls.push(await run(cmd))
    }
    expect(calls.every(r => r?.block === true)).toBe(true)

    // Ordinary work must still run. "Blocks everything when the daemon is
    // down" is the failure mode that gets a guardrail uninstalled, and
    // node_modules cleanup is the classic false positive of a naive list.
    for (const cmd of ['ls -la', 'npm test', 'rm -rf node_modules', 'git push origin feature/x']) {
      expect(await run(cmd)).toBeUndefined()
    }
    delete process.env.KEEL_DAEMON_PORT
    delete process.env.KEEL_TIMEOUT_MS
  })

  it('derives an exit code from after_tool_call, which carries no exit', () => {
    // The real event has { result?, error?, durationMs? } — no exit code.
    // Without deriving one, every attempt looks successful and the
    // stuck-loop detector goes blind.
    expect(plugin.exitCodeFrom({ error: 'boom' })).toBe(1)
    expect(plugin.exitCodeFrom({ result: 'ok' })).toBe(0)
    expect(plugin.exitCodeFrom({})).toBeNull()
  })
})
