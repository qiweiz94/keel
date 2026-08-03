// ── Core enforcement primitive ──────────────────────────────────────

export type ProtectionLevel = 'sprint' | 'balanced' | 'protect'

export type RuleScope = 'global' | 'user' | 'project' | 'folder' | 'session'

export type RuleContext = 'local' | 'ci' | 'both'

export type EnforcementDepth = 'fast' | 'full' | 'deep'

export type EnforcementAction = 'block' | 'deny' | 'warn' | 'prompt' | 'allow' | 'mask' | 'fix' | 'report'

export type RuleType =
  | 'command' | 'filesystem' | 'content' | 'env' | 'network'
  | 'rate' | 'time' | 'sequence' | 'flow' | 'mcp'
  | 'session' | 'inheritance' | 'context' | 'verification' | 'meta'

// ── Keel configuration (YAML frontmatter in CLAUDE.md) ──────────────

export interface KeelConfig {
  version: number
  level?: ProtectionLevel
  rules?: KeelRule[]
  cache?: CacheConfig
  re_injection?: ReInjectionConfig
}

export interface KeelRule {
  id: string
  type: RuleType
  level?: ProtectionLevel           // sprint | balanced | protect — when is this rule active
  scope?: RuleScope                 // where in the hierarchy this rule applies
  context?: RuleContext[]           // local | ci | both
  action: EnforcementAction
  message: string
  priority?: number                 // higher = evaluated first

  // ── Command rules ──
  match?: string                    // regex or literal
  match_prefix?: string
  match_regex?: string

  // ── Filesystem rules ──
  paths?: string[]
  exclude?: string[]
  operations?: ('read' | 'write' | 'delete' | 'overwrite' | 'glob')[]

  // ── Content rules ──
  patterns?: ({ regex?: string; prefix?: string })[]

  // ── Network rules ──
  except?: string[]                 // domains to allow

  // ── Environment rules ──
  vars?: string[]

  // ── Rate limit rules ──
  window_seconds?: number
  max_calls?: number

  // ── Time rules ──
  timezone?: string
  schedule?: { start: string; end: string; days?: string[] }
  outside_schedule_action?: EnforcementAction

  // ── Sequence rules ──
  steps?: SequenceStep[]
  sequence_window_seconds?: number

  // ── Verification obligations ──
  trigger?: VerificationMatcher
  satisfy?: VerificationMatcher
  boundaries?: Record<string, VerificationBoundary>
  verification_window_seconds?: number

  // ── Flow / IFC rules ──
  sources?: string[]
  sinks?: string[]

  // ── MCP rules ──
  mcp_check?: 'tool_descriptions' | 'tool_results' | 'server_changes'

  // ── Session rules ──
  max_duration_minutes?: number

  // ── Inheritance rules ──
  propagate_rules?: 'all' | 'global' | 'none'
  propagate_memory?: boolean
  resource_access?: 'full' | 'restrict' | 'none'
  termination?: 'quarantine' | 'merge' | 'discard'

  // ── Fix/mutation ──
  fix?: FixTransform[]

  // ── Reasoning awareness ──
  unless_reasoning?: string         // regex — allow if agent reasoning matches
  unless?: { regex?: string }[]     // existing from CommandRule

  // ── Meta rules ──
  condition?: string                // e.g. "3 denials in 60 seconds"
}

export interface SequenceStep {
  tool: string
  path?: string                     // optional path matching (${same_ref} for cross-step refs)
  pattern?: string
}

export interface VerificationMatcher {
  tools?: string[]
  tool?: string
  path?: string
  /** Any-of additional path targets (e.g. package.json re-arms the obligation). */
  paths?: string[]
  pattern?: string
}

export interface VerificationBoundary {
  pattern: string
  action?: EnforcementAction
}

export interface FixTransform {
  pattern: string
  replace: string
}

export interface CacheConfig {
  enabled?: boolean
  max_size?: number                 // max entries in session cache
  ttl_seconds?: number
  persistent?: boolean               // persist across sessions
}

export interface ReInjectionConfig {
  enabled?: boolean
  thresholds?: number[]             // token counts at which to re-inject
}

// ── Enforcement pipeline types ──────────────────────────────────────

export interface EnforceInput {
  tool: string
  args: Record<string, unknown>
  cwd: string
  session_id: string
  turn_number: number
  context_tokens: number
  level: ProtectionLevel
  context: RuleContext
  agent: string                     // 'opencode' | 'claude-code' | 'cline' | etc.
  subagent_of: string | null
  reasoning?: string                // agent's chain-of-thought, if available
  depth?: EnforcementDepth          // fast | full | deep evaluation depth
  action_override?: EnforcementAction // integration-level action override
}

export interface EnforceResult {
  action: EnforcementAction
  rule_id?: string | null
  rule_name?: string
  message: string
  matched_pattern?: string
  timestamp: string
  duration_ms?: number
  cache_hit?: boolean
  tier?: number
  fix_result?: Record<string, unknown>
}

// ── Audit log ───────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string
  session_id?: string
  turn_number?: number
  tool?: string
  args?: Record<string, unknown>
  rule_id?: string | null
  rule_name?: string
  action: EnforcementAction
  message?: string
  level?: ProtectionLevel
  context?: RuleContext
  agent?: string
  subagent_of?: string | null
  cache_hit?: boolean
  duration_ms?: number
  tier?: number
  context_tokens?: number

  // Backward compat fields from old AuditEntry
  tool_name?: string

  reasoning?: string
  fix_applied?: boolean
}

// ── Cache ───────────────────────────────────────────────────────────

export interface CacheEntry {
  verdict: string
  rule_id: string | null
  count: number
  timestamp: number
}

export interface CacheStats {
  size: number
  hits: number
  misses: number
  hit_rate: number
}

// ── Learning layer ──────────────────────────────────────────────────

export interface Suggestion {
  type: 'add_rule' | 'remove_rule' | 'modify_rule' | 'adjust_level' | 'add_exception' | 'cache_tune'
  rule_id?: string
  current_value?: string
  suggested_value?: string
  reason: string
  confidence: 'high' | 'medium' | 'low'
  evidence: {
    sessions_observed: number
    violations_count: number
    false_positive_count: number
    override_count: number
  }
}

export interface ProjectInsights {
  sessions_analyzed: number
  total_tool_calls: number
  total_denies: number
  total_warns: number
  false_positives_reported: number
  most_fired_rules: Array<{ rule_id: string; count: number }>
  most_ignored_rules: Array<{ rule_id: string; count: number }>  // overridden rules
  suggested_rules: Suggestion[]
  cache_efficiency: number  // 0-1
  violation_hotspots: Array<{ token_range: string; count: number }>
}

// ── Backward compatibility aliases ─────────────────────────────────

/**
 * @deprecated Use EnforceResult instead
 */
export type EnforcementResult = EnforceResult

/**
 * @deprecated Use ProtectionLevel instead
 */
export type Level = ProtectionLevel

// ── Existing types (re-exported for compatibility) ──────────────────

export interface PolicyFile {
  version: string
  name?: string
  description?: string
  patterns?: PatternDef[]
  file_rules?: FileRule[]
  command_rules?: CommandRule[]
  content_rules?: ContentRule[]
  env_rules?: EnvRule[]
  network_rules?: NetworkRule[]
  rate_limits?: RateLimit[]
  time_rules?: TimeRule[]
  settings?: PolicySettings
}

export interface PolicySettings {
  default_action?: EnforcementAction
  audit_log?: boolean
  fail_on_error?: boolean
  level?: ProtectionLevel
}

export interface PatternDef {
  id: string
  type: 'regex' | 'prefix' | 'glob'
  pattern: string
  description?: string
}

export interface FileRule {
  name: string
  paths: string[]
  exclude?: string[]
  actions: {
    read?: EnforcementAction
    write?: EnforcementAction
    glob?: EnforcementAction
  }
  message: string
}

export interface CommandRule {
  name: string
  patterns: { prefix?: string; regex?: string }[]
  action: EnforcementAction
  message: string
  unless?: { regex?: string }[]
}

export interface ContentRule {
  name: string
  patterns: ({ ref?: string; regex?: string; prefix?: string })[]
  paths?: string[]
  action: EnforcementAction
  mode?: 'commit' | 'read' | 'write' | 'always'
  message: string
}

export interface EnvRule {
  name: string
  vars: string[]
  action: EnforcementAction
  message: string
}

export interface NetworkRule {
  name: string
  patterns: { regex?: string }[]
  action: EnforcementAction
  message?: string
}

export interface RateLimit {
  name: string
  scope: 'tool' | 'repo' | 'user'
  window: number
  max_calls: number
  action: EnforcementAction
  message: string
}

export interface TimeRule {
  name: string
  timezone?: string
  schedule?: { start: string; end: string; days?: string[] }
  subjects: ({ patterns: { regex?: string }[]; paths?: string[] })[]
  outside_schedule_action: EnforcementAction
  message: string
}

export interface ToolCallEvent {
  tool_name: string
  args: Record<string, unknown>
  cwd: string
  timestamp: string
}
