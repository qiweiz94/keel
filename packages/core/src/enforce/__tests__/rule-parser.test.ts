import { describe, expect, it } from 'vitest'
import {
  parseRulesContent, validateRules, sprintExpiryStatus, resolvedLevel,
  DEFAULT_SPRINT_EXPIRY_HOURS, mergeRules,
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
})
