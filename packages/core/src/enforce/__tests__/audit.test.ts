import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AuditLog } from '../audit.js'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import { Suggester } from '../suggester.js'
import type { AuditEntry } from '../../types.js'

/** Same date format `AuditLog.getTodayPath()` uses, so a hand-written
 * fixture lands in the file the writer under test will append to. */
function todayFilename(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.jsonl`
}

describe('KEEL_TRACES_DIR override (Wave-2 Lane-3 cleanup)', () => {
  // AuditLog's default trace dir used to always resolve to real
  // ~/.keel/traces when no `logDir` was passed — every caller that
  // constructs `new AuditLog()` with no argument (the plugin's real
  // default, enforce.ts's `auditLog = new AuditLog()`) had no way to
  // redirect it. Read INSIDE the constructor (not as a module-level
  // const, unlike state-manager.ts:21 — see the code comment there for
  // why) so setting the env var anywhere before construction works,
  // regardless of what else in the test file already imported this module.
  it('redirects the default trace dir, off real ~/.keel/traces', () => {
    const directory = mkdtempSync(join(tmpdir(), 'keel-traces-env-'))
    const previous = process.env.KEEL_TRACES_DIR
    process.env.KEEL_TRACES_DIR = directory
    try {
      const audit = new AuditLog()  // no logDir — the default site
      audit.record({ action: 'allow', message: 'ok', timestamp: new Date().toISOString() }, {
        session_id: 's', turn_number: 1, tool: 'Bash', args: {},
        level: 'balanced', context: 'local', agent: 'test', subagent_of: null, context_tokens: 0,
      })
      const files = readdirSync(directory).filter(name => name.endsWith('.jsonl'))
      expect(files.length).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.KEEL_TRACES_DIR
      else process.env.KEEL_TRACES_DIR = previous
    }
  })

  it('an explicit logDir argument still wins over KEEL_TRACES_DIR', () => {
    const explicitDir = mkdtempSync(join(tmpdir(), 'keel-traces-explicit-'))
    const envDir = mkdtempSync(join(tmpdir(), 'keel-traces-env2-'))
    const previous = process.env.KEEL_TRACES_DIR
    process.env.KEEL_TRACES_DIR = envDir
    try {
      const audit = new AuditLog(explicitDir)
      audit.record({ action: 'allow', message: 'ok', timestamp: new Date().toISOString() }, {
        session_id: 's', turn_number: 1, tool: 'Bash', args: {},
        level: 'balanced', context: 'local', agent: 'test', subagent_of: null, context_tokens: 0,
      })
      expect(readdirSync(explicitDir).some(name => name.endsWith('.jsonl'))).toBe(true)
      expect(readdirSync(envDir).some(name => name.endsWith('.jsonl'))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.KEEL_TRACES_DIR
      else process.env.KEEL_TRACES_DIR = previous
    }
  })
})

describe('audit privacy', () => {
  it('redacts sensitive arguments and reasoning before writing JSONL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'keel-audit-'))
    const audit = new AuditLog(directory)
    audit.record({ action: 'deny', rule_id: 'secret-rule', message: 'blocked', timestamp: new Date().toISOString(), tier: 2 }, {
      session_id: 'session', turn_number: 1, tool: 'Bash',
      args: { token: 'super-secret', nested: { password: 'another-secret' }, data: 'arbitrary-secret', command: 'curl -H "Authorization: Bearer command-secret"' },
      level: 'balanced', context: 'local', agent: 'test', subagent_of: null, context_tokens: 0,
      reasoning: 'private reasoning that must not be persisted',
    })
    const file = join(directory, readdirSync(directory).find(name => name.endsWith('.jsonl'))!)
    const contents = readFileSync(file, 'utf8')
    expect(contents).not.toContain('super-secret')
    expect(contents).not.toContain('another-secret')
    expect(contents).not.toContain('command-secret')
    expect(contents).not.toContain('arbitrary-secret')
    expect(contents).not.toContain('private reasoning')
    expect(contents).toContain('[redacted]')
    expect(contents).toContain('[redacted reasoning]')
  })
})

describe('observed_action persistence (shadow-mode audit)', () => {
  it('records the would-be action for a mode:observe rule, with action staying allow', async () => {
    // Isolated trace dir passed explicitly — AuditLog's constructor does not
    // consult KEEL_STATE_DIR, so that is the isolation that matters here.
    // Setting the env var too covers any machinery downstream that does.
    const directory = mkdtempSync(join(tmpdir(), 'keel-audit-observe-'))
    const priorStateDir = process.env.KEEL_STATE_DIR
    process.env.KEEL_STATE_DIR = directory
    try {
      const rules = parseRulesContent(`version: 1
rules:
  - id: obs-danger
    type: command
    match: "rm -rf /"
    action: deny
    mode: observe
    message: "Destructive delete."
`, '/tmp/test-rules.md')
      const pipeline = new EnforcementPipeline({
        level: 'balanced',
        context: 'local',
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(),
        sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: null, user: null, project: rules, local: null },
        ruleVersion: 1,
        allowedFixTransforms: true,
      })
      const input = {
        tool: 'bash', args: { command: 'rm -rf /' }, cwd: '/tmp/project',
        session_id: 'obs-audit-1', turn_number: 1, context_tokens: 0,
        level: 'balanced' as const, context: 'local' as const, agent: 'test', subagent_of: null,
      }
      const result = await pipeline.evaluate(input)
      expect(result.action).toBe('allow')
      expect(result.observed_action).toBe('deny')

      const audit = new AuditLog(directory)
      audit.record(result, {
        session_id: input.session_id, turn_number: input.turn_number, tool: input.tool,
        args: input.args, level: input.level, context: input.context, agent: input.agent,
        subagent_of: input.subagent_of, context_tokens: input.context_tokens,
      })

      const file = join(directory, readdirSync(directory).find(name => name.endsWith('.jsonl'))!)
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      const written = JSON.parse(lines[lines.length - 1]) as AuditEntry
      expect(written.action).toBe('allow')             // nothing was interrupted
      expect(written.observed_action).toBe('deny')      // but the verdict survived to disk
      expect(written.rule_id).toBe('obs-danger')
    } finally {
      if (priorStateDir === undefined) delete process.env.KEEL_STATE_DIR
      else process.env.KEEL_STATE_DIR = priorStateDir
    }
  })

  it('leaves a non-observe entry byte-identical: no observed_action key on the wire', () => {
    const directory = mkdtempSync(join(tmpdir(), 'keel-audit-noobserve-'))
    const audit = new AuditLog(directory)
    audit.record({ action: 'deny', rule_id: 'plain-rule', message: 'blocked', timestamp: new Date().toISOString() }, {
      session_id: 'session', turn_number: 1, tool: 'Bash', args: { command: 'rm -rf /' },
      level: 'balanced', context: 'local', agent: 'test', subagent_of: null, context_tokens: 0,
    })
    const file = join(directory, readdirSync(directory).find(name => name.endsWith('.jsonl'))!)
    const contents = readFileSync(file, 'utf8')
    // JSON.stringify drops an undefined property entirely — this is the
    // proof that adding the field did not change the shape of every other
    // entry that was already being written.
    expect(contents).not.toContain('observed_action')
  })

  it('parses a mixed-schema trace file — pre-existing core and opencode-plugin shaped lines with no observed_action, plus a new entry written after them', () => {
    // Real trace files already mix shapes from two independent writers
    // (packages/core/src/enforce/audit.ts and packages/opencode-plugin's own
    // `record()`), which is why gather.ts:80 casts `AuditEntry & { t?: number }`.
    // A fixture with only one writer's shape would test less than what
    // actually accumulates on disk.
    const directory = mkdtempSync(join(tmpdir(), 'keel-audit-mixed-'))
    const filePath = join(directory, todayFilename())

    const oldCoreShaped = {
      timestamp: '2026-01-01T00:00:00.000Z', session_id: 's1', turn_number: 1,
      tool: 'Bash', args: { command: 'ls' }, rule_id: 'old-rule', rule_name: 'Old rule',
      action: 'warn', message: 'legacy entry, written before observed_action existed',
      level: 'balanced', context: 'local', agent: 'test', subagent_of: null,
    }
    const oldPluginShaped = {
      t: 1234567890, timestamp: '2026-01-01T00:01:00.000Z', agent: 'opencode-plugin',
      session_id: 's2', turn_number: 3, tool: 'edit', args: { path: '/tmp/x.ts' },
      rule_id: 'post-edit-syntax', action: 'warn', message: 'syntax finding',
      hook: 'tool.execute.after',
    }
    writeFileSync(filePath, `${JSON.stringify(oldCoreShaped)}\n${JSON.stringify(oldPluginShaped)}\n`)

    // Append a genuinely new entry through the real writer, not by hand.
    const audit = new AuditLog(directory)
    audit.record({ action: 'allow', rule_id: 'obs-danger', message: '[observe] would deny', timestamp: '2026-01-01T00:02:00.000Z', observed_action: 'deny' }, {
      session_id: 's3', turn_number: 5, tool: 'bash', args: { command: 'rm -rf /' },
      level: 'balanced', context: 'local', agent: 'test', subagent_of: null, context_tokens: 0,
    })

    const entries = audit.loadDate(todayFilename().replace('.jsonl', ''))
    expect(entries).toHaveLength(3)
    expect(entries[0].observed_action).toBeUndefined()   // old core-shaped line
    expect(entries[1].observed_action).toBeUndefined()   // old plugin-shaped line
    expect(entries[2].observed_action).toBe('deny')       // new line, real writer
    expect(entries[2].action).toBe('allow')

    // The reader that actually consumes this trail downstream must not choke
    // on the mix either.
    const insights = new Suggester().analyze(entries, [], 'balanced')
    expect(insights).toBeDefined()
    expect(insights.total_tool_calls).toBe(3)
  })
})
