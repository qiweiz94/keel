import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveHome } from '../../home.js'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { SessionTracker } from '../session-tracker.js'
import { PersistentSessionStore } from '../session-store.js'
import type { PipelineConfig } from '../pipeline.js'
import type { ProtectionLevel, RuleContext } from '../../types.js'
import { loadRuleHierarchy, parseRulesContent, parseRulesFile, validateRules } from '../rule-parser.js'
import type { StateManager } from '../state-manager.js'
import { FileRuleOverrideStore } from '../overrides.js'
import { rmSafe } from './helpers/fs-safe.js'

// Every pipeline this file builds via makePipeline()/makePipelineFromYaml()
// points at a private tmp HALTED path that is never written to, rather than
// relying on the real ~/.keel/HALTED being absent. This is deliberately
// NOT the same pattern as the DISABLED guard in the 'EnforcementPipeline'
// beforeAll below (which does rm the real sentinel) — halt's whole contract
// is "nothing but `keel resume` clears this", so a test suite silently
// deleting a developer's real HALTED file would violate the feature it is
// testing, not just risk a flaky run.
const SHARED_HALT_FILE = join(mkdtempSync(join(tmpdir(), 'keel-pipeline-halt-')), 'HALTED')

function sharedStateManager(): StateManager {
  const state = {
    denyFirstTime: {} as Record<string, number | { timestamp: number; version?: string }>,
    circuitBreaker: {} as Record<string, { count: number; startTime: number }>,
    rateCounts: {} as Record<string, { count: number; windowStart: number }>,
    verification: {},
    markFirstTime(ruleId: string, version?: string) {
      this.denyFirstTime[ruleId] = version ? { timestamp: Date.now(), version } : Date.now()
    },
    isFirstTime(ruleId: string, version?: string) {
      const value = this.denyFirstTime[ruleId]
      return value === undefined || (!!version && (typeof value === 'number' || value.version !== version))
    },
    recordCircuitBreaker(ruleId: string, tool: string) {
      const key = `${ruleId}:${tool}`
      const now = Date.now()
      const current = this.circuitBreaker[key]
      this.circuitBreaker[key] = current && now - current.startTime < 60000
        ? { count: current.count + 1, startTime: current.startTime }
        : { count: 1, startTime: now }
      return this.circuitBreaker[key].count >= 3
    },
    checkRateLimit(ruleId: string, match: string, windowSec: number, maxCalls: number) {
      const key = `rate:${ruleId}:${match}`
      const now = Date.now()
      const current = this.rateCounts[key]
      this.rateCounts[key] = current && now - current.windowStart < windowSec * 1000
        ? { count: current.count + 1, windowStart: current.windowStart }
        : { count: 1, windowStart: now }
      return this.rateCounts[key].count > maxCalls
    },
  }
  return state as unknown as StateManager
}

function makeSampleRules() {
  return parseRulesContent(`---
keel:
  version: 1
  level: balanced
  rules:
    - id: never-force-push
      type: command
      match: "git push --force"
      action: deny
      level: sprint
      message: "No force push"

    - id: warn-secrets
      type: command
      match: "echo.*KEY|echo.*SECRET"
      action: warn
      level: balanced
      message: "Potential secret leak"

    - id: fix-commits
      type: command
      match: "git commit"
      action: fix
      fix:
        - pattern: "git commit"
          replace: "git commit --signoff"
      level: sprint
      message: "Auto-signoff"
---
# Test rules
`, '/tmp/test-rules.md')
}

function makePipeline(level: ProtectionLevel = 'balanced'): EnforcementPipeline {
  const rules = makeSampleRules()
  const hierarchy = {
    global: null,
    user: null,
    project: rules,
    local: null,
  }

  const config: PipelineConfig = {
    level,
    context: 'local' as RuleContext,
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: hierarchy,
    ruleVersion: 1,
    allowedFixTransforms: true,
    haltFile: SHARED_HALT_FILE,
  }

  return new EnforcementPipeline(config)
}

function makePipelineFromYaml(yaml: string, stateManager?: StateManager, sourcePath = '/tmp/test-rules.md'): EnforcementPipeline {
  const rules = parseRulesContent(yaml, sourcePath)
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local' as RuleContext,
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: { global: null, user: null, project: rules, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
    haltFile: SHARED_HALT_FILE,
    stateManager,
  })
}

function input(tool: string, args: Record<string, unknown>, session = 'sequence-test') {
  return {
    tool,
    args,
    cwd: '/tmp/project',
    session_id: session,
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced' as const,
    context: 'local' as const,
    agent: 'test',
    subagent_of: null,
  }
}

// Each test gets a private tmp file so this suite is safe to run in parallel
// processes (the CLI package vendors a copy of these tests via the build).
let tmpDir = ''
function tmpFile(name: string): string {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'keel-pipeline-'))
  return join(tmpDir, name)
}

describe('EnforcementPipeline', () => {
  afterAll(() => {
    if (tmpDir) rmSafe(tmpDir)
  })

  beforeAll(() => {
    // Do not let a developer's live kill switch affect unrelated unit tests.
    // Mirrors pipeline.ts's own resolveHome()-based fallback so this stays
    // in lockstep with the code under test.
    const sentinelPath = join(resolveHome(), '.keel', 'DISABLED')
    if (existsSync(sentinelPath)) rmSync(sentinelPath)
    // No equivalent rm of the real ~/.keel/HALTED here, deliberately: every
    // pipeline this file builds (including the 'Kill switch' describe block
    // above and the dedicated 'Halt' describe block below) is given an
    // explicit `haltFile` pointing at a private tmp path — see
    // SHARED_HALT_FILE's own comment for why silently clearing a
    // developer's real halt would be wrong, not just risky.
  })

  describe('Stateful rules', () => {
    it('records allowed actions before evaluating a sequence', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: write-then-edit
    type: sequence
    steps:
      - tool: WriteFile
        pattern: "src/"
      - tool: edit
        pattern: "src/"
    sequence_window_seconds: 300
    action: deny
    message: "Do not edit immediately after writing source."
`)

      expect((await pipeline.evaluate(input('WriteFile', { filePath: 'src/a.ts' }))).action).toBe('allow')
      expect((await pipeline.evaluate(input('edit', { filePath: 'src/a.ts' }))).action).toBe('warn')
      expect((await pipeline.evaluate(input('edit', { filePath: 'src/a.ts' }))).action).toBe('deny')
    })

    it('does not reuse the current action as a preceding repeated step', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: repeated-step
    type: sequence
    steps:
      - tool: Bash
        pattern: "same"
      - tool: Bash
        pattern: "same"
    action: deny
    message: "Repeated sequence"
`)

      expect((await pipeline.evaluate(input('Bash', { command: 'same' }, 'repeated'))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'same' }, 'repeated'))).action).toBe('warn')
    })

    it('tracks and clears verification obligations at an explicit boundary', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: source-test
    type: verification
    trigger:
      tools: [WriteFile, edit]
      pattern: "src/"
    satisfy:
      tools: [Bash]
      pattern: "npm test"
    boundaries:
      commit:
        pattern: "git commit"
        action: warn
    verification_window_seconds: 300
    action: deny
    message: "Test before commit."
`)

      expect((await pipeline.evaluate(input('WriteFile', { filePath: 'src/a.ts' }, 'obligation'))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'git commit -m x' }, 'obligation'))).action).toBe('warn')
      pipeline.markVerificationSatisfied(input('Bash', { command: 'npm test' }, 'obligation'))
      expect((await pipeline.evaluate(input('Bash', { command: 'git commit -m x' }, 'obligation'))).action).toBe('allow')
    })
  })

  describe('public action and filesystem semantics', () => {
    it('uses the integration action override inside the pipeline', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: override-me
    type: command
    match: "danger"
    action: deny
    message: "Dangerous command"
`)
      const first = await pipeline.evaluate({ ...input('Bash', { command: 'danger' }), action_override: 'warn' })
      expect(first.action).toBe('warn')
    })

    it('warns when fix is requested without a transform', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: no-fix
    type: command
    match: "danger"
    action: deny
    message: "Dangerous command"
`)
      const result = await pipeline.evaluate({ ...input('Bash', { command: 'danger' }), action_override: 'fix' })
      expect(result.action).toBe('warn')
      expect(result.message).toContain('no automatic fix available')
    })

    it('treats a negated path as the complement of its pattern', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: protect-outside-src
    type: filesystem
    paths: ["!/src/*"]
    operations: [delete]
    action: warn
    message: "Only delete source files"
`)
      const inside = await pipeline.evaluate({ ...input('Delete', { path: 'src/a.ts', operation: 'delete' }), cwd: '/tmp/project' })
      const outside = await pipeline.evaluate({ ...input('Delete', { path: 'config.json', operation: 'delete' }), cwd: '/tmp/project' })
      expect(inside.action).toBe('allow')
      expect(outside.action).toBe('warn')
    })

    it('consumes a one-time rule override before first-warning escalation', async () => {
      let available = true
      const rules = parseRulesContent(`version: 1
rules:
  - id: overridable
    type: command
    match: "danger"
    action: deny
    message: "Dangerous command"
`, '/tmp/override-rules.yaml')
      const pipeline = new EnforcementPipeline({
        level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(), ruleHierarchy: { global: null, user: null, project: rules, local: null },
        ruleVersion: 1,
        overrideStore: { consume: () => {
          const result = available
          available = false
          return result
        } },
      })
      expect((await pipeline.evaluate(input('Bash', { command: 'danger' }))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: 'danger' }))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'danger' }))).action).toBe('deny')
    })

    it('threads the caller session_id through to a real overrideStore — `keel allow --session` end to end', async () => {
      // Unlike the hand-rolled mocks above, this exercises the ACTUAL
      // FileRuleOverrideStore `keel allow --session` writes into, wired
      // through the pipeline exactly like `keel hook <host>` does, so a
      // regression in the session_id plumbing between EnforceInput and
      // the store shows up here even if overrides.test.ts's
      // store-in-isolation tests still pass.
      const home = mkdtempSync(join(tmpdir(), 'keel-pipeline-session-override-'))
      const directory = join(home, '.keel')
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'overrides.json'), JSON.stringify({
        'session-overridable': { expires_at: Date.now() + 60000, mode: 'session', session_id: 'ses_owner' },
      }))
      const rules = parseRulesContent(`version: 1
rules:
  - id: session-overridable
    type: command
    match: "danger"
    action: deny
    message: "Dangerous command"
`, '/tmp/session-override-rules.yaml')
      const pipeline = new EnforcementPipeline({
        level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(), ruleHierarchy: { global: null, user: null, project: rules, local: null },
        ruleVersion: 1,
        overrideStore: new FileRuleOverrideStore(home),
      })

      // A different session_id gets the normal warn-once-then-deny ladder —
      // the session override never applies to it.
      expect((await pipeline.evaluate(input('Bash', { command: 'danger' }, 'ses_stranger'))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: 'danger' }, 'ses_stranger'))).action).toBe('deny')

      // The owning session_id is allowed — repeatedly, not spent like
      // --once — because the override's mode is `session`, not `once`.
      expect((await pipeline.evaluate(input('Bash', { command: 'danger' }, 'ses_owner'))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'danger' }, 'ses_owner'))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'danger' }, 'ses_owner'))).action).toBe('allow')

      // And the stranger session is still denied afterwards — the owning
      // session's use never leaked a grant to it.
      expect((await pipeline.evaluate(input('Bash', { command: 'danger' }, 'ses_stranger'))).action).toBe('deny')

      rmSafe(home)
    })

    it('consumes an override before returning a cached deny', async () => {
      let available = false
      const rules = parseRulesContent(`version: 1
rules:
  - id: cached-overridable
    type: command
    match: "cached-danger"
    action: deny
    message: "Cached dangerous command"
`, '/tmp/cached-override-rules.yaml')
      const pipeline = new EnforcementPipeline({
        level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(), ruleHierarchy: { global: null, user: null, project: rules, local: null },
        ruleVersion: 1, overrideStore: { consume: () => available && (available = false, true) },
      })
      const call = () => pipeline.evaluate(input('Bash', { command: 'cached-danger' }, 'cached-override'))
      expect((await call()).action).toBe('warn')
      expect((await call()).action).toBe('deny')
      available = true
      expect((await call()).action).toBe('allow')
    })

    it('gates a prompt action on first and every attempt (no warn-once)', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: gate-history
    type: command
    match: "filter-branch"
    action: prompt
    message: "History mutation"
`)
      const first = await pipeline.evaluate(input('Bash', { command: 'git filter-branch' }))
      expect(first.action).toBe('prompt')
      expect(first.message).toContain('keel allow gate-history --once')
      const second = await pipeline.evaluate(input('Bash', { command: 'git filter-branch' }))
      expect(second.action).toBe('prompt')
    })

    it('consumes a one-time override for a prompt-gated action', async () => {
      let available = true
      const rules = parseRulesContent(`version: 1
rules:
  - id: gate-overridable
    type: command
    match: "filter-branch"
    action: prompt
    message: "History mutation"
`, '/tmp/override-prompt-rules.yaml')
      const pipeline = new EnforcementPipeline({
        level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(), ruleHierarchy: { global: null, user: null, project: rules, local: null },
        ruleVersion: 1,
        overrideStore: { consume: () => {
          const result = available
          available = false
          return result
        } },
      })
      expect((await pipeline.evaluate(input('Bash', { command: 'git filter-branch' }))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'git filter-branch' }))).action).toBe('prompt')
    })

    it('does not downgrade prompt to warn at sprint level', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: gate-sprint
    type: command
    match: "filter-branch"
    action: prompt
    level: sprint
    message: "History mutation"
`)
      const result = await pipeline.evaluate({ ...input('Bash', { command: 'git filter-branch' }), level: 'sprint' })
      expect(result.action).toBe('prompt')
    })

    it('honors action_override for prompt-gated actions', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: gate-override
    type: command
    match: "filter-branch"
    action: prompt
    message: "History mutation"
`)
      const result = await pipeline.evaluate({ ...input('Bash', { command: 'git filter-branch' }), action_override: 'warn' })
      expect(result.action).toBe('warn')
    })

    it('excludes temp paths from filesystem rules', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: guard-delete
    type: filesystem
    paths: ["*"]
    operations: [delete]
    exclude: ["/tmp/*"]
    action: warn
    message: "No deletions"
`)
      const temp = await pipeline.evaluate(input('Delete', { path: '/tmp/hooks-test', operation: 'delete' }))
      expect(temp.action).toBe('allow')
      const live = await pipeline.evaluate(input('Delete', { path: '/home/user/data', operation: 'delete' }))
      expect(live.action).toBe('warn')
    })

    it('matches multi-segment globs with **', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: log-guard
    type: filesystem
    paths: ["**/*.log"]
    operations: [delete]
    action: warn
    message: "Do not delete logs"
`)
      const nested = await pipeline.evaluate(input('Delete', { path: 'src/deep/x.log', operation: 'delete' }))
      expect(nested.action).toBe('warn')
      const source = await pipeline.evaluate(input('Delete', { path: 'src/x.ts', operation: 'delete' }))
      expect(source.action).toBe('allow')
    })

    it('reloads changed rules and keeps the last known good for invalid replacements', async () => {
      const sourcePath = tmpFile('live-reload.yaml')
      writeFileSync(sourcePath, `version: 1
rules:
  - id: live-rule
    type: command
    match: "before-reload"
    action: deny
    message: "Before reload"
`)
      const reportedErrors: string[][] = []
      const pipeline = new EnforcementPipeline({
        level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(), ruleHierarchy: { global: null, user: null, project: parseRulesFile(sourcePath), local: null },
        ruleVersion: 1,
        reloadRules: () => ({ global: null, user: null, project: parseRulesFile(sourcePath), local: null }),
        onRulesError: (errors) => { reportedErrors.push(errors) },
      })
      expect((await pipeline.evaluate(input('Bash', { command: 'before-reload' }, 'reload'))).action).toBe('warn')
      writeFileSync(sourcePath, `version: 1
rules:
  - id: live-rule
    type: command
    match: "after-reload"
    action: deny
    message: "After reload"
`)
      expect((await pipeline.evaluate(input('Bash', { command: 'before-reload' }, 'reload'))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'after-reload' }, 'reload'))).action).toBe('warn')
      writeFileSync(sourcePath, 'version: 1\nrules: [broken\n')
      // Last known good: an invalid reload keeps the previous rules enforced
      // instead of throwing on every call, and surfaces the error. The retry
      // is attempted on each call (the hash never advances past the bad file).
      // Escalation state also persists: a typo must never soften enforcement,
      // so the second hit of a deny rule after the failed reload still denies.
      expect((await pipeline.evaluate(input('Bash', { command: 'after-reload' }, 'reload'))).action).toBe('deny')
      expect((await pipeline.evaluate(input('Bash', { command: 'before-reload' }, 'reload'))).action).toBe('allow')
      expect(reportedErrors.length).toBeGreaterThan(0)
      rmSync(sourcePath, { force: true })
    })
  })

  describe('Kill switch', () => {
    const sentinelDir = mkdtempSync(join(tmpdir(), 'keel-killswitch-'))
    const sentinelPath = join(sentinelDir, 'DISABLED')
    const killSwitchPipeline = (): EnforcementPipeline =>
      new EnforcementPipeline({
        level: 'balanced',
        context: 'local' as RuleContext,
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(),
        sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: null, user: null, project: makeSampleRules(), local: null },
        ruleVersion: 1,
        allowedFixTransforms: true,
        disableFile: sentinelPath,
        haltFile: SHARED_HALT_FILE,
      })

    afterAll(() => {
      rmSafe(sentinelDir)
    })

    it('enforces rules normally when no sentinel file exists', async () => {
      if (existsSync(sentinelPath)) rmSync(sentinelPath)
      const pipeline = killSwitchPipeline()
      // First call warns (never-deny-first-time)
      const first = await pipeline.evaluate({
        tool: 'Bash',
        args: { command: 'git push --force' },
        cwd: '/tmp',
        session_id: 'test',
        turn_number: 1,
        context_tokens: 0,
        level: 'balanced' as const,
        context: 'local' as const,
        agent: 'test',
        subagent_of: null,
      })
      expect(first.action).toBe('warn')
      // Second call denies
      const second = await pipeline.evaluate({
        tool: 'Bash',
        args: { command: 'git push --force' },
        cwd: '/tmp',
        session_id: 'test',
        turn_number: 2,
        context_tokens: 0,
        level: 'balanced' as const,
        context: 'local' as const,
        agent: 'test',
        subagent_of: null,
      })
      expect(second.action).toBe('deny')
      expect(second.rule_id).toBe('never-force-push')
    })

    it('allows all actions when sentinel file exists', async () => {
      writeFileSync(sentinelPath, JSON.stringify({
        disabled_at: new Date().toISOString(),
        expires_at: null,
        reason: 'Test disable',
      }))
      const pipeline = killSwitchPipeline()
      // Even a clear violation should be allowed
      const result = await pipeline.evaluate({
        tool: 'Bash',
        args: { command: 'git push --force' },
        cwd: '/tmp',
        session_id: 'test',
        turn_number: 1,
        context_tokens: 0,
        level: 'balanced' as const,
        context: 'local' as const,
        agent: 'test',
        subagent_of: null,
      })
      expect(result.action).toBe('allow')
      expect(result.message).toContain('kill switch')
      rmSync(sentinelPath)
    })

    it('keeps a restart-only disable sentinel until an integration consumes it', async () => {
      writeFileSync(sentinelPath, JSON.stringify({
        disabled_at: new Date().toISOString(),
        expires_at: null,
        auto_enable_on_restart: true,
      }))
      const pipeline = killSwitchPipeline()
      const result = await pipeline.evaluate({
        tool: 'Bash',
        args: { command: 'git push --force' },
        cwd: '/tmp',
        session_id: 'restart-test',
        turn_number: 1,
        context_tokens: 0,
        level: 'balanced' as const,
        context: 'local' as const,
        agent: 'test',
        subagent_of: null,
      })
      expect(result.action).toBe('allow')
      expect(existsSync(sentinelPath)).toBe(true)
      rmSync(sentinelPath)
    })

    it('fails closed when the kill-switch state is corrupt', async () => {
      writeFileSync(sentinelPath, '{not-json')
      await expect(killSwitchPipeline().evaluate(input('Bash', { command: 'echo safe' }))).rejects.toThrow('Invalid Keel kill-switch state')
      rmSync(sentinelPath)
    })
  })

  describe('Halt (`keel halt` — the inverse of the kill switch)', () => {
    const haltDir = mkdtempSync(join(tmpdir(), 'keel-halt-'))
    const haltPath = join(haltDir, 'HALTED')
    const haltPipeline = (extra: Partial<PipelineConfig> = {}): EnforcementPipeline =>
      new EnforcementPipeline({
        level: 'balanced',
        context: 'local' as RuleContext,
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(),
        sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: null, user: null, project: makeSampleRules(), local: null },
        ruleVersion: 1,
        allowedFixTransforms: true,
        haltFile: haltPath,
        ...extra,
      })

    afterEach(() => {
      if (existsSync(haltPath)) rmSync(haltPath)
    })

    afterAll(() => {
      rmSafe(haltDir)
    })

    it('denies every call while halted, including a call with no matching rule at all', async () => {
      writeFileSync(haltPath, JSON.stringify({ halted_at: new Date().toISOString(), reason: 'testing halt', auto_clear_on_restart: false }))
      const pipeline = haltPipeline()
      const result = await pipeline.evaluate(input('Bash', { command: 'echo perfectly-harmless' }))
      expect(result.action).toBe('deny')
      expect(result.rule_id).toBe('keel-halted')
      expect(result.message).toContain('HALTED')
      expect(result.message).toContain('testing halt')
      expect(result.message).toContain('keel resume')
    })

    it('has no expires_at / TTL — the sentinel never auto-clears itself no matter how old halted_at is', async () => {
      writeFileSync(haltPath, JSON.stringify({ halted_at: new Date(0).toISOString(), reason: 'ancient halt', auto_clear_on_restart: false }))
      const pipeline = haltPipeline()
      const result = await pipeline.evaluate(input('Bash', { command: 'echo still-halted' }))
      expect(result.action).toBe('deny')
      expect(existsSync(haltPath)).toBe(true)
    })

    it('fails closed (stays halted, DENY) when the halt sentinel is corrupt — unlike DISABLED, this does not throw', async () => {
      writeFileSync(haltPath, '{not-json')
      const pipeline = haltPipeline()
      const result = await pipeline.evaluate(input('Bash', { command: 'echo corrupt-halt' }))
      expect(result.action).toBe('deny')
      expect(result.rule_id).toBe('keel-halted')
    })

    it('resumes normal enforcement once the sentinel is removed', async () => {
      writeFileSync(haltPath, JSON.stringify({ halted_at: new Date().toISOString(), reason: 'temp', auto_clear_on_restart: false }))
      const pipeline = haltPipeline()
      expect((await pipeline.evaluate(input('Bash', { command: 'echo x' }))).action).toBe('deny')
      rmSync(haltPath)
      // A fresh pipeline instance, same as a real `keel resume` followed by
      // the next call — evaluate() re-checks the sentinel every call, so an
      // existing instance would also see this, but a fresh one rules out
      // any hidden per-instance caching of the halted state.
      const resumed = haltPipeline()
      expect((await resumed.evaluate(input('Bash', { command: 'echo x' }))).action).toBe('allow')
    })

    it('wins over the DISABLED kill switch when both sentinels are present', async () => {
      const disableDir = mkdtempSync(join(tmpdir(), 'keel-halt-disable-'))
      const disablePath = join(disableDir, 'DISABLED')
      writeFileSync(disablePath, JSON.stringify({ disabled_at: new Date().toISOString(), expires_at: null, reason: 'agent tried to disable its way out' }))
      writeFileSync(haltPath, JSON.stringify({ halted_at: new Date().toISOString(), reason: 'halted after the disable', auto_clear_on_restart: false }))
      const pipeline = haltPipeline({ disableFile: disablePath })
      // Without the halt, this DISABLED sentinel alone would return 'allow'
      // (see the 'allows all actions when sentinel file exists' case
      // above) — the halt must override that, not merely coexist with it.
      const result = await pipeline.evaluate(input('Bash', { command: 'git push --force' }))
      expect(result.action).toBe('deny')
      expect(result.rule_id).toBe('keel-halted')
      rmSafe(disableDir)
    })

    it('also blocks the Stop-hook claim-to-evidence path (evaluateClaim), not just tool-call evaluation', async () => {
      writeFileSync(haltPath, JSON.stringify({ halted_at: new Date().toISOString(), reason: 'claim-path halt', auto_clear_on_restart: false }))
      const pipeline = haltPipeline()
      const claimInput = { ...input('assistant-message', {}), reasoning: 'Done! All tests pass.' }
      const result = await pipeline.evaluateClaim(claimInput)
      expect(result.action).toBe('deny')
      expect(result.rule_id).toBe('keel-halted')
    })
  })

  describe('Session composite trip (`type: session`)', () => {
    // Small thresholds so these tests run fast and don't need thousands of
    // evaluate() calls — the SHIPPED default (session-runaway-trip,
    // install.ts) uses much larger real-world numbers; the escalation
    // LOGIC being tested here is identical regardless of the threshold
    // values.
    // Deliberately no top-level `level:` in this frontmatter (unlike
    // makeSampleRules() above) — a hierarchy-level `level:` WINS over
    // per-call `input.level` (effectiveHierarchyLevel / resolvedLevel,
    // rule-parser.ts), which would make the sprint-dial test below
    // silently ineffective since PipelineConfig.level (set via
    // sessionPipeline({ level: 'sprint' })) is NOT the dial
    // effectiveLevel() reads — input.level (falling back through the
    // hierarchy) is.
    const sessionRules = (extraSteps = '') => parseRulesContent(`---
keel:
  version: 1
  rules:
    - id: test-session-trip
      type: session
      action: warn
      session_escalation:
        - { dimension: consecutive_failures, at: 2, action: warn }
        - { dimension: consecutive_failures, at: 3, action: prompt }
        - { dimension: consecutive_failures, at: 4, action: deny, halt: true }
        - { dimension: tool_calls, at: 5, action: warn }
        - { dimension: tool_calls, at: 8, action: prompt }
        ${extraSteps}
      message: "test session trip"
---
`, '/tmp/test-session-rules.md')

    // A SECOND, minimal rule builder carrying ONLY the caller's own steps —
    // no base tool_calls/consecutive_failures ladder. Needed for tests that
    // isolate a single dimension (file_write_churn, duration_minutes):
    // sessionRules()'s built-in `tool_calls` steps (at:5 warn, at:8 prompt)
    // would otherwise ALSO trip once a test makes more than 5-8 evaluate()
    // calls (e.g. probing 10 Grep calls), producing a `prompt` outer action
    // that has nothing to do with the dimension actually under test.
    const isolatedSessionRule = (steps: string) => parseRulesContent(`---
keel:
  version: 1
  rules:
    - id: test-session-trip-isolated
      type: session
      action: warn
      session_escalation:
        ${steps}
      message: "test session trip (isolated dimension)"
---
`, '/tmp/test-session-rules-isolated.md')

    const haltDir = mkdtempSync(join(tmpdir(), 'keel-session-halt-'))
    const sessionPipeline = (extra: Partial<PipelineConfig> = {}, extraSteps = ''): { pipeline: EnforcementPipeline; haltPath: string } => {
      const haltPath = join(haltDir, `HALTED-${Math.random().toString(36).slice(2)}`)
      const pipeline = new EnforcementPipeline({
        level: 'balanced',
        context: 'local' as RuleContext,
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(),
        sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: null, user: null, project: sessionRules(extraSteps), local: null },
        ruleVersion: 1,
        allowedFixTransforms: true,
        haltFile: haltPath,
        sessionTracker: new SessionTracker(),
        ...extra,
      })
      return { pipeline, haltPath }
    }

    // Pairs with isolatedSessionRule() above — a pipeline carrying ONLY the
    // caller's own escalation steps, no base tool_calls/consecutive_failures
    // ladder to interfere with a single-dimension probe.
    const isolatedPipeline = (steps: string, extra: Partial<PipelineConfig> = {}): { pipeline: EnforcementPipeline; haltPath: string } => {
      const haltPath = join(haltDir, `HALTED-isolated-${Math.random().toString(36).slice(2)}`)
      const pipeline = new EnforcementPipeline({
        level: 'balanced',
        context: 'local' as RuleContext,
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(),
        sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: null, user: null, project: isolatedSessionRule(steps), local: null },
        ruleVersion: 1,
        allowedFixTransforms: true,
        haltFile: haltPath,
        sessionTracker: new SessionTracker(),
        ...extra,
      })
      return { pipeline, haltPath }
    }

    afterAll(() => {
      rmSafe(haltDir)
    })

    it('escalates consecutive_failures through warn -> prompt -> deny+halt, and writes the halt sentinel only at the terminal step', async () => {
      const { pipeline, haltPath } = sessionPipeline()
      const session = `sess-${Math.random().toString(36).slice(2)}`
      const call = (n: number) => input('Bash', { command: `cmd-${n}` }, session)

      // recordAttemptOutcome is the AFTER-hook: by the time evaluate() runs
      // for call N, it can only see the outcomes of calls 1..N-1 — so the
      // escalation for a given failure count is only observable on the
      // NEXT call, exactly like `no-repeat-loops`'s own stuck-tracker.

      const r1 = await pipeline.evaluate(call(1)) // 0 prior failures
      expect(r1.action).toBe('allow')
      pipeline.recordAttemptOutcome(call(1), 1) // failures -> 1

      const r2 = await pipeline.evaluate(call(2)) // 1 prior failure — below warn-at-2
      expect(r2.action).toBe('allow')
      pipeline.recordAttemptOutcome(call(2), 1) // failures -> 2

      const r3 = await pipeline.evaluate(call(3)) // 2 prior failures — warn
      expect(r3.action).toBe('warn')
      pipeline.recordAttemptOutcome(call(3), 1) // failures -> 3
      expect(existsSync(haltPath)).toBe(false)

      const r4 = await pipeline.evaluate(call(4)) // 3 prior failures — prompt
      expect(r4.action).toBe('prompt')
      pipeline.recordAttemptOutcome(call(4), 1) // failures -> 4
      expect(existsSync(haltPath)).toBe(false)

      const r5 = await pipeline.evaluate(call(5)) // 4 prior failures — deny + halt
      expect(r5.action).toBe('deny')
      expect(r5.rule_id).toBe('test-session-trip')
      expect(existsSync(haltPath)).toBe(true)
      const sentinel = JSON.parse(readFileSync(haltPath, 'utf-8'))
      expect(sentinel.auto_clear_on_restart).toBe(false)
      expect(typeof sentinel.halted_at).toBe('string')
    })

    it('a success resets consecutive_failures — the streak never reaches the halt step', async () => {
      const { pipeline, haltPath } = sessionPipeline()
      const session = `sess-${Math.random().toString(36).slice(2)}`
      for (let i = 0; i < 10; i++) {
        const call = input('Bash', { command: `cmd-${i}` }, session)
        await pipeline.evaluate(call)
        // Alternate fail/succeed — never two consecutive failures, let
        // alone four.
        pipeline.recordAttemptOutcome(call, i % 2 === 0 ? 1 : 0)
      }
      const result = await pipeline.evaluate(input('Bash', { command: 'final' }, session))
      expect(result.action).not.toBe('deny')
      expect(existsSync(haltPath)).toBe(false)
    })

    it('SAFETY: a long successful session never reaches deny/halt through volume dimensions alone — they cap at prompt', async () => {
      const { pipeline, haltPath } = sessionPipeline()
      const session = `sess-${Math.random().toString(36).slice(2)}`
      let last
      for (let i = 0; i < 20; i++) {
        const call = input('Read', { path: `/tmp/file-${i}.txt` }, session)
        last = await pipeline.evaluate(call)
        pipeline.recordAttemptOutcome(call, 0) // every attempt succeeds
      }
      // tool_calls threshold (8) is well past by call 20 — must have
      // escalated to `prompt` (its ceiling), never `deny`.
      expect(last!.action).toBe('prompt')
      expect(existsSync(haltPath)).toBe(false)
    })

    it('exitCode === null neither increments nor resets consecutive_failures', async () => {
      const { pipeline, haltPath } = sessionPipeline()
      const session = `sess-${Math.random().toString(36).slice(2)}`
      const call = (n: number) => input('Bash', { command: `cmd-${n}` }, session)
      await pipeline.evaluate(call(1))
      pipeline.recordAttemptOutcome(call(1), 1)
      await pipeline.evaluate(call(2))
      pipeline.recordAttemptOutcome(call(2), null) // no exit code reported
      await pipeline.evaluate(call(3))
      pipeline.recordAttemptOutcome(call(3), null)
      // Still only 1 real failure recorded (call 1) — below the warn-at-2
      // threshold, since the two null outcomes were no-ops.
      const result = await pipeline.evaluate(call(4))
      expect(result.action).toBe('allow')
      expect(existsSync(haltPath)).toBe(false)
    })

    it('the sprint dial downgrading deny to warn must NOT write the halt sentinel', async () => {
      // sprint-dial downgrade (dialAction, rule-parser.ts) only softens
      // deny/block when the rule carries no `level: protect` floor — the
      // test rule here has none, so `level: sprint` softens its terminal
      // step to warn. The dial itself is read from EnforceInput.level
      // (effectiveLevel() / effectiveHierarchyLevel(), NOT
      // PipelineConfig.level) since sessionRules()'s hierarchy carries no
      // top-level `level:` of its own — see sessionRules()'s own comment.
      const { pipeline, haltPath } = sessionPipeline()
      const session = `sess-${Math.random().toString(36).slice(2)}`
      const call = (n: number) => ({ ...input('Bash', { command: `cmd-${n}` }, session), level: 'sprint' as const })
      for (let i = 1; i <= 4; i++) {
        await pipeline.evaluate(call(i))
        pipeline.recordAttemptOutcome(call(i), 1)
      }
      const result = await pipeline.evaluate(call(5))
      expect(result.action).toBe('warn')
      expect(existsSync(haltPath)).toBe(false)
    })

    it('a consumed override on the terminal step must NOT write the halt sentinel', async () => {
      const { pipeline, haltPath } = sessionPipeline({ overrideStore: { consume: () => true, peek: () => null, list: () => ({}) } })
      const session = `sess-${Math.random().toString(36).slice(2)}`
      const call = (n: number) => input('Bash', { command: `cmd-${n}` }, session)
      for (let i = 1; i <= 4; i++) {
        await pipeline.evaluate(call(i))
        pipeline.recordAttemptOutcome(call(i), 1)
      }
      const result = await pipeline.evaluate(call(5))
      expect(result.action).toBe('allow')
      expect(existsSync(haltPath)).toBe(false)
    })

    it('mode: observe never writes the halt sentinel, even past the terminal threshold', async () => {
      const observeRules = parseRulesContent(`---
keel:
  version: 1
  level: balanced
  rules:
    - id: test-session-trip-observe
      type: session
      mode: observe
      action: warn
      session_escalation:
        - { dimension: consecutive_failures, at: 2, action: deny, halt: true }
      message: "test session trip (observe)"
---
`, '/tmp/test-session-rules-observe.md')
      const haltPath = join(haltDir, `HALTED-observe-${Math.random().toString(36).slice(2)}`)
      const pipeline = new EnforcementPipeline({
        level: 'balanced',
        context: 'local' as RuleContext,
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(),
        sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: null, user: null, project: observeRules, local: null },
        ruleVersion: 1,
        allowedFixTransforms: true,
        haltFile: haltPath,
        sessionTracker: new SessionTracker(),
      })
      const session = `sess-${Math.random().toString(36).slice(2)}`
      const call = (n: number) => input('Bash', { command: `cmd-${n}` }, session)
      for (let i = 1; i <= 3; i++) {
        await pipeline.evaluate(call(i))
        pipeline.recordAttemptOutcome(call(i), 1)
      }
      const result = await pipeline.evaluate(call(4))
      expect(result.action).toBe('allow')
      expect(result.observed_action).toBe('deny')
      expect(existsSync(haltPath)).toBe(false)
    })

    it('a call with no session_id is a no-op for the tracker — never throws, never escalates', async () => {
      const { pipeline, haltPath } = sessionPipeline()
      const noSession = { ...input('Bash', { command: 'anything' }), session_id: '' }
      for (let i = 0; i < 6; i++) {
        const result = await pipeline.evaluate(noSession)
        expect(result.action).not.toBe('deny')
      }
      expect(existsSync(haltPath)).toBe(false)
    })

    it('file_write_churn counts DISTINCT write-tool targets, and does NOT count read-only search tools (Grep/Glob/LS) even though they take a path argument', async () => {
      const { pipeline, haltPath } = isolatedPipeline('- { dimension: file_write_churn, at: 3, action: warn }')
      const session = `sess-${Math.random().toString(36).slice(2)}`

      // Grep/Glob/LS all take a `path` argPath() can resolve, and none are
      // "read"-prefixed — the exact false-positive class this dimension's
      // WRITE_TOOL_NAMES gate (verification.ts) exists to avoid. 10 calls,
      // 10 distinct paths, well past the at:3 threshold if these counted.
      for (let i = 0; i < 10; i++) {
        await pipeline.evaluate(input('Grep', { path: `/tmp/dir-${i}` }, session))
      }
      const afterSearch = await pipeline.evaluate(input('Glob', { path: '/tmp/dir-final' }, session))
      expect(afterSearch.action).toBe('allow')

      // Now 3 DISTINCT real writes — should trip the threshold.
      await pipeline.evaluate(input('Write', { path: '/tmp/f1.txt', content: 'x' }, session))
      await pipeline.evaluate(input('Write', { path: '/tmp/f2.txt', content: 'x' }, session))
      const afterWrites = await pipeline.evaluate(input('Write', { path: '/tmp/f3.txt', content: 'x' }, session))
      expect(afterWrites.action).toBe('warn')
      expect(existsSync(haltPath)).toBe(false)
    })

    it('file_write_churn does NOT double-count the SAME path written twice', async () => {
      const { pipeline } = isolatedPipeline('- { dimension: file_write_churn, at: 3, action: warn }')
      const session = `sess-${Math.random().toString(36).slice(2)}`
      await pipeline.evaluate(input('Write', { path: '/tmp/same.txt', content: 'x' }, session))
      await pipeline.evaluate(input('Write', { path: '/tmp/same.txt', content: 'y' }, session))
      const result = await pipeline.evaluate(input('Write', { path: '/tmp/same.txt', content: 'z' }, session))
      // 3 calls, 1 distinct path — must stay well under the at:3 threshold.
      expect(result.action).toBe('allow')
    })

    it('duration_minutes is computed LIVE from first-seen — advances across calls even with no intervening activity', async () => {
      const { pipeline, haltPath } = isolatedPipeline('- { dimension: duration_minutes, at: 240, action: warn }\n        - { dimension: duration_minutes, at: 480, action: prompt }')
      const session = `sess-${Math.random().toString(36).slice(2)}`
      const now = new Date()
      vi.useFakeTimers()
      try {
        vi.setSystemTime(now)
        const first = await pipeline.evaluate(input('Bash', { command: 'start' }, session))
        expect(first.action).toBe('allow')

        // +5h, no calls in between — this is what an idle-overnight session
        // looks like: sessionStart never moves, only wall-clock time does.
        vi.setSystemTime(new Date(now.getTime() + 5 * 60 * 60 * 1000))
        const after5h = await pipeline.evaluate(input('Bash', { command: 'resume' }, session))
        expect(after5h.action).toBe('warn')
        expect(existsSync(haltPath)).toBe(false)

        // +9h total — crosses the prompt tier too, still never halt (a
        // duration-only dimension is structurally barred from reaching it).
        vi.setSystemTime(new Date(now.getTime() + 9 * 60 * 60 * 1000))
        const after9h = await pipeline.evaluate(input('Bash', { command: 'resume-again' }, session))
        expect(after9h.action).toBe('prompt')
        expect(existsSync(haltPath)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    describe('with a real PersistentSessionStore (cross-process)', () => {
      // The tests above all use sessionPipeline()'s default in-memory-only
      // SessionTracker (no store passed to its constructor) — fine for
      // exercising the ESCALATION LOGIC, but it is NOT what `keel hook
      // <host>` actually uses in production (cli/enforce.ts wires
      // PersistentSessionStore precisely because that host is a fresh
      // process per tool call). The increment/reset logic is implemented
      // TWICE — once in session-store.ts's bumpActivity/bumpFailure, once
      // more in session-tracker.ts's in-memory fallback paths — so
      // exercising only the fallback leaves the copy real users depend on
      // completely unverified. These tests close that gap.
      let storeDir = ''
      afterEach(() => {
        if (storeDir) { rmSafe(storeDir); storeDir = '' }
      })

      it('the full ladder (warn -> prompt -> deny+halt), reset-on-success, and exitCode===null all behave identically through a real disk-backed store', async () => {
        storeDir = mkdtempSync(join(tmpdir(), 'keel-session-store-'))
        const haltPath = join(haltDir, `HALTED-store-${Math.random().toString(36).slice(2)}`)
        const pipeline = new EnforcementPipeline({
          level: 'balanced',
          context: 'local' as RuleContext,
          cache: new ActionCache({ maxSize: 100 }),
          contentTracker: new ContentTracker(),
          sequenceDetector: new SequenceDetector(),
          flowTracker: new FlowTracker(),
          ruleHierarchy: { global: null, user: null, project: sessionRules(), local: null },
          ruleVersion: 1,
          allowedFixTransforms: true,
          haltFile: haltPath,
          sessionTracker: new SessionTracker(new PersistentSessionStore(storeDir)),
        })
        const session = `sess-${Math.random().toString(36).slice(2)}`
        const call = (n: number) => input('Bash', { command: `cmd-${n}` }, session)

        expect((await pipeline.evaluate(call(1))).action).toBe('allow')
        pipeline.recordAttemptOutcome(call(1), 1)
        expect((await pipeline.evaluate(call(2))).action).toBe('allow')
        pipeline.recordAttemptOutcome(call(2), 0) // reset-on-success, through the store
        expect((await pipeline.evaluate(call(3))).action).toBe('allow') // reset held
        pipeline.recordAttemptOutcome(call(3), 1)
        pipeline.recordAttemptOutcome(call(3), null) // no-op, through the store
        expect((await pipeline.evaluate(call(4))).action).toBe('allow') // still only 1 real failure
        pipeline.recordAttemptOutcome(call(4), 1) // 2
        expect((await pipeline.evaluate(call(5))).action).toBe('warn') // 2 -> warn
        pipeline.recordAttemptOutcome(call(5), 1) // 3
        expect((await pipeline.evaluate(call(6))).action).toBe('prompt') // 3 -> prompt
        pipeline.recordAttemptOutcome(call(6), 1) // 4
        const final = await pipeline.evaluate(call(7)) // 4 -> deny + halt
        expect(final.action).toBe('deny')
        expect(existsSync(haltPath)).toBe(true)
      })

      it('a second SessionTracker instance sharing the same store dir sees the FIRST instance\'s accumulated failures — the fresh-process-per-call gap this store exists to close', async () => {
        storeDir = mkdtempSync(join(tmpdir(), 'keel-session-store-'))
        const buildPipeline = () => new EnforcementPipeline({
          level: 'balanced',
          context: 'local' as RuleContext,
          cache: new ActionCache({ maxSize: 100 }),
          contentTracker: new ContentTracker(),
          sequenceDetector: new SequenceDetector(),
          flowTracker: new FlowTracker(),
          ruleHierarchy: { global: null, user: null, project: sessionRules(), local: null },
          ruleVersion: 1,
          allowedFixTransforms: true,
          haltFile: join(haltDir, `HALTED-store2-${Math.random().toString(36).slice(2)}`),
          // A FRESH SessionTracker + FRESH PersistentSessionStore each time,
          // mirroring `keel hook <host>` constructing a brand-new
          // in-memory tracker every process — only the on-disk file is
          // shared.
          sessionTracker: new SessionTracker(new PersistentSessionStore(storeDir)),
        })
        const session = `sess-${Math.random().toString(36).slice(2)}`
        const call = (n: number) => input('Bash', { command: `cmd-${n}` }, session)

        // "Process A": 3 failing attempts.
        const pipelineA = buildPipeline()
        for (let i = 1; i <= 3; i++) {
          await pipelineA.evaluate(call(i))
          pipelineA.recordAttemptOutcome(call(i), 1)
        }

        // "Process B": a BRAND NEW pipeline/tracker instance, same session_id,
        // same store dir. Its in-memory map is empty — it must still see
        // the 3 accumulated failures on its very first evaluate() call.
        const pipelineB = buildPipeline()
        const result = await pipelineB.evaluate(call(4))
        expect(result.action).toBe('prompt') // 3 prior failures -> prompt tier
      })
    })
  })

  describe('Rate limiting', () => {
    it('allows first N calls within window', async () => {
      const pipeline = makePipeline('protect')
      // Add a rate limit rule dynamically — the pipeline needs to track calls
      const result = await pipeline.evaluate({
        tool: 'npm install',
        args: {},
        cwd: '/tmp',
        session_id: 'test-rate',
        turn_number: 1,
        context_tokens: 0,
        level: 'balanced' as const,
        context: 'local' as const,
        agent: 'test',
        subagent_of: null,
      })
      // Should not be denied by rate limit
      expect(result.action).toBe('allow')
    })

    it('warns before denying when a rate limit is exceeded', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: rate-test
    type: rate
    match: "rate-token"
    window_seconds: 300
    max_calls: 1
    action: deny
    message: "Too many calls"
`)
      expect((await pipeline.evaluate(input('Bash', { command: 'rate-token' }, 'rate'))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'rate-token' }, 'rate'))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: 'rate-token' }, 'rate'))).action).toBe('deny')
    })

    it('shares rate-limit and first-warning state between pipeline instances', async () => {
      const state = sharedStateManager()
      const yaml = `version: 1
rules:
  - id: cross-process-rate
    type: rate
    match: "rate-token"
    window_seconds: 300
    max_calls: 1
    action: deny
    message: "Too many calls"
`
      expect((await makePipelineFromYaml(yaml, state).evaluate(input('Bash', { command: 'rate-token' }, 'cross-rate'))).action).toBe('allow')
      expect((await makePipelineFromYaml(yaml, state).evaluate(input('Bash', { command: 'rate-token' }, 'cross-rate'))).action).toBe('warn')
      expect((await makePipelineFromYaml(yaml, state).evaluate(input('Bash', { command: 'rate-token' }, 'cross-rate'))).action).toBe('deny')
    })

    it('persists circuit-breaker mutations through the state API', async () => {
      const state = sharedStateManager()
      const yaml = `version: 1
rules:
  - id: cross-process-circuit
    type: command
    match: "danger"
    action: deny
    message: "Dangerous command"
`
      const call = (turn: number) => makePipelineFromYaml(yaml, state).evaluate(input('Bash', { command: `danger-${turn}` }, 'cross-circuit'))
      expect((await call(1)).action).toBe('warn')
      expect((await call(2)).action).toBe('deny')
      expect((await call(3)).action).toBe('deny')
      expect((await call(4)).message).toContain('times')
    })
  })

  describe('Time and information flow', () => {
    it('warns before denying outside a configured schedule', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: time-test
    type: time
    schedule:
      start: "00:00"
      end: "23:59"
      days: [Neverday]
    action: deny
    message: "Outside schedule"
`)
      expect((await pipeline.evaluate(input('Bash', { command: 'echo hi' }, 'time'))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: 'echo hi' }, 'time'))).action).toBe('deny')
    })

    it('fires the before-start and after-end schedule branches', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: time-window
    type: time
    schedule:
      start: "10:00"
      end: "14:00"
    action: deny
    message: "Window"
`)
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-01-05T08:00:00'))
        // First violation of the deny rule warns (generic message); the
        // schedule-specific text is surfaced on the blocking call.
        expect((await pipeline.evaluate(input('Bash', { command: 'echo hi' }, 'time-window'))).action).toBe('warn')
        vi.setSystemTime(new Date('2026-01-05T16:00:00'))
        const after = await pipeline.evaluate(input('Bash', { command: 'echo hi' }, 'time-window'))
        expect(after.action).toBe('deny')
        expect(after.message).toContain('Outside schedule window')
        vi.setSystemTime(new Date('2026-01-05T11:00:00'))
        expect((await pipeline.evaluate(input('Bash', { command: 'echo hi' }, 'time-window'))).action).toBe('allow')
      } finally {
        vi.useRealTimers()
      }
    })

    it('fires only for matching commands when a match is present', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: publish-window
    type: time
    match: "npm publish"
    schedule:
      start: "09:00"
      end: "22:00"
    action: warn
    message: "After hours"
`)
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-01-05T23:00:00'))
        expect((await pipeline.evaluate(input('Bash', { command: 'npm publish' }, 'pw1'))).action).toBe('warn')
        expect((await pipeline.evaluate(input('Bash', { command: 'npm publish' }, 'pw1'))).action).toBe('warn')
        expect((await pipeline.evaluate(input('Bash', { command: 'echo hi' }, 'pw1'))).action).toBe('allow')
      } finally {
        vi.useRealTimers()
      }
    })

    it('treats a start > end schedule as an overnight allowed window', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: overnight-window
    type: time
    schedule:
      start: "22:00"
      end: "09:00"
    action: warn
    message: "Overnight only"
`)
      vi.useFakeTimers()
      try {
        // 23:00 and 08:00 are INSIDE the overnight window (no violation).
        vi.setSystemTime(new Date('2026-01-05T23:00:00'))
        expect((await pipeline.evaluate(input('Bash', { command: 'echo hi' }, 'ow1'))).action).toBe('allow')
        vi.setSystemTime(new Date('2026-01-05T08:00:00'))
        expect((await pipeline.evaluate(input('Bash', { command: 'echo hi' }, 'ow1'))).action).toBe('allow')
        // 15:00 is OUTSIDE it (violation).
        vi.setSystemTime(new Date('2026-01-05T15:00:00'))
        expect((await pipeline.evaluate(input('Bash', { command: 'echo hi' }, 'ow1'))).action).toBe('warn')
      } finally {
        vi.useRealTimers()
      }
    })

    it('rate rules warn after exceeding the window limit without blocking', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: bash-storm
    type: rate
    match: "Bash"
    window_seconds: 60
    max_calls: 3
    action: warn
    message: "Too many calls"
`)
      const r1 = await pipeline.evaluate(input('Bash', { command: 'echo 1' }, 'rate1'))
      const r2 = await pipeline.evaluate(input('Bash', { command: 'echo 2' }, 'rate1'))
      const r3 = await pipeline.evaluate(input('Bash', { command: 'echo 3' }, 'rate1'))
      const r4 = await pipeline.evaluate(input('Bash', { command: 'echo 4' }, 'rate1'))
      expect(r1.action).toBe('allow')
      expect(r2.action).toBe('allow')
      expect(r3.action).toBe('allow')
      expect(r4.action).toBe('warn')
      expect(r4.rule_id).toBe('bash-storm')
    })

    it('tracks a sensitive read before blocking a network sink', async () => {
      const sensitivePath = tmpFile('flow-test.env')
      writeFileSync(sensitivePath, 'TOKEN=secret\n')
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: flow-test
    type: flow
    sources: [".env"]
    sinks: [Bash]
    action: deny
    message: "Sensitive data cannot leave"
`)
      expect((await pipeline.evaluate(input('ReadFile', { filePath: sensitivePath }, 'flow'))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'send' }, 'flow'))).action).toBe('warn')
      expect((await pipeline.evaluate(input('Bash', { command: 'send' }, 'flow'))).action).toBe('deny')
      rmSync(sensitivePath, { force: true })
    })

    it('matches semantic network sinks without losing explicit tool sinks', async () => {
      const sensitivePath = tmpFile('flow-network.env')
      writeFileSync(sensitivePath, 'TOKEN=secret\n')
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: network-flow
    type: flow
    sources: [".env"]
    sinks: [network]
    action: deny
    message: "No network egress"
`)
      expect((await pipeline.evaluate(input('ReadFile', { filePath: sensitivePath }, 'network'))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'curl https://example.test' }, 'network'))).action).toBe('warn')
      rmSync(sensitivePath, { force: true })

      const explicit = makePipelineFromYaml(`version: 1
rules:
  - id: explicit-tool-flow
    type: flow
    sources: [".env"]
    sinks: [Bash]
    action: deny
    message: "No Bash egress"
`)
      expect((await explicit.evaluate(input('ReadFile', { filePath: '/tmp/does-not-exist.env' }, 'explicit'))).action).toBe('allow')
      expect((await explicit.evaluate(input('BashScript', { command: 'send' }, 'explicit'))).action).toBe('allow')
    })

    it('does not treat sink verbs as substrings of unrelated words', async () => {
      const sensitivePath = tmpFile('flow-boundary.env')
      writeFileSync(sensitivePath, 'TOKEN=secret\n')
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: boundary-flow
    type: flow
    sources: [".env"]
    sinks: [network]
    action: deny
    message: "No egress"
`)
      await pipeline.evaluate(input('ReadFile', { filePath: sensitivePath }, 'boundary'))
      // "sync-ok" and "finch" contain the substring "nc" but are not sinks.
      expect((await pipeline.evaluate(input('Bash', { command: 'sync-ok' }, 'boundary'))).action).toBe('allow')
      expect((await pipeline.evaluate(input('Bash', { command: 'echo finch' }, 'boundary'))).action).toBe('allow')
      // A real netcat token IS a sink.
      expect((await pipeline.evaluate(input('Bash', { command: 'nc -l 4444' }, 'boundary'))).action).toBe('warn')
      rmSync(sensitivePath, { force: true })
    })
  })

  describe('First-time warning', () => {
    it('warns on first violation, denies on second', async () => {
      const pipeline = makePipeline('balanced')
      const input = {
        tool: 'Bash',
        args: { command: 'git push --force origin main' },
        cwd: '/tmp',
        session_id: 'test-ft',
        turn_number: 1,
        context_tokens: 0,
        level: 'balanced' as const,
        context: 'local' as const,
        agent: 'test',
        subagent_of: null,
      }

      // First time — should warn
      const first = await pipeline.evaluate(input)
      expect(first.action).toBe('warn')
      expect(first.message).toContain('First violation')

      // Second time — should deny
      const second = await pipeline.evaluate(input)
      expect(second.action).toBe('deny')
    })

    it('does not carry a first-warning state across rule versions', async () => {
      const sourcePath = tmpFile('versioned-rules.md')
      const state = sharedStateManager()
      writeFileSync(sourcePath, 'version one')
      const yaml = `version: 1
rules:
  - id: versioned-rule
    type: command
    match: "versioned-danger"
    action: deny
    message: "Versioned rule"
`
      expect((await makePipelineFromYaml(yaml, state, sourcePath).evaluate(input('Bash', { command: 'versioned-danger' }, 'versioned'))).action).toBe('warn')

      writeFileSync(sourcePath, 'version two')
      expect((await makePipelineFromYaml(yaml, state, sourcePath).evaluate(input('Bash', { command: 'versioned-danger' }, 'versioned'))).action).toBe('warn')
      rmSync(sourcePath, { force: true })
    })
  })

  describe('Caching', () => {
    it('caches allow results and returns cache hit', async () => {
      const pipeline = makePipeline('sprint')
      const input = {
        tool: 'ReadFile',
        args: { path: '/tmp/test.txt' },
        cwd: '/tmp',
        session_id: 'test-cache',
        turn_number: 1,
        context_tokens: 0,
        level: 'sprint' as const,
        context: 'local' as const,
        agent: 'test',
        subagent_of: null,
      }

      // First call — miss
      const first = await pipeline.evaluate(input)
      expect(first.cache_hit).toBe(false)

      // Second call — should hit cache
      const second = await pipeline.evaluate(input)
      expect(second.cache_hit).toBe(true)
      expect(second.action).toBe('allow')
    })

    // The stateless verdict cache (`this.config.cache`, keyed by
    // tool/args/ruleVersion/cacheContext) is otherwise agent-BLIND: two
    // different hosts making the identical call would collide on the same
    // key without `agent` folded into cacheContext(). Deliberately built
    // from a MINIMAL, non-stateful, non-`prompt` ruleset — the shipped
    // catalog's verification/claim/research/stuck/oscillation/rate rules
    // (statefulRules/gatedRules, pipeline.ts's cache-eligibility gate)
    // would make the cache path never engage at all here, and this test
    // would pass vacuously without ever exercising the bug it guards
    // against.
    it('does not leak one host\'s cached verdict to a different host for an otherwise-identical call', async () => {
      // Deliberately NOT `level: protect` on the rule itself: a rule-level
      // floor is evaluated in `evaluateTiers()`'s floorTieredRules pass,
      // which runs BEFORE the Tier-1 cache lookup and therefore never
      // reads (though it does write) the cache — cache_hit would stay
      // false forever and this test couldn't observe the thing it's
      // checking. Instead the PIPELINE's dial is set to `protect`
      // (`level: 'protect'` below, config/dial-level, not rule-level) —
      // `evaluateTiers()`'s blockFirst check is `effectiveLevel(input) ===
      // 'protect' || rule.level === 'protect'`, so a plain rule with no
      // `level` field still blocks (never warns) on the first hit at this
      // dial, while staying in the normal cache-eligible tiered path.
      const rules = parseRulesContent(`version: 1
rules:
  - id: claude-only-block
    type: command
    match: "^dangerous-cmd$"
    action: block
    agents: [claude-code]
    message: "blocked for claude-code only"
`, '/tmp/agent-scope-cache-rules.md')
      const pipeline = new EnforcementPipeline({
        level: 'protect',
        context: 'local' as RuleContext,
        cache: new ActionCache({ maxSize: 100 }),
        contentTracker: new ContentTracker(),
        sequenceDetector: new SequenceDetector(),
        flowTracker: new FlowTracker(),
        ruleHierarchy: { global: null, user: null, project: rules, local: null },
        ruleVersion: 1,
        allowedFixTransforms: true,
        haltFile: SHARED_HALT_FILE,
      })

      const baseCall = (agent: string) => ({
        tool: 'Bash',
        args: { command: 'dangerous-cmd' },
        cwd: '/tmp',
        session_id: 'agent-scope-cache-test',
        turn_number: 1,
        context_tokens: 0,
        level: 'protect' as const,
        context: 'local' as const,
        agent,
        subagent_of: null,
      })

      // claude-code: the rule applies -> deny. First call is a cache miss.
      const claudeFirst = await pipeline.evaluate(baseCall('claude-code'))
      expect(claudeFirst.action).toBe('deny')  // block()'s result action is always 'deny', regardless of the rule's own declared action (deny vs block)
      expect(claudeFirst.cache_hit).toBe(false)

      // claude-code again, identical call -> cache HIT, still deny. Proves
      // the cache path is actually live for this ruleset — a control
      // assertion, not the thing under test.
      const claudeSecond = await pipeline.evaluate(baseCall('claude-code'))
      expect(claudeSecond.action).toBe('deny')
      expect(claudeSecond.cache_hit).toBe(true)

      // opencode: the rule does NOT apply -> allow. Same tool/args/cwd/
      // level/context/depth as the claude-code call above — if `agent`
      // were missing from the cache key, this would incorrectly return
      // the cached claude-code 'deny' verdict instead of evaluating fresh.
      const opencodeResult = await pipeline.evaluate(baseCall('opencode'))
      expect(opencodeResult.action).toBe('allow')
      expect(opencodeResult.cache_hit).toBe(false)
    })
  })

  describe('Auto-fix', () => {
    it('fixes commands with fix transforms', async () => {
      const pipeline = makePipeline('sprint')
      const result = await pipeline.evaluate({
        tool: 'Bash',
        args: { command: 'git commit -m "test"' },
        cwd: '/tmp',
        session_id: 'test-fix',
        turn_number: 1,
        context_tokens: 0,
        level: 'sprint' as const,
        context: 'local',
        agent: 'test',
        subagent_of: null,
      })
      expect(result.action).toBe('fix')
      expect(result.fix_result).toBeDefined()
      const fr = result.fix_result as Record<string, unknown>
      expect(fr.fixed).toContain('--signoff')
    })
  })

  describe('Circuit breaker', () => {
    it('escalates after repeated denials', async () => {
      const pipeline = makePipeline('balanced')
      // Use different args to avoid cache hits (cache key includes args)
      const call = (num: number) => pipeline.evaluate({
        tool: 'Bash',
        args: { command: `git push --force origin branch-${num}` },
        cwd: '/tmp',
        session_id: 'test-cb',
        turn_number: num,
        context_tokens: 0,
        level: 'balanced' as const,
        context: 'local' as const,
        agent: 'test',
        subagent_of: null,
      })

      // Call 1: warn (first-time protection)
      const first = await call(1)
      expect(first.action).toBe('warn')

      // Calls 2-4: deny, circuit breaker activates at count >= 3
      const second = await call(2)
      expect(second.action).toBe('deny')
      expect(second.cache_hit).toBe(false)  // fresh evaluation

      const third = await call(3)
      expect(third.action).toBe('deny')
      expect(third.cache_hit).toBe(false)

      const fourth = await call(4)
      expect(fourth.action).toBe('deny')
      expect(fourth.cache_hit).toBe(false)
      // Circuit breaker appends warning on 3rd+ deny
      expect(fourth.message).toContain('times')
    })
  })

  // ── Observe mode ───────────────────────────────────────────────────
  // Enforcement (`mode`) is a separate axis from the declared `action`, so
  // a new rule can burn in against real traffic before it ever interrupts.
  describe('observe mode', () => {
    const observeRules = (mode: string) => `version: 1
rules:
  - id: obs-danger
    type: command
    match: "rm -rf /"
    action: deny
    mode: ${mode}
    message: "Destructive delete."
`

    it('does not block, but records what it would have done', async () => {
      const pipeline = makePipelineFromYaml(observeRules('observe'))
      const result = await pipeline.evaluate(input('bash', { command: 'rm -rf /' }, 'obs-1'))

      expect(result.action).toBe('allow')          // nothing is interrupted
      expect(result.observed_action).toBe('deny')  // but the verdict is recorded
      expect(result.rule_id).toBe('obs-danger')    // and attributed to the rule
      expect(result.message).toContain('[observe]')
    })

    it('still blocks when the same rule is in block mode', async () => {
      const pipeline = makePipelineFromYaml(observeRules('block'))
      const first = await pipeline.evaluate(input('bash', { command: 'rm -rf /' }, 'obs-2'))
      // balanced dial warns once, then blocks — either way it is NOT a
      // silent allow, which is what distinguishes it from observe.
      expect(first.action).not.toBe('allow')
      expect(first.observed_action).toBeUndefined()
    })

    it('leaves non-matching calls alone in observe mode', async () => {
      // The must-NOT-fire case: observe must not turn every call into a
      // rule hit. An allow with no rule_id is a genuine no-match.
      const pipeline = makePipelineFromYaml(observeRules('observe'))
      const result = await pipeline.evaluate(input('bash', { command: 'ls -la' }, 'obs-3'))

      expect(result.action).toBe('allow')
      expect(result.observed_action).toBeUndefined()
      expect(result.rule_id).toBeFalsy()
    })

    it('never mutates arguments in observe mode', async () => {
      // A fix rule rewrites args. Observe must not, or "observation" would
      // silently change behavior — the thing it exists to avoid.
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: obs-fix
    type: command
    match: "grep"
    action: fix
    mode: observe
    fix: { replace: "grep", with: "rg" }
    message: "Prefer rg."
`)
      const args = { command: 'grep foo' }
      const result = await pipeline.evaluate(input('bash', args, 'obs-4'))

      expect(result.action).toBe('allow')
      expect(args.command).toBe('grep foo')   // unchanged
    })

    it('does not raise an approval gate for an observed prompt rule', () => {
      // effectiveAction() feeds three call sites; violation() and the fix
      // path are covered above, this is the third (the `prompt` filter).
      // An observe rule must never demand `keel allow` — that would be an
      // interruption, which is exactly what observe promises not to do.
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: obs-gate
    type: command
    match: "terraform destroy"
    action: prompt
    mode: observe
    message: "Teardown needs approval."
`)
      return pipeline.evaluate(input('bash', { command: 'terraform destroy' }, 'obs-5')).then(result => {
        expect(result.action).toBe('allow')
        expect(result.observed_action).toBe('prompt')
        expect(result.message).not.toContain('keel allow')
      })
    })

    // ── Observe-continue (Wave-3): a matched observe rule records and
    // evaluation CONTINUES instead of short-circuiting — the OPA Gatekeeper
    // dryrun / Cloudflare WAF log-mode shape. Before this fix, ANY matching
    // observe rule (regardless of priority or evaluation order) returned
    // straight out of evaluate(), blinding every lower-priority rule on
    // that same call — including unrelated REAL enforcement rules, not
    // just other observe rules (see agentic-eval.test.ts / threat-model.
    // test.ts, where the shipped must-sign-commits / no-push-to-main rules
    // were being silently bypassed this way).
    it('an observe match no longer blinds a later real deny rule on the same call — it records and the deny still fires', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: obs-blind-check
    type: command
    match: "danger"
    action: warn
    mode: observe
    message: "Observed first, should not blind."
  - id: real-deny-after-observe
    type: command
    match: "danger"
    action: deny
    level: protect
    message: "Actually blocked."
`)
      const result = await pipeline.evaluate(input('bash', { command: 'danger' }, 'obs-6'))
      // The definitive verdict comes from the REAL (non-observe) rule.
      expect(result.action).toBe('deny')
      expect(result.rule_id).toBe('real-deny-after-observe')
      // The observe rule's own would-be action is STILL recorded —
      // observing and blocking on the same call are not mutually exclusive.
      expect(result.observed_action).toBe('warn')
      expect(result.observed_matches).toEqual([
        expect.objectContaining({ rule_id: 'obs-blind-check', observed_action: 'warn' }),
      ])
    })

    it('two observe rules on the same call both record, independent of which one (if either) fires first', async () => {
      const pipeline = makePipelineFromYaml(`version: 1
rules:
  - id: obs-a
    type: command
    match: "danger"
    action: warn
    mode: observe
    message: "A."
  - id: obs-b
    type: command
    match: "danger"
    action: deny
    mode: observe
    message: "B."
`)
      const result = await pipeline.evaluate(input('bash', { command: 'danger' }, 'obs-7'))
      // Neither rule is non-observe, so nothing definitive matches — the
      // verdict is a bare allow, same as a single observe match would be.
      expect(result.action).toBe('allow')
      expect(result.observed_matches).toHaveLength(2)
      expect(result.observed_matches).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule_id: 'obs-a', observed_action: 'warn' }),
        expect.objectContaining({ rule_id: 'obs-b', observed_action: 'deny' }),
      ]))
    })

    it('a repeated identical call re-evaluates and re-records instead of returning a stale cached allow', async () => {
      // The tier-1 allow-cache must never suppress an observe rule's shadow
      // count on a repeat call — see pipeline.ts's cache-write guard
      // (`!this.observedMatches.length`). Pre-guard, the first call would
      // fall through to the bottom "Allowed — cache and return" block
      // (unreachable pre-fix, since the observe branch used to return
      // directly) and cache a bare allow verdict; the SECOND identical call
      // would then hit tier 1 and never re-run the rules loop at all —
      // exactly the traffic an observe rule burning in most needs to count.
      const pipeline = makePipelineFromYaml(observeRules('observe'))
      const first = await pipeline.evaluate(input('bash', { command: 'rm -rf /' }, 'obs-8'))
      const second = await pipeline.evaluate(input('bash', { command: 'rm -rf /' }, 'obs-8'))
      expect(first.observed_action).toBe('deny')
      expect(first.cache_hit).toBe(false)
      expect(second.observed_action).toBe('deny')
      expect(second.cache_hit).toBe(false)
    })

    it('rejects a typo in mode rather than silently enforcing', () => {
      // A guardrail that silently does the opposite of what the config says
      // is the single most trust-destroying failure shape. Catch it at parse.
      const parsed = parseRulesContent(observeRules('observ'), '/tmp/test-rules.md')
      const errors = validateRules(parsed.rules)
      expect(errors.some(e => e.includes('unsupported mode'))).toBe(true)
    })

    it('rejects typos in the catalog metadata fields', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: meta-typo
    type: command
    match: "x"
    action: warn
    severity: sever
    confidence: mostly
    maturity: baked
    category: nonsense
    message: "m"
`, '/tmp/test-rules.md')
      const errors = validateRules(parsed.rules)
      for (const field of ['severity', 'confidence', 'maturity', 'category']) {
        expect(errors.some(e => e.includes(`unsupported ${field}`))).toBe(true)
      }
    })

    it('accepts a fully annotated rule', () => {
      const parsed = parseRulesContent(`version: 1
rules:
  - id: fully-annotated
    type: command
    match: "rm -rf /"
    action: deny
    mode: observe
    category: destructive
    severity: critical
    confidence: high
    maturity: incubating
    rationale: "Recursive delete of a root-adjacent path is unrecoverable."
    remediation: "Scope the delete to the workspace."
    false_positives: ["rm -rf node_modules"]
    review_by: "2026-11-01"
    message: "Destructive delete."
`, '/tmp/test-rules.md')
      expect(validateRules(parsed.rules)).toEqual([])
      expect(parsed.rules[0].mode).toBe('observe')
      expect(parsed.rules[0].severity).toBe('critical')
      expect(parsed.rules[0].false_positives).toEqual(['rm -rf node_modules'])
    })
  })
})
