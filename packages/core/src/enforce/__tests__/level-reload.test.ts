import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRuleHierarchy, parseRulesContent, dialAction } from '../rule-parser.js'
import { StateManager } from '../state-manager.js'
import type { KeelRule, ProtectionLevel } from '../../types.js'

function hashRulesFile(p: string): string {
  if (!existsSync(p)) return ''
  const c = readFileSync(p, 'utf-8')
  let x = 0
  for (let i = 0; i < c.length; i++) x = ((x << 5) - x + c.charCodeAt(i)) | 0
  return x.toString(36)
}

describe('dial level changes apply on the next call (no one-call lag)', () => {
  const home = mkdtempSync(join(tmpdir(), 'level-reload-home-'))
  const dir = mkdtempSync(join(tmpdir(), 'level-reload-'))
  const rulesPath = join(dir, '.keel', 'rules.yaml')
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // Isolate ~/.keel (state, overrides, sentinel) so the test never touches
  // the host's real enforcement state.
  const previousHome = process.env.HOME
  process.env.HOME = home
  const results: Array<{ label: string; action: string }> = []
  beforeAll(async () => {
    mkdirSync(join(dir, '.keel'), { recursive: true })
    const mkRules = (level: string, id: string) => `version: 1
level: ${level}
rules:
  - id: ${id}
    type: command
    match: "dial-token-${uid}"
    action: deny
    message: "m0"
`
    const pipeline = new EnforcementPipeline({
      level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 1000 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(), ruleHierarchy: loadRuleHierarchy(dir), ruleVersion: 1,
      allowedFixTransforms: true, stateManager: new StateManager(),
      disableFile: join(home, '.keel', 'DISABLED'),
      reloadRules: () => loadRuleHierarchy(dir),
      ruleFingerprint: () => [
        rulesPath, join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md'),
        join(dir, '.keel.local.yaml'), join(dir, 'AGENTS.local.md'), join(dir, 'CLAUDE.local.md'),
        join(home, '.keel', 'rules.yaml'), join(home, '.config', 'keel', 'rules.yaml'),
      ].map(hashRulesFile).join(':'),
    })
    let level = 'balanced'
    const setLevel = (l: string) => { level = l }
    const call = async () => {
      return pipeline.evaluate({
        tool: 'Bash', args: { command: `dial-token-${uid}` }, cwd: dir,
        session_id: 's1', turn_number: 1, context_tokens: 0,
        level, context: 'local', agent: 't', subagent_of: null,
        depth: level === 'protect' ? 'deep' : level === 'sprint' ? 'fast' : 'full',
      } as any)
    }
    writeFileSync(rulesPath, mkRules('balanced', 'b-warn'))
    const b1 = await call()
    const b2 = await call()
    setLevel('sprint')
    writeFileSync(rulesPath, mkRules('sprint', 's-warn'))
    const s1 = await call()
    const s2 = await call()
    setLevel('protect')
    writeFileSync(rulesPath, mkRules('protect', 'p-warn'))
    const p1 = await call()
    const p2 = await call()
    expect(b1.action).toBe('warn')
    expect(b2.action).toBe('deny')
    // Floor semantics: a plain deny rule stays visible at sprint (deny→warn
    // downgrade), it is no longer filtered out of the merged rule set.
    // At protect the deny blocks FIRST (block-first dial).
    expect(s1.action).toBe('warn')
    expect(s2.action).toBe('warn')
    expect(p1.action).toBe('deny')
    expect(p2.action).toBe('deny')
    results.push({ label: 'balanced-second', action: b2.action }, { label: 'sprint-second', action: s2.action }, { label: 'protect-second', action: p2.action })
  })
  afterAll(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
  it('balanced → sprint → protect transitions evaluate at the new level immediately', () => {
    // The real assertions live in beforeAll (they need the live file
    // rewrites); this test re-checks the recorded outcomes so the suite
    // fails if the setup is ever removed.
    expect(results).toEqual([
      { label: 'balanced-second', action: 'deny' },
      { label: 'sprint-second', action: 'warn' },
      { label: 'protect-second', action: 'deny' },
    ])
  })
})

describe('rule level is a minimum-dial filter', () => {
  const DIAL_RULES = `version: 1
rules:
  - id: unleveled-rule
    type: command
    match: "tok-unleveled"
    action: deny
    message: "unleveled"
  - id: sprint-rule
    type: command
    match: "tok-sprint"
    level: sprint
    action: deny
    message: "sprint"
  - id: balanced-rule
    type: command
    match: "tok-balanced"
    level: balanced
    action: deny
    message: "balanced"
  - id: protect-rule
    type: command
    match: "tok-protect"
    level: protect
    action: deny
    message: "protect"
`

  function dialPipeline(dial: ProtectionLevel): EnforcementPipeline {
    const rules = parseRulesContent(DIAL_RULES, '/tmp/dial.yaml')
    rules.config.level = dial
    return new EnforcementPipeline({
      level: dial, context: 'local', cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(),
      ruleHierarchy: { global: rules, user: null, project: null, local: null },
      ruleVersion: 1, allowedFixTransforms: true,
    })
  }

  function dialCall(p: EnforcementPipeline, dial: ProtectionLevel, token: string) {
    return p.evaluate({
      tool: 'Bash', args: { command: token }, cwd: '/tmp/dial', session_id: 'dial',
      turn_number: 1, context_tokens: 0, level: dial, context: 'local', agent: 't', subagent_of: null,
    } as any)
  }

  it('at sprint, balanced-level rules are filtered out; sprint/protect/unleveled fire', async () => {
    const p = dialPipeline('sprint')
    expect((await dialCall(p, 'sprint', 'tok-unleveled')).action).toBe('warn')
    expect((await dialCall(p, 'sprint', 'tok-sprint')).action).toBe('warn')
    expect((await dialCall(p, 'sprint', 'tok-balanced')).action).toBe('allow')
    expect((await dialCall(p, 'sprint', 'tok-protect')).action).toBe('warn')
  })

  it('at balanced, every level fires', async () => {
    const p = dialPipeline('balanced')
    expect((await dialCall(p, 'balanced', 'tok-unleveled')).action).toBe('warn')
    expect((await dialCall(p, 'balanced', 'tok-sprint')).action).toBe('warn')
    expect((await dialCall(p, 'balanced', 'tok-balanced')).action).toBe('warn')
    expect((await dialCall(p, 'balanced', 'tok-protect')).action).toBe('warn')
  })

  it('at protect, every level fires — and deny rules block FIRST (block-first dial)', async () => {
    const p = dialPipeline('protect')
    expect((await dialCall(p, 'protect', 'tok-unleveled')).action).toBe('deny')
    expect((await dialCall(p, 'protect', 'tok-sprint')).action).toBe('deny')
    expect((await dialCall(p, 'protect', 'tok-balanced')).action).toBe('deny')
    expect((await dialCall(p, 'protect', 'tok-protect')).action).toBe('deny')
  })

  it('protect-level rules deny at every dial on repeat (floors never soften)', async () => {
    for (const dial of ['sprint', 'balanced', 'protect'] as ProtectionLevel[]) {
      const p = dialPipeline(dial)
      if (dial === 'protect') {
        // Block-first: the floor blocks on the FIRST violation at protect.
        expect((await dialCall(p, dial, 'tok-protect')).action).toBe('deny')
        expect((await dialCall(p, dial, 'tok-protect')).action).toBe('deny')
      } else {
        expect((await dialCall(p, dial, 'tok-protect')).action).toBe('warn')
        expect((await dialCall(p, dial, 'tok-protect')).action).toBe('deny')
      }
    }
  })

  // Explicit floor test: at sprint, a `level: protect` rule's violation
  // still reaches `deny` — contrasted directly against a plain deny rule,
  // which sprint permanently softens to `warn`. Both rules go through the
  // same warn-once-then-block escalation; the difference this test proves
  // is which final action that escalation lands on.
  it('at sprint: a protect-floor violation still reaches deny on repeat; a plain deny rule stays stuck at warn', async () => {
    const p = dialPipeline('sprint')
    expect((await dialCall(p, 'sprint', 'tok-unleveled')).action).toBe('warn')
    expect((await dialCall(p, 'sprint', 'tok-unleveled')).action).toBe('warn') // sprint softened this permanently
    expect((await dialCall(p, 'sprint', 'tok-protect')).action).toBe('warn')   // first-violation warn (same escalation as any rule)
    expect((await dialCall(p, 'sprint', 'tok-protect')).action).toBe('deny')   // floor: sprint never softened it — still deny
  })
})

describe('sprint auto-expiry reverts enforcement to balanced (timeout-only, no daemon, no session tracking)', () => {
  const home = mkdtempSync(join(tmpdir(), 'sprint-expiry-home-'))
  const dir = mkdtempSync(join(tmpdir(), 'sprint-expiry-'))
  const rulesPath = join(dir, '.keel', 'rules.yaml')
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const previousHome = process.env.HOME
  process.env.HOME = home
  const results: Record<string, string> = {}

  beforeAll(async () => {
    mkdirSync(join(dir, '.keel'), { recursive: true })
    const rules = (startedAtIso: string) => `version: 1
level: sprint
sprint_started_at: ${startedAtIso}
rules:
  - id: expiry-rule
    type: command
    match: "expiry-token-${uid}"
    action: deny
    message: "m0"
`
    const pipeline = new EnforcementPipeline({
      level: 'sprint', context: 'local', cache: new ActionCache({ maxSize: 1000 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(), ruleHierarchy: loadRuleHierarchy(dir), ruleVersion: 1,
      allowedFixTransforms: true, stateManager: new StateManager(),
      disableFile: join(home, '.keel', 'DISABLED'),
      reloadRules: () => loadRuleHierarchy(dir),
      ruleFingerprint: () => [rulesPath].map(hashRulesFile).join(':'),
    })
    const call = async () => pipeline.evaluate({
      tool: 'Bash', args: { command: `expiry-token-${uid}` }, cwd: dir,
      session_id: 's1', turn_number: 1, context_tokens: 0,
      level: 'sprint', context: 'local', agent: 't', subagent_of: null,
    } as any)

    // Sprint started 1h ago, default 4h expiry: still in effect — a plain
    // deny rule stays softened to warn no matter how many times it fires.
    writeFileSync(rulesPath, rules(new Date(Date.now() - 1 * 3_600_000).toISOString()))
    results.fresh1 = (await call()).action
    results.fresh2 = (await call()).action

    // Rewrite with an ancient sprint_started_at (5h ago, past the 4h
    // default): the EFFECTIVE level reverts to balanced on the very next
    // call — no plugin restart, no daemon, just the reload this process
    // already does when the rules file's hash changes.
    writeFileSync(rulesPath, rules(new Date(Date.now() - 5 * 3_600_000).toISOString()))
    results.expired1 = (await call()).action
    results.expired2 = (await call()).action
  })
  afterAll(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('a fresh (non-expired) sprint keeps softening deny to warn on repeat', () => {
    expect(results.fresh1).toBe('warn')
    expect(results.fresh2).toBe('warn')
  })

  it('an expired sprint reverts to balanced enforcement — warn once, then deny on repeat', () => {
    expect(results.expired1).toBe('warn')
    expect(results.expired2).toBe('deny')
  })
})

describe('dialAction() — the pure floor + sprint-downgrade logic pipeline.enforcedAction() and `keel level`\'s dial-diff both delegate to', () => {
  const denyRule: KeelRule = { id: 'r-deny', type: 'command', action: 'deny', message: 'm' } as KeelRule
  const blockRule: KeelRule = { id: 'r-block', type: 'command', action: 'block', message: 'm' } as KeelRule
  const protectFloor: KeelRule = { id: 'r-floor', type: 'command', action: 'deny', level: 'protect', message: 'm' } as KeelRule
  const warnRule: KeelRule = { id: 'r-warn', type: 'command', action: 'warn', message: 'm' } as KeelRule

  it('sprint softens a plain deny/block rule to warn', () => {
    expect(dialAction(denyRule, 'sprint')).toBe('warn')
    expect(dialAction(blockRule, 'sprint')).toBe('warn')
  })

  it('sprint does NOT touch a `level: protect` rule — it keeps its declared action at every dial', () => {
    expect(dialAction(protectFloor, 'sprint')).toBe('deny')
    expect(dialAction(protectFloor, 'balanced')).toBe('deny')
    expect(dialAction(protectFloor, 'protect')).toBe('deny')
  })

  it('a rule that is not deny/block is unaffected by the dial regardless of level', () => {
    expect(dialAction(warnRule, 'sprint')).toBe('warn')
    expect(dialAction(warnRule, 'balanced')).toBe('warn')
    expect(dialAction(warnRule, 'protect')).toBe('warn')
  })
})
