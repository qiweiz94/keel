import { describe, it, expect } from 'vitest'
import { parseRulesContent } from '../core/enforce/rule-parser.js'
import { computeDialDiff } from '../commands/level.js'

/**
 * `keel level`'s dial-switch summary claims to print EXACTLY which rules
 * change effective action, derived from the real merged ruleset and the
 * real effectiveAction logic — not hardcoded prose. These tests exercise
 * computeDialDiff() directly (the function level.ts's CLI output is built
 * on) so the diff's correctness doesn't depend on parsing colorized
 * terminal output.
 *
 * The floor guarantee specifically: a `level: protect` rule must never
 * appear in `softened` when switching to sprint — that's the one thing a
 * user reading "N rules soften deny→warn" needs to be able to trust.
 */

const RULES_YAML = `version: 1
level: balanced
rules:
  - id: plain-deny
    type: command
    match: "tok-plain"
    action: deny
    message: "plain deny rule"
  - id: plain-block
    type: command
    match: "tok-block"
    action: block
    message: "plain block rule"
  - id: already-warn
    type: command
    match: "tok-warn"
    action: warn
    message: "already a warn"
  - id: floor-rule
    type: command
    match: "tok-floor"
    action: deny
    level: protect
    message: "protect floor"
  - id: balanced-only
    type: command
    match: "tok-balanced-only"
    action: deny
    level: balanced
    message: "only active at balanced+"
`

function hierarchy() {
  const parsed = parseRulesContent(RULES_YAML, '/tmp/dial-diff-test.yaml')
  return { global: parsed, user: null, project: null, local: null }
}

describe('computeDialDiff (balanced → sprint)', () => {
  const diff = computeDialDiff(hierarchy(), 'balanced', 'sprint')

  it('softens plain deny/block rules', () => {
    expect(diff.softened.sort()).toEqual(['plain-block', 'plain-deny'])
  })

  it('never lists a `level: protect` floor as softened', () => {
    expect(diff.softened).not.toContain('floor-rule')
    expect(diff.hardened).not.toContain('floor-rule')
  })

  it('reports the floor as present and unchanged', () => {
    expect(diff.floors).toContain('floor-rule')
  })

  it('deactivates a rule whose `level` floor is above sprint', () => {
    expect(diff.deactivated).toContain('balanced-only')
  })

  it('does not touch a rule that was already warn', () => {
    expect(diff.softened).not.toContain('already-warn')
    expect(diff.hardened).not.toContain('already-warn')
  })
})

describe('computeDialDiff (sprint → protect)', () => {
  const diff = computeDialDiff(hierarchy(), 'sprint', 'protect')

  it('hardens rules that sprint had softened', () => {
    expect(diff.hardened.sort()).toEqual(['plain-block', 'plain-deny'])
  })

  it('never lists the floor as hardened (it never softened, so it cannot harden)', () => {
    expect(diff.hardened).not.toContain('floor-rule')
  })

  it('activates the level-gated rule that sprint had filtered out', () => {
    expect(diff.activated).toContain('balanced-only')
  })
})

describe('computeDialDiff (no-op switch)', () => {
  it('reports no changes when previous and new level are the same', () => {
    const diff = computeDialDiff(hierarchy(), 'balanced', 'balanced')
    expect(diff.softened).toEqual([])
    expect(diff.hardened).toEqual([])
    expect(diff.deactivated).toEqual([])
    expect(diff.activated).toEqual([])
  })
})
