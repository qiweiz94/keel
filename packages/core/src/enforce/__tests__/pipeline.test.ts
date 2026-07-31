import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import type { PipelineConfig } from '../pipeline.js'
import type { ProtectionLevel, RuleContext } from '../../types.js'
import { loadRuleHierarchy, parseRulesContent } from '../rule-parser.js'

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
    enableReasoningCheck: false,
  }

  return new EnforcementPipeline(config)
}

function makePipelineFromYaml(yaml: string): EnforcementPipeline {
  const rules = parseRulesContent(yaml, '/tmp/test-rules.md')
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
    enableReasoningCheck: false,
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

describe('EnforcementPipeline', () => {
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

  describe('Kill switch', () => {
    const sentinelPath = join(homedir(), '.keel', 'DISABLED')

    beforeAll(() => {
      const dir = join(homedir(), '.keel')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    })

    it('enforces rules normally when no sentinel file exists', async () => {
      if (existsSync(sentinelPath)) rmSync(sentinelPath)
      const pipeline = makePipeline()
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
      const pipeline = makePipeline()
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
})
