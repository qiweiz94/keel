import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  KeelRule, EnforceInput, EnforceResult, EnforcementAction,
  ProtectionLevel, RuleContext, CacheEntry, AuditEntry,
} from '../types.js'
import { ActionCache, ContentTracker } from './cache.js'
import type { RuleHierarchy } from './rule-parser.js'
import { mergeRules, detectConflicts, hashRulesFile } from './rule-parser.js'
import { SequenceDetector } from './sequencer.js'
import { FlowTracker } from './flow-tracker.js'
import { StateManager } from './state-manager.js'

export type PipelineTier = 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface PipelineConfig {
  level: ProtectionLevel
  context: RuleContext
  cache: ActionCache
  contentTracker: ContentTracker
  sequenceDetector: SequenceDetector
  flowTracker: FlowTracker
  ruleHierarchy: RuleHierarchy
  ruleVersion: number
  allowedFixTransforms?: boolean
  enableReasoningCheck?: boolean
  stateManager?: StateManager
}

/**
 * Tiered enforcement pipeline.
 *
 * Each tier runs from cheapest to most expensive.
 * First definitive match (ALLOW or DENY) short-circuits.
 *
 * Tiers:
 *   1 — Cache hit check (O(1), instant)
 *   2 — Blocklist/allowlist regex match (~0.01ms)
 *   3 — Simple conditionals (path, tool name, time) (~0.1ms)
 *   4 — Rate limit check (~0.01ms)
 *   5 — File content scan (~1-10ms, only if changed)
 *   6 — Sequence + flow tracking (~0.5ms)
 *   7 — Reasoning coherence check (~5-50ms)
 */
export class EnforcementPipeline {
  private config: PipelineConfig
  private denyFirstTime: Map<string, boolean> = new Map()
  private circuitBreaker: Map<string, { count: number; startTime: number }> = new Map()
  private rateCounts: Map<string, { count: number; windowStart: number }> = new Map()
  private lastRulesHash: string = ''
  private previousRulesHash: string = ''

  constructor(config: PipelineConfig) {
    this.config = config
    this.lastRulesHash = this.computeRulesHash()
    this.loadState()
  }

  /** Load persisted state from StateManager into instance maps. */
  private loadState(): void {
    const sm = this.config.stateManager
    if (!sm) return

    for (const ruleId of Object.keys(sm.denyFirstTime)) {
      this.denyFirstTime.set(ruleId, true)
    }
    for (const [key, val] of Object.entries(sm.circuitBreaker)) {
      this.circuitBreaker.set(key, { count: val.count, startTime: val.startTime })
    }
    for (const [key, val] of Object.entries(sm.rateCounts)) {
      this.rateCounts.set(key, { count: val.count, windowStart: val.windowStart })
    }
  }

  private computeRulesHash(): string {
    const h = this.config.ruleHierarchy
    return [
      h.global ? hashRulesFile(h.global.sourcePath) : '',
      h.project ? hashRulesFile(h.project.sourcePath) : '',
      h.local ? hashRulesFile(h.local.sourcePath) : '',
    ].join(':')
  }

  /**
   * Check if rules have changed since last evaluation.
   * If so, flush cache and re-merge rules.
   */
  private checkRuleVersion(): boolean {
    const currentHash = this.computeRulesHash()
    if (currentHash !== this.lastRulesHash) {
      this.previousRulesHash = this.lastRulesHash
      this.lastRulesHash = currentHash
      this.config.cache.invalidate(this.config.ruleVersion)
      this.denyFirstTime.clear()
      return true  // rules changed
    }
    return false
  }

  /**
   * Evaluate an action against all active rules.
   */
  async evaluate(input: EnforceInput): Promise<EnforceResult> {
    const start = Date.now()

    // Check global kill switch (sentinel file)
    const sentinelPath = join(homedir(), '.keel', 'DISABLED')
    if (existsSync(sentinelPath)) {
      try {
        const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf-8'))
        if (sentinel.expires_at && new Date(sentinel.expires_at) < new Date()) {
          rmSync(sentinelPath)
        } else {
          return this.result('allow', '', 'Enforcement disabled via kill switch', start, false, 0)
        }
      } catch { /* ignore corrupt sentinel */ }
    }

    this.checkRuleVersion()

    // Get merged rules for current level and context
    const rules = mergeRules(this.config.ruleHierarchy, input.level, input.context)

    // ── Tier 1: Cache check ──
    const cached = this.config.cache.get(input.tool, input.args, this.config.ruleVersion)
    if (cached) {
      if (cached.verdict === 'deny' || cached.verdict === 'block') {
        return this.result('deny', cached.rule_id || '', 'Cached deny verdict', start, true, 1)
      }
      if (cached.verdict === 'allow') {
        return this.result('allow', '', 'Allowed (cached)', start, true, 1)
      }
    }

    // ── Tier 2-3: Match rules against action ──
    for (const rule of rules) {
      // Respect "never deny first time" — first violation of any rule = warn
      const isFirstTime = !this.denyFirstTime.has(rule.id)

      // Check rate limit rules
      if (rule.type === 'rate') {
        const matchPattern = rule.match || input.tool
        const windowSec = rule.window_seconds || 60
        const maxCalls = rule.max_calls || 10
        const rateKey = `rate:${rule.id}:${matchPattern}`
        const now = Date.now()
        const existing = this.rateCounts.get(rateKey)

        if (existing && (now - existing.windowStart) < windowSec * 1000) {
          existing.count++
          if (existing.count > maxCalls) {
            return this.block(input, rule, `Rate limit: ${maxCalls} calls per ${windowSec}s for "${matchPattern}"`, start, 2)
          }
        } else {
          this.rateCounts.set(rateKey, { count: 1, windowStart: now })
        }
        continue
      }

      // Check time-based rules
      if (rule.type === 'time' && rule.schedule) {
        const now = new Date()
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
        const currentDay = dayNames[now.getDay()]
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

        if (rule.schedule.days && !rule.schedule.days.some(d => d.toLowerCase() === currentDay)) {
          // Today is outside schedule
          return this.block(input, rule, `Outside schedule: ${rule.schedule.days.join(', ')} ${rule.schedule.start}-${rule.schedule.end}`, start, 2)
        }
        if (rule.schedule.start && currentTime < rule.schedule.start) {
          return this.block(input, rule, `Before schedule start: ${rule.schedule.start}`, start, 2)
        }
        if (rule.schedule.end && currentTime > rule.schedule.end) {
          return this.block(input, rule, `After schedule end: ${rule.schedule.end}`, start, 2)
        }
        continue
      }

      // Match against command patterns
      if (rule.type === 'command' && rule.match) {
        const cmdStr = typeof input.args === 'string' ? input.args : JSON.stringify(input.args)
        const regex = new RegExp(rule.match, 'i')

        if (regex.test(cmdStr)) {
          // Check unless_reasoning
          if (rule.unless_reasoning && input.reasoning) {
            const unlessRegex = new RegExp(rule.unless_reasoning, 'i')
            if (unlessRegex.test(input.reasoning)) {
              continue  // Reasoning explains the action — allow
            }
          }

          // Check unless patterns
          if (rule.unless) {
            let shouldSkip = false
            for (const u of rule.unless) {
              if (u.regex) {
                const unlessRegex = new RegExp(u.regex, 'i')
                if (unlessRegex.test(cmdStr)) {
                  shouldSkip = true
                  break
                }
              }
            }
            if (shouldSkip) continue
          }

          // Fix action — mutate arguments
          if (rule.action === 'fix' && rule.fix) {
            return this.fixAction(input, rule, cmdStr, start)
          }

          if (isFirstTime && rule.action === 'deny') {
            this.denyFirstTime.set(rule.id, true)
            // Persist to StateManager so future calls (even in new processes) know this isn't first time
            const sm = this.config.stateManager
            if (sm) sm.markFirstTime(rule.id)
            return this.warn(input, rule, `First violation of "${rule.id}" — warning only. Next time will be blocked.`, start, 2)
          }

          return this.block(input, rule, rule.message, start, 2)
        }
      }

      // Match against filesystem patterns
      if (rule.type === 'filesystem' && rule.paths) {
        const path = typeof input.args === 'object' && input.args !== null
          ? (input.args as Record<string, unknown>).path || (input.args as Record<string, unknown>).file || ''
          : ''

        const pathStr = String(path)
        for (const p of rule.paths) {
          const isNegation = p.startsWith('!')
          const pattern = isNegation ? p.slice(1) : p

          if (isNegation && pathStr.startsWith(pattern.replace('*', '').replace('/*', ''))) {
            // Path is in the negated (protected) zone
            if (isFirstTime && rule.action === 'deny') {
              this.denyFirstTime.set(rule.id, true)
              return this.warn(input, rule, `First violation of "${rule.id}" — warning only.`, start, 3)
            }
            return this.block(input, rule, rule.message, start, 3)
          }
        }
      }

      // Match against network patterns
      if (rule.type === 'network' && rule.match) {
        const url = typeof input.args === 'object' && input.args !== null
          ? (input.args as Record<string, unknown>).url || (input.args as Record<string, unknown>).host || ''
          : ''

        const urlStr = String(url)
        // Check except list first
        if (rule.except) {
          let isExcepted = false
          for (const ex of rule.except) {
            if (urlStr.includes(ex)) { isExcepted = true; break }
          }
          if (isExcepted) continue
        }

        const regex = new RegExp(rule.match, 'i')
        if (regex.test(urlStr)) {
          if (isFirstTime && rule.action === 'deny') {
            this.denyFirstTime.set(rule.id, true)
            return this.warn(input, rule, `First violation of "${rule.id}" — warning only.`, start, 3)
          }
          return this.block(input, rule, rule.message, start, 3)
        }
      }

      // Match against content patterns (Tier 5 — only if file changed)
      if (rule.type === 'content' && rule.patterns && rule.paths) {
        const path = typeof input.args === 'object' && input.args !== null
          ? (input.args as Record<string, unknown>).path || ''
          : ''

        const pathStr = String(path)
        if (pathStr && existsSync(pathStr) && this.config.contentTracker.hasChanged(pathStr)) {
          for (const pattern of rule.patterns) {
            if (pattern.regex) {
              const content = readFileSync(pathStr, 'utf-8')
              const regex = new RegExp(pattern.regex, 'i')
              if (regex.test(content)) {
                if (isFirstTime && rule.action === 'deny') {
                  this.denyFirstTime.set(rule.id, true)
                  return this.warn(input, rule, `First violation of "${rule.id}" — warning only.`, start, 5)
                }
                return this.block(input, rule, rule.message, start, 5)
              }
            }
          }
          this.config.contentTracker.markUnchanged(pathStr)
        }
      }

      // Check sequence rules (Tier 6)
      if (rule.type === 'sequence' && rule.steps) {
        const seqResult = this.config.sequenceDetector.check(input, rule)
        if (seqResult) {
          return this.block(input, rule, seqResult, start, 6)
        }
      }

      // Check flow/IFC rules (Tier 6)
      if (rule.type === 'flow' && rule.sources && rule.sinks) {
        const flowResult = this.config.flowTracker.check(input, rule)
        if (flowResult) {
          return this.block(input, rule, flowResult, start, 6)
        }
      }

      // Session duration check
      if (rule.type === 'session' && rule.max_duration_minutes) {
        // This would be checked per-session, not per-action. Handled by context manager.
        continue
      }
    }

    // ── Tier 7: Reasoning coherence check ──
    if (this.config.enableReasoningCheck && input.reasoning) {
      // Simple heuristic: if agent is doing something it shouldn't
      const dangerSignals = [
        /ignore.*(rule|policy|restrict)/i,
        /bypass.*(check|guard|protect)/i,
        /disable.*(safety|keel|hook)/i,
        /workaround.*(rule|block)/i,
        /don'?t tell.*(user|human)/i,
        /hid(e|den).*(action|change)/i,
      ]
      for (const signal of dangerSignals) {
        if (signal.test(input.reasoning)) {
          return this.result('warn', 'reasoning-anomaly', `Suspicious reasoning pattern detected`, start, false, 7)
        }
      }
    }

    // ── Allowed — cache and return ──
    this.config.cache.set(input.tool, input.args, this.config.ruleVersion, {
      verdict: 'allow',
      rule_id: null,
      count: 0,
      timestamp: Date.now(),
    })

    return this.result('allow', '', 'Allowed (no matching rule)', start, false, 0)
  }

  /**
   * Evaluate a proposed fix/mutation instead of blocking.
   */
  private fixAction(input: EnforceInput, rule: KeelRule, cmdStr: string, start: number): EnforceResult {
    if (!rule.fix) {
      return this.block(input, rule, rule.message, start, 2)
    }

    let fixed = cmdStr
    for (const t of rule.fix) {
      fixed = fixed.replace(new RegExp(t.pattern, 'g'), t.replace)
    }

    return {
      action: 'fix',
      rule_id: rule.id,
      rule_name: rule.id,
      message: `${rule.message}\n   → Applied fix: ${cmdStr} → ${fixed}`,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - start,
      cache_hit: false,
      tier: 2,
      fix_result: { original: cmdStr, fixed },
    }
  }

  private block(input: EnforceInput, rule: KeelRule, message: string, start: number, tier: PipelineTier): EnforceResult {
    // Track circuit breaker
    const cbKey = `${rule.id}:${input.tool}`
    const now = Date.now()
    const cb = this.circuitBreaker.get(cbKey) || { count: 0, startTime: now }

    // Reset if more than 60s since first deny
    if (now - cb.startTime > 60000) {
      cb.count = 0
      cb.startTime = now
    }

    cb.count++
    this.circuitBreaker.set(cbKey, cb)

    // Persist to StateManager
    const sm = this.config.stateManager
    if (sm) {
      sm.circuitBreaker[cbKey] = { count: cb.count, startTime: cb.startTime }
    }

    // Cache the deny
    this.config.cache.set(input.tool, input.args, this.config.ruleVersion, {
      verdict: 'deny',
      rule_id: rule.id,
      count: 0,
      timestamp: Date.now(),
    })

    // Track for flow analysis
    this.config.flowTracker.record(input, rule.id)
    this.config.sequenceDetector.record(input)

    const result = this.result('deny', rule.id, message, start, false, tier)

    // Circuit breaker: if 3+ denies in 60s for same rule+tool, escalate
    if (cb.count >= 3) {
      return { ...result, message: `${message}\n   ⚠ This has been blocked ${cb.count} times in 60s. Approve with \`keel allow ${rule.id} --once\` or investigate.` }
    }

    return result
  }

  private warn(input: EnforceInput, rule: KeelRule, message: string, start: number, tier: PipelineTier): EnforceResult {
    this.config.flowTracker.record(input, rule.id)
    return this.result('warn', rule.id, message, start, false, tier)
  }

  private result(
    action: EnforcementAction,
    ruleId: string,
    message: string,
    start: number,
    cacheHit: boolean,
    tier: number,
    fixResult?: Record<string, unknown>,
  ): EnforceResult {
    return {
      action,
      rule_id: ruleId || null,
      rule_name: ruleId,
      message,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - start,
      cache_hit: cacheHit,
      tier: tier as PipelineTier,
      fix_result: fixResult,
    }
  }

  getCircuitBreakerState(): Array<{ ruleId: string; tool: string; count: number }> {
    const state: Array<{ ruleId: string; tool: string; count: number }> = []
    for (const [key, val] of this.circuitBreaker) {
      const [ruleId, tool] = key.split(':')
      state.push({ ruleId, tool, count: val.count })
    }
    return state
  }

  getFirstTimeViolations(): string[] {
    return Array.from(this.denyFirstTime.keys())
  }
}


