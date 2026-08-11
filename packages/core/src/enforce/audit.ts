import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AuditEntry, EnforceResult, ProtectionLevel, RuleContext } from '../types.js'
import { projectAuditArgs, sanitizeReasoning } from './audit-redaction.js'

export class AuditLog {
  private logDir: string
  private today: string = ''
  private writer: AuditWriter | null = null
  private entries: AuditEntry[] = []

  constructor(logDir?: string) {
    // KEEL_TRACES_DIR mirrors state-manager.ts:21's KEEL_STATE_DIR — same
    // env-override-else-real-home shape — but is read HERE, inside the
    // constructor, rather than as a module-level const. A module-level
    // const is fixed at first import of this file (whichever test happens
    // to import it first, process-wide), which defeats a test that sets
    // the env var in its own beforeAll/it after some other file already
    // triggered the import (verified empirically this wave — see
    // session/EVIDENCE/wave2-claim.md). Reading it per-construction makes
    // the override correct regardless of import order.
    this.logDir = logDir || process.env.KEEL_TRACES_DIR || join(homedir(), '.keel', 'traces')
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true })
    }
  }

  /**
   * Record an enforcement result as an audit entry.
   */
  record(result: EnforceResult, extra: {
    session_id: string
    turn_number: number
    tool: string
    args: Record<string, unknown>
    level: ProtectionLevel
    context: RuleContext
    agent: string
    subagent_of: string | null
    context_tokens: number
    reasoning?: string
  }): void {
    const entry: AuditEntry = {
      timestamp: result.timestamp,
      session_id: extra.session_id,
      turn_number: extra.turn_number,
      tool: extra.tool,
      args: projectAuditArgs(extra.args),
      rule_id: result.rule_id,
      rule_name: result.rule_name || '',
      action: result.action,
      message: result.message,
      level: extra.level,
      context: extra.context,
      agent: extra.agent,
      subagent_of: extra.subagent_of,
      cache_hit: result.cache_hit,
      duration_ms: result.duration_ms,
      tier: result.tier,
      context_tokens: extra.context_tokens,
      reasoning: sanitizeReasoning(extra.reasoning),
      fix_applied: result.action === 'fix',
      // Present only for `mode: observe` rules (action stays "allow" while
      // this carries what would have been enforced). Written unconditionally
      // — JSON.stringify drops an undefined property, so a non-observe entry
      // serializes byte-identical to before this field existed.
      observed_action: result.observed_action,
    }

    this.entries.push(entry)
    this.writeEntry(entry)
  }

  /**
   * Get entries for analysis.
   */
  getEntries(): AuditEntry[] {
    return [...this.entries]
  }

  /**
   * Load today's existing entries from disk.
   */
  loadToday(): AuditEntry[] {
    const filePath = this.getTodayPath()
    if (!existsSync(filePath)) return []
    try {
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
      return lines.map(l => JSON.parse(l) as AuditEntry)
    } catch {
      return []
    }
  }

  /**
   * Load a specific date's entries.
   */
  loadDate(dateStr: string): AuditEntry[] {
    const filePath = join(this.logDir, `${dateStr}.jsonl`)
    if (!existsSync(filePath)) return []
    try {
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
      return lines.map(l => JSON.parse(l) as AuditEntry)
    } catch {
      return []
    }
  }

  /**
   * Load entries from all available trace files.
   */
  loadAll(): AuditEntry[] {
    const all: AuditEntry[] = []
    if (!existsSync(this.logDir)) return all
    for (const file of readdirSync(this.logDir)) {
      if (file.endsWith('.jsonl')) {
        const dateStr = file.replace('.jsonl', '')
        all.push(...this.loadDate(dateStr))
      }
    }
    return all
  }

  private writeEntry(entry: AuditEntry): void {
    const filePath = this.getTodayPath()
    try {
      appendFileSync(filePath, JSON.stringify(entry) + '\n')
    } catch {
      // Fail silently — audit log is non-critical
    }
  }

  private getTodayPath(): string {
    const now = new Date()
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    if (dateStr !== this.today) {
      this.today = dateStr
      this.writer = null
    }
    return join(this.logDir, `${dateStr}.jsonl`)
  }
}

class AuditWriter {
  // Future: buffered writer, rotation, etc.
}
