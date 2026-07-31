import type { EnforceInput, KeelRule, VerificationMatcher } from '../types.js'
import type { StateManager } from './state-manager.js'

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
    this.pending.delete(this.key(rule, input))
    this.stateManager?.clearVerification(this.key(rule, input))
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
    const args = JSON.stringify(input.args || {})
    for (const boundary of Object.values(rule.boundaries)) {
      try {
        if (boundary.pattern && new RegExp(boundary.pattern, 'i').test(args)) {
          return { message: rule.message, action: boundary.action }
        }
      } catch {}
    }
    return null
  }

  clear(): void {
    this.pending.clear()
    this.generations.clear()
  }
}
