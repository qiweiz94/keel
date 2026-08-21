import type { EnforceInput, KeelRule, VerificationMatcher } from '../types.js'
import type { StateManager } from './state-manager.js'
import { stripContentArgs, mcpToolString, argPath, commandString } from './arg-utils.js'
import { normalizeForMatch } from './path-normalize.js'

// `type: claim` (enforce/claim.ts) reuses this tracker's trigger/satisfy/
// pending state machine verbatim — same edit-arms / test-discharges shape,
// see types.ts's comment on the verification-obligation fields for why.
// Every gate below that used to read `rule.type !== 'verification'` is
// broadened to accept both types; `boundary()` is left verification-only
// since claim rules never declare `boundaries`.
function isObligationRule(rule: KeelRule): boolean {
  return rule.type === 'verification' || rule.type === 'claim'
}

// File-modification tools under their real names. opencode calls them
// write/edit/apply_patch; Claude Code calls them WriteFile/Write/Edit; MCP
// servers expose file writes under arbitrary tool names. Rules whose trigger
// names a write tool must fire on all of them, which is why `matches` falls
// back to arg-shape matching (below) instead of comparing tool names only.
// Exported for pipeline.ts's session-trip branch (`file_write_churn`
// dimension), which needs the SAME "is this call a write" judgment this
// module already encodes — reusing it instead of a second, narrower
// heuristic is what keeps a read-only search tool (Grep/Glob/LS, none of
// which are in this Set) from being counted as a file write just because it
// takes a `path` argument argPath() can resolve.
export const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch', 'patch', 'writefile', 'write_file'])

function matchesToolList(tools: string[], input: EnforceInput): boolean {
  if (tools.some(tool => tool.toLowerCase() === input.tool.toLowerCase())) return true
  if (!tools.some(tool => WRITE_TOOL_NAMES.has(tool.toLowerCase()))) return false
  // Write-shape fallback: an obligation whose trigger names a write tool is
  // also created by any tool that is about to write file content, regardless
  // of what the tool is called (e.g. an MCP server named `mcp__fs__put`).
  const args = input.args || {}
  return typeof args.patchText === 'string'
    || ((typeof args.filePath === 'string' || typeof args.file === 'string')
      && (args.content !== undefined || args.text !== undefined || args.newString !== undefined))
}

export function matches(matcher: VerificationMatcher | undefined, input: EnforceInput): boolean {
  if (!matcher) return false
  const tools = matcher.tools || (matcher.tool ? [matcher.tool] : [])
  if (tools.length && !matchesToolList(tools, input)) return false
  const args = input.args || {}
  // `paths` is additive: the single `path` (or its absence) still applies,
  // so the worktree-fingerprint fake input ({ path: "src/" }) keeps working.
  const pathTargets = matcher.paths?.length
    ? [...matcher.paths, ...(matcher.path ? [matcher.path] : [])]
    : (matcher.path ? [matcher.path] : [])
  if (pathTargets.length) {
    // Substring match, not a glob: `"src/"` deliberately keeps its
    // trailing slash through normalizeForMatch (see path-normalize.ts's
    // canonicalizePath header) so it still anchors to a real path-segment
    // boundary and doesn't also match `"src-backup/"`. Separator/case
    // normalization is what's new here — a real Windows argument path
    // (`\`-separated) previously never matched a `/`-authored trigger
    // path at all.
    const value = normalizeForMatch(argPath(args))
    if (!pathTargets.some(target => value.includes(normalizeForMatch(target)))) return false
  }
  if (matcher.pattern) {
    let re: RegExp
    try {
      re = new RegExp(matcher.pattern, 'i')
    } catch {
      return false
    }
    // Match-surface repair (same class as pipeline.ts's rate/diagnosis fix,
    // see match-surface.test.ts): a raw JSON.stringify(args) haystack
    // distorts quoted commands (escaped `"`) and defeats end-of-string
    // anchors (the JSON string always continues with a closing quote/brace).
    // The real command text is tried ADDITIVELY — nothing that matched the
    // JSON surface before stops matching; an anchored pattern that could
    // only ever match the command text now can too.
    if (!re.test(JSON.stringify(args)) && !re.test(commandString(input))) return false
  }
  return true
}

interface PendingVerification {
  ruleId: string
  cwd: string
  sessionId: string
  generation: number
  createdAt: number
}

export class VerificationTracker {
  private pending = new Map<string, PendingVerification>()
  private generations = new Map<string, number>()

  constructor(private readonly stateManager?: StateManager) {}

  private key(rule: KeelRule, input: EnforceInput): string {
    return `${rule.id}:${input.cwd}`
  }

  observeTrigger(rule: KeelRule, input: EnforceInput): void {
    if (!isObligationRule(rule) || !matches(rule.trigger, input)) return
    const key = this.key(rule, input)
    const previous = this.stateManager?.verification[key]
    const generation = Math.max(this.generations.get(key) || 0, previous?.generation || 0) + 1
    this.generations.set(key, generation)
    this.pending.set(key, {
      ruleId: rule.id,
      cwd: input.cwd,
      sessionId: input.session_id,
      generation,
      createdAt: Date.now(),
    })
    this.stateManager?.setVerification(key, { createdAt: Date.now(), generation })
  }

  markSatisfied(rule: KeelRule, input: EnforceInput): void {
    if (!isObligationRule(rule) || !matches(rule.satisfy, input)) return
    if (this.isFakeSatisfy(input)) return
    this.pending.delete(this.key(rule, input))
    this.stateManager?.clearVerification(this.key(rule, input))
  }

  /**
   * A satisfy command that only prints help or lists tests is not evidence:
   * `npm test --help`, `npm run test -- --list`, `vitest --dry-run`,
   * `vitest --list-files` exit 0 without running the suite, so they must not
   * clear the obligation. Case-insensitive and tolerant of `=json` suffixes;
   * MCP-shaped shells (`mcp__shell__run`) carry the command in nested args.
   *
   * Exit-code swallowing is equally fake: `npm test || true`,
   * `npm test; exit 0`, `npm test | cat` all exit 0 even when the suite
   * failed (or never ran), so they must not count as evidence either. The
   * command string is visible to the hook — the swallow is detectable.
   */
  private isFakeSatisfy(input: EnforceInput): boolean {
    const args = input.args || {}
    const nested = args.args && typeof args.args === 'object'
      ? (args.args as Record<string, unknown>).command
      : undefined
    const command = String(args.command || args.cmd || nested || '')
    return /--(help|list[a-z-]*|dry[-_]?run|version)(=|\s|$)|(^|\s)-h(\s|$)|(\|\||;)\s*(true|exit(\s+0)?|:)(\s|$)|(^|\s)\|\s*(cat|tee|head|tail|grep|true)(\s|$)/i.test(command)
  }

  isPending(rule: KeelRule, input: EnforceInput): boolean {
    if (!isObligationRule(rule)) return false
    const key = this.key(rule, input)
    const pending = this.pending.get(key) || this.stateManager?.verification[key]
    if (!pending) return false
    const window = (rule.verification_window_seconds || 300) * 1000
    if (Date.now() - pending.createdAt > window) {
      this.pending.delete(key)
      this.stateManager?.clearVerification(key)
      return false
    }
    return true
  }

  boundary(rule: KeelRule, input: EnforceInput): { message: string; action?: string } | null {
    if (!this.isPending(rule, input) || !rule.boundaries) return null
    const args = JSON.stringify(stripContentArgs(input.args || {}))
    // Same match-surface class as `matches()`'s matcher.pattern fix above
    // (see match-surface.test.ts): the JSON haystack distorts quoted
    // commands and defeats end-of-string anchors. Tried additively —
    // nothing that matched the JSON surface before stops matching.
    const cmd = commandString(input)
    const mcp = mcpToolString(input)
    for (const boundary of Object.values(rule.boundaries)) {
      try {
        if (boundary.pattern) {
          const re = new RegExp(boundary.pattern, 'i')
          if (re.test(args) || re.test(cmd)) {
            return { message: rule.message, action: boundary.action }
          }
        }
      } catch {}
      // MCP-shaped calls (`mcp__github__create_commit`) don't carry a shell
      // command string, so match the boundary's words against the tool name
      // and direct command. Only the pattern's VERB words ("git commit" →
      // commit, "git push" → push) are required, with word boundaries so
      // `github` never satisfies `git` and `list_commits` never satisfies
      // `commit`. Nested arg VALUES are excluded entirely — they cannot
      // inject a false boundary hit.
      if (mcp && boundary.pattern) {
        const words = boundary.pattern.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
        const verbs = words.slice(1)
        if (verbs.length && verbs.every(word => new RegExp(`\\b${word}\\b`, 'i').test(mcp))) {
          return { message: rule.message, action: boundary.action }
        }
      }
    }
    return null
  }

  clear(): void {
    this.pending.clear()
    this.generations.clear()
  }
}
