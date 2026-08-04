import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import type { PipelineConfig } from '../pipeline.js'
import type { ProtectionLevel, RuleContext } from '../../types.js'
import { loadRuleHierarchy, parseRulesContent, parseRulesFile, validateRules } from '../rule-parser.js'
import type { StateManager } from '../state-manager.js'

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
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeAll(() => {
    // Do not let a developer's live kill switch affect unrelated unit tests.
    const sentinelPath = join(homedir(), '.keel', 'DISABLED')
    if (existsSync(sentinelPath)) rmSync(sentinelPath)
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
      })

    afterAll(() => {
      rmSync(sentinelDir, { recursive: true, force: true })
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
