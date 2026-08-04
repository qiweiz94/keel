import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent } from '../rule-parser.js'
import { ResearchCache, researchKey } from '../research/research-cache.js'
import { ResearchTracker } from '../research-tracker.js'
import { fetchPage, ResearchError } from '../research/fetcher.js'
import { parseDuckDuckGo } from '../research/search.js'
import type { EnforceInput } from '../../types.js'

/**
 * Phase 1 — the research capability:
 *   - fetcher: SSRF guards (scheme, private IPs, metadata, redirects, size cap)
 *   - search: DuckDuckGo HTML parsing
 *   - cache: session-scoped put/get/probe with freshness
 *   - pipeline: `research` rules gate on missing/stale knowledge, then allow
 *     once fresh evidence exists
 */

function makePipeline(yaml: string, cache: ResearchCache): EnforcementPipeline {
  const rules = parseRulesContent(yaml, '/tmp/research-rules.yaml')
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    researchCache: cache,
    researchTracker: new ResearchTracker(cache),
    ruleHierarchy: { global: rules, user: null, project: null, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
  })
}

function input(tool: string, args: Record<string, unknown>, session = 'research-test'): EnforceInput {
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

const FRESHNESS_RULE = `version: 1
rules:
  - id: freshness-openai
    type: research
    topics: ["openai"]
    max_age_hours: 24
    action: research
    message: "OpenAI SDK knowledge is stale"
`

describe('research fetcher (SSRF guards)', () => {
  it('rejects file:, ftp:, data: schemes', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/plain,hi']) {
      await expect(fetchPage(url)).rejects.toMatchObject({ code: 'ssrf_blocked' })
    }
  })

  it('rejects loopback, private, and metadata hosts', async () => {
    for (const url of [
      'http://127.0.0.1/x',
      'http://localhost/x',
      'http://10.0.0.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x',
      'http://metadata.google.internal/x',
    ]) {
      await expect(fetchPage(url)).rejects.toMatchObject({ code: 'ssrf_blocked' })
    }
  })

  it('rejects malformed urls', async () => {
    await expect(fetchPage('not a url')).rejects.toBeInstanceOf(ResearchError)
  })
})

describe('search (DuckDuckGo HTML parsing)', () => {
  it('parses result links, titles, and snippets', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/page')}&rut=x">Example &amp; Page</a>
        <a class="result__snippet">Some snippet text</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.org/two">Second Result</a>
        <a class="result__snippet">Another snippet</a>
      </div>
    `
    const results = parseDuckDuckGo(html, 5)
    expect(results).toHaveLength(2)
    expect(results[0].url).toBe('https://example.com/page')
    expect(results[0].title).toBe('Example & Page')
    expect(results[0].snippet).toBe('Some snippet text')
    expect(results[1].rank).toBe(2)
  })

  it('respects maxResults and skips non-http urls', () => {
    const html = `
      <div class="result"><a class="result__a" href="file:///etc/passwd">Bad</a><a class="result__snippet">x</a></div>
      <div class="result"><a class="result__a" href="https://ok.example">Good</a><a class="result__snippet">y</a></div>
    `
    const results = parseDuckDuckGo(html, 5)
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://ok.example')
  })
})

describe('research cache', () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    previousHome = process.env.HOME
    process.env.HOME = home
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    execSync(`rm -rf "${home}"`)
  })

  it('puts, gets, lists, and probes freshness per session', () => {
    const cache = new ResearchCache()
    const fetched = Date.now()
    cache.put({ topic: 'openai sdk latest', kind: 'search', session_id: 's1', fetched_at: fetched, maxAgeHours: 24, results: [], source: 'duckduckgo', truncated: false })

    const got = cache.get('s1', 'openai sdk latest')
    expect(got?.topic).toBe('openai sdk latest')
    expect(got?.key).toBe(researchKey('s1', 'openai sdk latest'))

    const fresh = cache.probe('s1', ['openai sdk'], 24)
    expect(fresh.hit).toBe(true)

    // Another session sees nothing.
    expect(cache.probe('s2', ['openai sdk'], 24).hit).toBe(false)
    expect(cache.list('s1')).toHaveLength(1)
    expect(cache.list('s2')).toHaveLength(0)

    // Stale probe: evidence fetched an hour ago, max age 30 minutes. Target
    // a topic only the old entry matches (the fresh one would win otherwise).
    cache.put({ topic: 'openai sdk old', kind: 'search', session_id: 's1', fetched_at: Date.now() - 3600_000, maxAgeHours: 24, results: [], source: 'duckduckgo', truncated: false })
    const stale = cache.probe('s1', ['openai sdk old'], 0.5)
    expect(stale.hit).toBe(false)
    expect(stale.stalenessHours).toBeGreaterThan(0)
  })

  it('persists to the disk mirror and survives cache recreation', () => {
    const cache = new ResearchCache()
    cache.put({ topic: 'topic-x', kind: 'search', session_id: 's9', fetched_at: Date.now(), maxAgeHours: 24, results: [], source: 'duckduckgo', truncated: false })
    const recreated = new ResearchCache()
    const entry = recreated.get('s9', 'topic-x')
    expect(entry?.topic).toBe('topic-x')
  })
})

describe('research rules (knowledge freshness gate)', () => {
  let home: string
  let previousHome: string | undefined
  let cache: ResearchCache

  beforeEach(() => {
    home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    previousHome = process.env.HOME
    process.env.HOME = home
    cache = new ResearchCache()
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    execSync(`rm -rf "${home}"`)
  })

  it('gates on missing research with a directive', async () => {
    const pipeline = makePipeline(FRESHNESS_RULE, cache)
    const result = await pipeline.evaluate(input('Bash', { command: 'npm install openai' }))
    expect(result.action).toBe('research')
    expect(result.rule_id).toBe('freshness-openai')
    expect(result.directive?.missing).toBe(true)
    expect(result.directive?.suggestion).toContain('keel_research')
  })

  it('allows once fresh research exists in the session', async () => {
    const pipeline = makePipeline(FRESHNESS_RULE, cache)
    cache.put({ topic: 'openai sdk version 2026', kind: 'search', session_id: 'research-test', fetched_at: Date.now(), maxAgeHours: 24, results: [], source: 'duckduckgo', truncated: false })
    const result = await pipeline.evaluate(input('Bash', { command: 'npm install openai' }))
    expect(result.action).toBe('allow')
  })

  it('gates again when research is stale', async () => {
    const pipeline = makePipeline(FRESHNESS_RULE, cache)
    cache.put({ topic: 'openai sdk old info', kind: 'search', session_id: 'research-test', fetched_at: Date.now() - 30 * 3600_000, maxAgeHours: 24, results: [], source: 'duckduckgo', truncated: false })
    const result = await pipeline.evaluate(input('Bash', { command: 'npm install openai' }))
    expect(result.action).toBe('research')
    expect(result.directive?.missing).toBe(false)
    expect(result.directive?.stalenessHours).toBeGreaterThan(24)
  })

  it('ignores actions whose topics do not match', async () => {
    const pipeline = makePipeline(FRESHNESS_RULE, cache)
    const result = await pipeline.evaluate(input('Bash', { command: 'git commit -m x' }))
    expect(result.action).toBe('allow')
  })

  it('honors the except list', async () => {
    const yaml = `version: 1
rules:
  - id: freshness-except
    type: research
    topics: ["openai"]
    except: ["openai.com/docs"]
    max_age_hours: 24
    action: research
    message: "stale"
`
    const pipeline = makePipeline(yaml, cache)
    const result = await pipeline.evaluate(input('Bash', { command: 'openai.com/docs api' }))
    expect(result.action).toBe('allow')
  })

  it('does not cache an allow verdict for research rules (stateful)', async () => {
    const pipeline = makePipeline(FRESHNESS_RULE, cache)
    // First call: no research → research gate.
    expect((await pipeline.evaluate(input('Bash', { command: 'npm install openai' }, 'stateful-1'))).action).toBe('research')
    // Same call again: still gated (no stale allow-cache entry).
    expect((await pipeline.evaluate(input('Bash', { command: 'npm install openai' }, 'stateful-1'))).action).toBe('research')
  })
})

const OBLIGATION_RULE = `version: 1
rules:
  - id: research-before-fix
    type: research
    trigger:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest)"
      exit: nonzero
    satisfy:
      tools: [Bash]
      pattern: "keel_research"
    topics: ["failing"]
    boundaries:
      edit:
        pattern: "apply_patch|write|edit"
        action: redirect
      commit:
        pattern: "git commit"
        action: warn
    research_window_seconds: 600
    freshness_seconds: 1800
    action: redirect
    message: "The failing command needs fresh research before you fix it."
`

describe('research-before-solve obligation (trigger/satisfy/boundaries)', () => {
  let home: string
  let previousHome: string | undefined
  let cache: ResearchCache

  beforeEach(() => {
    home = execSync('mktemp -d', { encoding: 'utf-8' }).trim()
    previousHome = process.env.HOME
    process.env.HOME = home
    cache = new ResearchCache()
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    execSync(`rm -rf "${home}"`)
  })

  it('arms on a failing test run and redirects the next fix', async () => {
    const pipeline = makePipeline(OBLIGATION_RULE, cache)
    pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'obl-1'), 1)
    const fix = await pipeline.evaluate(input('write', { filePath: '/tmp/src/x.ts', content: 'x' }, 'obl-1'))
    expect(fix.action).toBe('redirect')
    expect(fix.redirect?.kind).toBe('research')
    expect(fix.redirect?.suggested_call).toContain('keel_research')
  })

  it('does not arm on a passing test run', async () => {
    const pipeline = makePipeline(OBLIGATION_RULE, cache)
    pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'obl-2'), 0)
    const fix = await pipeline.evaluate(input('write', { filePath: '/tmp/src/x.ts', content: 'x' }, 'obl-2'))
    expect(fix.action).toBe('allow')
  })

  it('discharges after a satisfying research action', async () => {
    const pipeline = makePipeline(OBLIGATION_RULE, cache)
    pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'obl-3'), 1)
    // The research call itself hits the freshness gate ('research' — text
    // alone is not evidence); the daemon populates the cache afterwards.
    const research = await pipeline.evaluate(input('Bash', { command: 'keel_research {"query": "failing module"}' }, 'obl-3'))
    expect(research.action).toBe('research')
    cache.put({ topic: 'failing module docs 2026', kind: 'search', session_id: 'obl-3', fetched_at: Date.now(), maxAgeHours: 24, results: [], source: 'duckduckgo', truncated: false })
    const fix = await pipeline.evaluate(input('write', { filePath: '/tmp/src/x.ts', content: 'x' }, 'obl-3'))
    expect(fix.action).toBe('allow')
  })

  it('discharges when fresh research evidence exists in the session cache', async () => {
    const pipeline = makePipeline(OBLIGATION_RULE, cache)
    pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'obl-4'), 1)
    cache.put({ topic: 'failing module docs 2026', kind: 'search', session_id: 'obl-4', fetched_at: Date.now(), maxAgeHours: 24, results: [], source: 'duckduckgo', truncated: false })
    const fix = await pipeline.evaluate(input('write', { filePath: '/tmp/src/x.ts', content: 'x' }, 'obl-4'))
    expect(fix.action).toBe('allow')
  })

  it('expires the obligation after the window', async () => {
    const tracker = new ResearchTracker(cache)
    const pipeline = makePipeline(OBLIGATION_RULE, cache)
    pipeline.recordAttemptOutcome(input('Bash', { command: 'npm test' }, 'obl-5'), 1)
    // Simulate an aged pending entry via a tiny window rule.
    const rules = parseRulesContent(OBLIGATION_RULE, '/tmp/obl.yaml')
    const agedRule = { ...rules.rules[0], research_window_seconds: -1 }
    expect(tracker.isPending(agedRule, input('Bash', { command: 'npm test' }, 'obl-5'))).toBe(false)
  })
})
