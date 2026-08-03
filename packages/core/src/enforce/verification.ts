import type { EnforceInput, KeelRule, VerificationMatcher } from '../types.js'
import type { StateManager } from './state-manager.js'
import { stripContentArgs, mcpToolString } from './arg-utils.js'

interface PendingVerification {
  ruleId: string
  cwd: string
  sessionId: string
  generation: number
  createdAt: number
}

function matches(matcher: VerificationMatcher | undefined, input: EnforceInput): boolean {
  if (!matcher) return false
  const tools = matcher.tools || (matcher.tool ? [matcher.tool] : [])
  if (tools.length && !tools.some(tool => tool.toLowerCase() === input.tool.toLowerCase())) return false
  const args = input.args || {}
  if (matcher.path) {
    const value = String(args.path || args.filePath || args.file || args.dest || '')
    if (!value.includes(matcher.path)) return false
  }
  if (matcher.pattern) {
    try {
      if (!new RegExp(matcher.pattern, 'i').test(JSON.stringify(args))) return false
    } catch {
      return false
    }
  }
  return true
}

export class VerificationTracker {
  private pending = new Map<string, PendingVerification>()
  private generations = new Map<string, number>()

  constructor(private readonly stateManager?: StateManager) {}

  private key(rule: KeelRule, input: EnforceInput): string {
    return `${rule.id}:${input.cwd}`
  }

  observeTrigger(rule: KeelRule, input: EnforceInput): void {
    if (rule.type !== 'verification' || !matches(rule.trigger, input)) return
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
    if (rule.type !== 'verification' || !matches(rule.satisfy, input)) return
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
   */
  private isFakeSatisfy(input: EnforceInput): boolean {
    const args = input.args || {}
    const nested = args.args && typeof args.args === 'object'
      ? (args.args as Record<string, unknown>).command
      : undefined
    const command = String(args.command || args.cmd || nested || '')
    return /--(help|list[a-z-]*|dry[-_]?run|version)(=|\s|$)|(^|\s)-h(\s|$)/i.test(command)
  }

  isPending(rule: KeelRule, input: EnforceInput): boolean {
    if (rule.type !== 'verification') return false
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
    const mcp = mcpToolString(input)
    for (const boundary of Object.values(rule.boundaries)) {
      try {
        if (boundary.pattern && new RegExp(boundary.pattern, 'i').test(args)) {
          return { message: rule.message, action: boundary.action }
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
