/**
 * keel — OpenClaw plugin.
 *
 * A thin client. All policy lives in the keel daemon (`keel daemon`), so
 * this file never decides what a rule means — it asks, then translates the
 * verdict into what OpenClaw understands. One engine, thin clients: a
 * second copy of the rule engine would drift, and the drift would be
 * silent.
 *
 * Written against the SDK actually installed on this machine
 * (openclaw 2026.4.15, dist/plugin-sdk/src/plugins/hook-types.d.ts) rather
 * than the published docs, which describe a richer before_tool_call event
 * than the runtime provides.
 *
 *   before_tool_call(event, ctx) -> { params?, block?, blockReason?, requireApproval? } | void
 *   event: { toolName, params, runId?, toolCallId? }
 *   ctx:   { agentId?, sessionKey?, sessionId?, runId?, toolName, toolCallId? }
 *   after_tool_call(event, ctx) -> void
 *   event adds: { result?, error?, durationMs? }
 *
 * `definePluginEntry` is effectively identity (it returns { id, name,
 * description, register }), so this module exports that object literal
 * directly and imports nothing. That keeps it a single file with no build
 * step — the same reason the Hermes adapter is one Python file.
 *
 * INSTALL: keel install --openclaw
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DAEMON_PORT = Number(process.env.KEEL_DAEMON_PORT || 31990)
const DAEMON_HOST = '127.0.0.1'
const TIMEOUT_MS = Number(process.env.KEEL_TIMEOUT_MS || 5000)
const TOKEN_PATH = join(homedir(), '.keel', 'daemon-token')

function token() {
  try { return readFileSync(TOKEN_PATH, 'utf-8').trim() } catch { return null }
}

async function daemon(path, payload) {
  const auth = token()
  if (!auth) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`http://${DAEMON_HOST}:${DAEMON_PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null      // unreachable, refused, or timed out
  } finally {
    clearTimeout(timer)
  }
}

// ── Circuit breaker ───────────────────────────────────────────────────
// OpenClaw fails open: a plugin that throws or fails to load is logged and
// skipped, and every tool call proceeds unguarded (issue #20914, closed as
// stale without a fix). keel fails closed. A thin client cannot bundle the
// engine, so when the daemon is unreachable neither extreme is right:
// silent fail-open means protection vanishes while the user believes they
// have it; blocking everything gets the plugin uninstalled the first time
// the daemon is not running.
//
// So: block only what is catastrophic and irreversible, allow the rest,
// and say loudly that enforcement is degraded. A last-resort backstop,
// NOT a second rule engine — keep it short and obvious.
const OFFLINE_DENY = [
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\s+(\/|~|\$HOME)(\s|\/|$)/i, 'recursive delete of a root or home path'],
  [/\bgit\s+push\b.*\s(--force|-f)\b.*\b(main|master|prod|production)\b/i, 'force-push to a protected branch'],
  [/\bDROP\s+(DATABASE|TABLE)\b/i, 'destructive SQL'],
  [/\bTRUNCATE\s+TABLE\b/i, 'destructive SQL'],
  [/:\(\)\{\s*:\|:&\s*\};:/, 'fork bomb'],
  [/\bmkfs(\.\w+)?\b/i, 'filesystem format'],
  [/\bdd\s+.*\bof=\/dev\/(disk|sd|nvme)/i, 'raw write to a block device'],
]

const DEGRADED =
  '[keel] DEGRADED — the keel daemon is unreachable, so rules are NOT being enforced. '
  + 'Only catastrophic operations are blocked. Start it with `keel daemon`.'

function commandOf(params) {
  if (!params || typeof params !== 'object') return ''
  for (const key of ['command', 'cmd']) {
    if (typeof params[key] === 'string') return params[key]
  }
  return ''
}

function offlineVerdict(params) {
  const command = commandOf(params)
  for (const [pattern, why] of OFFLINE_DENY) {
    if (pattern.test(command)) {
      return { block: true, blockReason: `[keel] Blocked while offline: ${why}. ${DEGRADED}` }
    }
  }
  return undefined
}

/**
 * Map a keel EnforceResult onto an OpenClaw before_tool_call result.
 *
 * `emit` receives advisory text that must reach the human without
 * interrupting the agent. This matters: keel's ladder is
 * warn-once-then-block, so the FIRST violation of every deny rule comes
 * back as `warn`. Dropping it silently would show the user nothing, then a
 * hard block on the repeat, with no warning in between.
 */
export function translate(result, emit) {
  if (!result || typeof result !== 'object') return undefined
  const { action, message = '', rule_id: ruleId } = result
  const label = `[keel${ruleId ? `:${ruleId}` : ''}] ${message}`.trim()

  if (action === 'deny' || action === 'block') {
    return { block: true, blockReason: label }
  }
  if (action === 'prompt' || action === 'research' || action === 'redirect') {
    return {
      requireApproval: {
        title: `keel: ${ruleId || 'approval required'}`,
        description: label,
        severity: action === 'prompt' ? 'critical' : 'warning',
        // An approval nobody answers must NOT become an allow — that is
        // the fail-open shape this plugin exists to avoid.
        timeoutBehavior: 'deny',
      },
    }
  }
  if (action === 'fix' && result.fix_result?.fixed && typeof result.fix_result.fixed === 'string') {
    // OpenClaw CAN rewrite arguments, unlike Hermes — so a fix rule is
    // genuinely enforced here rather than merely advisory.
    ;(emit || console.warn)(`${label} (arguments rewritten by keel)`)
    return { params: { command: result.fix_result.fixed } }
  }
  if ((action === 'warn' || action === 'report' || action === 'fix') && message) {
    ;(emit || console.warn)(label)
  }
  return undefined    // allow / warn / report / mask — never interrupt
}

/** Derive a coarse exit code: OpenClaw reports `error`, not an exit code. */
export function exitCodeFrom(event) {
  if (event?.error) return 1
  return typeof event?.result === 'undefined' ? null : 0
}

export function register(api) {
  api.on('before_tool_call', async (event, ctx) => {
    const result = await daemon('/v1/check', {
      tool: event?.toolName || 'unknown',
      args: event?.params || {},
      cwd: process.cwd(),
      session_id: ctx?.sessionId || ctx?.sessionKey || event?.runId || 'openclaw',
      agent: 'openclaw-plugin',
      subagent_of: null,
    })
    if (result === null) {
      console.warn(DEGRADED)
      return offlineVerdict(event?.params)
    }
    return translate(result)
  }, { priority: 100 })

  api.on('after_tool_call', async (event, ctx) => {
    await daemon('/v1/outcome', {
      tool: event?.toolName || 'unknown',
      args: event?.params || {},
      cwd: process.cwd(),
      session_id: ctx?.sessionId || ctx?.sessionKey || event?.runId || 'openclaw',
      agent: 'openclaw-plugin',
      exit: exitCodeFrom(event),
      duration_ms: event?.durationMs ?? null,
    })
  })
}

export default {
  id: 'keel',
  name: 'keel',
  description: 'Guardrail and workflow governor — evaluates every tool call against your keel rules.',
  register,
}
