import { describe, it, expect } from 'vitest'
import { parseRulesContent, validateRules } from '../core/enforce/rule-parser.js'
import { HARNESS_RULES_YAML, HARNESS_RULE_IDS } from '../commands/harness-rules.js'

/**
 * The harness rules are meant to be pasted into a user's rules.yaml. If
 * they do not parse, or parse but never fire, the paste is a no-op with a
 * green checkmark — the exact failure this project keeps finding
 * elsewhere. So: parse them with keel's own parser, validate them with
 * keel's own validator, and prove the stuck rule actually fires.
 */

const asDocument = () => `version: 1\nlevel: balanced\nrules:\n${HARNESS_RULES_YAML}`

describe('problem-solving harness rules', () => {
  it('parse cleanly with keel’s own parser', () => {
    const parsed = parseRulesContent(asDocument(), '/tmp/harness-test.yaml')
    expect(parsed.errors ?? []).toEqual([])
    expect(parsed.rules.map(r => r.id).sort()).toEqual([...HARNESS_RULE_IDS].sort())
  })

  it('pass validation — an invalid field would make the paste silently inert', () => {
    const parsed = parseRulesContent(asDocument(), '/tmp/harness-test.yaml')
    expect(validateRules(parsed.rules)).toEqual([])
  })

  it('use the rule types that do not exist in a default install', () => {
    const parsed = parseRulesContent(asDocument(), '/tmp/harness-test.yaml')
    const types = parsed.rules.map(r => r.type).sort()
    expect(types).toEqual(['diagnosis', 'research', 'stuck'])
  })

  it('ship in observe mode so nothing interrupts on first hit', () => {
    const parsed = parseRulesContent(asDocument(), '/tmp/harness-test.yaml')
    for (const rule of parsed.rules) {
      expect(rule.mode).toBe('observe')
      // Metadata is what lets the dashboard rank and promote them later.
      expect(rule.severity).toBeTruthy()
      expect(rule.confidence).toBeTruthy()
      expect(rule.rationale).toBeTruthy()
    }
  })

  it('the stuck rule matches the command that actually looped 39 times', () => {
    // From this machine's real traces: `keel allow source-change-requires-test
    // --once` was retried 39 times in one session. If the match pattern
    // does not cover it, the rule is decorative.
    const parsed = parseRulesContent(asDocument(), '/tmp/harness-test.yaml')
    const stuck = parsed.rules.find(r => r.id === 'no-repeat-loops')!
    const pattern = new RegExp(stuck.match!, 'i')

    expect(pattern.test('keel allow source-change-requires-test --once')).toBe(true)
    expect(pattern.test('npm test')).toBe(true)
    expect(pattern.test('git commit -m "wip"')).toBe(true)
    // And must NOT match ordinary reads, or every session becomes a loop.
    expect(pattern.test('ls -la')).toBe(false)
    expect(pattern.test('cat README.md')).toBe(false)
  })

  it('the research rule arms on failure only, never on green-field work', () => {
    const parsed = parseRulesContent(asDocument(), '/tmp/harness-test.yaml')
    const research = parsed.rules.find(r => r.id === 'research-before-fix')!
    // `exit: nonzero` is what keeps this from firing on ordinary editing.
    expect(research.trigger?.exit).toBe('nonzero')
    expect(research.boundaries?.edit?.action).toBe('redirect')
  })

  it('the diagnosis rule accepts investigation as evidence, not just a hypothesis', () => {
    // Demanding a recorded hypothesis from someone who already ran git
    // blame is ceremony, and ceremony is what gets rules disabled.
    const parsed = parseRulesContent(asDocument(), '/tmp/harness-test.yaml')
    const diagnosis = parsed.rules.find(r => r.id === 'root-cause-before-refactor')!
    expect(new RegExp(diagnosis.fallback_pattern!).test('git bisect start')).toBe(true)
    expect(new RegExp(diagnosis.fallback_pattern!).test('git blame src/a.ts')).toBe(true)
  })
})
