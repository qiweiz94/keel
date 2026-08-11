import { describe, expect, it } from 'vitest'
import {
  parseRulesContent, validateRules, sprintExpiryStatus, resolvedLevel,
  DEFAULT_SPRINT_EXPIRY_HOURS,
} from '../rule-parser.js'
import type { KeelConfig } from '../../types.js'

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
