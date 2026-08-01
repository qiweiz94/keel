import type { KeelRule, EnforceInput } from '../types.js'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface DataTag {
  source: string     // matched source path or source tool
  value: string      // the sensitive content (truncated for privacy)
  timestamp: number
  sessionId: string
  originTool: string
  path?: string
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
  record(input: EnforceInput, rule?: KeelRule | string): void {
    const args = input.args as Record<string, unknown>

    // Check if this tool reads a sensitive file
    const rawPath = String(args.path || args.file || args.filePath || '')
    const path = rawPath && !rawPath.startsWith('/') ? resolve(input.cwd, rawPath) : rawPath
    if (path && existsSync(path)) {
      const configuredSources = typeof rule === 'object' ? rule.sources : undefined
      const matchedRule = configuredSources?.find(source => this.pathMatches(path, source))
        || (!configuredSources ? this.matchesSensitivePath(path) : null)
      if (matchedRule) {
        // Tag the output of this tool call
        const tag: DataTag = {
          source: matchedRule,
          value: `<redacted: ${path}>`,
          timestamp: Date.now(),
          sessionId: input.session_id,
          originTool: input.tool,
          path,
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
    const isSink = rule.sinks.some(sink => this.matchesSink(sink, tool, args))

    if (!isSink) return null

    // Check if there are any tagged values from source tools
    let hasSourceData = false

    for (const [key, tags] of this.taggedValues) {
      if (tags.some(tag => tag.sessionId === input.session_id && rule.sources!.some(source =>
        tag.originTool.toLowerCase().includes(source.toLowerCase())
        || (!!tag.path && this.pathMatches(tag.path, source))
      ))) {
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

  private pathMatches(value: string, pattern: string): boolean {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    try { return new RegExp(`^${escaped}$`, 'i').test(value) || new RegExp(escaped, 'i').test(value) } catch { return false }
  }

  private matchesSink(sink: string, tool: string, args: Record<string, unknown>): boolean {
    const normalized = sink.toLowerCase()
    const toolName = tool.toLowerCase()
    if (toolName === normalized) return true

    const url = String(args.url || args.uri || args.host || '')
    if (url && (url.toLowerCase().includes(normalized) || normalized === 'network')) return true

    if (normalized !== 'network') return false
    const command = String(args.command || args.cmd || '').toLowerCase()
    return /(?:curl|wget|fetch|http|https|nc|netcat|socat)\b/.test(`${toolName} ${command}`)
  }

  clear(): void {
    this.taggedValues.clear()
    this.tagOrigins.clear()
  }
}
