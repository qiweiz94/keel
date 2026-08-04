import type { KeelRule, EnforceInput } from '../types.js'
import type { ResearchCache } from './research/research-cache.js'
import { matches } from './verification.js'
import { stripContentArgs, mcpToolString } from './arg-utils.js'

/**
 * ResearchTracker — the research-before-solve obligation.
 *
 * Inverted verification: armed by a FAILING command (trigger with a
 * nonzero exit), discharged by research EVIDENCE (a satisfying research
 * action, or fresh matching entries in the session research cache), and
 * gated at the next FIX action (boundaries).
 *
 * Discharge via the cache makes plugin and daemon instances consistent
 * without any cross-process channel: `keel_research` (daemon-side) writes
 * the session cache on disk, and the in-process plugin pipeline sees the
 * fresh evidence on its next evaluation.
 */

export interface ResearchPending {
  createdAt: number
}

export class ResearchTracker {
  private pending = new Map<string, ResearchPending>()

  constructor(private readonly researchCache?: ResearchCache) {}

  private key(rule: KeelRule, input: EnforceInput): string {
    return `${rule.id}:${input.cwd}:${input.session_id}`
  }

  /** Arm the obligation: a FAILING command matched the trigger. */
  observeTrigger(rule: KeelRule, input: EnforceInput, exitCode: number | null): void {
    if (rule.type !== 'research' || !rule.trigger) return
    if (!matches(rule.trigger, input)) return
    // Trigger.exit gates arming on failure.
    if (rule.trigger.exit !== undefined) {
      const want = rule.trigger.exit
      if (want === 'nonzero' && exitCode === 0) return
      if (typeof want === 'number' && exitCode !== want) return
    }
    this.pending.set(this.key(rule, input), { createdAt: Date.now() })
  }

  isPending(rule: KeelRule, input: EnforceInput): boolean {
    if (rule.type !== 'research' || !rule.trigger) return false
    const pending = this.pending.get(this.key(rule, input))
    if (!pending) return false
    const window = (rule.research_window_seconds || 600) * 1000
    if (Date.now() - pending.createdAt > window) {
      this.pending.delete(this.key(rule, input))
      return false
    }
    return true
  }

  /**
   * Fresh research evidence discharges the obligation: either the current
   * action is a satisfying research call, or the session cache holds fresh
   * entries matching the rule's topics.
   */
  discharge(rule: KeelRule, input: EnforceInput): boolean {
    if (!this.isPending(rule, input)) return true
    if (rule.satisfy && matches(rule.satisfy, input)) {
      this.pending.delete(this.key(rule, input))
      return true
    }
    const freshnessSec = rule.freshness_seconds ?? 1800
    if (this.researchCache && rule.topics?.length) {
      const probe = this.researchCache.probe(input.session_id, rule.topics, freshnessSec / 3600)
      if (probe.hit) {
        this.pending.delete(this.key(rule, input))
        return true
      }
    }
    return false
  }

  /** Boundary check: a fix/commit action while the obligation is pending. */
  boundary(rule: KeelRule, input: EnforceInput): { message: string; action?: string } | null {
    if (!this.isPending(rule, input) || !rule.boundaries) return null
    // The tool name matters for edit/write boundaries (the args alone carry
    // the file path, not the tool name).
    const args = `${input.tool} ${JSON.stringify(stripContentArgs(input.args || {}))}`
    const mcp = mcpToolString(input)
    for (const boundary of Object.values(rule.boundaries)) {
      try {
        if (boundary.pattern && new RegExp(boundary.pattern, 'i').test(args)) {
          return { message: rule.message, action: boundary.action }
        }
      } catch {}
      if (mcp && boundary.pattern) {
        const words = boundary.pattern.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
        const verbs = words.slice(1)
        if (verbs.length && verbs.every((word) => new RegExp(`\\b${word}\\b`, 'i').test(mcp))) {
          return { message: rule.message, action: boundary.action }
        }
      }
    }
    return null
  }

  clear(): void {
    this.pending.clear()
  }
}
