import { initEnforce, evaluateToolCall } from './enforce.js'
import type { ProtectionLevel } from '../core/types.js'

export interface EvaluateOptions {
  tool: string
  args?: string
  cwd?: string
  turnNumber?: string
  contextTokens?: string
  level?: string
  agent?: string
  reasoning?: string
}

/**
 * `keel evaluate` — JSON-in/JSON-out enforcement evaluation.
 *
 * Designed for programmatic use by the OpenCode plugin (or any agent).
 * Reads tool/args from CLI flags, returns structured JSON result on stdout.
 *
 * Exit codes:
 *   0 — allow/warn/fix (action allowed or fix applied)
 *   1 — deny/block (action denied)
 *   2 — initialization error
 */
export async function evaluateCommand(options: EvaluateOptions) {
  const dir = options.cwd || process.cwd()
  const level = (options.level || 'balanced') as ProtectionLevel

  let args: Record<string, unknown>
  try {
    args = options.args ? JSON.parse(options.args) : {}
  } catch {
    process.stdout.write(JSON.stringify({
      action: 'error',
      message: `Invalid --args JSON: ${options.args}`,
      timestamp: new Date().toISOString(),
    }) + '\n')
    process.exit(2)
    return
  }

  try {
    initEnforce(dir, { level, context: 'local' })
  } catch (err) {
    process.stdout.write(JSON.stringify({
      action: 'error',
      message: `Init failed: ${(err as Error).message}`,
      timestamp: new Date().toISOString(),
    }) + '\n')
    process.exit(2)
    return
  }

  const result = await evaluateToolCall(options.tool, args, {
    cwd: dir,
    turnNumber: options.turnNumber ? parseInt(options.turnNumber, 10) : 0,
    contextTokens: options.contextTokens ? parseInt(options.contextTokens, 10) : 0,
    level,
    context: 'local',
    agent: options.agent || 'opencode-plugin',
    subagentOf: null,
    reasoning: options.reasoning,
  })

  process.stdout.write(JSON.stringify(result) + '\n')

  if (result.action === 'deny' || result.action === 'block') {
    process.exit(1)
  }
}
