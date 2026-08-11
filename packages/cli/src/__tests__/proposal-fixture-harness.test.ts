import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  ActionCache,
  ContentTracker,
  EnforcementPipeline,
  FlowTracker,
  SequenceDetector,
  parseRulesContent,
  validateRules,
  PackageVerifierCache,
} from '@get-keel/core'
import type {
  EnforceInput, EnforceResult, KeelRule, PipelineConfig, ProtectionLevel, RuleContext, RuleHierarchy,
} from '@get-keel/core'

/**
 * Extension point for tests/rules/<rule-id>/{must-block,must-allow}.yaml
 * fixtures that belong to a rule NOT YET in DEFAULT_RULES_YAML — a
 * "capability lane" rule shipped as session/proposals/<id>.yaml, pasted
 * into DEFAULT_RULES_YAML only at the wave gate (see session/DECISIONS.md,
 * "Tier-3 NEW rule YAML"). fixture-harness.test.ts only ever reads
 * install.ts's DEFAULT_RULES_YAML, so a proposal rule has no coverage
 * until it's pasted in — this file reads session/proposals/*.yaml instead,
 * coordinate-free: it picks up EVERY proposal file present, from any lane,
 * with no edit to the shared default-rules harness.
 *
 * Deliberately narrower than fixture-harness.test.ts:
 *   - single-step cases only (tool + args) — no multi-step / precreate /
 *     repeat / fake_time. Proposal rules that need those can extend this
 *     file when they land; nothing here forecloses it.
 *   - `expect_action` is REQUIRED on every must-block case and asserted
 *     exactly, rather than inferring one action from the rule's declared
 *     `action` field. That inference (fixture-harness.test.ts's
 *     `expectedActionFor`) assumes one rule = one action, which
 *     `unverified-package-install` breaks on purpose: a `not_found`
 *     package forces `deny` while an `unverified`/`age_gate` verdict stays
 *     at the rule's declared `prompt` (see package-verifier.ts's module
 *     header). Loosening the assertion to "not allow" would make a
 *     misrouted deny/prompt pass silently — exactly the failure this
 *     harness exists to catch.
 *   - a `type: package` rule additionally gets a MOCKED registry
 *     (`registryFor`, below) wired in via `packageVerifierFetch`, keyed by
 *     the package name embedded in each fixture's command string. A
 *     future proposal of a different rule type gets a plain pipeline, same
 *     as fixture-harness.test.ts's default.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROPOSALS_ROOT = join(HERE, '..', '..', '..', '..', 'session', 'proposals')
const FIXTURES_ROOT = join(HERE, '..', '..', '..', '..', 'tests', 'rules')

interface ProposalRuleFile {
  ruleId: string
  rule: KeelRule
  sourcePath: string
}

/**
 * Both DEFAULT_RULES_YAML constants the supervisor pastes proposals into
 * (packages/cli/src/commands/install.ts and plugin.ts) are JS TEMPLATE
 * LITERALS (backtick-delimited). A proposal file containing a backtick
 * terminates that literal early; a backslash gets collapsed by the JS
 * string escape before the YAML parser ever sees it (e.g. a YAML
 * double-quoted scalar's \" survives standalone but becomes a bare "
 * once pasted, closing the string early and corrupting everything after
 * it); a `${` opens a template expression. All three are silent at
 * standalone parse/validate time — session/proposals/*.yaml is never
 * itself embedded in a template literal until the paste — so this check
 * exists specifically to catch what a standalone parse cannot.
 */
function assertPasteSafe(raw: string, sourcePath: string): void {
  expect(raw.includes('`'), `${sourcePath} contains a backtick — this breaks the JS template literal it gets pasted into`).toBe(false)
  expect(raw.includes('\\'), `${sourcePath} contains a backslash — JS collapses escapes inside a template literal before the YAML parser sees them`).toBe(false)
  expect(raw.includes('${'), `${sourcePath} contains \${ — this opens a JS template expression once pasted`).toBe(false)
}

function loadProposalRules(): ProposalRuleFile[] {
  if (!existsSync(PROPOSALS_ROOT)) return []
  const out: ProposalRuleFile[] = []
  for (const entry of readdirSync(PROPOSALS_ROOT)) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue
    const sourcePath = join(PROPOSALS_ROOT, entry)
    const raw = readFileSync(sourcePath, 'utf-8')
    assertPasteSafe(raw, sourcePath)
    // Proposal files ship in one of two shapes, both accepted here since
    // the gate paste extracts the rule ENTRIES either way:
    //   (a) a bare, indented rule-list fragment meant to be pasted inside
    //       an existing `rules:` list (harness-rules.ts style), or
    //   (b) a standalone document with its own `version:`/`rules:` header
    //       so the lane's own tests can load it through the real parser
    //       (oracle/claim lanes do this).
    const standalone = parseRulesContent(raw, sourcePath)
    const parsed = (!standalone.errors && standalone.rules.length > 0)
      ? standalone
      : parseRulesContent(`version: 1\nrules:\n${raw}`, sourcePath)
    expect(parsed.errors, `${entry} failed to parse as a rules fragment: ${parsed.errors}`).toBeUndefined()
    expect(validateRules(parsed.rules), `${entry} failed validation`).toEqual([])
    for (const rule of parsed.rules) out.push({ ruleId: rule.id, rule, sourcePath })
  }
  return out
}

const PROPOSAL_RULES = loadProposalRules()

// ── Fixture schema (single-step subset of fixture-harness.test.ts's) ──

interface CaseDef {
  note?: string
  tool: string
  args: Record<string, unknown>
  expect_action?: EnforceResult['action']
  skip?: boolean
  reason?: string
}
interface FixtureFile { cases: CaseDef[] }

function loadFixtures(ruleId: string, file: 'must-block.yaml' | 'must-allow.yaml'): CaseDef[] {
  const path = join(FIXTURES_ROOT, ruleId, file)
  if (!existsSync(path)) return []
  const doc = parseYaml(readFileSync(path, 'utf-8')) as FixtureFile
  return doc?.cases ?? []
}

// ── Mock npm registry, keyed by package name conventions used in the
//    unverified-package-install fixtures. Every request is recorded so a
//    broken injection (falling through to the real fetch) fails LOUDLY —
//    see the "the mock is actually wired in" test below. ──

interface MockCall { url: string }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

function makeMockRegistry() {
  const calls: MockCall[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url.toString()
    calls.push({ url: href })
    if (href.includes('/-/v1/search')) {
      const text = new URL(href).searchParams.get('text') || ''
      return jsonResponse({ objects: [{ package: { name: `${text}-suggestion` } }] })
    }
    const name = decodeURIComponent(href.replace(/^https?:\/\/[^/]+\//, ''))
    if (name.includes('slow-unreachable')) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    }
    if (name.includes('hallucinated') || name.includes('does-not-exist')) return jsonResponse(null, 404)
    if (name.includes('brand-new-fresh')) return jsonResponse({ name, time: { created: daysAgoIso(3) } })
    if (name.startsWith('@')) return jsonResponse(null, 404) // any scoped name not special-cased above: simulate a private-registry 404
    // Default: an old, boring, real package.
    return jsonResponse({ name, time: { created: daysAgoIso(4000) } })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

// ── Isolated pipeline construction (mirrors fixture-harness.test.ts) ──

let scratchRoot = ''

function stubOverrideStore() {
  return { consume: () => false, peek: () => null, list: () => ({}) }
}

function buildHierarchy(rule: KeelRule): RuleHierarchy {
  return {
    global: null,
    user: null,
    local: null,
    project: {
      config: { version: 1, level: 'balanced' as ProtectionLevel, rules: [rule] },
      rules: [rule],
      sourcePath: '/keel-proposal-fixture-harness/nonexistent-rules.yaml',
      version: 1,
      markdown: '',
    },
  }
}

function buildPipeline(rule: KeelRule, fetchImpl?: typeof fetch): EnforcementPipeline {
  const stateDir = mkdtempSync(join(scratchRoot, 'state-'))
  const config: PipelineConfig = {
    level: 'balanced',
    context: 'local' as RuleContext,
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: buildHierarchy(rule),
    ruleVersion: 1,
    allowedFixTransforms: true,
    disableFile: join(scratchRoot, 'DISABLED-unused'),
    overrideStore: stubOverrideStore(),
    packageVerifierCache: new PackageVerifierCache(stateDir),
    packageVerifierFetch: fetchImpl,
  }
  return new EnforcementPipeline(config)
}

function makeInput(c: CaseDef, cwd: string, sessionId: string): EnforceInput {
  return {
    tool: c.tool,
    args: c.args,
    cwd,
    session_id: sessionId,
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'keel-proposal-fixture-harness',
    subagent_of: null,
  }
}

async function evaluateCase(rule: KeelRule, c: CaseDef, fetchImpl?: typeof fetch): Promise<EnforceResult> {
  const pipeline = buildPipeline(rule, fetchImpl)
  const cwd = mkdtempSync(join(scratchRoot, 'case-'))
  const sessionId = `proposal-fixture-${rule.id}-${Math.random().toString(36).slice(2)}`
  return pipeline.evaluate(makeInput(c, cwd, sessionId))
}

describe('proposal rule fixtures (session/proposals/*.yaml, not yet in DEFAULT_RULES_YAML)', () => {
  it('every proposal file present has a non-empty must-block and must-allow fixture', () => {
    for (const { ruleId } of PROPOSAL_RULES) {
      const dir = join(FIXTURES_ROOT, ruleId)
      expect(existsSync(dir), `missing tests/rules/${ruleId}/`).toBe(true)
      expect(loadFixtures(ruleId, 'must-block.yaml').length, `${ruleId}/must-block.yaml has no cases`).toBeGreaterThan(0)
      expect(loadFixtures(ruleId, 'must-allow.yaml').length, `${ruleId}/must-allow.yaml has no cases`).toBeGreaterThan(0)
    }
  })
})

for (const { ruleId, rule, sourcePath } of PROPOSAL_RULES) {
  const isPackageRule = rule.type === 'package'
  describe(`proposal rule: ${ruleId} (${sourcePath.split('/').pop()})`, () => {
    const blockCases = loadFixtures(ruleId, 'must-block.yaml')
    const allowCases = loadFixtures(ruleId, 'must-allow.yaml')

    for (const c of blockCases) {
      const run = c.skip ? it.skip : it
      run(`must-block: ${c.note ?? '(no note)'}`, async () => {
        expect(c.expect_action, `${ruleId}/must-block.yaml case "${c.note}" is missing expect_action`).toBeTruthy()
        const { fetchImpl, calls } = isPackageRule ? makeMockRegistry() : { fetchImpl: undefined, calls: [] as MockCall[] }
        const result = await evaluateCase(rule, c, fetchImpl)
        expect(result.action, `message: ${result.message}`).toBe(c.expect_action)
        expect(result.rule_id).toBe(rule.id)
        if (isPackageRule) expect(calls.length, 'the mocked registry was never called — check the fetchImpl injection').toBeGreaterThan(0)
      })
    }

    for (const c of allowCases) {
      const run = c.skip ? it.skip : it
      run(`must-allow: ${c.note ?? '(no note)'}`, async () => {
        const { fetchImpl } = isPackageRule ? makeMockRegistry() : { fetchImpl: undefined }
        const result = await evaluateCase(rule, c, fetchImpl)
        expect(result.action, `expected allow, got "${result.action}" (rule_id=${result.rule_id}, message=${result.message})`).toBe('allow')
      })
    }
  })
}

// ── Injection sanity: prove the mock actually intercepts, so a broken
//    wire-up shows up as a loud failure instead of a quiet pass against
//    the real registry (which package-verifier.ts's VITEST-aware
//    defaultRegistryBaseUrl() would otherwise silently redirect to a
//    closed loopback port — safe, but it would hide a real harness bug). ──

describe('mock registry injection sanity (unverified-package-install)', () => {
  const target = PROPOSAL_RULES.find(p => p.ruleId === 'unverified-package-install')

  it('the pipeline uses the injected fetchImpl, not the real registry', async () => {
    expect(target, 'unverified-package-install proposal not found — is session/proposals/unverified-package-install.yaml present?').toBeTruthy()
    const { fetchImpl, calls } = makeMockRegistry()
    await evaluateCase(target!.rule, { tool: 'Bash', args: { command: 'npm install some-mock-tracked-package' } }, fetchImpl)
    expect(calls.some(c => c.url.includes('some-mock-tracked-package'))).toBe(true)
  })
})

// ── Gate simulation: what fixture-harness.test.ts (the OFFLINE harness for
//    DEFAULT_RULES_YAML) will see once this proposal is pasted in — no
//    packageVerifierFetch wired at all, so it falls through to the module's
//    own default fetch. package-verifier.ts's defaultRegistryBaseUrl()
//    safety net redirects that to a closed loopback port under vitest
//    (VITEST=1 is always set by the test runner), so the lookup fails via
//    ECONNREFUSED — fast, not a hang — and every must-block case degrades
//    to 'unverified' -> 'prompt', which is exactly what
//    fixture-harness.test.ts's expectedActionFor() expects for a rule
//    shipping action: prompt. This proves that reasoning empirically
//    instead of asserting it in a comment. ──

describe('gate simulation: unmocked pipeline (no fetchImpl injected, matches the offline main harness)', () => {
  const target = PROPOSAL_RULES.find(p => p.ruleId === 'unverified-package-install')
  const blockCases = target ? loadFixtures('unverified-package-install', 'must-block.yaml') : []

  for (const c of blockCases) {
    it(`degrades to prompt, not a hang or a wrong verdict: ${c.note ?? '(no note)'}`, async () => {
      const startedAt = Date.now()
      const result = await evaluateCase(target!.rule, c, undefined) // no mock — real defaultRegistryBaseUrl() path
      const elapsedMs = Date.now() - startedAt
      expect(result.action, `message: ${result.message}`).toBe('prompt')
      expect(elapsedMs).toBeLessThan(2500) // ECONNREFUSED must fail fast, not ride out the 2s budget
    })
  }
})

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'keel-proposal-fixture-scratch-'))
})
afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true })
})
