import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRuleHierarchy, parseRulesContent } from '../rule-parser.js'
import { StateManager } from '../state-manager.js'
import type { ProtectionLevel } from '../../types.js'

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
    expect(s1.action).toBe('warn')
    expect(s2.action).toBe('warn')
    expect(p1.action).toBe('warn')
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

  it('at protect, every level fires', async () => {
    const p = dialPipeline('protect')
    expect((await dialCall(p, 'protect', 'tok-unleveled')).action).toBe('warn')
    expect((await dialCall(p, 'protect', 'tok-sprint')).action).toBe('warn')
    expect((await dialCall(p, 'protect', 'tok-balanced')).action).toBe('warn')
    expect((await dialCall(p, 'protect', 'tok-protect')).action).toBe('warn')
  })

  it('protect-level rules deny at every dial on repeat (floors never soften)', async () => {
    for (const dial of ['sprint', 'balanced', 'protect'] as ProtectionLevel[]) {
      const p = dialPipeline(dial)
      expect((await dialCall(p, dial, 'tok-protect')).action).toBe('warn')
      expect((await dialCall(p, dial, 'tok-protect')).action).toBe('deny')
    }
  })
})
