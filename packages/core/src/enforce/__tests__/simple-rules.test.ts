import { describe, it, expect } from 'vitest'
import { parseRulesContent, expandSimpleRule, validateRules, mergeRules } from '../rule-parser.js'
import type { RuleHierarchy } from '../rule-parser.js'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import type { EnforceInput } from '../../types.js'

/**
 * Minimal/beginner-friendly rule format ("simple_rules:").
 *
 * The full KeelRule shape (id, type, level, scope, context, action,
 * message, priority, plus ~20 type-specific optional fields) is the shape
 * keel's own shipped catalog uses, not a reasonable first thing to hand a
 * user who wants to block one footgun command. `simple_rules:` is the
 * shorthand: id + type + one match-condition field appropriate to `type` +
 * action + message. expandSimpleRule() (rule-parser.ts) translates each
 * entry into a full KeelRule inside parseRulesContent(), before
 * validateRules() or the enforcement pipeline ever see it — this suite
 * covers the translation, the friendly validation errors, and that an
 * expanded rule actually fires when evaluated.
 */

// EnforcementPipeline defaults `overrideStore` to a FileRuleOverrideStore
// rooted at the real homedir() when none is supplied, and every deny/block
// verdict calls overrideStore.consume() — which touches real ~/.keel even
// when no override is ever armed. An in-memory stub keeps this suite off
// the real filesystem (same pattern as match-surface.test.ts).
const noopOverrideStore = { consume: () => false, peek: () => null, list: () => ({}) }

function makePipeline(yaml: string): EnforcementPipeline {
  const rules = parseRulesContent(yaml, '/tmp/simple-rules.md')
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    overrideStore: noopOverrideStore,
    ruleHierarchy: { global: null, user: null, project: rules, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
  })
}

function input(tool: string, args: Record<string, unknown>, session = 'simple-rules'): EnforceInput {
  return {
    tool,
    args,
    cwd: '/tmp',
    session_id: session,
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
  }
}

describe('simple_rules — minimal-form rule parses and round-trips into a full KeelRule', () => {
  it('expands a command rule with defaults applied', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: no-drop-db
    type: command
    match: "DROP TABLE"
    action: deny
    message: "Do not drop tables directly — use a migration."
`, '/tmp/rules.yaml')

    expect(parsed.errors).toBeUndefined()
    expect(parsed.rules).toHaveLength(1)
    const rule = parsed.rules[0]
    expect(rule).toEqual({
      id: 'no-drop-db',
      type: 'command',
      action: 'deny',
      message: 'Do not drop tables directly — use a migration.',
      level: 'sprint',
      context: ['both'],
      priority: -100,
      match: 'DROP TABLE',
    })
  })

  it('expands a content rule, converting plain regex strings into the {regex} object shape', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: no-hardcoded-key
    type: content
    patterns:
      - "sk-[a-zA-Z0-9]{20,}"
    action: warn
    message: "Looks like a hardcoded API key."
`, '/tmp/rules.yaml')

    expect(parsed.errors).toBeUndefined()
    const rule = parsed.rules[0]
    expect(rule.patterns).toEqual([{ regex: 'sk-[a-zA-Z0-9]{20,}' }])
    expect(rule.level).toBe('sprint')
    expect(rule.context).toEqual(['both'])
  })

  it('expands a filesystem rule', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: no-env-write
    type: filesystem
    paths: ["**/.env", "**/.env.*"]
    action: deny
    message: "Do not write secrets files directly."
`, '/tmp/rules.yaml')

    expect(parsed.errors).toBeUndefined()
    expect(parsed.rules[0].paths).toEqual(['**/.env', '**/.env.*'])
  })

  it('merges simple_rules alongside a full-form rules: list without disturbing it', () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: full-form-rule
    type: command
    match: "rm -rf /"
    action: deny
    level: protect
    message: "no"
simple_rules:
  - id: shorthand-rule
    type: command
    match: "curl.*| sh"
    action: warn
    message: "piping curl to sh"
`, '/tmp/rules.yaml')

    expect(parsed.errors).toBeUndefined()
    expect(parsed.rules.map(r => r.id)).toEqual(['full-form-rule', 'shorthand-rule'])
    expect(parsed.rules[0].level).toBe('protect')
    expect(parsed.rules[1].level).toBe('sprint')
  })

  it('does not set `scope` on an expanded rule — it must be inferred per-tier like a hand-written rule', () => {
    const { rule } = expandSimpleRule({ id: 'x', type: 'command', match: 'foo', action: 'warn', message: 'msg' })
    expect(rule?.scope).toBeUndefined()
  })

  // `level: 'balanced'` would be dropped ENTIRELY (not softened) by
  // mergeRules' dial filter the moment the ambient dial is `keel level
  // sprint` — docs/tiers.md documents 'sprint' (or unset) as the shipped
  // catalog's "no floor — obey the dial" convention, which is what
  // DEFAULT_SIMPLE_RULE_LEVEL follows. This is the test that would have
  // caught defaulting to the wrong literal: it merges at the sprint dial
  // specifically, not the 'balanced' dial every other test in this file
  // uses.
  it('a minimal-form rule survives mergeRules at the sprint dial (not silently dropped)', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: no-drop-db-sprint
    type: command
    match: "DROP TABLE"
    action: deny
    message: "no"
`, '/tmp/rules.yaml')
    const hierarchy: RuleHierarchy = { global: null, user: null, project: parsed, local: null }
    const merged = mergeRules(hierarchy, 'sprint', 'local')
    expect(merged.map(r => r.id)).toContain('no-drop-db-sprint')
  })

  it('an expanded rule passes the normal validateRules() with no additional issues', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: no-force-push-simple
    type: command
    match: "git push --force"
    action: deny
    message: "no force push"
`, '/tmp/rules.yaml')
    expect(validateRules(parsed.rules)).toEqual([])
  })
})

describe('simple_rules — default priority defers to the shipped catalog', () => {
  // Every shipped default rule with a deliberately negative priority
  // (e.g. secret-file-read-without-egress, broad-privilege-escalation —
  // both priority -5, see install.ts) relies on sorting LAST so it never
  // shadows a more specific rule ahead of it. SimpleRule has no `priority`
  // field, so before this fix every simple-form rule defaulted to
  // priority 0 — HIGHER than -5 — and would silently out-rank and shadow
  // those defaults for any command matching both surfaces.
  it('expandSimpleRule defaults priority to -100 (below any shipped default)', () => {
    const { rule } = expandSimpleRule({ id: 'x', type: 'command', match: 'foo', action: 'warn', message: 'msg' })
    expect(rule?.priority).toBe(-100)
  })

  it('a broad simple_rules allow no longer priority-shadows a negative-priority shipped default (real repro)', () => {
    // Mirrors the shape of install.ts's secret-file-read-without-egress:
    // a project-scope full-form rule at priority -5 that catches `cat` of
    // a secrets file.
    const shippedDefault: RuleHierarchy['global'] = parseRulesContent(`version: 1
rules:
  - id: secret-file-read-without-egress
    type: command
    match: "cat .env"
    action: warn
    priority: -5
    message: "Read of a secret file with no egress detected yet."
`, '/tmp/CLAUDE.md')

    // An agent-added simple_rules block matching a broad command surface
    // that also happens to catch `cat .env` — e.g. added to CLAUDE.md by
    // an agent that wants to quiet cat/less/head/tail noise.
    const agentAdded: RuleHierarchy['local'] = parseRulesContent(`version: 1
simple_rules:
  - id: quiet-pager-noise
    type: command
    match_regex: "^(cat|less|head|tail) "
    action: allow
    message: "Pager commands are noisy, allow them."
`, '/tmp/CLAUDE.local.md')

    const hierarchy: RuleHierarchy = { global: null, user: null, project: shippedDefault, local: agentAdded }
    const merged = mergeRules(hierarchy, 'balanced', 'local')

    // Both rules match "cat .env" — the shipped default (priority -5)
    // must sort AHEAD of the simple-form rule (priority -100 is lower
    // still, so it evaluates LAST), meaning the pipeline's first-match-
    // wins loop reaches the shipped warn before the simple-form allow.
    const defaultIdx = merged.findIndex(r => r.id === 'secret-file-read-without-egress')
    const simpleIdx = merged.findIndex(r => r.id === 'quiet-pager-noise')
    expect(defaultIdx).toBeGreaterThanOrEqual(0)
    expect(simpleIdx).toBeGreaterThanOrEqual(0)
    expect(defaultIdx).toBeLessThan(simpleIdx)
  })

  it('end-to-end via EnforcementPipeline: the shipped-default warn fires before the simple-form allow can shadow it', async () => {
    const shippedDefault = parseRulesContent(`version: 1
rules:
  - id: secret-file-read-without-egress-2
    type: command
    match: "cat .env"
    action: warn
    priority: -5
    message: "Read of a secret file with no egress detected yet."
simple_rules:
  - id: quiet-pager-noise-2
    type: command
    match_regex: "^(cat|less|head|tail) "
    action: allow
    message: "Pager commands are noisy, allow them."
`, '/tmp/rules.yaml')

    const pipeline = new EnforcementPipeline({
      level: 'balanced',
      context: 'local',
      cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(),
      sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(),
      overrideStore: noopOverrideStore,
      ruleHierarchy: { global: null, user: null, project: shippedDefault, local: null },
      ruleVersion: 1,
      allowedFixTransforms: true,
    })

    const result = await pipeline.evaluate(input('Bash', { command: 'cat .env' }))
    expect(result.rule_id).toBe('secret-file-read-without-egress-2')
    expect(result.action).not.toBe('allow')
  })
})

describe('simple_rules — friendly validation errors', () => {
  it('rejects a whitespace-only `match` (would otherwise become a regex matching almost any command)', () => {
    // Real repro of the danger: before this fix, a whitespace-only match
    // string passed the (bare falsy) emptiness check, was assigned to
    // base.match verbatim, and `new RegExp(' ')` matches almost any
    // command containing a space — shadowing every other rule ahead of it.
    expect(new RegExp(' ').test('git status')).toBe(true)

    const { error, rule } = expandSimpleRule({ id: 'ws-match', type: 'command', match: '   ', action: 'warn', message: 'no' })
    expect(error).toBe("rule 'ws-match': 'match' cannot be empty")
    expect(rule).toBeUndefined()
  })

  it('rejects a whitespace-only `match_regex`', () => {
    const { error, rule } = expandSimpleRule({ id: 'ws-match-regex', type: 'command', match_regex: '   ', action: 'warn', message: 'no' })
    expect(error).toBe("rule 'ws-match-regex': 'match_regex' cannot be empty")
    expect(rule).toBeUndefined()
  })

  it('a command rule missing both match and match_regex gets a specific, friendly error', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: broken-command-rule
    type: command
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    expect(parsed.errors).toContain(
      "rule 'broken-command-rule': type 'command' requires a 'match' or 'match_regex' field (the command text or pattern to catch)",
    )
    expect(parsed.rules).toHaveLength(0)
  })

  it('a filesystem rule missing paths gets a specific, friendly error', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: broken-fs-rule
    type: filesystem
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    expect(parsed.errors).toContain(
      "rule 'broken-fs-rule': type 'filesystem' requires a non-empty 'paths' list (e.g. paths: [\"**/.env\"])",
    )
  })

  it('a content rule missing patterns gets a specific, friendly error', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: broken-content-rule
    type: content
    action: warn
    message: "no"
`, '/tmp/rules.yaml')

    expect(parsed.errors).toContain(
      "rule 'broken-content-rule': type 'content' requires a non-empty 'patterns' list of regex strings (e.g. patterns: [\"sk-[a-zA-Z0-9]+\"])",
    )
  })

  it('a rule with an unsupported type names the supported set and points at the full form', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: bad-type
    type: sequence
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    expect(parsed.errors?.[0]).toBe(
      "rule 'bad-type': 'type' must be one of command, filesystem, content, env, network (got: \"sequence\") — for any other rule type, use the full rule format under 'rules:'",
    )
  })

  it('a rule missing an id is reported without throwing', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - type: command
    match: "foo"
    action: deny
    message: "no"
`, '/tmp/rules.yaml')

    expect(parsed.errors).toContain("simple rule \"<unnamed>\": missing a non-empty 'id'")
  })

  it('a rule missing a message is reported', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: no-message-rule
    type: command
    match: "foo"
    action: deny
`, '/tmp/rules.yaml')

    expect(parsed.errors).toContain("rule 'no-message-rule': missing a non-empty 'message' explaining what this rule does")
  })

  it('simple_rules must be an array', () => {
    const parsed = parseRulesContent('version: 1\nsimple_rules: not-an-array\n', '/tmp/rules.yaml')
    expect(parsed.errors).toContain('simple_rules must be an array')
  })

  it('a mistyped action gets the friendly, field-specific error instead of falling through to validateRules\' generic dump', () => {
    const parsed = parseRulesContent(`version: 1
simple_rules:
  - id: typo-action-rule
    type: command
    match: "foo"
    action: blok
    message: "no"
`, '/tmp/rules.yaml')

    expect(parsed.errors?.some(e => e.startsWith("rule 'typo-action-rule': 'action' must be one of"))).toBe(true)
    expect(parsed.errors?.some(e => e.includes('blok'))).toBe(true)
    // The rule never made it into `rules`, so validateRules()' generic
    // "has an unsupported action" message must NOT also appear.
    expect(parsed.errors?.some(e => e.includes('unsupported action'))).toBe(false)
    expect(parsed.rules).toHaveLength(0)
  })
})

describe('simple_rules — works from AGENTS.md/CLAUDE.md YAML frontmatter, not just standalone YAML', () => {
  it('expands a simple_rules entry nested under `keel:` in frontmatter', () => {
    const parsed = parseRulesContent(`---
keel:
  version: 1
  simple_rules:
    - id: no-force-push-frontmatter
      type: command
      match: "git push --force"
      action: deny
      message: "no force push"
---
# Project notes
`, '/tmp/CLAUDE.md')

    expect(parsed.errors).toBeUndefined()
    expect(parsed.rules).toHaveLength(1)
    expect(parsed.rules[0]).toMatchObject({
      id: 'no-force-push-frontmatter',
      type: 'command',
      match: 'git push --force',
      action: 'deny',
      level: 'sprint',
      context: ['both'],
    })
  })
})

describe('simple_rules — an expanded rule fires correctly when evaluated by EnforcementPipeline', () => {
  // A `deny` rule with no stateManager wired up (isFirstTime() defaults to
  // true on every call) warns on the first hit and blocks on the second —
  // the same warn-once-then-block escalation match-surface.test.ts's
  // expectMatchAndBlock() exercises. This isolates "did the minimal-form
  // rule match" from "warn vs deny", which is orthogonal to the format.
  it('denies a command matched by a minimal-form command rule (warn once, then deny)', async () => {
    const pipeline = makePipeline(`version: 1
simple_rules:
  - id: no-drop-db-pipeline
    type: command
    match: "DROP TABLE"
    action: deny
    message: "Do not drop tables directly."
`)

    const first = await pipeline.evaluate(input('Bash', { command: 'psql -c "DROP TABLE users"' }))
    expect(first.action).not.toBe('allow')
    expect(first.rule_id).toBe('no-drop-db-pipeline')
    const second = await pipeline.evaluate(input('Bash', { command: 'psql -c "DROP TABLE users"' }))
    expect(second.action).toBe('deny')
    expect(second.rule_id).toBe('no-drop-db-pipeline')
    expect(second.message).toBe('Do not drop tables directly.')
  })

  it('allows a command that does not match', async () => {
    const pipeline = makePipeline(`version: 1
simple_rules:
  - id: no-drop-db-pipeline-2
    type: command
    match: "DROP TABLE"
    action: deny
    message: "Do not drop tables directly."
`)

    const result = await pipeline.evaluate(input('Bash', { command: 'psql -c "SELECT 1"' }))
    expect(result.action).toBe('allow')
  })

  it('warns on content matched by a minimal-form content rule', async () => {
    const pipeline = makePipeline(`version: 1
simple_rules:
  - id: no-hardcoded-key-pipeline
    type: content
    patterns:
      - "sk-[a-zA-Z0-9]{10,}"
    action: warn
    message: "Looks like a hardcoded API key."
`)

    const result = await pipeline.evaluate(input('WriteFile', { filePath: 'src/config.ts', content: 'const key = "sk-abcdefghij1234567890"' }))
    expect(result.action).toBe('warn')
    expect(result.rule_id).toBe('no-hardcoded-key-pipeline')
  })

  it('denies a write matched by a minimal-form filesystem rule (warn once, then deny)', async () => {
    const pipeline = makePipeline(`version: 1
simple_rules:
  - id: no-env-write-pipeline
    type: filesystem
    paths: ["**/.env"]
    action: deny
    message: "Do not write secrets files directly."
`)

    const first = await pipeline.evaluate(input('WriteFile', { filePath: '/tmp/project/.env', content: 'SECRET=1' }))
    expect(first.action).not.toBe('allow')
    expect(first.rule_id).toBe('no-env-write-pipeline')
    const second = await pipeline.evaluate(input('WriteFile', { filePath: '/tmp/project/.env', content: 'SECRET=1' }))
    expect(second.action).toBe('deny')
    expect(second.rule_id).toBe('no-env-write-pipeline')
  })
})
