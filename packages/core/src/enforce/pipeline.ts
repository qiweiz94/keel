import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  KeelRule, EnforceInput, EnforceResult, EnforcementAction,
  ProtectionLevel, RuleContext, CacheEntry, AuditEntry,
} from '../types.js'
import { ActionCache, ContentTracker, type CacheContext } from './cache.js'
import type { RuleHierarchy } from './rule-parser.js'
import { mergeRules, detectConflicts, hashRulesFile, loadRuleHierarchy, validateRules } from './rule-parser.js'
import { SequenceDetector } from './sequencer.js'
import { FlowTracker } from './flow-tracker.js'
import { StateManager } from './state-manager.js'
import { VerificationTracker } from './verification.js'
import { FileRuleOverrideStore } from './overrides.js'
import { commandString, argPath } from './arg-utils.js'

export type PipelineTier = 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface PipelineConfig {
  level: ProtectionLevel
  context: RuleContext
  cache: ActionCache
  contentTracker: ContentTracker
  sequenceDetector: SequenceDetector
  verificationTracker?: VerificationTracker
  flowTracker: FlowTracker
  ruleHierarchy: RuleHierarchy
  ruleVersion: number
  allowedFixTransforms?: boolean
  stateManager?: StateManager
  overrideStore?: import('./overrides.js').RuleOverrideStore
  reloadRules?: () => RuleHierarchy
  ruleFingerprint?: () => string
  onRulesReload?: (hierarchy: RuleHierarchy) => void
  /** Called when a rules reload failed validation; the previous hierarchy is kept. */
  onRulesError?: (errors: string[]) => void
  disableFile?: string
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
  private verificationTracker: VerificationTracker
  private denyFirstTime: Map<string, boolean> = new Map()
  private circuitBreaker: Map<string, { count: number; startTime: number }> = new Map()
  private rateCounts: Map<string, { count: number; windowStart: number }> = new Map()
  private lastRulesHash: string = ''
  private previousRulesHash: string = ''
  private readonly overrideStore

  constructor(config: PipelineConfig) {
    this.config = config
    this.verificationTracker = config.verificationTracker || new VerificationTracker(config.stateManager)
    this.overrideStore = config.overrideStore || new FileRuleOverrideStore()
    this.lastRulesHash = this.computeRulesHash()
    this.loadState()
  }

  /** Load persisted state from StateManager into instance maps. */
  private loadState(): void {
    const sm = this.config.stateManager
    if (!sm) return

    for (const ruleId of Object.keys(sm.denyFirstTime)) {
      if (!sm.isFirstTime(ruleId, this.lastRulesHash)) this.denyFirstTime.set(ruleId, true)
    }
    for (const [key, val] of Object.entries(sm.circuitBreaker)) {
      this.circuitBreaker.set(key, { count: val.count, startTime: val.startTime })
    }
    for (const [key, val] of Object.entries(sm.rateCounts)) {
      this.rateCounts.set(key, { count: val.count, windowStart: val.windowStart })
    }
  }

  private computeRulesHash(): string {
    if (this.config.ruleFingerprint) return this.config.ruleFingerprint()
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
      const reloaded = this.config.reloadRules?.()
      if (reloaded) {
        const errors = [reloaded.global, reloaded.user, reloaded.project, reloaded.local]
          .flatMap(source => source ? [...(source.errors || []), ...validateRules(source.rules)] : [])
        if (errors.length) {
          // Last known good: a typo mid-session must not silence the
          // guardrails. Keep enforcing with the previous valid hierarchy,
          // surface the errors, and leave the hash unchanged so the reload
          // is retried (and the error re-surfaced) on the next call.
          this.config.onRulesError?.(errors)
          return false
        }
        this.config.ruleHierarchy = reloaded
        this.config.onRulesReload?.(reloaded)
      }
      this.previousRulesHash = this.lastRulesHash
      this.lastRulesHash = this.computeRulesHash()
      this.config.ruleVersion += 1
      this.config.cache.invalidate(this.config.ruleVersion)
      this.denyFirstTime.clear()
      this.config.contentTracker.clear()
      this.config.sequenceDetector.clear()
      this.config.flowTracker.clear()
      return true  // rules changed
    }
    return false
  }

  /**
   * Evaluate an action against all active rules.
   */
  async evaluate(input: EnforceInput): Promise<EnforceResult> {
    const start = Date.now()
    // The hierarchy is reloaded below (checkRuleVersion); the active level is
    // re-derived from the reloaded rules so the first call after a level change
    // (keel level / enforce --persist) evaluates at the NEW level, not the
    // stale caller-supplied one.
    this.checkRuleVersion()
    const level = this.effectiveLevel(input)
    const depth = input.depth || (level === 'protect' ? 'deep' : level === 'sprint' ? 'fast' : 'full')
    // `level: protect` rules are floors: even at sprint (fast depth) they must
    // stay fully enforced, so their check classes cannot be skipped.
    const protectFloor = (rules: ReturnType<typeof mergeRules>) =>
      rules.some(rule => rule.level === 'protect' && (rule.type === 'content' || rule.type === 'sequence' || rule.type === 'flow'))
    const reasoningChecks = depth === 'deep'

    // Check global kill switch (sentinel file)
    const sentinelPath = this.config.disableFile || join(homedir(), '.keel', 'DISABLED')
    if (existsSync(sentinelPath)) {
      try {
        const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf-8'))
        if (sentinel.expires_at && new Date(sentinel.expires_at) < new Date()) {
          rmSync(sentinelPath)
        } else {
          return this.result('allow', '', 'Enforcement disabled via kill switch', start, false, 0)
        }
      } catch (err) {
        // ENOENT is a race: the sentinel was removed by another process between
        // existsSync and readFileSync — treat as not-disabled, not as corruption.
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          // not disabled
        } else {
          throw new Error('Invalid Keel kill-switch state; run `keel enable` to recover')
        }
      }
    }

    // Flow tracking observes every action, not only actions that already
    // violated another rule. This lets a later sink see sensitive reads.
    this.config.flowTracker.record(input, '')

    // Get merged rules for current level and context
    const rules = mergeRules(this.config.ruleHierarchy, level, input.context)
    const deepChecks = depth !== 'fast' || protectFloor(rules)
    const statefulRules = rules.filter(rule =>
      ['verification', 'rate', 'time'].includes(rule.type)
      || (deepChecks && ['sequence', 'flow'].includes(rule.type))
    )
    // Approval-gated rules are re-evaluated on every call: the user may grant
    // a one-time override (`keel allow <id> --once`) between attempts, so a
    // cached verdict would bypass fresh override checks.
    const gatedRules = rules.filter(rule => this.effectiveAction(rule, input) === 'prompt')
    if (statefulRules.length) {
      const maxWindow = Math.max(...statefulRules.map(rule => rule.sequence_window_seconds || rule.window_seconds || 60))
      this.config.sequenceDetector.setWindow(maxWindow * 1000)
      // Stateful rules depend on every action and cannot use a stateless cache verdict.
      this.config.sequenceDetector.record(input)
    }

    for (const rule of statefulRules) {
      if (rule.type === 'verification') {
        const boundaryMessage = this.verificationTracker.boundary(rule, input)
          if (boundaryMessage) {
            const stateKey = `${rule.id}:${input.cwd}`
            const boundaryRule: KeelRule = boundaryMessage.action
              ? { ...rule, action: boundaryMessage.action as KeelRule['action'] }
              : rule
            return this.violation(input, boundaryRule, boundaryMessage.message, start, 6, stateKey)
          }
      }
    }

    // ── Tier 1: Cache check ──
    const cached = statefulRules.length || gatedRules.length || input.action_override ? null : this.config.cache.get(
      input.tool, input.args, this.config.ruleVersion, this.cacheContext(input, depth),
    )
    if (cached) {
      if (cached.verdict === 'deny' || cached.verdict === 'block') {
        if (cached.rule_id && this.overrideStore.consume(cached.rule_id)) {
          return this.result('allow', cached.rule_id, `One-time override consumed for "${cached.rule_id}"`, start, true, 1)
        }
        return this.result('deny', cached.rule_id || '', 'Cached deny verdict', start, true, 1)
      }
      if (cached.verdict === 'allow') {
        return this.result('allow', '', 'Allowed (cached)', start, true, 1)
      }
    }

    // ── Tier 2-3: Match rules against action ──
    for (const rule of rules) {
      // Check rate limit rules
      if (rule.type === 'rate') {
        const matchPattern = rule.match || input.tool
        if (rule.match && !this.matchesRulePattern(rule.match, `${input.tool} ${JSON.stringify(input.args)}`)) continue
        const windowSec = rule.window_seconds || 60
        const maxCalls = rule.max_calls || 10
        const rateKey = `rate:${rule.id}:${matchPattern}`
        const now = Date.now()
        const existing = this.rateCounts.get(rateKey)

        const exceeded = this.config.stateManager
          ? this.config.stateManager.checkRateLimit(rule.id, matchPattern, windowSec, maxCalls)
          : (() => {
            if (existing && (now - existing.windowStart) < windowSec * 1000) {
              existing.count++
              return existing.count > maxCalls
            }
            this.rateCounts.set(rateKey, { count: 1, windowStart: now })
            return false
          })()
        if (this.config.stateManager) {
          const persisted = this.config.stateManager.rateCounts[rateKey]
          if (persisted) this.rateCounts.set(rateKey, { ...persisted })
        }
        if (exceeded) {
          return this.violation(input, rule, `Rate limit: ${maxCalls} calls per ${windowSec}s for "${matchPattern}"`, start, 2)
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
          return this.violation(input, rule, `Outside schedule: ${rule.schedule.days.join(', ')} ${rule.schedule.start}-${rule.schedule.end}`, start, 2)
        }
        if (rule.schedule.start && currentTime < rule.schedule.start) {
          return this.violation(input, rule, `Before schedule start: ${rule.schedule.start}`, start, 2)
        }
        if (rule.schedule.end && currentTime > rule.schedule.end) {
          return this.violation(input, rule, `After schedule end: ${rule.schedule.end}`, start, 2)
        }
        continue
      }

      // Match against command patterns
      if (rule.type === 'command' && (rule.match || rule.match_regex || rule.match_prefix)) {
        const cmdStr = commandString(input)
        const pattern = rule.match_regex || rule.match
        const matches = rule.match_prefix
          ? cmdStr.toLowerCase().startsWith(rule.match_prefix.toLowerCase())
          : !!pattern && this.matchesRulePattern(pattern, cmdStr)

        if (matches) {
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
          if (this.effectiveAction(rule, input) === 'fix' && rule.fix) {
            return this.fixAction(input, rule, cmdStr, start)
          }

          return this.violation(input, rule, rule.message, start, 2)
        }
      }

      // Match against filesystem patterns
      // Reads are skipped (mirroring content rules): reading a secret file
      // for legitimate config work must not double-flag, and exfiltration of
      // read data is the flow rules' job. Filesystem rules police writes.
      if (rule.type === 'filesystem' && rule.paths && !/^read/i.test(input.tool)) {
        const args = input.args as Record<string, unknown>
        const pathStr = argPath(args)
        const resolvedPath = pathStr && !pathStr.startsWith('/') ? resolve(input.cwd, pathStr) : pathStr
        const operation = String(args.operation || '')
        const excluded = (rule.exclude || []).some(p => this.pathMatches(resolvedPath, p))
        const pathMatched = rule.paths.some(p => p.startsWith('!')
          ? !this.pathMatches(resolvedPath, p.slice(1))
          : this.pathMatches(resolvedPath, p))
        const operationMatched = !rule.operations?.length || rule.operations.includes(operation as any)
        if (pathMatched && operationMatched && !excluded) return this.violation(input, rule, rule.message, start, 3)
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

        if (this.matchesRulePattern(rule.match, urlStr)) return this.violation(input, rule, rule.message, start, 3)
      }

      // Match against environment variable names appearing in the command
      // (echo $VAR, printenv VAR, export VAR=...) — the pipeline has no
      // access to the agent's process environment, so matching is on the
      // command/args text. Never on file content (commandString strips it).
      if (rule.type === 'env' && rule.vars?.length) {
        const cmdStr = commandString(input)
        const varHit = rule.vars.some(v => cmdStr.toLowerCase().includes(String(v).toLowerCase()))
        if (varHit) return this.violation(input, rule, rule.message, start, 3)
      }

      // Match against content patterns (Tier 5 — only if file changed)
      // Content rules police writes: a read of an already-written file would
      // double-flag content the write rule already accepted, and pure reads
      // (e.g. reading .env to detect exfiltration via flow rules) must pass.
      if (deepChecks && rule.type === 'content' && rule.patterns && !/^read/i.test(input.tool)) {
        const args = input.args as Record<string, unknown>
        const pathStr = argPath(args)
        const resolvedPath = pathStr && !pathStr.startsWith('/') ? resolve(input.cwd, pathStr) : pathStr
        // apply_patch carries the new content in patchText and the target
        // path only inside `*** Add File:` markers — both are honored here.
        const patchText = String(args.patchText || '')
        const inlineContent = String(args.content || args.text || patchText || '')
        const isFile = resolvedPath && existsSync(resolvedPath) && statSync(resolvedPath).isFile()
        // Inline content is ALWAYS checkable — it is what the agent is about
        // to write. Only the disk-scan fallback is gated on the file having
        // changed since the last scan; gating inline content on the file's
        // disk hash let an overwrite of an already-scanned file smuggle
        // secrets past the content rules.
        const diskChanged = isFile && this.config.contentTracker.hasChanged(resolvedPath)
        if (inlineContent || diskChanged) {
          for (const pattern of rule.patterns) {
            const content = inlineContent || (isFile ? readFileSync(resolvedPath, 'utf-8') : '')
            if ((pattern.regex && this.matchesRulePattern(pattern.regex, content)) || (pattern.prefix && content.startsWith(pattern.prefix))) {
              return this.violation(input, rule, rule.message, start, 5)
            }
          }
          if (isFile) this.config.contentTracker.markUnchanged(resolvedPath)
        }
      }

      // Check sequence rules (Tier 6)
      if (deepChecks && rule.type === 'sequence' && rule.steps) {
        const seqResult = this.config.sequenceDetector.check(input, rule)
        if (seqResult) {
          return this.violation(input, rule, seqResult, start, 6)
        }
      }

      if (rule.type === 'verification') {
        this.verificationTracker.observeTrigger(rule, input)
      }

      // Check flow/IFC rules (Tier 6)
      if (deepChecks && rule.type === 'flow' && rule.sources && rule.sinks) {
        // Record successful reads before evaluating a later sink action.
        this.config.flowTracker.record(input, rule)
        const flowResult = this.config.flowTracker.check(input, rule)
        if (flowResult) {
          return this.violation(input, rule, flowResult, start, 6)
        }
      }

      // Session duration check
      if (rule.type === 'session' && rule.max_duration_minutes) {
        // This would be checked per-session, not per-action. Handled by context manager.
        continue
      }
    }

    // ── Tier 7: Reasoning coherence check ──
    if (reasoningChecks && level === 'protect' && input.reasoning) {
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
    if (!statefulRules.length && !gatedRules.length) {
      this.config.cache.set(input.tool, input.args, this.config.ruleVersion, {
        verdict: 'allow',
        rule_id: null,
        count: 0,
        timestamp: Date.now(),
      }, this.cacheContext(input, depth))
    }

    return this.result('allow', '', 'Allowed (no matching rule)', start, false, 0)
  }

  markVerificationSatisfied(input: EnforceInput): void {
    const rules = mergeRules(this.config.ruleHierarchy, this.effectiveLevel(input), input.context)
    for (const rule of rules) {
      if (rule.type === 'verification') this.verificationTracker.markSatisfied(rule, input)
    }
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

    const sm = this.config.stateManager
    if (sm) {
      sm.recordCircuitBreaker(rule.id, input.tool)
      const persisted = sm.circuitBreaker[cbKey]
      if (persisted) {
        cb.count = persisted.count
        cb.startTime = persisted.startTime
      }
    } else {
      cb.count++
    }
    this.circuitBreaker.set(cbKey, cb)

    // Cache the deny
    this.config.cache.set(input.tool, input.args, this.config.ruleVersion, {
      verdict: 'deny',
      rule_id: rule.id,
      count: 0,
      timestamp: Date.now(),
    }, this.cacheContext(input, this.effectiveDepth(input)))

    // Track for flow analysis
    this.config.flowTracker.record(input, rule.id)

    const result = this.result('deny', rule.id, message, start, false, tier)

    // Circuit breaker: if 3+ denies in 60s for same rule+tool, escalate
    if (cb.count >= 3) {
      return { ...result, message: `${message}\n   ⚠ This has been blocked ${cb.count} times in 60s. Approve with \`keel allow ${rule.id} --once\` or investigate.` }
    }

    return result
  }

  /**
   * Approval gate (`action: prompt`). Behaves like a deny (blocks, tracks the
   * circuit breaker, caches a deny verdict for override consumption) but is
   * reported as `prompt` and always requires explicit user approval via
   * `keel allow <id> --once`. Never escalates from warn-once — the first
   * violation is already gated.
   */
  private gate(input: EnforceInput, rule: KeelRule, message: string, start: number, tier: PipelineTier): EnforceResult {
    const blocked = this.block(input, rule, message, start, tier)
    return {
      ...blocked,
      action: 'prompt',
      message: `${blocked.message}\n   → Approval required: run \`keel allow ${rule.id} --once\` to approve this action.`,
    }
  }

  private violation(input: EnforceInput, rule: KeelRule, message: string, start: number, tier: PipelineTier, warningKey = rule.id): EnforceResult {
    const action = this.effectiveAction(rule, input)
    if (action === 'fix') {
      if (rule.fix && rule.type === 'command') {
        const args = input.args as Record<string, unknown>
        const raw = typeof input.args === 'string'
          ? input.args
          : typeof args.command === 'string' ? args.command
            : typeof args.cmd === 'string' ? args.cmd : ''
        if (raw) return this.fixAction(input, rule, raw, start)
      }
      return this.warn(input, rule, `${message} (no automatic fix available)`, start, tier)
    }
    if (action === 'warn' || action === 'allow' || action === 'report') {
      return action === 'warn' ? this.warn(input, rule, message, start, tier) : this.result(action, rule.id, message, start, false, tier)
    }
    if (action === 'prompt') {
      // Approval gate: always blocks, no first-warn escalation. Never auto-
      // downgraded by sprint level — irreversible operations stay gated.
      // A human-run `keel allow <id> --once` covers the next violation.
      if (this.overrideStore.consume(rule.id)) {
        return this.result('allow', rule.id, `One-time override consumed for "${rule.id}"`, start, false, tier)
      }
      return this.gate(input, rule, message, start, tier)
    }
    if (action === 'deny' || action === 'block') {
      const first = this.isFirstWarning(warningKey)
      if (first && input.action_override !== 'deny' && input.action_override !== 'block') {
        // The first violation only warns — never consume an armed override
        // for it, or the approval is wasted on a call that would not have
        // been blocked (the next one would then be blocked anyway).
        this.denyFirstTime.set(warningKey, true)
        this.config.stateManager?.markFirstTime(warningKey, this.lastRulesHash)
        return this.warn(input, rule, `First violation of "${rule.id}" — warning only. Next time will be blocked.`, start, tier)
      }
      if (this.overrideStore.consume(rule.id)) {
        return this.result('allow', rule.id, `One-time override consumed for "${rule.id}"`, start, false, tier)
      }
      return this.block(input, rule, message, start, tier)
    }
    return this.warn(input, rule, `${message} (action "${action}" is not supported by this integration)`, start, tier)
  }

  private effectiveLevel(input: EnforceInput): ProtectionLevel {
    const h = this.config.ruleHierarchy
    return (h.project?.config?.level || h.global?.config?.level || input.level) as ProtectionLevel
  }

  private effectiveAction(rule: KeelRule, input: EnforceInput): EnforcementAction {
    if (input.action_override) return input.action_override
    // `level: protect` rules are floors: always enforced at their declared
    // action, never softened by the sprint dial's deny→warn downgrade.
    if (rule.level === 'protect') return rule.action
    // The sprint downgrade is derived from the LIVE level (reloaded with the
    // rules), so `keel level` takes effect without a plugin restart.
    if (this.effectiveLevel(input) === 'sprint' && (rule.action === 'deny' || rule.action === 'block')) return 'warn'
    return rule.action
  }

  private cacheContext(input: EnforceInput, depth: string): CacheContext {
    return {
      cwd: input.cwd,
      level: this.effectiveLevel(input),
      context: input.context,
      depth,
      action: input.action_override,
      rules_hash: this.lastRulesHash,
    }
  }

  private effectiveDepth(input: EnforceInput): string {
    return input.depth || (this.effectiveLevel(input) === 'protect' ? 'deep' : this.effectiveLevel(input) === 'sprint' ? 'fast' : 'full')
  }

  private matchesRulePattern(pattern: string, value: string): boolean {
    try { return new RegExp(pattern, 'i').test(value) } catch { return false }
  }

  private isFirstWarning(ruleId: string): boolean {
    if (this.denyFirstTime.has(ruleId)) return false
    return this.config.stateManager?.isFirstTime(ruleId, this.lastRulesHash) ?? true
  }

  private pathMatches(value: string, pattern: string): boolean {
    const normalized = pattern
    // `**` matches across any number of segments; `*` matches one segment.
    // Only engaged for patterns that use `**`, keeping the legacy prefix and
    // includes semantics for simple patterns (existing rules depend on them).
    if (normalized.includes('**')) {
      const regex = '^' + normalized
        .split('**')
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*'))
        .join('.*') + '$'
      try { return new RegExp(regex).test(value) } catch { return false }
    }
    const prefix = normalized.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\/$/, '')
    return value === prefix || value.startsWith(prefix + '/') || value.includes(normalized.replace(/\*/g, ''))
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
