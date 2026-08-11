import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractPackageInstalls,
  decidePackageAction,
  checkPackages,
  checkPackagesCacheOnly,
  scheduleBackgroundVerification,
  PackageVerifierCache,
  defaultRegistryBaseUrl,
  type PackageCheckResult,
} from '../package-verifier.js'
import { EnforcementPipeline } from '../pipeline.js'
import type { PipelineConfig } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent, validateRules } from '../rule-parser.js'
import type { EnforceInput, KeelRule } from '../../types.js'

/**
 * Wave-2 slopsquatting install gate.
 *
 * Layered exactly like the module: (1) extraction is pure/sync and cheap —
 * tested with zero mocking; (2) decidePackageAction is pure — tested
 * against hand-built PackageCheckResult[] with no network layer at all;
 * (3) checkPackages against a MOCKED fetch — no test in this file ever
 * makes a real network call (see also defaultRegistryBaseUrl()'s own
 * VITEST-aware safety net, tested at the bottom); (4) pipeline wiring —
 * a `type: package` rule run through the real EnforcementPipeline with the
 * mock injected via `packageVerifierFetch`.
 */

// ── (1) extraction ──────────────────────────────────────────────────

describe('extractPackageInstalls', () => {
  it('extracts a single npm install', () => {
    expect(extractPackageInstalls('npm install lodash')).toEqual([
      { name: 'lodash', requestedVersion: undefined, manager: 'npm', raw: 'lodash' },
    ])
  })

  it('extracts npm i (alias) and multiple packages', () => {
    const specs = extractPackageInstalls('npm i lodash left-pad')
    expect(specs.map(s => s.name)).toEqual(['lodash', 'left-pad'])
  })

  it('extracts pnpm add, yarn add, bun add', () => {
    expect(extractPackageInstalls('pnpm add zod')[0].name).toBe('zod')
    expect(extractPackageInstalls('yarn add react')[0].name).toBe('react')
    expect(extractPackageInstalls('bun add axios')[0].name).toBe('axios')
  })

  it('extracts a versioned package', () => {
    expect(extractPackageInstalls('npm install lodash@4.17.21')[0]).toMatchObject({ name: 'lodash', requestedVersion: '4.17.21' })
  })

  it('extracts a scoped package, with and without a version', () => {
    expect(extractPackageInstalls('npm install @babel/core')[0]).toMatchObject({ name: '@babel/core', requestedVersion: undefined })
    expect(extractPackageInstalls('npm install @babel/core@7.20.0')[0]).toMatchObject({ name: '@babel/core', requestedVersion: '7.20.0' })
  })

  it('ignores flags interspersed with package names', () => {
    const specs = extractPackageInstalls('npm install --save-dev lodash -g left-pad')
    expect(specs.map(s => s.name)).toEqual(['lodash', 'left-pad'])
  })

  it('ignores local paths, file:, git+, github shorthand, and tarball URLs', () => {
    expect(extractPackageInstalls('npm install ./local-pkg')).toEqual([])
    expect(extractPackageInstalls('npm install ../sibling-pkg')).toEqual([])
    expect(extractPackageInstalls('npm install file:../foo')).toEqual([])
    expect(extractPackageInstalls('npm install git+https://github.com/x/y.git')).toEqual([])
    expect(extractPackageInstalls('npm install user/repo')).toEqual([])
    expect(extractPackageInstalls('npm install https://example.com/pkg.tgz')).toEqual([])
    expect(extractPackageInstalls('npm install ./pkg.tar.gz')).toEqual([])
  })

  it('ignores a workspace: version protocol', () => {
    expect(extractPackageInstalls('pnpm add foo@workspace:*')).toEqual([])
  })

  it('bare install/ci with no package args extracts nothing (reads from package.json/lockfile)', () => {
    expect(extractPackageInstalls('npm install')).toEqual([])
    expect(extractPackageInstalls('npm ci')).toEqual([])
    expect(extractPackageInstalls('pnpm install')).toEqual([])
    expect(extractPackageInstalls('yarn')).toEqual([])
    expect(extractPackageInstalls('yarn install')).toEqual([])
    expect(extractPackageInstalls('npm install --production')).toEqual([])
  })

  it('finds an install inside a compound command', () => {
    expect(extractPackageInstalls('cd packages/app && npm install lodash')[0].name).toBe('lodash')
    expect(extractPackageInstalls('npm install lodash; npm test')[0].name).toBe('lodash')
    expect(extractPackageInstalls('npm install lodash || echo failed')[0].name).toBe('lodash')
  })

  it('handles a sudo prefix and inline env assignment', () => {
    expect(extractPackageInstalls('sudo npm install lodash')[0].name).toBe('lodash')
    expect(extractPackageInstalls('CI=true npm install lodash')[0].name).toBe('lodash')
  })

  it('an unrelated command with no manager keyword extracts nothing (quick prefilter)', () => {
    expect(extractPackageInstalls('git commit -m "add lodash dependency"')).toEqual([])
    expect(extractPackageInstalls('ls -la')).toEqual([])
    expect(extractPackageInstalls('')).toEqual([])
  })

  it('known false-negative, documented: a quoted install inside bash -c is not unwrapped', () => {
    // The tokenizer treats the whole quoted string as one opaque token —
    // a real shell parse would be needed to see inside it. This asserts
    // the DOCUMENTED gap so a future accidental fix is noticed, not a
    // desired behavior.
    expect(extractPackageInstalls('bash -c "npm install evil-pkg"')).toEqual([])
  })
})

// ── (2) decision logic (pure) ───────────────────────────────────────

function result(overrides: Partial<PackageCheckResult>): PackageCheckResult {
  return { name: 'pkg', verdict: 'exists', fromCache: false, ...overrides }
}

describe('decidePackageAction', () => {
  it('allows when everything exists and is old enough', () => {
    const d = decidePackageAction([result({ verdict: 'exists', ageDays: 2000 })], 30)
    expect(d.reason).toBe('ok')
  })

  it('denies (reason not_found) when a package does not exist', () => {
    const d = decidePackageAction([result({ name: 'totally-fake-hallucinated-pkg', verdict: 'not_found' })], 30)
    expect(d.reason).toBe('not_found')
    expect(d.message).toContain('does not exist')
  })

  it('includes a did-you-mean suggestion in the not_found message when present', () => {
    const d = decidePackageAction([result({ verdict: 'not_found', didYouMean: ['left-pad', 'left-padder'] })], 30)
    expect(d.message).toContain('left-pad')
  })

  it('prompts (reason age_gate) for a package younger than the threshold', () => {
    const d = decidePackageAction([result({ verdict: 'exists', ageDays: 10 })], 30)
    expect(d.reason).toBe('age_gate')
    expect(d.message).toContain('10 day')
  })

  it('prompts (reason unverified) with the exact required substring on a network failure', () => {
    const d = decidePackageAction([result({ verdict: 'unverified', reason: 'timeout' })], 30)
    expect(d.reason).toBe('unverified')
    expect(d.message).toContain('unverified — registry unreachable')
  })

  it('prompts (reason unverified) for a scoped 404, distinct wording, never not_found', () => {
    const d = decidePackageAction([result({ name: '@myorg/internal-tool', verdict: 'unverified', reason: 'scoped_not_public' })], 30)
    expect(d.reason).toBe('unverified')
    expect(d.message).toContain('unverified')
    expect(d.message).toContain('private/org')
  })

  it('priority: not_found beats unverified and age_gate in the same command', () => {
    const d = decidePackageAction([
      result({ name: 'young-pkg', verdict: 'exists', ageDays: 1 }),
      result({ name: 'unreachable-pkg', verdict: 'unverified', reason: 'timeout' }),
      result({ name: 'fake-pkg', verdict: 'not_found' }),
    ], 30)
    expect(d.reason).toBe('not_found')
    expect(d.result?.name).toBe('fake-pkg')
  })

  it('priority: unverified beats age_gate', () => {
    const d = decidePackageAction([
      result({ name: 'young-pkg', verdict: 'exists', ageDays: 1 }),
      result({ name: 'unreachable-pkg', verdict: 'unverified', reason: 'network_error' }),
    ], 30)
    expect(d.reason).toBe('unverified')
  })
})

// ── (3) checkPackages against a mocked fetch ────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

/** A tiny fake registry keyed by package name, with call tracking so an accidental fallback to the real registry (or a broken mock wire-up) fails LOUDLY instead of passing quietly. */
function makeMockRegistry(behaviors: Record<string, 'not_found' | 'timeout' | 'network_error' | { existsDaysAgo: number }>) {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString()
    calls.push(href)
    if (href.includes('/-/v1/search')) {
      const text = new URL(href).searchParams.get('text') || ''
      return jsonResponse({ objects: [{ package: { name: `${text}-suggestion` } }] })
    }
    const name = decodeURIComponent(href.replace(/^https?:\/\/[^/]+\//, ''))
    const behavior = behaviors[name]
    if (!behavior) return jsonResponse(null, 404)
    if (behavior === 'not_found') return jsonResponse(null, 404)
    if (behavior === 'timeout') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }
    if (behavior === 'network_error') throw new Error('ECONNREFUSED (simulated)')
    return jsonResponse({ name, time: { created: daysAgoIso(behavior.existsDaysAgo) } })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('checkPackages (mocked registry)', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-')) })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('nonexistent unscoped package -> not_found, with a did-you-mean suggestion', async () => {
    const { fetchImpl, calls } = makeMockRegistry({ 'totally-fake-hallucinated-pkg-xyz': 'not_found' })
    const [r] = await checkPackages(
      [{ name: 'totally-fake-hallucinated-pkg-xyz', manager: 'npm', raw: 'totally-fake-hallucinated-pkg-xyz' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), registryBaseUrl: 'https://mock.invalid' },
    )
    expect(r.verdict).toBe('not_found')
    expect(r.didYouMean).toEqual(['totally-fake-hallucinated-pkg-xyz-suggestion'])
    expect(calls.some(c => c.includes('/-/v1/search'))).toBe(true)
  })

  it('a package published 10 days ago -> exists, ageDays ~10', async () => {
    const { fetchImpl } = makeMockRegistry({ 'freshpkg': { existsDaysAgo: 10 } })
    const [r] = await checkPackages(
      [{ name: 'freshpkg', manager: 'npm', raw: 'freshpkg' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), registryBaseUrl: 'https://mock.invalid' },
    )
    expect(r.verdict).toBe('exists')
    expect(r.ageDays).toBeGreaterThan(9)
    expect(r.ageDays).toBeLessThan(11)
  })

  it('a package published 5 years ago -> exists, well past any reasonable age threshold', async () => {
    const { fetchImpl } = makeMockRegistry({ lodash: { existsDaysAgo: 365 * 5 } })
    const [r] = await checkPackages(
      [{ name: 'lodash', manager: 'npm', raw: 'lodash' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), registryBaseUrl: 'https://mock.invalid' },
    )
    expect(r.verdict).toBe('exists')
    expect(decidePackageAction([r], 30).reason).toBe('ok')
  })

  it('timeout -> unverified/timeout, decision message carries the required literal substring', async () => {
    const { fetchImpl } = makeMockRegistry({ 'slow-pkg': 'timeout' })
    const [r] = await checkPackages(
      [{ name: 'slow-pkg', manager: 'npm', raw: 'slow-pkg' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), registryBaseUrl: 'https://mock.invalid', totalTimeoutMs: 30 },
    )
    expect(r.verdict).toBe('unverified')
    expect(r.reason).toBe('timeout')
    expect(decidePackageAction([r], 30).message).toContain('unverified — registry unreachable')
  })

  it('a thrown network error -> unverified/network_error, never denied', async () => {
    const { fetchImpl } = makeMockRegistry({ 'unreachable-pkg': 'network_error' })
    const [r] = await checkPackages(
      [{ name: 'unreachable-pkg', manager: 'npm', raw: 'unreachable-pkg' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), registryBaseUrl: 'https://mock.invalid' },
    )
    expect(r.verdict).toBe('unverified')
    expect(r.reason).toBe('network_error')
  })

  it('a scoped package 404 -> unverified/scoped_not_public, NEVER not_found (private-registry safety)', async () => {
    const { fetchImpl } = makeMockRegistry({}) // nothing registered -> every lookup 404s
    const [r] = await checkPackages(
      [{ name: '@myorg/internal-tool', manager: 'npm', raw: '@myorg/internal-tool' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), registryBaseUrl: 'https://mock.invalid' },
    )
    expect(r.verdict).toBe('unverified')
    expect(r.reason).toBe('scoped_not_public')
    expect(r.verdict).not.toBe('not_found')
  })

  it('an unscoped 404 is a real deny, not a private-scope pass-through', async () => {
    const { fetchImpl } = makeMockRegistry({}) // 404 for everything not registered
    const [r] = await checkPackages(
      [{ name: 'unscoped-hallucinated-name', manager: 'npm', raw: 'unscoped-hallucinated-name' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), registryBaseUrl: 'https://mock.invalid' },
    )
    expect(r.verdict).toBe('not_found')
  })

  it('a cache hit skips the mock entirely', async () => {
    const cache = new PackageVerifierCache(stateDir)
    const { fetchImpl, calls } = makeMockRegistry({ lodash: { existsDaysAgo: 2000 } })
    await checkPackages([{ name: 'lodash', manager: 'npm', raw: 'lodash' }], { fetchImpl, cache, registryBaseUrl: 'https://mock.invalid' })
    expect(calls.length).toBe(1)

    // Second lookup: fresh mock that would fail loudly if ever called.
    const angryMock = (async () => { throw new Error('should never be called — cache hit expected') }) as unknown as typeof fetch
    const [r2] = await checkPackages([{ name: 'lodash', manager: 'npm', raw: 'lodash' }], { fetchImpl: angryMock, cache, registryBaseUrl: 'https://mock.invalid' })
    expect(r2.verdict).toBe('exists')
    expect(r2.fromCache).toBe(true)
  })

  it('cache entries expire per their own TTL tier (unverified expires faster than exists)', async () => {
    const cache = new PackageVerifierCache(stateDir)
    let now = 1_000_000
    cache.set({ name: 'flaky-pkg', verdict: 'unverified', reason: 'timeout', checkedAt: now }, now)
    cache.set({ name: 'stable-pkg', verdict: 'exists', ageDays: 2000, checkedAt: now }, now)

    now += 6 * 60 * 1000 // 6 minutes later — past the 5-minute unverified TTL, well under the 24h exists TTL
    expect(cache.get('flaky-pkg', now)).toBeNull()
    expect(cache.get('stable-pkg', now)).not.toBeNull()
  })

  it('respects KEEL_STATE_DIR when constructed with no explicit dir (read at call time, not import time)', () => {
    const prior = process.env.KEEL_STATE_DIR
    try {
      process.env.KEEL_STATE_DIR = stateDir
      const cache = new PackageVerifierCache() // no explicit dir — must pick up the env var set just now
      cache.set({ name: 'probe-pkg', verdict: 'exists', ageDays: 100, checkedAt: Date.now() })
      const reread = new PackageVerifierCache()
      expect(reread.get('probe-pkg')?.verdict).toBe('exists')
    } finally {
      if (prior === undefined) delete process.env.KEEL_STATE_DIR
      else process.env.KEEL_STATE_DIR = prior
    }
  })

  it('shares one total timeout budget across multiple packages in one command; budget exhaustion never denies', async () => {
    const { fetchImpl } = makeMockRegistry({ 'timeout-a': 'timeout', 'timeout-b': 'timeout' })
    const results = await checkPackages(
      [
        { name: 'timeout-a', manager: 'npm', raw: 'timeout-a' },
        { name: 'timeout-b', manager: 'npm', raw: 'timeout-b' },
      ],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), registryBaseUrl: 'https://mock.invalid', totalTimeoutMs: 20 },
    )
    for (const r of results) {
      expect(r.verdict).toBe('unverified')
      expect(['timeout', 'budget_exhausted']).toContain(r.reason)
    }
  })
})

// ── (4) pipeline wiring ─────────────────────────────────────────────

function stubOverrideStore() {
  // Never touches real ~/.keel/overrides.json — matches the CLI fixture
  // harness's stub (see packages/cli/src/__tests__/fixture-harness.test.ts).
  return { consume: () => false, peek: () => null, list: () => ({}) }
}

function buildPipeline(rule: KeelRule, fetchImpl: typeof fetch, extra: Partial<PipelineConfig> = {}): EnforcementPipeline {
  const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-pipeline-'))
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: { global: null, user: null, project: { config: { version: 1, rules: [rule] }, rules: [rule], sourcePath: '/tmp/pkg-rule.yaml', version: 1, markdown: '' }, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
    disableFile: join(stateDir, 'DISABLED-unused'),
    overrideStore: stubOverrideStore(),
    packageVerifierCache: new PackageVerifierCache(stateDir),
    packageVerifierFetch: fetchImpl,
    ...extra,
  })
}

/** Captures the fire-and-forget background-verification promise a `type: package` cache miss kicks off, via `packageVerifierOnBackgroundStart` — a test-only pipeline hook (see PipelineConfig's doc). Lets a test `await` the background fill deterministically instead of racing a real timer. */
function backgroundCapture(): { hook: (settled: Promise<void>) => void; settled: () => Promise<void> } {
  let captured: Promise<void> = Promise.resolve()
  return {
    hook: (settled: Promise<void>) => { captured = settled },
    settled: () => captured,
  }
}

function makeInput(command: string): EnforceInput {
  return {
    tool: 'Bash',
    args: { command },
    cwd: '/tmp',
    session_id: 'pkg-pipeline-test',
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
  }
}

const PACKAGE_RULE: KeelRule = {
  id: 'unverified-package-install-test',
  type: 'package',
  action: 'prompt',
  message: 'Verify a package exists before installing it.',
}

/**
 * v0.4 package-lookup budget fix: `pipeline.ts`'s `type: package` branch no
 * longer awaits the network on a cache miss (see pipeline.ts's own header
 * comment on that branch, and session/v04/EVIDENCE/pkgbudget.md for the
 * before/after measurement — the old synchronous path blocked ~2000ms on a
 * cache miss against a slow/unreachable registry, a4-perf.md §5.3). Every
 * test below that used to assert a same-call deny/allow/age-gate verdict on
 * an UNCACHED package now runs in two phases:
 *   1. First `evaluate()` on a fresh (never-looked-up) package name — must
 *      return FAST (no real verdict is possible yet) with `action: prompt`
 *      and a `not yet checked` message, and must fire a background lookup
 *      it never awaits.
 *   2. `await` that background lookup via the `packageVerifierOnBackgroundStart`
 *      test hook (never used by any production host), THEN a second
 *      `evaluate()` on the SAME package name — this is what now carries the
 *      real deny/allow/age-gate/unverified-reason verdict, from the cache
 *      the background lookup just filled.
 * This is an intentional behavior change, not a regression: a same-day
 * hallucinated install is still stopped by the human-approval prompt on the
 * very first attempt; it is the deterministic, no-human-needed DENY that
 * now lands one attempt later. See pipeline.ts's branch comment for the
 * accepted host-dependent caveat (this two-attempt guarantee holds for a
 * long-lived pipeline host — the opencode plugin, the MCP daemon — but not
 * for the claude-code/codex/gemini/cursor `keel hook` path, which calls
 * `process.exit()` immediately after rendering the first verdict and kills
 * the background promise before it can land the second one).
 */
describe('pipeline: type "package" rule', () => {
  it('phase 1 — an uncached package prompts immediately with a not-yet-checked message, regardless of what the mock would eventually say', async () => {
    const { fetchImpl } = makeMockRegistry({}) // would 404 -> not_found, but must never be awaited here
    const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl)
    const res = await pipeline.evaluate(makeInput('npm install totally-hallucinated-pkg-does-not-exist'))
    expect(res.action).toBe('prompt')
    expect(res.message).toContain('not yet checked')
  })

  it('phase 2 — denies a hallucinated package once the background fill has cached not_found (retry, not first attempt)', async () => {
    const { fetchImpl } = makeMockRegistry({})
    const cap = backgroundCapture()
    const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl, { packageVerifierOnBackgroundStart: cap.hook })
    const cmd = 'npm install totally-hallucinated-pkg-does-not-exist'

    const first = await pipeline.evaluate(makeInput(cmd))
    expect(first.action).toBe('prompt') // not a same-call deny — see describe()'s header comment

    await cap.settled()
    const second = await pipeline.evaluate(makeInput(cmd))
    expect(second.action).toBe('deny')
    expect(second.rule_id).toBe('unverified-package-install-test')
  })

  it('never denies on a registry timeout, on the first attempt or the retry', async () => {
    const { fetchImpl } = makeMockRegistry({ 'slow-registry-pkg': 'timeout' })
    const cap = backgroundCapture()
    const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl, { packageVerifierOnBackgroundStart: cap.hook })
    const cmd = 'npm install slow-registry-pkg'

    const first = await pipeline.evaluate(makeInput(cmd))
    expect(first.action).toBe('prompt')
    expect(first.message).toContain('not yet checked')

    await cap.settled() // background lookup itself times out (~internal abort) and caches 'unverified'/'timeout'
    const second = await pipeline.evaluate(makeInput(cmd))
    expect(second.action).toBe('prompt') // still never denies
    expect(second.message).toContain('unverified — registry unreachable')
  })

  it('prompts on a young package on the retry, with an age-gate message (not a generic not-yet-checked one)', async () => {
    const { fetchImpl } = makeMockRegistry({ 'brand-new-pkg': { existsDaysAgo: 3 } })
    const cap = backgroundCapture()
    const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl, { packageVerifierOnBackgroundStart: cap.hook })
    const cmd = 'npm install brand-new-pkg'

    const first = await pipeline.evaluate(makeInput(cmd))
    expect(first.action).toBe('prompt')

    await cap.settled()
    const second = await pipeline.evaluate(makeInput(cmd))
    expect(second.action).toBe('prompt')
    expect(second.message).toContain('day(s) ago') // proves the age_gate branch, not the not_yet_checked one, decided this
  })

  it('allows an old, verified package on the retry, once the background fill has cached "exists"', async () => {
    const { fetchImpl } = makeMockRegistry({ react: { existsDaysAgo: 4000 } })
    const cap = backgroundCapture()
    const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl, { packageVerifierOnBackgroundStart: cap.hook })
    const cmd = 'npm install react'

    const first = await pipeline.evaluate(makeInput(cmd))
    expect(first.action).toBe('prompt') // not a same-call allow — see describe()'s header comment

    await cap.settled()
    const second = await pipeline.evaluate(makeInput(cmd))
    expect(second.action).toBe('allow')
  })

  it('never touches the mock for a command with no install pattern (laziness) — unaffected by the cache-first change', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return jsonResponse({}) }) as unknown as typeof fetch
    const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl)
    const res = await pipeline.evaluate(makeInput('git status'))
    expect(res.action).toBe('allow')
    expect(called).toBe(false)
  })

  it('a private-scoped package never hard-denies even though it 404s publicly, on the first attempt or the retry', async () => {
    const { fetchImpl } = makeMockRegistry({}) // 404 for everything
    const cap = backgroundCapture()
    const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl, { packageVerifierOnBackgroundStart: cap.hook })
    const cmd = 'npm install @myorg/internal-build-tool'

    const first = await pipeline.evaluate(makeInput(cmd))
    expect(first.action).toBe('prompt')

    await cap.settled()
    const second = await pipeline.evaluate(makeInput(cmd))
    expect(second.action).toBe('prompt')
    expect(second.action).not.toBe('deny')
    expect(second.message).toContain('Scoped names 404 publicly') // proves the scoped_not_public branch decided this, not not_yet_checked
  })

  it('honors a rule-level age_days override on the retry', async () => {
    const { fetchImpl } = makeMockRegistry({ 'seven-day-old-pkg': { existsDaysAgo: 7 } })
    const strictRule: KeelRule = { ...PACKAGE_RULE, id: 'strict-age', age_days: 90 }
    const cap = backgroundCapture()
    const pipeline = buildPipeline(strictRule, fetchImpl, { packageVerifierOnBackgroundStart: cap.hook })
    const cmd = 'npm install seven-day-old-pkg'

    await pipeline.evaluate(makeInput(cmd))
    await cap.settled()
    const second = await pipeline.evaluate(makeInput(cmd))
    expect(second.action).toBe('prompt') // 7 days < 90-day threshold
    expect(second.message).toContain('day(s) ago')
  })

  it('REGRESSION: a cache-miss evaluate() call returns fast even when the registry lookup hangs for the full internal budget (the exact ~2000ms block this fix removes, a4-perf.md §5.3)', async () => {
    const { fetchImpl } = makeMockRegistry({ 'hangs-until-abort-pkg': 'timeout' }) // resolves only when the internal AbortController fires, ~2000ms later
    const cap = backgroundCapture()
    const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl, { packageVerifierOnBackgroundStart: cap.hook })

    const t0 = performance.now()
    const res = await pipeline.evaluate(makeInput('npm install hangs-until-abort-pkg'))
    const elapsedMs = performance.now() - t0
    console.log(`[pkg-budget] evaluate() on a cache miss with a hanging registry fetch: ${elapsedMs.toFixed(3)}ms (old synchronous path: ~2000ms — a4-perf.md §5.3)`)

    expect(res.action).toBe('prompt')
    expect(res.message).toContain('not yet checked')
    expect(
      elapsedMs,
      `evaluate() took ${elapsedMs.toFixed(2)}ms on a cache miss whose registry lookup hangs until the internal `
      + `2000ms abort fires — this is the regression proof: the OLD synchronous path measured 2003.8ms / 2003.5ms `
      + `for this exact scenario (session/v04/EVIDENCE/a4-perf.md §5.3); the fix's whole point is that evaluate() `
      + 'never awaits the network on a miss.',
    ).toBeLessThan(50)

    // Let the background lookup actually finish (~2s, via its own internal
    // abort) so the test exits cleanly instead of leaving a dangling timer —
    // also incidentally proves the background task settles rather than
    // hanging the process forever.
    await cap.settled()
  }, 10_000)
})

// ── cache-first hot path: checkPackagesCacheOnly + scheduleBackgroundVerification ──

describe('checkPackagesCacheOnly + scheduleBackgroundVerification (v0.4 package-lookup budget fix)', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-cacheonly-')) })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  it('a fresh cache entry is used as-is for deny/prompt/allow — zero I/O, no fetchImpl parameter to even call', () => {
    const cache = new PackageVerifierCache(stateDir)
    const now = Date.now()
    cache.set({ name: 'hallucinated-pkg', verdict: 'not_found', checkedAt: now }, now)
    cache.set({ name: 'flaky-pkg', verdict: 'unverified', reason: 'timeout', checkedAt: now }, now)
    cache.set({ name: 'good-pkg', verdict: 'exists', ageDays: 2000, checkedAt: now }, now)

    const specs = [
      { name: 'hallucinated-pkg', manager: 'npm' as const, raw: 'hallucinated-pkg' },
      { name: 'flaky-pkg', manager: 'npm' as const, raw: 'flaky-pkg' },
      { name: 'good-pkg', manager: 'npm' as const, raw: 'good-pkg' },
    ]
    const t0 = performance.now()
    const { results, misses } = checkPackagesCacheOnly(specs, cache)
    const elapsedMs = performance.now() - t0
    console.log(`[pkg-budget] checkPackagesCacheOnly for 3 cached specs: ${elapsedMs.toFixed(3)}ms`)

    expect(misses).toEqual([])
    expect(results.map(r => r.fromCache)).toEqual([true, true, true])
    expect(decidePackageAction([results[0]], 30).reason).toBe('not_found')
    expect(decidePackageAction([results[1]], 30).reason).toBe('unverified')
    expect(decidePackageAction([results[2]], 30).reason).toBe('ok')
    expect(elapsedMs).toBeLessThan(20) // generous, non-flaky bound — this is a pure sync cache read, no I/O at all
  })

  it('a cache miss returns an unverified/not_yet_checked placeholder immediately and lists the spec as a miss', () => {
    const cache = new PackageVerifierCache(stateDir)
    const specs = [{ name: 'never-looked-up-pkg', manager: 'npm' as const, raw: 'never-looked-up-pkg' }]
    const t0 = performance.now()
    const { results, misses } = checkPackagesCacheOnly(specs, cache)
    const elapsedMs = performance.now() - t0
    console.log(`[pkg-budget] checkPackagesCacheOnly for 1 uncached spec: ${elapsedMs.toFixed(3)}ms`)

    expect(results).toEqual([
      { name: 'never-looked-up-pkg', requestedVersion: undefined, verdict: 'unverified', reason: 'not_yet_checked', fromCache: false },
    ])
    expect(misses).toEqual(specs)
    expect(decidePackageAction(results, 30).reason).toBe('unverified')
    expect(decidePackageAction(results, 30).message).toContain('not yet checked')
    expect(elapsedMs).toBeLessThan(20)
  })

  it('dedupes repeated misses by name — one entry in `misses` even if the same uncached package is installed twice in one command', () => {
    const cache = new PackageVerifierCache(stateDir)
    const specs = [
      { name: 'dup-pkg', manager: 'npm' as const, raw: 'dup-pkg' },
      { name: 'dup-pkg', requestedVersion: '2.0.0', manager: 'npm' as const, raw: 'dup-pkg@2.0.0' },
    ]
    const { results, misses } = checkPackagesCacheOnly(specs, cache)
    expect(results.length).toBe(2) // one placeholder per input spec
    expect(misses.length).toBe(1) // but only one real lookup queued
  })

  it('scheduleBackgroundVerification fills the cache without the caller awaiting it in production — a second cache-only check then denies a nonexistent package', async () => {
    const { fetchImpl, calls } = makeMockRegistry({}) // 404 for everything -> not_found for an unscoped name
    const cache = new PackageVerifierCache(stateDir)
    const specs = [{ name: 'second-look-hallucinated-pkg', manager: 'npm' as const, raw: 'second-look-hallucinated-pkg' }]

    const first = checkPackagesCacheOnly(specs, cache)
    expect(first.misses.length).toBe(1)
    expect(decidePackageAction(first.results, 30).reason).toBe('unverified') // not_yet_checked -> prompt, not deny

    // Exactly how pipeline.ts fires this: NOT awaited before the caller's
    // own fast-path assertion above. Awaited here only so this test can
    // then assert on what it left behind.
    await scheduleBackgroundVerification(first.misses, { fetchImpl, cache, registryBaseUrl: 'https://mock.invalid' })
    // 2 calls: the existence lookup (404) plus the did-you-mean search a
    // not_found verdict triggers (see checkPackages/searchDidYouMean).
    expect(calls.length).toBe(2)

    const second = checkPackagesCacheOnly(specs, cache)
    expect(second.misses).toEqual([])
    expect(second.results[0].fromCache).toBe(true)
    expect(second.results[0].verdict).toBe('not_found')
    expect(decidePackageAction(second.results, 30).reason).toBe('not_found')
  })

  it('never rejects even if the underlying lookup throws — a failed background fill degrades to "try again next time", never an unhandled rejection', async () => {
    const throwingFetch = (async () => { throw new Error('simulated hard failure') }) as unknown as typeof fetch
    const cache = new PackageVerifierCache(stateDir)
    const specs = [{ name: 'will-network-error', manager: 'npm' as const, raw: 'will-network-error' }]
    await expect(
      scheduleBackgroundVerification(specs, { fetchImpl: throwingFetch, cache, registryBaseUrl: 'https://mock.invalid' }),
    ).resolves.toBeUndefined()
    // network_error still gets cached as 'unverified' (checkPackages' own behavior, unchanged) — a repeat prompts, never crashes.
    expect(cache.get('will-network-error')?.verdict).toBe('unverified')
  })

  it('resolves immediately without constructing any work when there are zero misses', async () => {
    const angryFetch = (async () => { throw new Error('should never be called for zero misses') }) as unknown as typeof fetch
    await expect(scheduleBackgroundVerification([], { fetchImpl: angryFetch })).resolves.toBeUndefined()
  })
})

// ── registry base URL safety net ────────────────────────────────────

describe('defaultRegistryBaseUrl', () => {
  it('honors an explicit KEEL_NPM_REGISTRY override', () => {
    const prior = process.env.KEEL_NPM_REGISTRY
    try {
      process.env.KEEL_NPM_REGISTRY = 'https://custom.registry.example'
      expect(defaultRegistryBaseUrl()).toBe('https://custom.registry.example')
    } finally {
      if (prior === undefined) delete process.env.KEEL_NPM_REGISTRY
      else process.env.KEEL_NPM_REGISTRY = prior
    }
  })

  it('defaults to a closed loopback port under vitest with no override — never the real registry in unit tests', () => {
    const priorRegistry = process.env.KEEL_NPM_REGISTRY
    delete process.env.KEEL_NPM_REGISTRY
    try {
      expect(process.env.VITEST).toBeTruthy() // sanity: confirms the branch this test exercises
      expect(defaultRegistryBaseUrl()).toBe('http://127.0.0.1:1')
    } finally {
      if (priorRegistry !== undefined) process.env.KEEL_NPM_REGISTRY = priorRegistry
    }
  })
})

// ── opt-in live integration test ────────────────────────────────────
//
// Skipped by default — set KEEL_LIVE_REGISTRY_TEST=1 to run it. Everything
// above this point mocks the registry; this is the one test that hits the
// REAL registry.npmjs.org, to answer a question no mock can: does a large
// real package's full packument (multi-MB for popular names — embedded
// per-version readmes are a known npm registry quirk) fit inside the 2s
// budget and the byte cap, and does `time.created` actually show up in the
// shape package-verifier.ts expects?

const LIVE = process.env.KEEL_LIVE_REGISTRY_TEST === '1'

describe.skipIf(!LIVE)('live npm registry (opt-in, KEEL_LIVE_REGISTRY_TEST=1)', () => {
  it('a real, large, popular package resolves within the budget with a usable creation date', async () => {
    const cache = new PackageVerifierCache(mkdtempSync(join(tmpdir(), 'keel-pkgverify-live-')))
    const started = Date.now()
    const [r] = await checkPackages(
      // Explicit registryBaseUrl: defaultRegistryBaseUrl()'s VITEST safety
      // net would otherwise redirect this deliberately-live test to the
      // closed loopback port too — that guard is for the OTHER 40+ tests
      // in this file that never intend to touch the network.
      [{ name: 'react', manager: 'npm', raw: 'react' }],
      { cache, totalTimeoutMs: 2000, registryBaseUrl: 'https://registry.npmjs.org' },
    )
    const elapsedMs = Date.now() - started
    expect(elapsedMs).toBeLessThan(2500) // budget + generous scheduling slack
    // Never a wrong deny: either it resolved (exists, with an age far past
    // any reasonable threshold) or it degraded to unverified (too_large /
    // timeout) — both are safe outcomes for a legitimate package.
    expect(['exists', 'unverified']).toContain(r.verdict)
    if (r.verdict === 'exists') {
      expect(r.ageDays).toBeGreaterThan(365)
    } else {
      expect(['too_large', 'timeout', 'network_error']).toContain(r.reason)
    }
  }, 10_000)

  it('a definitely-nonexistent package name 404s for real', async () => {
    const cache = new PackageVerifierCache(mkdtempSync(join(tmpdir(), 'keel-pkgverify-live-')))
    const [r] = await checkPackages(
      [{ name: 'keel-slopsquat-live-test-package-should-never-exist-9f3a8b2c1d', manager: 'npm', raw: 'x' }],
      { cache, totalTimeoutMs: 2000, registryBaseUrl: 'https://registry.npmjs.org' },
    )
    expect(r.verdict).toBe('not_found')
  }, 10_000)
})

// ── rule-parser validation ──────────────────────────────────────────

describe('package rule validation', () => {
  it('parses and validates cleanly with default age_days', () => {
    const yaml = `version: 1\nrules:\n  - id: pkg-rule\n    type: package\n    action: prompt\n    message: "Verify before install."\n`
    const parsed = parseRulesContent(yaml, '/tmp/pkg.yaml')
    expect(parsed.errors ?? []).toEqual([])
    expect(validateRules(parsed.rules)).toEqual([])
  })

  it('rejects a negative age_days', () => {
    const yaml = `version: 1\nrules:\n  - id: pkg-rule\n    type: package\n    action: prompt\n    age_days: -5\n    message: "Verify before install."\n`
    const parsed = parseRulesContent(yaml, '/tmp/pkg.yaml')
    expect(validateRules(parsed.rules).length).toBeGreaterThan(0)
  })
})
