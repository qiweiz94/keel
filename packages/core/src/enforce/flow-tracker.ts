import type { KeelRule, EnforceInput } from '../types.js'
import { existsSync, readFileSync } from 'node:fs'

interface DataTag {
  source: string     // which rule/source tagged this data
  value: string      // the sensitive content (truncated for privacy)
  timestamp: number
}

/**
 * Simplified information flow control tracker.
 *
 * Tags data as it flows through tools. When a tool reads
 * a sensitive file, the output is tagged. If a network tool
 * later receives tagged data, a rule violation is triggered.
 *
 * This is a lightweight version of Microsoft Fides.
 */
export class FlowTracker {
  private taggedValues: Map<string, DataTag[]> = new Map()
  // tag_key → tool name that created the tag
  private tagOrigins: Map<string, string> = new Map()

  /**
   * Track a tool call — check if it reads sensitive data
   * or sends tagged data to a network sink.
   */
  record(input: EnforceInput, ruleId: string): void {
    const args = input.args as Record<string, unknown>

    // Check if this tool reads a sensitive file
    const path = String(args.path || args.file || '')
    if (path && existsSync(path)) {
      const matchedRule = this.matchesSensitivePath(path)
      if (matchedRule) {
        // Tag the output of this tool call
        const tag: DataTag = {
          source: matchedRule,
          value: `<redacted: ${path}>`,
          timestamp: Date.now(),
        }
        const key = `flow:${input.session_id}:${input.turn_number}`
        const existing = this.taggedValues.get(key) || []
        existing.push(tag)
        this.taggedValues.set(key, existing)
        this.tagOrigins.set(key, input.tool)
      }
    }

    // Clean up old tags (keep last 1000)
    if (this.taggedValues.size > 1000) {
      const oldest = Array.from(this.taggedValues.keys()).sort()[0]
      this.taggedValues.delete(oldest)
      this.tagOrigins.delete(oldest)
    }
  }

  /**
   * Check if a flow/IFC rule is violated by the current action.
   * Returns violation message or null.
   */
  check(input: EnforceInput, rule: KeelRule): string | null {
    if (!rule.sources || !rule.sinks) return null

    const args = input.args as Record<string, unknown>
    const tool = input.tool

    // Check if this tool is a sink (network, write, etc.)
    const isSink = rule.sinks.some(s => tool.includes(s) || (args.url && String(args.url).includes(s)))

    if (!isSink) return null

    // Check if there are any tagged values from source tools
    const sourceTools = rule.sources
    let hasSourceData = false

    for (const [key, tags] of this.taggedValues) {
      const originTool = this.tagOrigins.get(key) || ''
      if (sourceTools.some(s => originTool.includes(s))) {
        hasSourceData = true
        break
      }
    }

    if (hasSourceData) {
      const sources = rule.sources.join(', ')
      const sinks = rule.sinks.join(', ')
      return `Data flow violation: data from ${sources} flowing to ${sinks} (rule: ${rule.id})`
    }

    return null
  }

  private matchesSensitivePath(path: string): string | null {
    // Common sensitive paths
    const sensitivePaths = [
      '.env', '.env.local', '.env.production',
      '.git-credentials', '.ssh/',
      'id_rsa', 'id_ed25519',
      'credentials', 'secrets',
      'token', 'api-key', 'apikey',
    ]
    for (const s of sensitivePaths) {
      if (path.includes(s)) return `sensitive-path:${s}`
    }
    return null
  }

  clear(): void {
    this.taggedValues.clear()
    this.tagOrigins.clear()
  }
}
