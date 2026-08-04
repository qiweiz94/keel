import { initEnforce, evaluateToolCall } from './enforce.js'
import { BLOCKING_ACTIONS } from './evaluate.js'
import type { EnforceResult, ProtectionLevel } from '../core/types.js'

/**
 * `keel hook <host>` — one enforcement entry point for every agent host.
 *
 * This replaced four near-identical shell scripts that each parsed a JSON
 * payload from stdin, shelled out to `keel evaluate`, and pulled the
 * verdict back out of its JSON with sed. That last part could not survive
 * a rule message containing a quote:
 *
 *   intended : Keel blocked this action: Use "--force-with-lease" instead
 *   actual   : Keel blocked this action: Use \
 *
 * The output stayed valid JSON, so nothing errored and no test failed —
 * the user was told they were blocked with the reason truncated at the
 * first quote. The reason is the entire point of a block. sed is simply
 * the wrong tool for JSON, and no amount of patching four copies fixes
 * that.
 *
 * Doing it here also removes a process: a hook used to spawn `sh` AND a
 * second `keel`, per tool call. Now the host spawns one.
 *
 * Adding a host is a row in HOST_ADAPTERS, not a new script.
 */

export const HOSTS = ['claude-code', 'cline', 'cursor', 'codex', 'generic'] as const
export type Host = (typeof HOSTS)[number]

export interface ParsedCall {
  tool: string
  args: Record<string, unknown>
}

/** What the host must do, expressed uniformly so tests can assert it. */
export interface HostVerdict {
  blocked: boolean
  exitCode: number
  stdout: string
  stderr: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Read a host's payload. Malformed input degrades to an unknown tool
 * rather than throwing: a hook that crashes is a hook the host skips, and
 * every host surveyed treats a skipped hook as permission to proceed.
 */
export function parsePayload(host: Host, raw: string): ParsedCall {
  let body: Record<string, unknown>
  try {
    body = asRecord(JSON.parse(raw))
  } catch {
    return { tool: 'unknown', args: {} }
  }

  switch (host) {
    case 'cline': {
      const pre = asRecord(body.preToolUse)
      return {
        tool: typeof pre.toolName === 'string' ? pre.toolName : 'unknown',
        args: asRecord(pre.parameters),
      }
    }
    case 'cursor': {
      // Cursor sends a bare `command` for shell execution, or
      // tool_name/tool_input for an MCP call.
      if (typeof body.command === 'string') {
        return { tool: 'bash', args: { command: body.command } }
      }
      return {
        tool: typeof body.tool_name === 'string' ? body.tool_name : 'unknown',
        args: asRecord(body.tool_input),
      }
    }
    case 'codex':
    case 'claude-code': {
      return {
        tool: typeof body.tool_name === 'string' ? body.tool_name : 'unknown',
        args: asRecord(body.tool_input),
      }
    }
    case 'generic':
    default: {
      return {
        tool: typeof body.tool === 'string' ? body.tool : 'unknown',
        args: asRecord(body.args),
      }
    }
  }
}

function label(result: EnforceResult): string {
  const rule = result.rule_id ? `:${result.rule_id}` : ''
  const prefix = result.action === 'prompt'
    ? 'Keel requires approval'
    : result.action === 'redirect' || result.action === 'research'
      ? 'Keel redirected this action'
      : 'Keel blocked this action'
  return `${prefix} [keel${rule}]: ${result.message || 'rule violation'}`
}

const COULD_NOT_EVALUATE =
  'Keel could not evaluate this action, so it was blocked. '
  + "Check `keel validate` and ~/.keel/rules.yaml."

/**
 * Turn a verdict into what the host understands.
 *
 * `result === null` means keel itself failed. That blocks: a guardrail
 * that waves calls through when it breaks is worse than none, because it
 * is believed.
 */
export function renderVerdict(host: Host, result: EnforceResult | null): HostVerdict {
  const blocked = result === null || BLOCKING_ACTIONS.has(result.action)
  const text = result === null ? COULD_NOT_EVALUATE : label(result)

  if (!blocked) {
    // Advisory verdicts still reach the human — keel's ladder is
    // warn-once-then-block, so the first violation of every deny rule
    // arrives as `warn`, and swallowing it means no warning is ever seen.
    const advisory = result && result.rule_id && result.action !== 'allow'
      ? `[keel:${result.rule_id}] ${result.message}`
      : ''
    switch (host) {
      case 'cursor':
        return { blocked: false, exitCode: 0, stdout: JSON.stringify({ permission: 'allow' }), stderr: advisory }
      case 'cline':
        return { blocked: false, exitCode: 0, stdout: '', stderr: advisory }
      default:
        return { blocked: false, exitCode: 0, stdout: '', stderr: advisory }
    }
  }

  switch (host) {
    case 'cursor': {
      // `ask` routes to Cursor's own approval UI, the closest match to
      // keel's `prompt`; everything else is a hard deny.
      const permission = result?.action === 'prompt' ? 'ask' : 'deny'
      return {
        blocked: true,
        exitCode: 0,          // Cursor decides from stdout, not the exit code
        stdout: JSON.stringify({ permission, userMessage: text, agentMessage: text }),
        stderr: '',
      }
    }
    case 'cline': {
      // Contract from the installed @cline/core: a HOOK_CONTROL line on
      // stdout, cancel:true stops the call.
      return {
        blocked: true,
        exitCode: 0,
        stdout: `HOOK_CONTROL\t${JSON.stringify({ cancel: true, errorMessage: text })}`,
        stderr: '',
      }
    }
    case 'codex':
    case 'claude-code':
    default: {
      // Both block on exit 2 specifically. For Codex any OTHER non-zero
      // means "the hook failed" and execution continues, so the code
      // matters as much as being non-zero.
      return { blocked: true, exitCode: 2, stdout: '', stderr: text }
    }
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf-8')
}

export async function hookCommand(hostArg: string, options: { cwd?: string; level?: string } = {}) {
  const host = (HOSTS as readonly string[]).includes(hostArg) ? hostArg as Host : 'generic'

  // Claude Code passes the call in the environment, not on stdin.
  const raw = host === 'claude-code' && process.env.TOOL_NAME
    ? JSON.stringify({ tool_name: process.env.TOOL_NAME, tool_input: safeJson(process.env.TOOL_INPUT) })
    : await readStdin()

  const call = parsePayload(host, raw)

  let result: EnforceResult | null = null
  try {
    const cwd = options.cwd || process.cwd()
    const level = (options.level as ProtectionLevel | undefined)
    initEnforce(cwd, level ? { level } : undefined)
    result = await evaluateToolCall(call.tool, call.args, {
      cwd,
      turnNumber: 0,
      contextTokens: 0,
      level,
      context: 'local',
      agent: host,
      subagentOf: null,
    })
  } catch {
    result = null      // fail closed — renderVerdict blocks on null
  }

  const verdict = renderVerdict(host, result)
  if (verdict.stdout) process.stdout.write(`${verdict.stdout}\n`)
  if (verdict.stderr) process.stderr.write(`${verdict.stderr}\n`)
  process.exit(verdict.exitCode)
}

function safeJson(text: string | undefined): Record<string, unknown> {
  if (!text) return {}
  try { return asRecord(JSON.parse(text)) } catch { return {} }
}
