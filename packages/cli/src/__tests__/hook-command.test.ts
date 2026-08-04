import { describe, it, expect } from 'vitest'
import { renderVerdict, parsePayload, HOSTS } from '../commands/hook.js'
import type { EnforceResult } from '../core/types.js'

/**
 * `keel hook <host>` replaced four shell scripts that each extracted the
 * verdict from JSON with sed. That could not survive an escaped quote:
 *
 *   intended : Keel blocked this action: Use "--force-with-lease" instead
 *   actual   : Keel blocked this action: Use \
 *
 * The output stayed valid JSON, so nothing errored and no test failed —
 * the user was told they were blocked with the reason cut off at the
 * first quote. These assert the messages survive intact.
 */

const verdict = (over: Partial<EnforceResult> = {}): EnforceResult => ({
  action: 'deny',
  rule_id: 'no-force-push',
  rule_name: 'no-force-push',
  message: 'Use "--force-with-lease" instead of --force.',
  timestamp: '2026-08-04T00:00:00.000Z',
  ...over,
} as EnforceResult)

describe('hook payload parsing', () => {
  it('reads each host’s own payload shape', () => {
    expect(parsePayload('cline', JSON.stringify({
      preToolUse: { toolName: 'bash', parameters: { command: 'rm -rf /' } },
    }))).toEqual({ tool: 'bash', args: { command: 'rm -rf /' } })

    expect(parsePayload('cursor', JSON.stringify({ command: 'rm -rf /' })))
      .toEqual({ tool: 'bash', args: { command: 'rm -rf /' } })

    expect(parsePayload('codex', JSON.stringify({
      tool_name: 'Write', tool_input: { filePath: 'a.ts' },
    }))).toEqual({ tool: 'Write', args: { filePath: 'a.ts' } })

    expect(parsePayload('generic', JSON.stringify({ tool: 'bash', args: { command: 'ls' } })))
      .toEqual({ tool: 'bash', args: { command: 'ls' } })
  })

  it('degrades to an unknown tool rather than throwing on junk', () => {
    // A hook that crashes is a hook the host skips — a silent fail-open.
    expect(parsePayload('cline', 'not json at all')).toEqual({ tool: 'unknown', args: {} })
    expect(parsePayload('cursor', '')).toEqual({ tool: 'unknown', args: {} })
  })
})

describe('verdict rendering per host', () => {
  it('preserves a message containing quotes — the sed bug', () => {
    const message = 'Use "--force-with-lease" instead of --force.'

    const cursor = JSON.parse(renderVerdict('cursor', verdict()).stdout)
    expect(cursor.permission).toBe('deny')
    expect(cursor.userMessage).toContain(message)

    const cline = renderVerdict('cline', verdict()).stdout
    const control = JSON.parse(cline.replace(/^HOOK_CONTROL\t/, ''))
    expect(control.cancel).toBe(true)
    expect(control.errorMessage).toContain(message)

    for (const host of ['codex', 'claude-code'] as const) {
      expect(renderVerdict(host, verdict()).stderr).toContain(message)
    }
  })

  it('preserves newlines, backticks and non-ASCII', () => {
    // The real no-push-to-main message has an em dash, an arrow and
    // backticks around the `keel allow` command.
    const message = 'Pushing directly to a protected branch — approval required.\n   → run `keel allow no-push-to-main --once`'
    const v = verdict({ action: 'prompt', rule_id: 'no-push-to-main', message })

    const cursor = JSON.parse(renderVerdict('cursor', v).stdout)
    expect(cursor.userMessage).toContain('→')
    expect(cursor.userMessage).toContain('`keel allow no-push-to-main --once`')

    const control = JSON.parse(renderVerdict('cline', v).stdout.replace(/^HOOK_CONTROL\t/, ''))
    expect(control.errorMessage).toContain('—')
  })

  it('blocks on every blocking verdict and stays out of the way otherwise', () => {
    for (const host of HOSTS) {
      for (const action of ['deny', 'block', 'prompt', 'redirect', 'research'] as const) {
        expect(renderVerdict(host, verdict({ action })).blocked).toBe(true)
      }
      for (const action of ['allow', 'warn', 'report'] as const) {
        expect(renderVerdict(host, verdict({ action })).blocked).toBe(false)
      }
    }
  })

  it('routes prompt to Cursor’s own approval UI, not a hard deny', () => {
    const cursor = JSON.parse(renderVerdict('cursor', verdict({ action: 'prompt' })).stdout)
    expect(cursor.permission).toBe('ask')
  })

  it('emits the exit code each host actually blocks on', () => {
    // Codex treats exit 2 as "blocked" and every OTHER non-zero as "the
    // hook failed, continue" — so the code matters, not just non-zero.
    expect(renderVerdict('codex', verdict()).exitCode).toBe(2)
    expect(renderVerdict('claude-code', verdict()).exitCode).toBe(2)
    // Cline and Cursor signal through stdout and must exit 0.
    expect(renderVerdict('cline', verdict()).exitCode).toBe(0)
    expect(renderVerdict('cursor', verdict()).exitCode).toBe(0)
  })

  it('fails CLOSED when keel itself could not evaluate', () => {
    for (const host of HOSTS) {
      const failure = renderVerdict(host, null)
      expect(failure.blocked).toBe(true)
      const text = failure.stdout + failure.stderr
      expect(text.toLowerCase()).toContain('keel')
    }
  })
})
