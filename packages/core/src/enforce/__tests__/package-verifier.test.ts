import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
  defaultPypiBaseUrl,
  defaultCratesBaseUrl,
  defaultGoProxyBaseUrl,
  type PackageCheckResult,
} from '../package-verifier.js'
import {
  applyAmbientConfig,
  AmbientConfigCache,
  resolveNpmAmbient,
  resolveCargoAmbient,
  matchesGoPrivate,
} from '../ambient-registry-config.js'
import { rmSafe } from './helpers/fs-safe.js'
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
  afterEach(() => { rmSafe(stateDir) })

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
  afterEach(() => { rmSafe(stateDir) })

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

describe('defaultPypiBaseUrl / defaultCratesBaseUrl / defaultGoProxyBaseUrl (same safety net as npm)', () => {
  const cases: Array<{ label: string; envVar: string; fn: () => string }> = [
    { label: 'pypi', envVar: 'KEEL_PYPI_REGISTRY', fn: defaultPypiBaseUrl },
    { label: 'crates', envVar: 'KEEL_CRATES_REGISTRY', fn: defaultCratesBaseUrl },
    { label: 'go proxy', envVar: 'KEEL_GO_PROXY', fn: defaultGoProxyBaseUrl },
  ]

  for (const { label, envVar, fn } of cases) {
    it(`${label}: honors an explicit ${envVar} override`, () => {
      const prior = process.env[envVar]
      try {
        process.env[envVar] = 'https://custom.example.invalid'
        expect(fn()).toBe('https://custom.example.invalid')
      } finally {
        if (prior === undefined) delete process.env[envVar]
        else process.env[envVar] = prior
      }
    })

    it(`${label}: defaults to a closed loopback port under vitest with no override — never the real registry in unit tests`, () => {
      const prior = process.env[envVar]
      delete process.env[envVar]
      try {
        expect(process.env.VITEST).toBeTruthy()
        expect(fn()).toBe('http://127.0.0.1:1')
      } finally {
        if (prior !== undefined) process.env[envVar] = prior
      }
    })
  }
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

// ═══════════════════════════════════════════════════════════════════
// Multi-ecosystem widening: PyPI (pip/pip3/uv/poetry), crates.io (cargo),
// Go module proxy (go get/install). See package-verifier.ts's module
// header for the full rationale; each block below is labeled with the
// audit finding (3a-3f) it exists to cover.
// ═══════════════════════════════════════════════════════════════════

// ── extraction: new ecosystems recognized ───────────────────────────

describe('extractPackageInstalls: new ecosystems', () => {
  it('extracts pip install, pip3 install, poetry add, cargo add, go get, go install', () => {
    expect(extractPackageInstalls('pip install requests')[0]).toMatchObject({ name: 'requests', manager: 'pip' })
    expect(extractPackageInstalls('pip3 install requests')[0]).toMatchObject({ name: 'requests', manager: 'pip3' })
    expect(extractPackageInstalls('poetry add requests')[0]).toMatchObject({ name: 'requests', manager: 'poetry' })
    expect(extractPackageInstalls('cargo add rand')[0]).toMatchObject({ name: 'rand', manager: 'cargo' })
    expect(extractPackageInstalls('go get golang.org/x/tools')[0]).toMatchObject({ name: 'golang.org/x/tools', manager: 'go' })
    expect(extractPackageInstalls('go install golang.org/x/tools/gopls@latest')[0]).toMatchObject({ name: 'golang.org/x/tools/gopls', manager: 'go', requestedVersion: 'latest' })
  })

  it('extracts both uv forms: uv add and uv pip install', () => {
    expect(extractPackageInstalls('uv add requests')[0]).toMatchObject({ name: 'requests', manager: 'uv' })
    expect(extractPackageInstalls('uv pip install requests')[0]).toMatchObject({ name: 'requests', manager: 'uv' })
  })

  it('cargo and go use @-splitting for version, same as npm', () => {
    expect(extractPackageInstalls('cargo add rand@0.8.5')[0]).toMatchObject({ name: 'rand', requestedVersion: '0.8.5' })
    expect(extractPackageInstalls('go get github.com/foo/bar@v1.2.3')[0]).toMatchObject({ name: 'github.com/foo/bar', requestedVersion: 'v1.2.3' })
  })

  it('deliberately does NOT match cargo install (a different subcommand than cargo add)', () => {
    expect(extractPackageInstalls('cargo install ripgrep')).toEqual([])
  })

  it('a bare add/install with no package args extracts nothing, for every new manager', () => {
    expect(extractPackageInstalls('pip install')).toEqual([])
    expect(extractPackageInstalls('poetry add')).toEqual([])
    expect(extractPackageInstalls('cargo add')).toEqual([])
    expect(extractPackageInstalls('go get')).toEqual([])
    expect(extractPackageInstalls('uv pip install')).toEqual([])
  })

  it('detects python -m pip install / python3 -m pip install identically to a bare pip install', () => {
    expect(extractPackageInstalls('python -m pip install requests')[0]).toMatchObject({ name: 'requests', manager: 'pip' })
    expect(extractPackageInstalls('python3 -m pip install requests')[0]).toMatchObject({ name: 'requests', manager: 'pip' })
    expect(extractPackageInstalls('python -m pip3 install requests')[0]).toMatchObject({ name: 'requests', manager: 'pip3' })
    expect(extractPackageInstalls('python -m pip install requests flask')).toHaveLength(2)
    expect(extractPackageInstalls('python -m pip install requests==2.31.0')[0]).toMatchObject({ name: 'requests', requestedVersion: '==2.31.0' })
  })

  it('detects versioned python basenames (python3.11, python3.12) identically to plain python3', () => {
    expect(extractPackageInstalls('python3.11 -m pip install requests')[0]).toMatchObject({ name: 'requests', manager: 'pip' })
    expect(extractPackageInstalls('python3.12 -m pip install requests')[0]).toMatchObject({ name: 'requests', manager: 'pip' })
  })

  it('does not misfire on a python-prefixed but non-interpreter basename like python-config', () => {
    expect(extractPackageInstalls('python-config -m pip install x')).toEqual([])
  })

  it('python -m pip install with no package args extracts nothing', () => {
    expect(extractPackageInstalls('python -m pip install')).toEqual([])
    expect(extractPackageInstalls('python -m pip install -r requirements.txt')).toEqual([])
  })

  it('does not misfire on unrelated python -m invocations', () => {
    expect(extractPackageInstalls('python -m http.server')).toEqual([])
    expect(extractPackageInstalls('python -m venv .venv')).toEqual([])
  })
})

// ── finding 3a: flag-value tokens must not be misread as package names ──

describe('finding 3a: per-manager flag-value consuming table', () => {
  it('pip install -r requirements.txt extracts NOTHING — must never false-deny on a requirements file', () => {
    expect(extractPackageInstalls('pip install -r requirements.txt')).toEqual([])
    expect(extractPackageInstalls('pip install --requirement requirements.txt')).toEqual([])
  })

  it('discriminating case: -t/--target DOES consume its value, but a real package after it still extracts', () => {
    expect(extractPackageInstalls('pip install -t /tmp/vendor requests')).toEqual([
      { name: 'requests', requestedVersion: undefined, manager: 'pip', raw: 'requests' },
    ])
  })

  it('pip -c/--index-url/--extra-index-url values are consumed, not treated as package names', () => {
    expect(extractPackageInstalls('pip install -c constraints.txt django')[0].name).toBe('django')
    expect(extractPackageInstalls('pip install -c constraints.txt django').length).toBe(1)
  })

  it('cargo --vers/--registry/--rename/--manifest-path values are consumed', () => {
    expect(extractPackageInstalls('cargo add rand --vers 0.8.5')).toEqual([
      { name: 'rand', requestedVersion: undefined, manager: 'cargo', raw: 'rand' },
    ])
    expect(extractPackageInstalls('cargo add --registry my-registry rand')[0].name).toBe('rand')
    expect(extractPackageInstalls('cargo add --registry my-registry rand').length).toBe(1)
    expect(extractPackageInstalls('cargo add --rename myrand rand')[0].name).toBe('rand')
    expect(extractPackageInstalls('cargo add --manifest-path ../other/Cargo.toml serde')[0].name).toBe('serde')
  })

  it('poetry --source/--python/--extras values are consumed', () => {
    expect(extractPackageInstalls('poetry add --source my-source requests')[0].name).toBe('requests')
    expect(extractPackageInstalls('poetry add --source my-source requests').length).toBe(1)
    expect(extractPackageInstalls('poetry add --python 3.11 requests')[0].name).toBe('requests')
  })

  it('npm flag-skip behavior is byte-identical to before (no consuming table for npm-family)', () => {
    // Regression proof: FLAG_VALUE_CONSUMING has no npm entry, so npm still
    // only skips the flag token itself, never a following token — exactly
    // the pre-existing behavior asserted in the "ignores flags interspersed"
    // test above.
    expect(extractPackageInstalls('npm install --registry my-registry lodash').map(s => s.name)).toEqual(['my-registry', 'lodash'])
  })
})

// ── finding 3f: pip extras + PEP 440 operators, never npm-style @-split ──

describe('finding 3f: pip-specific spec grammar', () => {
  it('strips [extras] before validating the name', () => {
    expect(extractPackageInstalls('pip install black[jupyter]')).toEqual([
      { name: 'black', requestedVersion: undefined, manager: 'pip', raw: 'black[jupyter]' },
    ])
  })

  it('splits a PEP 440 comparison operator off as the version, not on @', () => {
    expect(extractPackageInstalls('pip install "foo>=1.0"')[0]).toMatchObject({ name: 'foo', requestedVersion: '>=1.0' })
    expect(extractPackageInstalls('pip install "foo==1.2.3"')[0]).toMatchObject({ name: 'foo', requestedVersion: '==1.2.3' })
  })

  it('extras AND a version operator together', () => {
    expect(extractPackageInstalls('pip install "black[jupyter]>=22.0"')[0]).toMatchObject({ name: 'black', requestedVersion: '>=22.0' })
  })

  it('a PEP 508 URL reference (name @ url) is skipped entirely — NOT misparsed as a version pin', () => {
    expect(extractPackageInstalls('pip install foo @ https://example.com/foo-1.0.whl')).toEqual([])
    // uv pip install shares the same pip grammar.
    expect(extractPackageInstalls('uv pip install foo @ https://example.com/foo-1.0.whl')).toEqual([])
  })

  it('a bare pip package name with no extras/version parses cleanly', () => {
    expect(extractPackageInstalls('pip install requests')).toEqual([
      { name: 'requests', requestedVersion: undefined, manager: 'pip', raw: 'requests' },
    ])
  })
})

// ── finding 3b: PyPI private-index extraction marking ──────────────

describe('finding 3b: private-index flag detection at extraction time', () => {
  it('marks every spec privateIndex when --index-url is present, regardless of flag order', () => {
    // explicitRegistryOverride (new, ambient-config lane): the flag's VALUE,
    // captured alongside privateIndex so applyAmbientConfig can tell an
    // ordinary private-index install apart from the dependency-confusion
    // shape (see ambient-registry-config.ts).
    const before = extractPackageInstalls('pip install --index-url https://pypi.mycompany.com/simple mycompany-tool')
    expect(before).toEqual([{
      name: 'mycompany-tool', requestedVersion: undefined, manager: 'pip', raw: 'mycompany-tool',
      privateIndex: true, explicitRegistryOverride: 'https://pypi.mycompany.com/simple',
    }])

    const after = extractPackageInstalls('pip install mycompany-tool --index-url https://pypi.mycompany.com/simple')
    expect(after).toEqual([{
      name: 'mycompany-tool', requestedVersion: undefined, manager: 'pip', raw: 'mycompany-tool',
      privateIndex: true, explicitRegistryOverride: 'https://pypi.mycompany.com/simple',
    }])
  })

  it('-i and --extra-index-url both trigger it too', () => {
    expect(extractPackageInstalls('pip install -i https://pypi.mycompany.com/simple mycompany-tool')[0].privateIndex).toBe(true)
    expect(extractPackageInstalls('pip install --extra-index-url https://pypi.mycompany.com/simple mycompany-tool')[0].privateIndex).toBe(true)
  })

  it('an ordinary pip install with no index flag never sets privateIndex (key omitted, not false)', () => {
    const specs = extractPackageInstalls('pip install requests')
    expect(specs[0]).not.toHaveProperty('privateIndex')
  })
})

// ── new-ecosystem registry mocks ────────────────────────────────────

function pypiJson(releases: Record<string, string[]>): Record<string, unknown> {
  const body: Record<string, Array<{ upload_time_iso_8601: string }>> = {}
  for (const [version, isoTimes] of Object.entries(releases)) {
    body[version] = isoTimes.map(t => ({ upload_time_iso_8601: t }))
  }
  return { releases: body }
}

function makeMockPyPi(behaviors: Record<string, 'not_found' | 'timeout' | { releases: Record<string, string[]> }>) {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString()
    calls.push(href)
    const m = href.match(/\/([^/]+)\/json$/)
    const name = m ? decodeURIComponent(m[1]) : ''
    const behavior = behaviors[name]
    if (!behavior) return jsonResponse(null, 404)
    if (behavior === 'not_found') return jsonResponse(null, 404)
    if (behavior === 'timeout') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }
    return jsonResponse(pypiJson(behavior.releases))
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function makeMockCrates(behaviors: Record<string, 'not_found' | { createdAt: string }>) {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    const href = typeof url === 'string' ? url : url.toString()
    calls.push(href)
    const name = decodeURIComponent(href.split('/').pop() || '')
    const behavior = behaviors[name]
    if (!behavior) return jsonResponse(null, 404)
    if (behavior === 'not_found') return jsonResponse(null, 404)
    return jsonResponse({ crate: { created_at: behavior.createdAt } })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** existingModules holds UN-escaped module paths (e.g. "github.com/foo/bar"); the mock reverses the proxy's `!`-lowercase escaping to match against it, proving the real escaping path round-trips correctly. */
function makeMockGoProxy(existingModules: Set<string>) {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    const href = typeof url === 'string' ? url : url.toString()
    calls.push(href)
    const m = href.match(/^https?:\/\/[^/]+\/(.+)\/@v\/list$/)
    const escapedPath = m ? m[1] : ''
    const path = escapedPath.replace(/!([a-z])/g, (_match, c: string) => c.toUpperCase())
    if (existingModules.has(path)) return new Response('v1.0.0\n', { status: 200, headers: { 'content-type': 'text/plain' } })
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function combineFetch(routes: Array<{ prefix: string; fetchImpl: typeof fetch }>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString()
    for (const r of routes) {
      if (href.startsWith(r.prefix)) return (r.fetchImpl as unknown as (u: string | URL, i?: RequestInit) => Promise<Response>)(url, init)
    }
    throw new Error(`no mock route registered for ${href}`)
  }) as unknown as typeof fetch
}

// ── finding 3d: PyPI age gate MUST use first-ever publish, not latest ──

describe('finding 3d: PyPI age gate uses min(upload_time) across ALL releases, never the latest', () => {
  it('a package whose LATEST release is 2 days old but whose EARLIEST release is 400 days old is NOT age-gated', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-pypi-'))
    const { fetchImpl } = makeMockPyPi({
      'sneaky-repackage': {
        releases: {
          '1.0.0': [daysAgoIso(400)],
          '1.0.1': [daysAgoIso(200)],
          '2.0.0': [daysAgoIso(2)], // the LATEST release — this is the wrong field a naive port would key off
        },
      },
    })
    const [r] = await checkPackages(
      [{ name: 'sneaky-repackage', manager: 'pip', raw: 'sneaky-repackage' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), pypiBaseUrl: 'https://mock-pypi.invalid' },
    )
    expect(r.verdict).toBe('exists')
    // The discriminating assertion: a `urls[0].upload_time`-style (latest-
    // release) implementation would report ~2 days here, not >300.
    expect(r.ageDays).toBeGreaterThan(300)
    expect(decidePackageAction([r], 30).reason).toBe('ok') // allow — correctly NOT age-gated
    rmSafe(stateDir)
  })

  it('a genuinely brand-new PyPI package (single release, 2 days old) IS age-gated', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-pypi-'))
    const { fetchImpl } = makeMockPyPi({ 'brand-new-pypi-pkg': { releases: { '1.0.0': [daysAgoIso(2)] } } })
    const [r] = await checkPackages(
      [{ name: 'brand-new-pypi-pkg', manager: 'pip', raw: 'brand-new-pypi-pkg' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), pypiBaseUrl: 'https://mock-pypi.invalid' },
    )
    expect(r.verdict).toBe('exists')
    expect(r.ageDays).toBeLessThan(3)
    expect(decidePackageAction([r], 30).reason).toBe('age_gate')
    rmSafe(stateDir)
  })

  it('a nonexistent PyPI package -> not_found (unscoped 404 IS deterministic on PyPI, unlike npm scoped names)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-pypi-'))
    const { fetchImpl } = makeMockPyPi({})
    const [r] = await checkPackages(
      [{ name: 'totally-hallucinated-pypi-pkg', manager: 'pip', raw: 'totally-hallucinated-pypi-pkg' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), pypiBaseUrl: 'https://mock-pypi.invalid' },
    )
    expect(r.verdict).toBe('not_found')
    // Did-you-mean is npm-only (its search endpoint has no PyPI equivalent).
    expect(r.didYouMean).toBeUndefined()
    rmSafe(stateDir)
  })
})

// ── finding 3b (network layer): private-index specs never query anything ──

describe('finding 3b: private-index specs are never queried against any network endpoint', () => {
  it('checkPackages resolves to unverified/private_index without ever calling fetch', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-prividx-'))
    const angryFetch = (async () => { throw new Error('SSRF: private-index spec must never be queried') }) as unknown as typeof fetch
    const [r] = await checkPackages(
      [{ name: 'mycompany-tool', manager: 'pip', raw: 'mycompany-tool', privateIndex: true }],
      { fetchImpl: angryFetch, cache: new PackageVerifierCache(stateDir), pypiBaseUrl: 'https://mock-pypi.invalid' },
    )
    expect(r.verdict).toBe('unverified')
    expect(r.reason).toBe('private_index')
    expect(decidePackageAction([r], 30).reason).toBe('unverified')
    expect(decidePackageAction([r], 30).message).toContain('non-default package index')
    rmSafe(stateDir)
  })

  it('checkPackagesCacheOnly resolves it directly too — never a cache miss, never queued for background fill', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-prividx-cacheonly-'))
    const cache = new PackageVerifierCache(stateDir)
    const specs = [{ name: 'mycompany-tool', manager: 'pip' as const, raw: 'mycompany-tool', privateIndex: true }]
    const { results, misses } = checkPackagesCacheOnly(specs, cache)
    expect(results).toEqual([{ name: 'mycompany-tool', requestedVersion: undefined, verdict: 'unverified', reason: 'private_index', fromCache: false }])
    expect(misses).toEqual([]) // critical: never queued — see finding 3c note about not caching this under pypi:<name>
    rmSafe(stateDir)
  })

  it('a later PLAIN pip install of the same name (no --index-url this time) is unaffected — proves private_index is never cached under the bare name', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-prividx-nocache-'))
    const cache = new PackageVerifierCache(stateDir)
    const { fetchImpl } = makeMockPyPi({ 'mycompany-tool': { releases: { '1.0.0': [daysAgoIso(2000)] } } })

    await checkPackages([{ name: 'mycompany-tool', manager: 'pip', raw: 'mycompany-tool', privateIndex: true }], { cache, pypiBaseUrl: 'https://mock-pypi.invalid' })
    // Real lookup for the SAME name, no privateIndex flag this time.
    const [r] = await checkPackages([{ name: 'mycompany-tool', manager: 'pip', raw: 'mycompany-tool' }], { fetchImpl, cache, pypiBaseUrl: 'https://mock-pypi.invalid' })
    expect(r.verdict).toBe('exists') // not poisoned by the earlier private_index verdict
    rmSafe(stateDir)
  })
})

// ── finding 3c: cache/dedup namespaced by (ecosystem, name), not bare name ──

describe('finding 3c: cache and in-call dedup keyed by (ecosystem, name)', () => {
  it('PackageVerifierCache: an npm entry for "foo" does not leak into a pypi lookup for "foo"', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-nsdup-'))
    const cache = new PackageVerifierCache(stateDir)
    const now = Date.now()
    cache.set({ name: 'foo', ecosystem: 'npm', verdict: 'not_found', checkedAt: now }, now)
    expect(cache.get('foo', now, 'npm')?.verdict).toBe('not_found')
    expect(cache.get('foo', now, 'pypi')).toBeNull() // no cross-ecosystem bleed
    rmSafe(stateDir)
  })

  it('npm install foo && cargo add foo in ONE command queries BOTH registries independently — not a single deduped lookup', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-crossdedup-'))
    const npmMock = makeMockRegistry({ foo: 'not_found' }) // npm: hallucinated
    const cratesMock = makeMockCrates({ foo: { createdAt: daysAgoIso(2000) } }) // crates: real, old
    const fetchImpl = combineFetch([
      { prefix: 'https://mock-npm.invalid', fetchImpl: npmMock.fetchImpl },
      { prefix: 'https://mock-crates.invalid', fetchImpl: cratesMock.fetchImpl },
    ])
    const specs = extractPackageInstalls('npm install foo && cargo add foo')
    expect(specs.map(s => s.manager)).toEqual(['npm', 'cargo'])

    const results = await checkPackages(specs, {
      fetchImpl,
      cache: new PackageVerifierCache(stateDir),
      registryBaseUrl: 'https://mock-npm.invalid',
      cratesBaseUrl: 'https://mock-crates.invalid',
    })
    expect(results.map(r => r.verdict)).toEqual(['not_found', 'exists']) // two DIFFERENT verdicts for the "same" bare name proves no collision
    expect(npmMock.calls.length).toBeGreaterThanOrEqual(1)
    expect(cratesMock.calls.length).toBe(1)
    rmSafe(stateDir)
  })

  it('checkPackagesCacheOnly misses are deduped per (ecosystem, name), not bare name — two ecosystems, same name, both queued', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-crossdedup-cacheonly-'))
    const cache = new PackageVerifierCache(stateDir)
    const specs = [
      { name: 'foo', manager: 'npm' as const, raw: 'foo' },
      { name: 'foo', manager: 'cargo' as const, raw: 'foo' },
    ]
    const { misses } = checkPackagesCacheOnly(specs, cache)
    expect(misses.length).toBe(2) // NOT deduped away — different ecosystems
    rmSafe(stateDir)
  })
})

// ── finding 3e: Go module proxy 404s map to unverified, never not_found ──

describe('finding 3e: Go module proxy subpackage-404 handling', () => {
  it('a real module at the literal path resolves directly, exists, single request', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-go-'))
    const { fetchImpl, calls } = makeMockGoProxy(new Set(['golang.org/x/tools']))
    const [r] = await checkPackages(
      [{ name: 'golang.org/x/tools', manager: 'go', raw: 'golang.org/x/tools' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), goProxyBaseUrl: 'https://mock-go.invalid' },
    )
    expect(r.verdict).toBe('exists')
    expect(calls.length).toBe(1) // no retry needed
    rmSafe(stateDir)
  })

  it('a real SUBPACKAGE (module root exists one segment up) -> unverified, NEVER not_found/deny', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-go-sub-'))
    const { fetchImpl, calls } = makeMockGoProxy(new Set(['github.com/user/repo'])) // the module ROOT exists; the literal queried path is one segment deeper
    const [r] = await checkPackages(
      [{ name: 'github.com/user/repo/subpkg', manager: 'go', raw: 'github.com/user/repo/subpkg' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), goProxyBaseUrl: 'https://mock-go.invalid' },
    )
    expect(r.verdict).toBe('unverified')
    expect(r.verdict).not.toBe('not_found')
    expect(r.reason).toBe('go_ambiguous')
    expect(decidePackageAction([r], 30).message).toContain('subpackage')
    expect(calls.length).toBe(2) // literal path, then exactly one segment shorter
    rmSafe(stateDir)
  })

  it('a genuinely nonexistent Go module (both the literal path AND one segment up 404) -> STILL unverified, never not_found', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-go-fake-'))
    const { fetchImpl, calls } = makeMockGoProxy(new Set()) // nothing exists
    const [r] = await checkPackages(
      [{ name: 'github.com/totally/hallucinated-repo', manager: 'go', raw: 'github.com/totally/hallucinated-repo' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), goProxyBaseUrl: 'https://mock-go.invalid' },
    )
    expect(r.verdict).toBe('unverified')
    expect(r.verdict).not.toBe('not_found') // the mandate is unconditional — Go never denies on a 404
    expect(calls.length).toBe(2) // one retry, never walked further toward the domain root
    rmSafe(stateDir)
  })

  it('the retry never walks past ONE segment shorter — a 2-segment path with no shorter form available does not retry a 3rd time', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-go-root-'))
    const { fetchImpl, calls } = makeMockGoProxy(new Set())
    const [r] = await checkPackages(
      [{ name: 'onesegment', manager: 'go', raw: 'onesegment' }], // no slash at all -> shortenGoModulePath returns null
      { fetchImpl, cache: new PackageVerifierCache(stateDir), goProxyBaseUrl: 'https://mock-go.invalid' },
    )
    expect(r.verdict).toBe('unverified')
    expect(calls.length).toBe(1) // no retry possible, no retry attempted
    rmSafe(stateDir)
  })

  it('DOCUMENTED GAP: a same-day Go module still ALLOWS — no age signal is derived for Go (see checkGoExistence header)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-go-noage-'))
    const { fetchImpl } = makeMockGoProxy(new Set(['github.com/brand-new/module']))
    const [r] = await checkPackages(
      [{ name: 'github.com/brand-new/module', manager: 'go', raw: 'github.com/brand-new/module' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), goProxyBaseUrl: 'https://mock-go.invalid' },
    )
    expect(r.verdict).toBe('exists')
    expect(r.ageDays).toBeUndefined()
    expect(decidePackageAction([r], 30).reason).toBe('ok') // allow — the documented, deliberate scope gap
    rmSafe(stateDir)
  })
})

// ── crates.io basic existence + age (uses the crate's own created_at) ──

describe('crates.io existence + age', () => {
  it('an old, real crate allows', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-crates-'))
    const { fetchImpl } = makeMockCrates({ serde: { createdAt: daysAgoIso(3000) } })
    const [r] = await checkPackages(
      [{ name: 'serde', manager: 'cargo', raw: 'serde' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), cratesBaseUrl: 'https://mock-crates.invalid' },
    )
    expect(r.verdict).toBe('exists')
    expect(decidePackageAction([r], 30).reason).toBe('ok')
    rmSafe(stateDir)
  })

  it('a nonexistent crate -> not_found (crates.io has no scoped-name convention either)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-crates-404-'))
    const { fetchImpl } = makeMockCrates({})
    const [r] = await checkPackages(
      [{ name: 'totally-hallucinated-crate', manager: 'cargo', raw: 'totally-hallucinated-crate' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), cratesBaseUrl: 'https://mock-crates.invalid' },
    )
    expect(r.verdict).toBe('not_found')
    rmSafe(stateDir)
  })

  it('a fresh crate is age-gated', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'keel-pkgverify-crates-fresh-'))
    const { fetchImpl } = makeMockCrates({ 'brand-new-crate': { createdAt: daysAgoIso(5) } })
    const [r] = await checkPackages(
      [{ name: 'brand-new-crate', manager: 'cargo', raw: 'brand-new-crate' }],
      { fetchImpl, cache: new PackageVerifierCache(stateDir), cratesBaseUrl: 'https://mock-crates.invalid' },
    )
    expect(decidePackageAction([r], 30).reason).toBe('age_gate')
    rmSafe(stateDir)
  })
})

// ── pipeline wiring: private-index install through the real pipeline ──

describe('pipeline: finding 3b end-to-end — a private-index pip install never denies and never queries the network', () => {
  it('prompts immediately (not "not yet checked") and the mock is never called', async () => {
    const angryFetch = (async () => { throw new Error('should never be called for a private-index spec') }) as unknown as typeof fetch
    const pipeline = buildPipeline(PACKAGE_RULE, angryFetch)
    const res = await pipeline.evaluate(makeInput('pip install --index-url https://pypi.mycompany.com/simple mycompany-tool'))
    expect(res.action).toBe('prompt')
    expect(res.action).not.toBe('deny')
    expect(res.message).toContain('non-default package index')
  })

  it('pip install -r requirements.txt never triggers the rule at all (finding 3a, end-to-end)', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return jsonResponse({}) }) as unknown as typeof fetch
    const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl)
    const res = await pipeline.evaluate(makeInput('pip install -r requirements.txt'))
    expect(res.action).toBe('allow')
    expect(called).toBe(false)
  })
})

// ── ambient-config lane: closes the confirmed false-deny bug ───────────
//
// unverified-package-install ships with no mode/level and pipeline.ts's
// not_found branch applies a hard, first-strike deny (skipFirstWarning) —
// a team whose internal registry is configured ONLY through .npmrc/
// pip.conf/.cargo/config.toml/GOPRIVATE, with no command-line signal, got
// its own legitimate packages denied on the first try. applyAmbientConfig
// (ambient-registry-config.ts) reads the same ambient config a real
// package manager would and downgrades the name via the EXISTING
// privateIndex path — see that module's header for the full rationale.

function makeScratchDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Same VITEST-aware safety net every ambient-config read is gated behind
 * (see ambient-registry-config.ts's own header) — passed explicitly here
 * because these tests call `applyAmbientConfig`/`resolveNpmAmbient`/
 * `resolveCargoAmbient` DIRECTLY with a hand-built env object, which (unlike
 * `process.env` under a real vitest run) has no `VITEST` key of its own.
 * Without this, `ambientEnabled`/`ambientHomeDir` would fall through to the
 * REAL machine's `$HOME` for any test that doesn't also set `KEEL_HOME` —
 * exactly the test-determinism failure mode this module's header warns
 * about, just one level up (test code forgetting to opt in, rather than
 * the module itself reading ambient state by default).
 */
const TEST_ENV: NodeJS.ProcessEnv = { VITEST: process.env.VITEST ?? '1' }

describe('ambient config: npm .npmrc downgrades a would-be-404 to unverified, never deny', () => {
  it('a project .npmrc registry= entry marks an unscoped name privateIndex, and decidePackageAction never reaches not_found', async () => {
    const cwd = makeScratchDir('keel-ambient-npmrc-')
    writeFileSync(join(cwd, '.npmrc'), 'registry=https://npm.corp.example/\n')
    try {
      const rawSpecs = extractPackageInstalls('npm install internal-build-tool')
      expect(rawSpecs[0]).not.toHaveProperty('privateIndex') // proves the extraction layer itself is untouched

      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      expect(specs[0].privateIndex).toBe(true)
      expect(specs[0].ambientSource).toBe('project .npmrc')

      // Would 404 -> not_found -> deny WITHOUT the ambient fix; the mock
      // would throw if ever called, proving privateIndex's existing
      // never-queried contract still holds for an ambient-sourced flag.
      const angryFetch = (async () => { throw new Error('must never query an ambient-marked private registry') }) as unknown as typeof fetch
      const results = await checkPackages(specs, { fetchImpl: angryFetch, cache: new PackageVerifierCache(makeScratchDir('keel-ambient-state-')) })
      expect(results[0].verdict).toBe('unverified')
      expect(results[0].reason).toBe('ambient_private_registry')

      const decision = decidePackageAction(results, 30)
      expect(decision.reason).toBe('unverified') // NOT not_found/deny
      expect(decision.message).toContain('ambient package-manager config')
    } finally {
      rmSafe(cwd)
    }
  })

  it('a scoped name resolves via @scope:registry=, independent of the default registry', () => {
    const cwd = makeScratchDir('keel-ambient-npmrc-scoped-')
    writeFileSync(join(cwd, '.npmrc'), '@myorg:registry=https://npm.corp.example/\n')
    try {
      const rawSpecs = extractPackageInstalls('npm install @myorg/internal-tool')
      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      expect(specs[0].privateIndex).toBe(true)
    } finally {
      rmSafe(cwd)
    }
  })

  it('no ambient config at all leaves the spec byte-identical (no behavior change)', () => {
    const cwd = makeScratchDir('keel-ambient-none-')
    try {
      const rawSpecs = extractPackageInstalls('npm install lodash')
      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      expect(specs).toEqual(rawSpecs)
      expect(specs[0]).not.toHaveProperty('privateIndex')
    } finally {
      rmSafe(cwd)
    }
  })

  it('the CACHE-ONLY hot path (checkPackagesCacheOnly — what pipeline.ts actually calls) also resolves an ambient-marked spec directly, never queuing it as a miss', () => {
    const cwd = makeScratchDir('keel-ambient-npmrc-cacheonly-')
    writeFileSync(join(cwd, '.npmrc'), 'registry=https://npm.corp.example/\n')
    try {
      const rawSpecs = extractPackageInstalls('npm install internal-build-tool')
      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      const cache = new PackageVerifierCache(makeScratchDir('keel-ambient-npmrc-cacheonly-state-'))
      const { results, misses } = checkPackagesCacheOnly(specs, cache)
      expect(results[0].verdict).toBe('unverified')
      expect(results[0].reason).toBe('ambient_private_registry')
      expect(misses).toEqual([]) // never queued for background verification — same contract as private_index (finding 3b)
    } finally {
      rmSafe(cwd)
    }
  })
})

describe('ambient config: pipeline end-to-end — the ambient-downgrade case resolves on the FIRST attempt, no retry needed', () => {
  it('an ambient-private package prompts immediately with the real ambient message (never "not yet checked"), where the no-.npmrc control needs a retry to deny', async () => {
    const cwdAmbient = makeScratchDir('keel-ambient-pipeline-first-')
    writeFileSync(join(cwdAmbient, '.npmrc'), 'registry=https://npm.corp.example/\n')
    const cwdControl = makeScratchDir('keel-ambient-pipeline-first-control-')
    try {
      const { fetchImpl } = makeMockRegistry({}) // would 404 -> not_found for either cwd; must never be queried for the ambient one
      const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl)

      // Ambient case: privateIndex resolves DIRECTLY in checkPackagesCacheOnly
      // (never queued as a miss — see the cache-only test above), so the
      // real ambient message lands on attempt ONE, not after a background
      // fill.
      const ambientResult = await pipeline.evaluate({ ...makeInput('npm install internal-build-tool'), cwd: cwdAmbient })
      expect(ambientResult.action).toBe('prompt')
      expect(ambientResult.message).not.toContain('not yet checked')
      expect(ambientResult.message).toContain('ambient package-manager config')

      // Control: the identical command with NO ambient config still gets
      // the ordinary "not yet checked" first-attempt placeholder — proving
      // the difference above is the ambient fix, not some other change.
      const controlResult = await pipeline.evaluate({ ...makeInput('npm install internal-build-tool'), cwd: cwdControl })
      expect(controlResult.action).toBe('prompt')
      expect(controlResult.message).toContain('not yet checked')
    } finally {
      rmSafe(cwdAmbient)
      rmSafe(cwdControl)
    }
  })
})

describe('ambient config: correctness discipline — malformed/unreadable config never crashes or changes behavior', () => {
  it('a directory sitting at the .npmrc path (unreadable as a file) does not throw, and the package is still evaluated normally (deny on a real 404)', async () => {
    const cwd = makeScratchDir('keel-ambient-badconfig-')
    mkdirSync(join(cwd, '.npmrc')) // a directory, not a file — readFileSync must throw EISDIR
    try {
      const rawSpecs = extractPackageInstalls('npm install totally-hallucinated-pkg-ambient-test')
      expect(() => applyAmbientConfig(rawSpecs, cwd, TEST_ENV)).not.toThrow()
      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      expect(specs[0]).not.toHaveProperty('privateIndex') // "assume public", no behavior change

      const { fetchImpl } = makeMockRegistry({}) // 404 for everything
      const results = await checkPackages(specs, { fetchImpl, cache: new PackageVerifierCache(makeScratchDir('keel-ambient-badconfig-state-')), registryBaseUrl: 'https://mock.invalid' })
      expect(decidePackageAction(results, 30).reason).toBe('not_found') // unaffected — still denies a real hallucination
    } finally {
      rmSafe(cwd)
    }
  })

  it('applyAmbientConfig itself never throws even given a pathological spec', () => {
    const cwd = makeScratchDir('keel-ambient-safety-')
    try {
      expect(() => applyAmbientConfig([{ name: 'x', manager: 'go', raw: 'x', inlineEnv: { GOPRIVATE: '[[[' } }], cwd, TEST_ENV)).not.toThrow()
      expect(matchesGoPrivate('anything', ['[[['])).toBe(false) // malformed glob -> no match, never a thrown error
    } finally {
      rmSafe(cwd)
    }
  })
})

describe('ambient config: cargo replace-with indirection', () => {
  it('a single-hop [source.crates-io] replace-with is followed to its target registry URL', () => {
    const cwd = makeScratchDir('keel-ambient-cargo-')
    mkdirSync(join(cwd, '.cargo'))
    writeFileSync(join(cwd, '.cargo', 'config.toml'), [
      '[source.crates-io]',
      'replace-with = "corp-mirror"',
      '',
      '[source.corp-mirror]',
      'registry = "sparse+https://corp.example/cargo/"',
      '',
    ].join('\n'))
    try {
      const ambient = resolveCargoAmbient(cwd, TEST_ENV)
      expect(ambient.replacementRegistry).toBe('sparse+https://corp.example/cargo/')

      const rawSpecs = extractPackageInstalls('cargo add internal-crate')
      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      expect(specs[0].privateIndex).toBe(true)
    } finally {
      rmSafe(cwd)
    }
  })

  it('a multi-hop replace-with chain (crates-io -> mirror-a -> mirror-b) is followed to the end', () => {
    const cwd = makeScratchDir('keel-ambient-cargo-chain-')
    mkdirSync(join(cwd, '.cargo'))
    writeFileSync(join(cwd, '.cargo', 'config.toml'), [
      '[source.crates-io]',
      'replace-with = "mirror-a"',
      '[source.mirror-a]',
      'replace-with = "mirror-b"',
      '[source.mirror-b]',
      'registry = "https://final.example/cargo/"',
      '',
    ].join('\n'))
    try {
      const ambient = resolveCargoAmbient(cwd, TEST_ENV)
      expect(ambient.replacementRegistry).toBe('https://final.example/cargo/')
    } finally {
      rmSafe(cwd)
    }
  })

  it('no replace-with -> replacementRegistry is undefined, no downgrade', () => {
    const cwd = makeScratchDir('keel-ambient-cargo-none-')
    try {
      expect(resolveCargoAmbient(cwd, TEST_ENV).replacementRegistry).toBeUndefined()
      const specs = applyAmbientConfig(extractPackageInstalls('cargo add serde'), cwd, TEST_ENV)
      expect(specs[0]).not.toHaveProperty('privateIndex')
    } finally {
      rmSafe(cwd)
    }
  })
})

describe('ambient config: GOPRIVATE inline on the command is extracted, not swallowed by the generic env-prefix skip', () => {
  it('captures inlineEnv.GOPRIVATE from an inline per-command assignment', () => {
    const specs = extractPackageInstalls('GOPRIVATE=github.com/corp/* go get github.com/corp/internal-tool')
    expect(specs[0].inlineEnv).toEqual({ GOPRIVATE: 'github.com/corp/*' })
  })

  it('a matching inline GOPRIVATE pattern marks the module privateIndex via applyAmbientConfig', () => {
    const cwd = makeScratchDir('keel-ambient-goprivate-')
    try {
      const rawSpecs = extractPackageInstalls('GOPRIVATE=github.com/corp/* go get github.com/corp/internal-tool')
      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      expect(specs[0].privateIndex).toBe(true)
      expect(specs[0].ambientSource).toContain('inline GOPRIVATE=')
    } finally {
      rmSafe(cwd)
    }
  })

  it('a non-matching inline GOPRIVATE pattern does NOT mark the module private (discriminating case)', () => {
    const cwd = makeScratchDir('keel-ambient-goprivate-nomatch-')
    try {
      const rawSpecs = extractPackageInstalls('GOPRIVATE=github.com/other/* go get github.com/corp/internal-tool')
      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      expect(specs[0]).not.toHaveProperty('privateIndex')
    } finally {
      rmSafe(cwd)
    }
  })

  it('matchesGoPrivate: a pattern matches the module and everything under it, per Go\'s own glob semantics', () => {
    expect(matchesGoPrivate('github.com/corp/tool', ['github.com/corp/*'])).toBe(true)
    expect(matchesGoPrivate('github.com/corp/tool/sub', ['github.com/corp/*'])).toBe(true)
    expect(matchesGoPrivate('github.com/other/tool', ['github.com/corp/*'])).toBe(false)
  })

  it('an inline assignment for an UNRELATED var is never captured (only the watched ambient-config names are)', () => {
    const specs = extractPackageInstalls('CI=true GOPRIVATE=github.com/corp/* go get github.com/corp/tool')
    expect(specs[0].inlineEnv).toEqual({ GOPRIVATE: 'github.com/corp/*' })
    expect(specs[0].inlineEnv).not.toHaveProperty('CI')
  })
})

describe('ambient config: dependency-confusion detection — ambient private + explicit public override', () => {
  it('npm: an ambient-private name force-installed with --registry=<public> is flagged dependencyConfusionRisk, and decidePackageAction returns dependency_confusion only when the package genuinely exists publicly', async () => {
    const cwd = makeScratchDir('keel-ambient-confusion-npm-')
    writeFileSync(join(cwd, '.npmrc'), 'registry=https://npm.corp.example/\n')
    try {
      const rawSpecs = extractPackageInstalls('npm install internal-tool --registry=https://registry.npmjs.org')
      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      expect(specs[0].dependencyConfusionRisk).toBe(true)
      expect(specs[0].privateIndex).not.toBe(true) // NOT the ordinary private-index path — it must still be queried

      // The squatted-name shape: the name genuinely EXISTS on the public
      // registry (old enough to clear the age gate too) -> warn.
      const { fetchImpl } = makeMockRegistry({ 'internal-tool': { existsDaysAgo: 2000 } })
      const results = await checkPackages(specs, { fetchImpl, cache: new PackageVerifierCache(makeScratchDir('keel-ambient-confusion-state-')), registryBaseUrl: 'https://mock.invalid' })
      const decision = decidePackageAction(results, 30)
      expect(decision.reason).toBe('dependency_confusion')
      expect(decision.message).toContain('dependency-confusion')
    } finally {
      rmSafe(cwd)
    }
  })

  it('SECURITY INVARIANT: dependency_confusion never outranks not_found — a hallucinated name forced to the public registry still denies', async () => {
    const cwd = makeScratchDir('keel-ambient-confusion-security-')
    writeFileSync(join(cwd, '.npmrc'), 'registry=https://npm.corp.example/\n')
    try {
      const rawSpecs = extractPackageInstalls('npm install totally-hallucinated-name --registry=https://registry.npmjs.org')
      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      expect(specs[0].dependencyConfusionRisk).toBe(true) // the flag IS set...

      const { fetchImpl } = makeMockRegistry({}) // ...but the name does NOT exist publicly
      const results = await checkPackages(specs, { fetchImpl, cache: new PackageVerifierCache(makeScratchDir('keel-ambient-confusion-security-state-')), registryBaseUrl: 'https://mock.invalid' })
      const decision = decidePackageAction(results, 30)
      expect(decision.reason).toBe('not_found') // ...and not_found MUST win — see decidePackageAction's own priority comment
      expect(decision.reason).not.toBe('dependency_confusion')
    } finally {
      rmSafe(cwd)
    }
  })

  it('SECURITY: an agent-supplied --registry=<anything> with NO corroborating ambient config on disk is left UNCHANGED — it must never downgrade a deny on its own', async () => {
    // This is the deny-escape closed during review: an EARLIER version of
    // applySpecAmbient's npm branch treated ANY --registry= value that
    // wasn't the public registry as privateIndex, with no ambient signal
    // required — `npm install <hallucinated> --registry=https://evil.example`
    // would then never be queried and never deny. Ambient config is written
    // by a team ahead of time; a command-line flag is written by the same
    // agent this rule polices, so it can never be trusted alone.
    const cwd = makeScratchDir('keel-ambient-noescape-')
    // Deliberately NO .npmrc anywhere in cwd.
    try {
      const rawSpecs = extractPackageInstalls('npm install totally-hallucinated-name --registry=https://evil.example.com')
      const specs = applyAmbientConfig(rawSpecs, cwd, TEST_ENV)
      expect(specs).toEqual(rawSpecs) // byte-identical — the flag alone changes nothing
      expect(specs[0]).not.toHaveProperty('privateIndex')
      expect(specs[0]).not.toHaveProperty('dependencyConfusionRisk')

      const { fetchImpl } = makeMockRegistry({}) // 404 — a real hallucination
      const results = await checkPackages(specs, { fetchImpl, cache: new PackageVerifierCache(makeScratchDir('keel-ambient-noescape-state-')), registryBaseUrl: 'https://mock.invalid' })
      expect(decidePackageAction(results, 30).reason).toBe('not_found') // still denies, exactly as it would with no flag at all
    } finally {
      rmSafe(cwd)
    }
  })

  it('pip: -i/--index-url forcing pypi.org triggers confusion; --extra-index-url (additive, not a replacement) never does', () => {
    const cwd = makeScratchDir('keel-ambient-confusion-pip-')
    mkdirSync(join(cwd, '.config', 'pip'), { recursive: true })
    writeFileSync(join(cwd, '.config', 'pip', 'pip.conf'), '[global]\nindex-url = https://pypi.corp.example/simple\n')
    try {
      // -i forces the primary index to the public one -> confusion.
      const forced = applyAmbientConfig(extractPackageInstalls('pip install internal-tool -i https://pypi.org/simple'), cwd, { KEEL_HOME: cwd })
      expect(forced[0].dependencyConfusionRisk).toBe(true)

      // --extra-index-url only ADDS pypi.org as a fallback; the ambient
      // private index stays primary — must stay the ordinary private_index
      // path, never confusion.
      const extra = applyAmbientConfig(extractPackageInstalls('pip install internal-tool --extra-index-url https://pypi.org/simple'), cwd, { KEEL_HOME: cwd })
      expect(extra[0].dependencyConfusionRisk).toBeUndefined()
      expect(extra[0].privateIndex).toBe(true)
    } finally {
      rmSafe(cwd)
    }
  })

  it('pipeline end-to-end: an ambient-private package force-installed from the public registry warns on retry, where the no-override control denies', async () => {
    const cwd = makeScratchDir('keel-ambient-confusion-pipeline-')
    writeFileSync(join(cwd, '.npmrc'), 'registry=https://npm.corp.example/\n')
    try {
      const { fetchImpl } = makeMockRegistry({ 'confusable-tool': { existsDaysAgo: 2000 } })
      const cap = backgroundCapture()
      const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl, { packageVerifierOnBackgroundStart: cap.hook })
      const input = { ...makeInput('npm install confusable-tool --registry=https://registry.npmjs.org'), cwd }

      const first = await pipeline.evaluate(input)
      expect(first.action).toBe('prompt') // not_yet_checked on the first attempt, same two-phase design as every other package verdict

      await cap.settled()
      const second = await pipeline.evaluate(input)
      expect(second.action).toBe('warn')
      expect(second.message).toContain('dependency-confusion')
    } finally {
      rmSafe(cwd)
    }
  })

  it('pipeline control: the SAME --registry=<public> flag on a name with NO ambient config still denies on retry, exactly as before this feature', async () => {
    const cwd = makeScratchDir('keel-ambient-confusion-control-')
    // Deliberately no .npmrc — this is the pre-existing not_found path,
    // proving the new --registry= handling doesn't touch it.
    try {
      const { fetchImpl } = makeMockRegistry({}) // 404 for everything
      const cap = backgroundCapture()
      const pipeline = buildPipeline(PACKAGE_RULE, fetchImpl, { packageVerifierOnBackgroundStart: cap.hook })
      const input = { ...makeInput('npm install totally-hallucinated-name --registry=https://registry.npmjs.org'), cwd }

      const first = await pipeline.evaluate(input)
      expect(first.action).toBe('prompt') // not_yet_checked, same two-phase design

      await cap.settled()
      const second = await pipeline.evaluate(input)
      expect(second.action).toBe('deny') // unaffected by --registry=; still a hard deny on retry
    } finally {
      rmSafe(cwd)
    }
  })
})

// `${VAR}` interpolation in `.npmrc` — real npm resolves `${NPM_TOKEN}`-
// style placeholders (auth tokens, and occasionally registry URLs) against
// the environment; the parser here used to leave them as literal,
// unexpanded text. See ambient-registry-config.ts's `interpolateEnvVars`
// and `hostOf`'s guard against a STILL-unresolved `${...}` being misread as
// a real hostname.
describe('ambient config: .npmrc ${VAR} interpolation', () => {
  it('resolves ${VAR} in a scoped registry value when the env var IS set, alongside an (untracked) auth-token line', () => {
    const cwd = makeScratchDir('keel-ambient-npmrc-interp-set-')
    writeFileSync(
      join(cwd, '.npmrc'),
      [
        'registry=https://npm.corp.example/',
        '//registry.corp.com/:_authToken=${NPM_TOKEN_FOR_KEEL_TEST}',
        '@myorg:registry=https://${NPM_REGISTRY_HOST_FOR_KEEL_TEST}/npm/',
      ].join('\n') + '\n',
    )
    try {
      const env = { ...TEST_ENV, NPM_TOKEN_FOR_KEEL_TEST: 'secret-token-abc', NPM_REGISTRY_HOST_FOR_KEEL_TEST: 'internal.corp.example' }
      const ambient = resolveNpmAmbient(cwd, env)
      expect(ambient.defaultRegistry).toBe('https://npm.corp.example/')
      expect(ambient.scoped.get('@myorg')).toBe('https://internal.corp.example/npm/')

      // End-to-end: the resolved (not literal-placeholder) host correctly
      // downgrades a scoped install to privateIndex.
      const specs = applyAmbientConfig(extractPackageInstalls('npm install @myorg/internal-tool'), cwd, env)
      expect(specs[0].privateIndex).toBe(true)
    } finally {
      rmSafe(cwd)
    }
  })

  it('an UNSET ${VAR} is left as literal text, never crashes, and never gets misread as a valid private registry host', () => {
    const cwd = makeScratchDir('keel-ambient-npmrc-interp-unset-')
    writeFileSync(
      join(cwd, '.npmrc'),
      [
        '//registry.corp.com/:_authToken=${NPM_TOKEN_FOR_KEEL_TEST}', // untracked key — must not crash
        '@myorg:registry=https://${NPM_REGISTRY_HOST_FOR_KEEL_TEST}/npm/', // env var deliberately NOT set
      ].join('\n') + '\n',
    )
    try {
      expect(() => resolveNpmAmbient(cwd, TEST_ENV)).not.toThrow()
      const ambient = resolveNpmAmbient(cwd, TEST_ENV)
      // Literal placeholder preserved — NOT substituted with '' (which would
      // have silently turned the URL into "https:///npm/").
      expect(ambient.scoped.get('@myorg')).toBe('https://${NPM_REGISTRY_HOST_FOR_KEEL_TEST}/npm/')

      // The registry-URL determination must not be corrupted by the literal
      // "${...}" text: a value hostOf can't cleanly parse is treated as
      // unparseable (fail-open toward "not private"), so this must NOT
      // downgrade the install — same "no behavior change" as no .npmrc at all.
      const specs = applyAmbientConfig(extractPackageInstalls('npm install @myorg/internal-tool'), cwd, TEST_ENV)
      expect(specs[0]).not.toHaveProperty('privateIndex')
    } finally {
      rmSafe(cwd)
    }
  })

  it('a malicious project .npmrc cannot use an unresolved ${VAR} to manufacture a fake ambient-private downgrade for an unscoped hard-deny package', () => {
    const cwd = makeScratchDir('keel-ambient-npmrc-interp-attack-')
    // Crafted to make the default registry LOOK non-public if ${...} were
    // ever read as a literal hostname instead of being treated as unparseable.
    writeFileSync(join(cwd, '.npmrc'), 'registry=https://${SOME_UNDEFINED_REGISTRY_VAR}/\n')
    try {
      const specs = applyAmbientConfig(extractPackageInstalls('npm install totally-hallucinated-name'), cwd, TEST_ENV)
      expect(specs[0]).not.toHaveProperty('privateIndex') // still eligible for the normal not_found -> deny path
    } finally {
      rmSafe(cwd)
    }
  })
})

describe('ambient config: npm .npmrc cascade precedence — project overrides user overrides global', () => {
  it('project wins over user wins over global, and NPM_CONFIG_REGISTRY env wins over all', () => {
    const cwd = makeScratchDir('keel-ambient-cascade-cwd-')
    const home = makeScratchDir('keel-ambient-cascade-home-')
    const globalPath = join(makeScratchDir('keel-ambient-cascade-global-'), 'npmrc')
    writeFileSync(globalPath, 'registry=https://global.example/\n')
    try {
      const envBase = { NPM_CONFIG_GLOBALCONFIG: globalPath, KEEL_HOME: home }

      // Only global set -> global wins.
      expect(resolveNpmAmbient(cwd, envBase).defaultRegistry).toBe('https://global.example/')

      // Add user tier -> user overrides global.
      writeFileSync(join(home, '.npmrc'), 'registry=https://user.example/\n')
      expect(resolveNpmAmbient(cwd, envBase).defaultRegistry).toBe('https://user.example/')

      // Add project tier -> project overrides user (and global).
      writeFileSync(join(cwd, '.npmrc'), 'registry=https://project.example/\n')
      expect(resolveNpmAmbient(cwd, envBase).defaultRegistry).toBe('https://project.example/')

      // NPM_CONFIG_REGISTRY env outranks every file tier.
      expect(resolveNpmAmbient(cwd, { ...envBase, NPM_CONFIG_REGISTRY: 'https://env.example/' }).defaultRegistry).toBe('https://env.example/')
    } finally {
      rmSafe(cwd)
      rmSafe(home)
    }
  })
})

describe('ambient config: per-cwd caching (AmbientConfigCache)', () => {
  it('caches per cwd — a second call for the same cwd does not require re-reading a mutated file (proves the cache is actually used)', () => {
    const cwd = makeScratchDir('keel-ambient-cache-')
    writeFileSync(join(cwd, '.npmrc'), 'registry=https://first.example/\n')
    try {
      const cache = new AmbientConfigCache()
      expect(cache.npm(cwd, TEST_ENV).defaultRegistry).toBe('https://first.example/')

      // Mutate the file WITHOUT constructing a fresh cache — the cache
      // should still serve the pre-mutation parse for this same cwd/env key.
      writeFileSync(join(cwd, '.npmrc'), 'registry=https://second.example/\n')
      expect(cache.npm(cwd, TEST_ENV).defaultRegistry).toBe('https://first.example/')
    } finally {
      rmSafe(cwd)
    }
  })

  it('never leaks one cwd\'s config into a different cwd on the same cache instance', () => {
    const cwdA = makeScratchDir('keel-ambient-cache-a-')
    const cwdB = makeScratchDir('keel-ambient-cache-b-')
    writeFileSync(join(cwdA, '.npmrc'), 'registry=https://a.example/\n')
    try {
      const cache = new AmbientConfigCache()
      expect(cache.npm(cwdA, TEST_ENV).defaultRegistry).toBe('https://a.example/')
      expect(cache.npm(cwdB, TEST_ENV).defaultRegistry).toBeUndefined()
    } finally {
      rmSafe(cwdA)
      rmSafe(cwdB)
    }
  })
})
