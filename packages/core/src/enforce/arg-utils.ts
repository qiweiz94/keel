import type { EnforceInput } from '../types.js'

/**
 * Command rules must match COMMAND-ish arguments only, never arbitrary file
 * content. Writing a file whose body mentions "git rebase" or "npm publish"
 * is not itself a history rewrite or a publish — matching the full args JSON
 * (which includes WriteFile/Edit `content`) produced false-positive blocks
 * on any file that merely referenced such commands.
 *
 * `stripContentArgs` drops content-bearing keys before stringification;
 * `commandString` builds the string command rules match against, including
 * MCP-shaped calls (`mcp__<server>__<tool>` + nested `args.args`).
 */

const CONTENT_KEYS = new Set([
  'content', 'text', 'fileContent', 'code',
  // Edit and apply_patch carry file content under non-"content" names; an
  // edit whose new text merely mentions a command must not trip command
  // rules, and patch bodies are content, not commands.
  'newString', 'oldString', 'patchText', 'patch',
])

function isContentKey(key: string): boolean {
  return CONTENT_KEYS.has(key) || key.toLowerCase().includes('content') || key.toLowerCase().includes('filecontent')
}

/** Target path encoded in apply_patch text (`*** Add File: src/x.ts`). */
const PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Move|Delete|Rename) File: (.+)$/m

export function pathFromPatch(patchText: unknown): string {
  if (typeof patchText !== 'string' || !patchText) return ''
  const m = PATCH_PATH_RE.exec(patchText)
  return m ? m[1].trim() : ''
}

/**
 * The file path an action targets: explicit path args first, then apply_patch
 * markers (apply_patch carries no filePath argument — paths live in the body).
 */
export function argPath(args: Record<string, unknown>): string {
  return String(args.path || args.filePath || args.file || args.dest || pathFromPatch(args.patchText) || '')
}

export function stripContentArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) return args
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (isContentKey(key)) continue
    if (Array.isArray(value)) {
      out[key] = value.map(item => (item && typeof item === 'object' ? stripContentArgs(item as Record<string, unknown>) : item))
    } else if (value && typeof value === 'object') {
      out[key] = stripContentArgs(value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}

/** True for OpenCode-style MCP tool names: `mcp__<server>__<tool>`. */
export function isMcpCall(input: EnforceInput): boolean {
  return input.tool.toLowerCase().includes('mcp__')
}

export function mcpCallString(input: EnforceInput): string | null {
  if (!isMcpCall(input)) return null
  const args = input.args as Record<string, unknown>
  const nested = args.args && typeof args.args === 'object'
    ? JSON.stringify(stripContentArgs(args.args as Record<string, unknown>))
    : ''
  return `${mcpToolString(input)} ${nested}`.toLowerCase()
}

/**
 * MCP tool-name segments plus the direct command only — no nested arg values.
 * Used for verification boundary word-matching, where a substring match
 * against the full JSON (including commit messages etc.) would false-fire.
 */
export function mcpToolString(input: EnforceInput): string | null {
  if (!isMcpCall(input)) return null
  const args = input.args as Record<string, unknown>
  const segments = input.tool.split('__').map(seg => seg.replace(/_/g, ' ')).join(' ')
  const toolName = typeof args.tool === 'string' ? args.tool : ''
  const direct = commandArrayString(args.command ?? args.cmd)
  return `${segments} ${toolName} ${direct}`.toLowerCase()
}

function commandArrayString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(String).join(' ')
  return ''
}

/** The string command rules are matched against. */
export function commandString(input: EnforceInput): string {
  const args = input.args as Record<string, unknown>
  if (typeof args === 'string') return args
  const mcp = mcpCallString(input)
  if (mcp) return mcp
  // Match against the raw command text, not a JSON serialization — regex
  // anchors like `( |$)` on `rm -rf .` must not be broken by a trailing
  // quote. Non-command args (e.g. WebFetch url) fall back to JSON.
  const direct = commandArrayString(args.command ?? args.cmd)
  return direct || JSON.stringify(stripContentArgs(args))
}
