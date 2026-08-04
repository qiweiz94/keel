import { initEnforce, evaluateToolCall } from './enforce.js'
import type { EnforcementAction, ProtectionLevel } from '../core/types.js'

/**
 * Verdicts that stop the tool call. Exported so a hook, a test, or another
 * client cannot drift from the definition — the reason `prompt` was
 * missing here for so long is that the list was inline and invisible.
 */
export const BLOCKING_ACTIONS: ReadonlySet<EnforcementAction> = new Set<EnforcementAction>([
  'deny', 'block', 'prompt', 'redirect', 'research',
])

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

  let result
  try {
    result = await evaluateToolCall(options.tool, args, {
      cwd: dir,
      turnNumber: options.turnNumber ? parseInt(options.turnNumber, 10) : 0,
      contextTokens: options.contextTokens ? parseInt(options.contextTokens, 10) : 0,
      level,
      context: 'local',
      agent: options.agent || 'opencode-plugin',
      subagentOf: null,
      reasoning: options.reasoning,
    })
  } catch (error) {
    process.stdout.write(JSON.stringify({
      action: 'error',
      message: `Evaluation failed closed: ${(error as Error).message}`,
      timestamp: new Date().toISOString(),
    }) + '\n')
    process.exit(2)
    return
  }

  process.stdout.write(JSON.stringify(result) + '\n')

  // Every verdict that BLOCKS must exit non-zero, not just deny/block.
  //
  // `prompt` means "blocked, needs `keel allow <id> --once`", and
  // `redirect`/`research` interrupt the call to demand an action first.
  // Exiting 0 for those made every approval gate a silent no-op in every
  // shell-hook integration — Claude Code included. Five shipped rules are
  // `prompt` (no-db-destructive, no-push-to-main, no-remote-exec,
  // git-history-rewrite, publish-gate), so destructive SQL, protected-
  // branch pushes, remote code execution, history rewrites and publishing
  // all passed straight through.
  //
  // These share exit 1 with deny rather than getting a new code on
  // purpose: any existing consumer that tests `exit !== 0` becomes correct
  // immediately, and the change can only add blocking, never remove it.
  // The verdict's own message carries the `keel allow` path, so a hook
  // only has to surface it.
  if (BLOCKING_ACTIONS.has(result.action)) {
    process.exit(1)
  }
}
