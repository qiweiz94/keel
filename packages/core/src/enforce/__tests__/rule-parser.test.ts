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
