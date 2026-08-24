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

    // Every OFFLINE_DENY category in templates/openclaw/index.mjs: rm -rf
    // of a root/home path, force-push to a protected branch, destructive
    // SQL (DROP and TRUNCATE), a fork bomb, a filesystem format, and a
    // raw write to a block device.
    for (const cmd of ['rm -rf /', 'rm -rf ~', 'git push --force origin main',
      'DROP TABLE users;', 'TRUNCATE TABLE accounts;', ':(){ :|:& };:',
      'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda bs=1M']) {
      calls.push(await run(cmd))
    }
    expect(calls.every(r => r?.block === true), JSON.stringify(calls)).toBe(true)

    // Ordinary work must still run. "Blocks everything when the daemon is
    // down" is the failure mode that gets a guardrail uninstalled:
    // node_modules cleanup, feature-branch pushes, and a `dd` that only
    // writes TO a regular file (device targets only) are the classic false
    // positives of a naive deny list.
    for (const cmd of ['ls -la', 'npm test', 'rm -rf node_modules',
      'git push origin feature/x', 'dd if=file.img of=/dev/null']) {
      expect(await run(cmd), cmd).toBeUndefined()
    }
    delete process.env.KEEL_DAEMON_PORT
    delete process.env.KEEL_TIMEOUT_MS
  })

  it('documents a known false positive of the offline regex backstop: SQL keywords inside an unrelated string', async () => {
    // OFFLINE_DENY is a regex backstop, not a second rule engine (see its
    // module comment) — it has no command-vs-string-literal distinction.
    // Same known, accepted gap as the Hermes adapter's byte-identical list
    // (see hermes-adapter.test.ts); recorded here too for parity, since
    // both templates ship the same OFFLINE_DENY array.
    process.env.KEEL_DAEMON_PORT = '1'
    process.env.KEEL_TIMEOUT_MS = '300'
    const fresh = await import(`${join(DIR, 'index.mjs')}?offline2`)
    const api = {
      on: (name: string, handler: Function) => {
        if (name === 'before_tool_call') (api as never as { h: Function }).h = handler
      },
    }
    fresh.default.register(api)
    const result = await (api as never as { h: Function }).h(
      { toolName: 'bash', params: { command: 'echo "please DROP TABLE from your vocabulary"' } }, {})
    expect(result?.block).toBe(true)
    delete process.env.KEEL_DAEMON_PORT
    delete process.env.KEEL_TIMEOUT_MS
  })

  it('emitFor(api) routes a warn verdict through api.logger.warn when the host provides one', () => {
    // The installed before_tool_call return type has no field for "allow
    // but show a message" (see the module header) — api.logger.warn is
    // the best confirmed channel OpenClaw's plugin SDK actually exposes,
    // and register() wires it as translate()'s `emit`. Not fully verified
    // here whether logger.warn reaches the end user's chat surface vs.
    // only an operator log — see session/EVIDENCE/wave3-warnsurface.md
    // and HUMAN-CHECKLIST.md.
    const logged: string[] = []
    const api = { logger: { warn: (text: string) => { logged.push(text) } } }
    const emit = plugin.emitFor(api)
    plugin.translate({ action: 'warn', message: 'first violation', rule_id: 'no-destructive-commands' }, emit)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('no-destructive-commands')
  })

  it('emitFor(api) falls back to console.warn when the host has no logger', () => {
    const said: string[] = []
    const original = console.warn
    console.warn = (text: string) => { said.push(text) }
    try {
      plugin.emitFor({})('[keel:x] fallback message')
    } finally {
      console.warn = original
    }
    expect(said).toEqual(['[keel:x] fallback message'])
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
