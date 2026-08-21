import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseRulesContent, validateRules, sprintExpiryStatus, resolvedLevel,
  DEFAULT_SPRINT_EXPIRY_HOURS, mergeRules, parseRulesFile, detectConflicts,
} from '../rule-parser.js'
import type { KeelConfig, KeelRule } from '../../types.js'
import type { RuleHierarchy, ParsedRules } from '../rule-parser.js'

describe('rule validation', () => {
  it('reports one-step sequence rules', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: incomplete
    type: sequence
    steps:
      - tool: Bash
    action: deny
`, '/tmp/rules.yaml')

    expect(validateRules(parsed.rules)).toContain('Rule "incomplete" is a sequence rule but has fewer than two steps')
  })

  it('validates verification structure and regexes', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: malformed
    type: verification
    trigger:
      tools: [Bash]
      pattern: "["
    boundaries:
      commit:
        pattern: "git commit"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues).toContain('Rule "malformed" is missing verification.satisfy')
    expect(issues.some(issue => issue.includes('invalid regex'))).toBe(true)
  })

  it('rejects a command rule with an uncompilable unless[].regex', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-unless
    type: command
    match: "rm -rf"
    unless:
      - regex: "(unclosed"
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues).toContain('Rule "bad-unless" contains invalid regex: (unclosed')
  })

  it('accepts a command rule with a valid unless[].regex', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: good-unless
    type: command
    match: "rm -rf"
    unless:
      - regex: "--dry-run"
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues.some(issue => issue.includes('invalid regex'))).toBe(false)
  })

  it('rejects a content rule with an uncompilable patterns[].regex (quiet fail-open closed)', () => {
    // Without load-time validation this loads clean and silently never
    // matches — a security rule that stops catching what it should.
    const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-content
    type: content
    patterns:
      - regex: "(unclosed"
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues).toContain('Rule "bad-content" contains invalid regex: (unclosed')
  })

  it('surfaces malformed YAML instead of silently accepting it', () => {
    const parsed = parseRulesContent('rules: [', '/tmp/rules.yaml')
    expect(parsed.errors?.some(error => error.startsWith('Invalid YAML:'))).toBe(true)
  })

  it('rejects malformed rule objects and unsupported values', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: bad
    type: unknown
    action: explode
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues).toContain('Rule "bad" has an unsupported type: unknown')
    expect(issues).toContain('Rule "bad" has an unsupported action: explode')
    expect(issues).toContain('Rule "bad" is missing a non-empty message')
  })

  it('rejects a non-array rules value', () => {
    const parsed = parseRulesContent('version: 1\nrules: bad\n', '/tmp/rules.yaml')
    expect(parsed.errors).toContain('Rules must be an array')
  })

  it('rejects a negative or non-numeric sprint_expiry_hours', () => {
    const parsed = parseRulesContent('version: 1\nlevel: sprint\nsprint_expiry_hours: -1\nrules: []\n', '/tmp/rules.yaml')
    expect(parsed.errors?.some(e => e.includes('sprint_expiry_hours'))).toBe(true)
  })

  it('rejects a malformed sprint_started_at', () => {
    const parsed = parseRulesContent('version: 1\nlevel: sprint\nsprint_started_at: "not a date"\nrules: []\n', '/tmp/rules.yaml')
    expect(parsed.errors?.some(e => e.includes('sprint_started_at'))).toBe(true)
  })

  // ── Gap 2: a full-form `type: command` rule with none of match /
  // match_regex / match_prefix set previously passed validation cleanly
  // and was a permanent, silent no-op — pipeline.ts (~line 724) gates its
  // whole command-matching block on those three fields being present.
  it('rejects a full-form command rule with none of match/match_regex/match_prefix (was a silent no-op)', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: no-op-command-rule
    type: command
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues).toContain('Rule "no-op-command-rule" is a command rule but has no match, match_regex, or match_prefix')
  })

  it('accepts a full-form command rule using only match_prefix (no error raised)', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: prefix-command-rule
    type: command
    match_prefix: "rm -rf"
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues.some(i => i.includes('has no match'))).toBe(false)
  })

  // ── Gap 3: `rule.topics` (research rules) and `rule.fallback_pattern`
  // (diagnosis rules) were both missing from the load-time regex-validity
  // check. matchesRulePattern() (pipeline.ts) silently catches a bad regex
  // and returns false — a quiet fail-open that this same validator already
  // guards against for `patterns`/`match`/etc.
  it('rejects a research rule with an uncompilable topics[] regex', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-topics
    type: research
    topics:
      - "(unclosed"
    action: warn
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues).toContain('Rule "bad-topics" contains invalid regex: (unclosed')
  })

  it('rejects a diagnosis rule with an uncompilable fallback_pattern regex', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-fallback-pattern
    type: diagnosis
    fallback_pattern: "(unclosed"
    action: warn
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues).toContain('Rule "bad-fallback-pattern" contains invalid regex: (unclosed')
  })

  it('accepts a research rule with valid topics regexes (no false positive)', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: good-topics
    type: research
    topics:
      - "deploy.*process"
    action: warn
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues.some(i => i.includes('invalid regex'))).toBe(false)
  })

  // ── Gap 4: `scope` and `rule.context` were never validated, despite
  // being load-bearing in mergeRules' scopeOrder ranking and context
  // filter. A typo'd `scope` makes scopeOrder[rule.scope] undefined, and
  // `undefined > scopeOrder['global']` is false in JS — a typo'd
  // global-tier rule becomes permanently immune to being overridden. A
  // typo'd `context` entry fails the context filter in every possible
  // evaluation context — the rule never gets pushed at all, ever.
  it('rejects a rule with an invalid scope', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-scope
    type: command
    match: "rm -rf"
    scope: projekt
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues.some(i => i.includes('unsupported scope'))).toBe(true)
  })

  it('accepts every valid scope value', () => {
    for (const scope of ['global', 'user', 'project', 'folder', 'session']) {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: ok-scope
    type: command
    match: "rm -rf"
    scope: ${scope}
    action: deny
    message: "no"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('unsupported scope'))).toBe(false)
    }
  })

  it('rejects a rule with an invalid context entry', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-context
    type: command
    match: "rm -rf"
    context: [boht]
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues.some(i => i.includes('invalid context'))).toBe(true)
  })

  it('accepts valid context arrays', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: ok-context
    type: command
    match: "rm -rf"
    context: [local, ci]
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues.some(i => i.includes('invalid context'))).toBe(false)
  })

  // ── agent-scoped rules (`agents:` field) ──
  //
  // Host identity (EnforceInput.agent) is HOST identity — 'opencode' |
  // 'claude-code' | 'cline' | etc. — not a true multi-agent-fleet identity
  // concept (see types.ts's KeelRule.agents doc comment). Unlike
  // `context`, there is no fixed enum of valid hosts, so validation only
  // checks shape: a non-empty array of non-empty strings.
  it('rejects a rule with an invalid agents field', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-agents
    type: command
    match: "rm -rf"
    agents: []
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues.some(i => i.includes('invalid agents'))).toBe(true)
  })

  it('rejects a rule whose agents field is not an array', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-agents-shape
    type: command
    match: "rm -rf"
    agents: claude-code
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues.some(i => i.includes('invalid agents'))).toBe(true)
  })

  it('accepts a valid agents array and survives parseRulesContent -> mergeRules unmodified', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: ok-agents
    type: command
    match: "rm -rf"
    agents: [claude-code, opencode]
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    const issues = validateRules(parsed.rules)
    expect(issues.some(i => i.includes('invalid agents'))).toBe(false)

    // Real end-to-end check that the field is not silently stripped
    // somewhere between YAML parsing and the merged rule the pipeline
    // actually evaluates — a schema-stripping step elsewhere would make
    // every mergeRules-level unit test below pass vacuously.
    const hierarchy: RuleHierarchy = { global: parsed, user: null, project: null, local: null }
    const merged = mergeRules(hierarchy, 'balanced', 'local', 'claude-code')
    expect(merged.find(r => r.id === 'ok-agents')?.agents).toEqual(['claude-code', 'opencode'])
  })

  // `type: session` used to be in this list — see git history and
  // session-tracker.ts / pipeline.ts's session-trip branch for the real
  // handler it now has (a composite runaway-loop trip across five
  // session-scoped dimensions). mcp/inheritance/meta/context remain
  // genuinely unimplemented, matching SPEC.md's "Public v1 Release
  // Contract" table.
  it('still rejects the genuinely-unimplemented types (mcp, inheritance, meta, context)', () => {
    for (const type of ['mcp', 'inheritance', 'meta', 'context']) {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: unimplemented-${type}
    type: ${type}
    action: warn
    message: "no"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('not implemented by the enforcement engine'))).toBe(true)
    }
  })

  describe('type: injection — taint_correlation (Lane G)', () => {
    it('rejects taint_correlation: true without next_call_scrutiny — it could never fire', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: broken-taint
    type: injection
    taint_correlation: true
    action: warn
    message: "no"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('taint_correlation: true without next_call_scrutiny'))).toBe(true)
    })

    it('accepts taint_correlation: true together with next_call_scrutiny: true', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: ok-taint
    type: injection
    next_call_scrutiny: true
    taint_correlation: true
    action: warn
    message: "no"
`, '/tmp/rules.yaml')
      expect(validateRules(parsed.rules)).toEqual([])
    })

    it('rejects taint_correlation on a non-injection rule type', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: taint-on-command
    type: command
    match: "rm -rf /"
    taint_correlation: true
    action: deny
    message: "no"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('taint_correlation is only valid on type: injection rules'))).toBe(true)
    })

    it('locks in the tier constraint: the shipped untrusted-content-derived-call shape rejects action: prompt', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: untrusted-content-derived-call
    type: injection
    next_call_scrutiny: true
    taint_correlation: true
    action: prompt
    message: "no"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('injection rules may only ever declare action: warn'))).toBe(true)
    })
  })

  describe('type: session (composite runaway-loop trip)', () => {
    it('accepts a well-formed session_escalation ladder', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: ok-session
    type: session
    action: warn
    session_escalation:
      - dimension: tool_calls
        at: 500
        action: warn
      - dimension: consecutive_failures
        at: 5
        action: deny
        halt: true
    message: "session trip"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('not implemented by the enforcement engine'))).toBe(false)
      expect(issues).toEqual([])
    })

    it('rejects a session rule with no session_escalation at all — the exact "declared but inert" shape this type used to have', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: inert-session
    type: session
    action: warn
    message: "session trip"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('needs at least one session_escalation entry'))).toBe(true)
    })

    it('rejects an empty session_escalation array', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: empty-session
    type: session
    action: warn
    session_escalation: []
    message: "session trip"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('needs at least one session_escalation entry'))).toBe(true)
    })

    it('SAFETY: rejects action: deny on a volume-only dimension (tool_calls)', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-volume-deny
    type: session
    action: warn
    session_escalation:
      - dimension: tool_calls
        at: 500
        action: deny
    message: "session trip"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('volume-only counter') && i.includes('must not escalate past "prompt"'))).toBe(true)
    })

    it('SAFETY: rejects action: block on a volume-only dimension (duration_minutes)', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-volume-block
    type: session
    action: warn
    session_escalation:
      - dimension: duration_minutes
        at: 240
        action: block
    message: "session trip"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('volume-only counter'))).toBe(true)
    })

    it('SAFETY: rejects halt: true on a volume-only dimension (file_write_churn)', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-volume-halt
    type: session
    action: warn
    session_escalation:
      - dimension: file_write_churn
        at: 40
        action: warn
        halt: true
    message: "session trip"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('only allowed on a "consecutive_failures" step'))).toBe(true)
    })

    it('allows deny + halt on consecutive_failures — the one dimension permitted to reach it', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: ok-failure-halt
    type: session
    action: warn
    session_escalation:
      - dimension: consecutive_failures
        at: 8
        action: deny
        halt: true
    message: "session trip"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues).toEqual([])
    })

    it('rejects an unsupported dimension name', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-dimension
    type: session
    action: warn
    session_escalation:
      - dimension: token_count
        at: 1000
        action: warn
    message: "session trip"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('unsupported dimension'))).toBe(true)
    })

    it('rejects a non-positive "at" threshold', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: bad-at
    type: session
    action: warn
    session_escalation:
      - dimension: tool_calls
        at: 0
        action: warn
    message: "session trip"
`, '/tmp/rules.yaml')
      const issues = validateRules(parsed.rules)
      expect(issues.some(i => i.includes('positive numeric "at" threshold'))).toBe(true)
    })
  })
})

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString()
}

describe('sprintExpiryStatus / resolvedLevel — sprint auto-expiry', () => {
  it('is null for a non-sprint level regardless of other fields', () => {
    expect(sprintExpiryStatus({ version: 1, level: 'balanced', sprint_started_at: hoursAgo(100) })).toBeNull()
  })

  it('is null for `level: sprint` with no recorded start (hand-edited YAML never auto-expires)', () => {
    expect(sprintExpiryStatus({ version: 1, level: 'sprint' })).toBeNull()
    expect(resolvedLevel({ version: 1, level: 'sprint' }, 'balanced')).toBe('sprint')
  })

  it('is null when sprint_expiry_hours is 0 (explicitly disabled)', () => {
    const config: KeelConfig = { version: 1, level: 'sprint', sprint_started_at: hoursAgo(1000), sprint_expiry_hours: 0 }
    expect(sprintExpiryStatus(config)).toBeNull()
    expect(resolvedLevel(config, 'balanced')).toBe('sprint')
  })

  it('is not expired within the default 4h window', () => {
    const config: KeelConfig = { version: 1, level: 'sprint', sprint_started_at: hoursAgo(1) }
    const status = sprintExpiryStatus(config)
    expect(status?.expired).toBe(false)
    expect(status?.expiryHours).toBe(DEFAULT_SPRINT_EXPIRY_HOURS)
    expect(resolvedLevel(config, 'balanced')).toBe('sprint')
  })

  it('expires past the default 4h window and resolvedLevel reverts to balanced', () => {
    const config: KeelConfig = { version: 1, level: 'sprint', sprint_started_at: hoursAgo(5) }
    const status = sprintExpiryStatus(config)
    expect(status?.expired).toBe(true)
    expect(resolvedLevel(config, 'balanced')).toBe('balanced')
  })

  it('honors a custom sprint_expiry_hours', () => {
    const config: KeelConfig = { version: 1, level: 'sprint', sprint_started_at: hoursAgo(2), sprint_expiry_hours: 1 }
    expect(sprintExpiryStatus(config)?.expired).toBe(true)
    expect(resolvedLevel(config, 'balanced')).toBe('balanced')

    const notYet: KeelConfig = { version: 1, level: 'sprint', sprint_started_at: hoursAgo(2), sprint_expiry_hours: 3 }
    expect(sprintExpiryStatus(notYet)?.expired).toBe(false)
    expect(resolvedLevel(notYet, 'balanced')).toBe('sprint')
  })

  it('protect and balanced levels pass through resolvedLevel unchanged', () => {
    expect(resolvedLevel({ version: 1, level: 'protect' }, 'balanced')).toBe('protect')
    expect(resolvedLevel({ version: 1, level: 'balanced' }, 'sprint')).toBe('balanced')
    expect(resolvedLevel(undefined, 'balanced')).toBe('balanced')
    expect(resolvedLevel({ version: 1 }, 'sprint')).toBe('sprint')
  })
})

// ── mergeRules — floor rules cannot be weakened by a more specific scope ──
//
// A `level: protect` rule is a floor: keel's core promise is that no more
// specific scope (a project's own .keel.local.yaml, scope `folder`) can
// quietly downgrade it. Before this fix, mergeRules' dedup loop replaced a
// rule by id purely on scope specificity, with no check at all — a local
// override of a floor's id with a weaker action (or no `level`) silently
// won.

function parsedFrom(rules: KeelRule[]): ParsedRules {
  return { config: { version: 1 }, rules, sourcePath: '/tmp/test.yaml', version: 1, markdown: '' }
}

function hierarchyOf(global: KeelRule[], local: KeelRule[]): RuleHierarchy {
  return {
    global: parsedFrom(global),
    user: null,
    project: null,
    local: parsedFrom(local),
  }
}

describe('mergeRules — agent (host) scoping', () => {
  it('a rule with agents: [claude-code] fires for a claude-code call and not for an opencode call', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'claude-only', type: 'command', action: 'deny', message: 'claude-code only', agents: ['claude-code'] }],
      [],
    )
    const forClaude = mergeRules(hierarchy, 'balanced', 'local', 'claude-code')
    const forOpencode = mergeRules(hierarchy, 'balanced', 'local', 'opencode')
    expect(forClaude.some(r => r.id === 'claude-only')).toBe(true)
    expect(forOpencode.some(r => r.id === 'claude-only')).toBe(false)
  })

  it('a rule with no agents field fires for every host — regression check for the overwhelming majority of rules', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', message: 'no agents field at all' }],
      [],
    )
    for (const agent of ['claude-code', 'opencode', 'cline', 'unknown', 'anything-at-all']) {
      const merged = mergeRules(hierarchy, 'balanced', 'local', agent)
      expect(merged.some(r => r.id === 'no-force-push')).toBe(true)
    }
  })

  it('omitting `agent` entirely (the administrative/introspection call shape) does not filter agent-scoped rules', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'claude-only', type: 'command', action: 'deny', message: 'claude-code only', agents: ['claude-code'] }],
      [],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    expect(merged.some(r => r.id === 'claude-only')).toBe(true)
  })

  it('a rule can list multiple agents — matches any of them', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'multi-host', type: 'command', action: 'deny', message: 'two hosts', agents: ['claude-code', 'cline'] }],
      [],
    )
    expect(mergeRules(hierarchy, 'balanced', 'local', 'claude-code').some(r => r.id === 'multi-host')).toBe(true)
    expect(mergeRules(hierarchy, 'balanced', 'local', 'cline').some(r => r.id === 'multi-host')).toBe(true)
    expect(mergeRules(hierarchy, 'balanced', 'local', 'opencode').some(r => r.id === 'multi-host')).toBe(false)
  })

  // The safe direction of the push-time-filter gap documented in
  // mergeRules' pushRules(): an override that ADDS `agents` to a
  // level:protect floor's id differs from the floor under
  // sameEnforcementSurface's exclusion-based comparison (agents is not in
  // OVERRIDE_COSMETIC_FIELDS or OVERRIDE_STRENGTH_CHECKED_FIELDS), so it is
  // rejected as a surface-changing weakening — the floor stands, exactly
  // like any other surface-changing override.
  it('a local override that ADDS agents to a level:protect floor (same id) is rejected as a surface change — the unscoped floor stands', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', message: 'unscoped floor' }],
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', message: 'local narrows to one host', agents: ['claude-code'] }],
    )
    // Call with an agent NOT in the override's list — if the override had
    // incorrectly won, the floor would vanish for this host entirely.
    const merged = mergeRules(hierarchy, 'balanced', 'local', 'opencode')
    const rule = merged.find(r => r.id === 'no-force-push')
    expect(rule?.message).toBe('unscoped floor')
    expect(rule?.agents).toBeUndefined()
  })
})

describe('detectConflicts — agent-disjoint rules are not false conflicts', () => {
  it('does not flag a conflict between two rules with the same match but disjoint agents', () => {
    const rules: KeelRule[] = [
      { id: 'deny-for-claude', type: 'command', match: 'npx .*', action: 'deny', message: 'no', agents: ['claude-code'] },
      { id: 'allow-for-opencode', type: 'command', match: 'npx .*', action: 'allow', message: 'ok', agents: ['opencode'] },
    ]
    const conflicts = detectConflicts(rules)
    expect(conflicts).toHaveLength(0)
  })

  it('still flags a real conflict when agent sets overlap', () => {
    const rules: KeelRule[] = [
      { id: 'deny-for-claude', type: 'command', match: 'npx .*', action: 'deny', message: 'no', agents: ['claude-code', 'opencode'] },
      { id: 'allow-for-opencode', type: 'command', match: 'npx .*', action: 'allow', message: 'ok', agents: ['opencode'] },
    ]
    const conflicts = detectConflicts(rules)
    expect(conflicts).toHaveLength(1)
  })
})

describe('mergeRules — floor rules cannot be weakened by scope', () => {
  it('a local override that WEAKENS a level:protect floor is rejected — the floor stands', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', message: 'no force push' }],
      [{ id: 'no-force-push', type: 'command', action: 'warn', message: 'local says warn' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'no-force-push')
    expect(rule?.action).toBe('deny')
    expect(rule?.level).toBe('protect')
  })

  it('a local override that KEEPS level:protect but WEAKENS the action (deny -> warn) is still rejected', () => {
    // Distinct from the previous case: here the override does not drop
    // `level: protect` at all — it keeps the floor marker but picks a
    // weaker action. This is the case that specifically exercises
    // ACTION_STRENGTH (the previous test is rejected by the `level`
    // check alone; this one would pass a level-only check and must be
    // caught by the strength comparison).
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', message: 'global floor' }],
      [{ id: 'no-force-push', type: 'command', action: 'warn', level: 'protect', message: 'local weakens but keeps protect' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'no-force-push')
    expect(rule?.action).toBe('deny')
    expect(rule?.message).toBe('global floor')
  })

  it('a local override that TIGHTENS a level:protect floor (warn -> deny) is honored', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'warn', level: 'protect', message: 'global warn floor' }],
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', message: 'local tightens' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'no-force-push')
    expect(rule?.action).toBe('deny')
    expect(rule?.message).toBe('local tightens')
  })

  it('a local override that KEEPS the same action and level:protect is honored (tie, not a weakening)', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', message: 'global floor' }],
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', message: 'local restates' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'no-force-push')
    expect(rule?.action).toBe('deny')
    expect(rule?.message).toBe('local restates')
  })

  it('a NON-floor rule (no level) is still freely overridable by a more specific scope (regression)', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'some-style-rule', type: 'command', action: 'warn', message: 'global default' }],
      [{ id: 'some-style-rule', type: 'command', action: 'allow', message: 'local relaxes it' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'some-style-rule')
    expect(rule?.action).toBe('allow')
    expect(rule?.message).toBe('local relaxes it')
  })

  // ── mode + match: the two neutralization vectors ACTION_STRENGTH alone
  // does not close. An override can keep `action: deny` + `level: protect`
  // (passing the action check) and still disarm the floor by adding
  // `mode: observe` (which short-circuits enforcement to allow — see
  // pipeline.ts's effectiveAction) or by swapping the matching surface for
  // a pattern that never fires. Both must be rejected exactly like an
  // action-weakening override.

  it('a local override that KEEPS action deny + level:protect but adds mode:observe is rejected', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', match: 'push.*--force', message: 'global floor' }],
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', match: 'push.*--force', mode: 'observe', message: 'local silences via mode' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'no-force-push')
    expect(rule?.mode).toBeUndefined()
    expect(rule?.message).toBe('global floor')
  })

  it('a local override that KEEPS action deny + level:protect but replaces `match` with a non-matching pattern is rejected', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', match: 'push.*--force', message: 'global floor' }],
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', match: 'this-never-matches-anything', message: 'local narrows match' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'no-force-push')
    expect(rule?.match).toBe('push.*--force')
    expect(rule?.message).toBe('global floor')
  })

  it('a local override that strictly tightens mode (observe -> block/undefined) with the same match is still honored', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', match: 'push.*--force', mode: 'observe', message: 'global floor, burning in' }],
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', match: 'push.*--force', message: 'local promotes out of observe' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'no-force-push')
    expect(rule?.mode).toBeUndefined()
    expect(rule?.message).toBe('local promotes out of observe')
  })

  it('a NON-floor rule is still freely overridable on mode and match by a more specific scope (regression)', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'some-style-rule', type: 'command', action: 'warn', match: 'foo', message: 'global default' }],
      [{ id: 'some-style-rule', type: 'command', action: 'warn', match: 'bar', mode: 'observe', message: 'local relaxes match and mode' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'some-style-rule')
    expect(rule?.match).toBe('bar')
    expect(rule?.mode).toBe('observe')
    expect(rule?.message).toBe('local relaxes match and mode')
  })

  // ── the enforcement surface freeze is by EXCLUSION, not an enumerated
  // list of match-ish field names — these cover three fields that are NOT
  // literally `match`/`paths`/`patterns` but change when/how a floor fires
  // just as effectively: `exclude` (a filesystem floor's carve-outs),
  // `except` (a network floor's allowlist), and `priority` (pipeline.ts's
  // tier-2/3 loop is first-match-wins over the full priority-sorted rule
  // list — demoting a floor below an unrelated weaker rule that matches
  // the same command means the floor is never reached on that call at
  // all). None of these are in OVERRIDE_COSMETIC_FIELDS, so all three are
  // caught by sameEnforcementSurface's "everything not explicitly
  // allowlisted is frozen" default without needing their own field-name
  // entry in a match-specific list.

  it('an override that keeps a filesystem floor\'s action+level+mode but adds `exclude` is rejected', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-secrets-write', type: 'filesystem', action: 'deny', level: 'protect', paths: ['**/.env'], message: 'global floor' }],
      [{ id: 'no-secrets-write', type: 'filesystem', action: 'deny', level: 'protect', paths: ['**/.env'], exclude: ['**'], message: 'local carves out everything' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'no-secrets-write')
    expect(rule?.exclude).toBeUndefined()
    expect(rule?.message).toBe('global floor')
  })

  it('an override that keeps a network floor\'s action+level+mode but adds `except` is rejected', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-exfil', type: 'network', action: 'deny', level: 'protect', match: '*', message: 'global floor' }],
      [{ id: 'no-exfil', type: 'network', action: 'deny', level: 'protect', match: '*', except: ['*'], message: 'local allowlists everything' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'no-exfil')
    expect(rule?.except).toBeUndefined()
    expect(rule?.message).toBe('global floor')
  })

  it('an override that keeps action+level+mode but demotes `priority` (first-match-wins reordering) is rejected', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', match: 'push.*--force', priority: 82, message: 'global floor' }],
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', match: 'push.*--force', priority: -1000, message: 'local demotes below everything' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const rule = merged.find(r => r.id === 'no-force-push')
    expect(rule?.priority).toBe(82)
    expect(rule?.message).toBe('global floor')
  })
})

// ── mergeRules — a DIFFERENT-id rule cannot priority-shadow a floor ──
//
// Distinct residual from the same-id dedup guard above (SECURITY.md's
// "different-id priority shadowing" note): the dedup loop only ever
// arbitrates a collision on a MATCHING id. A lower-scope config can add a
// brand-new rule under its OWN id — no collision, nothing for dedup to
// reject — with a sky-high `priority` and `action: allow`. Before this
// fix, the final sort ordered the merged list by `priority` alone, so
// that new rule could still land ahead of a `level: protect` floor
// matching the same command and short-circuit pipeline.ts's first-
// match-wins tier loop before the floor was ever reached.

describe('mergeRules — a different-id rule cannot priority-shadow a level:protect floor', () => {
  it('a different-id, priority-999, action:allow rule is sorted AFTER a level:protect floor regardless of priority', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', priority: 82, match: 'push.*--force', message: 'floor' }],
      [{ id: 'my-allow', type: 'command', action: 'allow', priority: 999, match: 'push.*--force', message: 'shadow attempt' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const floorIndex = merged.findIndex(r => r.id === 'no-force-push')
    const shadowIndex = merged.findIndex(r => r.id === 'my-allow')
    expect(floorIndex).toBeGreaterThanOrEqual(0)
    expect(shadowIndex).toBeGreaterThanOrEqual(0)
    expect(floorIndex).toBeLessThan(shadowIndex)
  })

  it('a different-id, priority-999, action:warn rule is also sorted AFTER the floor (not just allow)', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', priority: 82, match: 'push.*--force', message: 'floor' }],
      [{ id: 'my-warn', type: 'command', action: 'warn', priority: 999, match: 'push.*--force', message: 'shadow attempt' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const floorIndex = merged.findIndex(r => r.id === 'no-force-push')
    const shadowIndex = merged.findIndex(r => r.id === 'my-warn')
    expect(floorIndex).toBeLessThan(shadowIndex)
  })

  it('non-floor priority ordering AMONG non-floor rules is unaffected (regression)', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'low-priority-rule', type: 'command', action: 'warn', priority: 10, match: 'foo', message: 'low' }],
      [{ id: 'high-priority-rule', type: 'command', action: 'warn', priority: 50, match: 'foo', message: 'high' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const highIndex = merged.findIndex(r => r.id === 'high-priority-rule')
    const lowIndex = merged.findIndex(r => r.id === 'low-priority-rule')
    expect(highIndex).toBeLessThan(lowIndex)
  })

  it('with no floor involved at all, merge order is unchanged from plain priority sort (regression)', () => {
    const hierarchy = hierarchyOf(
      [
        { id: 'a', type: 'command', action: 'warn', priority: 5, match: 'x', message: 'a' },
        { id: 'b', type: 'command', action: 'warn', priority: 20, match: 'y', message: 'b' },
      ],
      [{ id: 'c', type: 'command', action: 'warn', priority: 12, match: 'z', message: 'c' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    expect(merged.map(r => r.id)).toEqual(['b', 'c', 'a'])
  })

  // A `mode: observe` rule is structurally incapable of shadowing anything
  // (pipeline.ts's violation() throws OBSERVE_CONTINUE for it before ever
  // reaching the action switch, on every rule type — it always records and
  // falls through, never returns a verdict), so the sort puts it in a
  // FIXED tier ahead of everything, floors included — evaluating it first
  // is free and guarantees it always gets to record, strictly stronger
  // than "leave its priority-based position alone." See mergeRules' sort
  // comment for why a pairwise "floor beats the other one" comparator
  // (which WOULD leave observe at its plain-priority position) was tried
  // first and rejected as intransitive.
  it('a `mode: observe` non-floor rule sorts ahead of a floor even at equal (default) priority', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'real-floor', type: 'command', action: 'deny', level: 'protect', match: 'danger', message: 'floor' }],
      [{ id: 'obs-rule', type: 'command', action: 'warn', mode: 'observe', match: 'danger', message: 'observe' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    expect(merged.map(r => r.id)).toEqual(['obs-rule', 'real-floor'])
  })

  it('a `mode: observe` non-floor rule sorts ahead of a floor even with a LOWER declared priority (tier beats priority)', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'real-floor', type: 'command', action: 'deny', level: 'protect', priority: 999, match: 'danger', message: 'floor' }],
      [{ id: 'obs-rule', type: 'command', action: 'warn', mode: 'observe', priority: 1, match: 'danger', message: 'observe' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    expect(merged.map(r => r.id)).toEqual(['obs-rule', 'real-floor'])
  })

  it('a `mode: warn` (not observe) non-floor rule IS still pushed behind a floor despite higher priority (it can return a verdict, unlike observe)', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'real-floor', type: 'command', action: 'deny', level: 'protect', priority: 10, match: 'danger', message: 'floor' }],
      [{ id: 'warn-mode-rule', type: 'command', action: 'allow', mode: 'warn', priority: 999, match: 'danger', message: 'shadow attempt via mode:warn' }],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    expect(merged.map(r => r.id)).toEqual(['real-floor', 'warn-mode-rule'])
  })

  // The transitivity case: a naive pairwise "floor beats the other one"
  // comparator (tried first, replaced by the fixed-tier sort above) is
  // intransitive exactly here — floor(82) < observe(90) by priority,
  // observe(90) < shadow(999) by priority, but floor is forced ahead of
  // shadow directly regardless of priority: shadow < floor < observe <
  // shadow is a cycle, which makes Array.prototype.sort's actual output
  // implementation-defined rather than a guarantee. A two-rule test can't
  // see this (the cycle only exists with all three rules present); this
  // is the three-rule case that forces it to surface if the comparator
  // regresses to a pairwise one.
  it('floor still sorts ahead of a different-id shadow rule even with an observe-mode rule of in-between priority also in the mix (transitivity)', () => {
    const hierarchy = hierarchyOf(
      [{ id: 'no-force-push', type: 'command', action: 'deny', level: 'protect', priority: 82, match: 'danger', message: 'floor' }],
      [
        { id: 'my-allow', type: 'command', action: 'allow', priority: 999, match: 'danger', message: 'shadow' },
        { id: 'my-observe', type: 'command', action: 'warn', mode: 'observe', priority: 90, match: 'danger', message: 'observe, in between' },
      ],
    )
    const merged = mergeRules(hierarchy, 'balanced', 'local')
    const floorIndex = merged.findIndex(r => r.id === 'no-force-push')
    const shadowIndex = merged.findIndex(r => r.id === 'my-allow')
    expect(floorIndex).toBeLessThan(shadowIndex)
    // Full order: observe tier first, then the floor tier, then everything
    // else — exact, not just the pairwise relation above.
    expect(merged.map(r => r.id)).toEqual(['my-observe', 'no-force-push', 'my-allow'])
  })
})

// ── extends: rule composition ─────────────────────────────────────────
//
// A rules.yaml can declare `extends: <path>` (or a list of paths),
// resolved relative to its OWN directory, and merged in BEFORE its own
// rules — see resolveExtendsChain / applyExtendsOverrides in
// rule-parser.ts and KeelConfig.extends' doc comment in types.ts.

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'keel-extends-test-'))
}

function writeRules(dir: string, name: string, yaml: string): string {
  const path = join(dir, name)
  writeFileSync(path, yaml, 'utf-8')
  return path
}

describe('extends: rule composition', () => {
  it('a simple two-file extends chain merges the base rule and the extending file\'s own rule', () => {
    const dir = newDir()
    writeRules(dir, 'base.yaml', `
version: 1
rules:
  - id: base-rule
    type: command
    action: warn
    match: 'rm -rf'
    message: from base
`)
    const leafPath = writeRules(dir, 'leaf.yaml', `
version: 1
extends: base.yaml
rules:
  - id: leaf-rule
    type: command
    action: deny
    match: 'curl'
    message: from leaf
`)
    const parsed = parseRulesFile(leafPath)
    expect(parsed?.errors).toBeUndefined()
    const ids = parsed?.rules.map(r => r.id).sort()
    expect(ids).toEqual(['base-rule', 'leaf-rule'])
  })

  it('extends accepts a list of paths, resolved relative to the extending file\'s own directory', () => {
    const dir = newDir()
    const subDir = join(dir, 'shared')
    mkdirSync(subDir)
    writeRules(subDir, 'a.yaml', `
version: 1
rules:
  - id: rule-a
    type: command
    action: warn
    match: 'a'
    message: a
`)
    writeRules(subDir, 'b.yaml', `
version: 1
rules:
  - id: rule-b
    type: command
    action: warn
    match: 'b'
    message: b
`)
    const leafPath = writeRules(dir, 'leaf.yaml', `
version: 1
extends:
  - shared/a.yaml
  - shared/b.yaml
rules:
  - id: rule-c
    type: command
    action: warn
    match: 'c'
    message: c
`)
    const parsed = parseRulesFile(leafPath)
    expect(parsed?.errors).toBeUndefined()
    expect(parsed?.rules.map(r => r.id).sort()).toEqual(['rule-a', 'rule-b', 'rule-c'])
  })

  it('a project file overriding a non-protect base rule by id works normally (no error, override wins)', () => {
    const dir = newDir()
    writeRules(dir, 'base.yaml', `
version: 1
rules:
  - id: shared-rule
    type: command
    action: warn
    match: 'deploy'
    message: base says warn
`)
    const leafPath = writeRules(dir, 'leaf.yaml', `
version: 1
extends: base.yaml
rules:
  - id: shared-rule
    type: command
    action: deny
    match: 'deploy'
    message: leaf says deny
`)
    const parsed = parseRulesFile(leafPath)
    expect(parsed?.errors).toBeUndefined()
    expect(parsed?.rules).toHaveLength(1)
    expect(parsed?.rules[0]).toMatchObject({ id: 'shared-rule', action: 'deny', message: 'leaf says deny' })
  })

  // The single most important test in this suite: a project file that
  // extends a base policy must NOT be able to silently (or even loudly-
  // but-successfully) weaken a level:protect floor the base declares.
  it('a project file attempting to WEAKEN an inherited level:protect floor is REFUSED with a clear error, and the floor is kept', () => {
    const dir = newDir()
    writeRules(dir, 'base.yaml', `
version: 1
rules:
  - id: no-force-push
    type: command
    action: deny
    level: protect
    match: 'push.*--force'
    message: base floor
`)
    const leafPath = writeRules(dir, 'leaf.yaml', `
version: 1
extends: base.yaml
rules:
  - id: no-force-push
    type: command
    action: warn
    match: 'push.*--force'
    message: leaf tries to weaken
`)
    const parsed = parseRulesFile(leafPath)
    expect(parsed?.errors).toBeDefined()
    expect(parsed?.errors?.some(e => e.includes('no-force-push') && e.includes('protect') && e.includes('weaken'))).toBe(true)
    // The floor itself must be the one that survives into the merged list.
    const rule = parsed?.rules.find(r => r.id === 'no-force-push')
    expect(rule?.action).toBe('deny')
    expect(rule?.level).toBe('protect')
    expect(rule?.message).toBe('base floor')
  })

  it('a project file TIGHTENING an inherited level:protect floor (warn -> deny) is honored, no error', () => {
    const dir = newDir()
    writeRules(dir, 'base.yaml', `
version: 1
rules:
  - id: no-force-push
    type: command
    action: warn
    level: protect
    match: 'push.*--force'
    message: base floor, warn only
`)
    const leafPath = writeRules(dir, 'leaf.yaml', `
version: 1
extends: base.yaml
rules:
  - id: no-force-push
    type: command
    action: deny
    level: protect
    match: 'push.*--force'
    message: leaf tightens to deny
`)
    const parsed = parseRulesFile(leafPath)
    expect(parsed?.errors).toBeUndefined()
    const rule = parsed?.rules.find(r => r.id === 'no-force-push')
    expect(rule?.action).toBe('deny')
    expect(rule?.message).toBe('leaf tightens to deny')
  })

  it('a circular extends chain (A extends B extends A) is detected and errors clearly, not a hang or stack overflow', () => {
    const dir = newDir()
    // Write A first referencing B, then B referencing A — order of writes
    // doesn't matter since both are on disk before either is parsed.
    writeRules(dir, 'a.yaml', `
version: 1
extends: b.yaml
rules:
  - id: rule-a
    type: command
    action: warn
    match: 'a'
    message: a
`)
    const aPath = writeRules(dir, 'b.yaml', `
version: 1
extends: a.yaml
rules:
  - id: rule-b
    type: command
    action: warn
    match: 'b'
    message: b
`)
    // Parse starting from b.yaml, which extends a.yaml, which extends
    // b.yaml again — a real cycle.
    const parsed = parseRulesFile(aPath)
    expect(parsed?.errors).toBeDefined()
    expect(parsed?.errors?.some(e => e.toLowerCase().includes('circular'))).toBe(true)
  })

  it('an extends reference to a missing file errors clearly, not a silent skip or crash', () => {
    const dir = newDir()
    const leafPath = writeRules(dir, 'leaf.yaml', `
version: 1
extends: does-not-exist.yaml
rules:
  - id: leaf-rule
    type: command
    action: warn
    match: 'x'
    message: leaf
`)
    const parsed = parseRulesFile(leafPath)
    expect(parsed?.errors).toBeDefined()
    expect(parsed?.errors?.some(e => e.includes('does-not-exist.yaml') && e.includes('not exist'))).toBe(true)
    // The leaf's own rule should still be present — a missing extends
    // target shouldn't take down the whole file, just get flagged.
    expect(parsed?.rules.map(r => r.id)).toContain('leaf-rule')
  })

  it('a multi-level chain (3+ files) resolves correctly, later files overriding earlier ones', () => {
    const dir = newDir()
    writeRules(dir, 'grandparent.yaml', `
version: 1
rules:
  - id: shared-rule
    type: command
    action: warn
    match: 'x'
    message: from grandparent
  - id: grandparent-only
    type: command
    action: warn
    match: 'g'
    message: only in grandparent
`)
    writeRules(dir, 'parent.yaml', `
version: 1
extends: grandparent.yaml
rules:
  - id: shared-rule
    type: command
    action: prompt
    match: 'x'
    message: from parent
  - id: parent-only
    type: command
    action: warn
    match: 'p'
    message: only in parent
`)
    const leafPath = writeRules(dir, 'child.yaml', `
version: 1
extends: parent.yaml
rules:
  - id: shared-rule
    type: command
    action: deny
    match: 'x'
    message: from child
`)
    const parsed = parseRulesFile(leafPath)
    expect(parsed?.errors).toBeUndefined()
    const shared = parsed?.rules.find(r => r.id === 'shared-rule')
    expect(shared?.message).toBe('from child')
    expect(shared?.action).toBe('deny')
    expect(parsed?.rules.map(r => r.id).sort()).toEqual(['grandparent-only', 'parent-only', 'shared-rule'])
  })

  it('a malformed extends field (empty string) produces a clear validation error', () => {
    const leafPath = (() => {
      const dir = newDir()
      return writeRules(dir, 'leaf.yaml', `
version: 1
extends: ''
rules:
  - id: leaf-rule
    type: command
    action: warn
    match: 'x'
    message: leaf
`)
    })()
    const parsed = parseRulesFile(leafPath)
    expect(parsed?.errors).toBeDefined()
    expect(parsed?.errors?.some(e => e.includes('extends'))).toBe(true)
  })

  it('a chain deeper than MAX_EXTENDS_DEPTH errors clearly instead of hanging', () => {
    const dir = newDir()
    // Build a long non-circular chain: file_0 -> file_1 -> ... -> file_12,
    // each extending the next, well past any real-world depth.
    const depth = 12
    for (let i = depth; i >= 0; i--) {
      const next = i < depth ? `\nextends: file_${i + 1}.yaml` : ''
      writeRules(dir, `file_${i}.yaml`, `version: 1${next}\nrules:\n  - id: rule-${i}\n    type: command\n    action: warn\n    match: 'x${i}'\n    message: rule ${i}\n`)
    }
    const parsed = parseRulesFile(join(dir, 'file_0.yaml'))
    expect(parsed?.errors).toBeDefined()
    expect(parsed?.errors?.some(e => e.includes('maximum depth'))).toBe(true)
  })

  it('extends pointing at a directory errors clearly instead of crashing (EISDIR)', () => {
    const dir = newDir()
    mkdirSync(join(dir, 'shared'))
    const leafPath = writeRules(dir, 'leaf.yaml', `
version: 1
extends: shared
rules:
  - id: leaf-rule
    type: command
    action: warn
    match: 'x'
    message: leaf
`)
    expect(() => parseRulesFile(leafPath)).not.toThrow()
    const parsed = parseRulesFile(leafPath)
    expect(parsed?.errors).toBeDefined()
    expect(parsed?.errors?.some(e => e.includes('shared') && e.includes('could not be read'))).toBe(true)
    expect(parsed?.rules.map(r => r.id)).toContain('leaf-rule')
  })

  // Documents a known, pre-existing characteristic of the floor-tightening
  // check (see applyExtendsOverrides' doc comment "CAVEAT" paragraph):
  // sameEnforcementSurface compares by JSON.stringify, which is sensitive
  // to key insertion order. Two semantically-identical floor definitions
  // that list fields in a different order are read as a surface mismatch.
  // This is inherited from mergeRules (same helper, same characteristic)
  // and not something this feature introduces — this test exists so the
  // behavior is documented and intentional, not an accidental surprise.
  it('CHARACTERIZATION: a semantically-identical floor override with reordered YAML keys is (falsely) treated as a surface change', () => {
    const dir = newDir()
    writeRules(dir, 'base.yaml', `
version: 1
rules:
  - id: no-force-push
    type: command
    action: deny
    level: protect
    match: 'push.*--force'
    message: base floor
`)
    // Same fields, same values, DIFFERENT declaration order (match before type).
    const leafPath = writeRules(dir, 'leaf.yaml', `
version: 1
extends: base.yaml
rules:
  - id: no-force-push
    match: 'push.*--force'
    type: command
    action: deny
    level: protect
    message: base floor
`)
    const parsed = parseRulesFile(leafPath)
    // Known false-positive: this is flagged as a weakening attempt even
    // though the override is semantically identical to the floor it
    // "overrides" — see the CAVEAT above. If this test starts failing
    // because sameEnforcementSurface became key-order-INsensitive, that's
    // an improvement — update this test to assert no error instead.
    expect(parsed?.errors?.some(e => e.includes('no-force-push'))).toBe(true)
  })
})
