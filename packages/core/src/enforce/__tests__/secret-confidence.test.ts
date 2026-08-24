import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { resolveHome } from '../../home.js'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import type { PipelineConfig } from '../pipeline.js'
import type { ProtectionLevel, RuleContext } from '../../types.js'
import { parseRulesContent } from '../rule-parser.js'
import { rmSafe } from './helpers/fs-safe.js'
import { scoreSecretCandidate, shannonEntropyBitsPerChar, isUniformRedactionShape, worstSecretVerdict } from '../secret-confidence.js'

/**
 * Local-only false-positive reduction for `no-secrets-in-code`: a real,
 * confirmed false positive shipped in the defaults — `AKIA[0-9A-Z]{16}`
 * matches `AKIAIOSFODNN7EXAMPLE`, AWS's own canonical documentation
 * placeholder access key, denying an agent that writes ordinary
 * AWS-SDK-referencing docs. secret-confidence.ts adds a small, offline,
 * deterministic allowlist (an exact known literal, AWS's documented
 * EXAMPLE-suffix convention, or a redaction-shaped run of one repeated
 * character) checked before the deny-on-write path denies.
 *
 * A design-review pass on the first draft of this feature found that
 * entropy and file-path context must NEVER be allowed to clear or soften
 * a match on their own (no labeled corpus to calibrate a threshold; the
 * write-target path is attacker-controlled input an agent can pick
 * freely) — see secret-confidence.ts's header for the full reasoning.
 * The integration tests below specifically pin that: a real-shaped key
 * denies IDENTICALLY regardless of which file it's written to, and the
 * three label-only patterns (no `redact_span`) are entirely untouched by
 * this filter.
 */

describe('secret-confidence: unit', () => {
  describe('shannonEntropyBitsPerChar', () => {
    it('is 0 for a single repeated character', () => {
      expect(shannonEntropyBitsPerChar('AAAAAAAAAAAAAAAA')).toBe(0)
    })
    it('is at its 1-bit max for a two-symbol 50/50 alternation', () => {
      expect(shannonEntropyBitsPerChar('ABABABABABAB')).toBeCloseTo(1, 5)
    })
    it('is higher for a 16-distinct-character string than a low-variety one', () => {
      const distinct = shannonEntropyBitsPerChar('1234567890ABCDEF')
      const repeated = shannonEntropyBitsPerChar('AAAABBBBCCCCDDDD')
      expect(distinct).toBeGreaterThan(repeated)
    })
  })

  describe('isUniformRedactionShape', () => {
    it('true for an AKIA-prefixed all-X redacted placeholder', () => {
      expect(isUniformRedactionShape('AKIA' + 'X'.repeat(16))).toBe(true)
    })
    it('true for an AKIA-prefixed all-zero placeholder', () => {
      expect(isUniformRedactionShape('AKIA' + '0'.repeat(16))).toBe(true)
    })
    it('true for a ghp_-prefixed all-repeated-character placeholder', () => {
      expect(isUniformRedactionShape('ghp_' + 'a'.repeat(36))).toBe(true)
    })
    it('false for a genuinely random-looking 20-character AKIA key', () => {
      expect(isUniformRedactionShape('AKIATOGIXG0T74OFROQE')).toBe(false)
    })
    it('false for a purely sequential run (not a redaction placeholder shape)', () => {
      expect(isUniformRedactionShape('AKIAABCDEFGHIJKLMNOP')).toBe(false)
    })
  })

  describe('scoreSecretCandidate', () => {
    it('allows the exact known AWS placeholder literal', () => {
      expect(scoreSecretCandidate('AKIAIOSFODNN7EXAMPLE')).toBe('allow')
    })
    it('allows any AKIA-prefixed candidate ending in AWS\'s documented EXAMPLE suffix', () => {
      expect(scoreSecretCandidate('AKIAZZZZZZZZZEXAMPLE')).toBe('allow')
    })
    it('allows a uniform-repeated-character redaction placeholder', () => {
      expect(scoreSecretCandidate('AKIA' + '0'.repeat(16))).toBe('allow')
    })
    it('denies a real-shaped, non-placeholder AKIA key', () => {
      expect(scoreSecretCandidate('AKIATOGIXG0T74OFROQE')).toBe('deny')
    })
    it('denies a purely sequential fixture (not an allowlisted shape) — regression guard for edit-shaped-content.test.ts\'s fixture', () => {
      expect(scoreSecretCandidate('AKIAABCDEFGHIJKLMNOP')).toBe('deny')
    })
    it('denies a real-shaped GitHub token (no checksum implemented — unconfident in the real algorithm, so it falls back to unconditional deny, never a silent pass)', () => {
      expect(scoreSecretCandidate('ghp_4asHsWl5wrobL3S7EBOMUmoiSkW3DEDsuQ27')).toBe('deny')
    })
  })

  describe('worstSecretVerdict', () => {
    it('returns null when the pattern matches nothing', () => {
      expect(worstSecretVerdict('AKIA[0-9A-Z]{16}', 'no secrets here')).toBeNull()
    })
    it('returns deny if ANY occurrence in the content is deny-worthy, even after an earlier allow-worthy occurrence', () => {
      const content = 'placeholder: AKIAIOSFODNN7EXAMPLE\nreal one: AKIATOGIXG0T74OFROQE\n'
      expect(worstSecretVerdict('AKIA[0-9A-Z]{16}', content)).toBe('deny')
    })
    it('returns allow only when every occurrence is allow-worthy', () => {
      const content = 'AKIAIOSFODNN7EXAMPLE and AKIA' + '0'.repeat(16)
      expect(worstSecretVerdict('AKIA[0-9A-Z]{16}', content)).toBe('allow')
    })
  })
})

// ---------------------------------------------------------------------
// Integration: the REAL shipped no-secrets-in-code rule, loaded from the
// plugin source exactly like threat-model.test.ts's `makeDefaultsPipeline`
// (this deliberately reuses that pattern rather than a hand-copied rule
// fixture, so these tests exercise the actual rule text ships to users,
// not a stand-in that could silently drift from it).
// ---------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SENTINEL = join(mkdtempSync(join(tmpdir(), 'keel-secret-confidence-sentinel-')), 'DISABLED')
const HALT_SENTINEL = join(mkdtempSync(join(tmpdir(), 'keel-secret-confidence-halt-')), 'HALTED')

function findPluginSource(start: string): string {
  let dir = start
  for (;;) {
    const candidate = join(dir, 'opencode-plugin', 'src', 'plugin.ts')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error('plugin source not found above ' + start)
    dir = parent
  }
}

function loadDefaultRules(): ReturnType<typeof parseRulesContent> {
  const src = readFileSync(findPluginSource(HERE), 'utf-8')
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  if (!m) throw new Error('DEFAULT_RULES_YAML not found in plugin source')
  const parsed = parseRulesContent(m[1], 'default-rules')
  parsed.rules = parsed.rules.filter(rule => rule.type !== 'time' && rule.type !== 'rate')
  return parsed
}

function makePipeline(level: ProtectionLevel = 'balanced'): EnforcementPipeline {
  const rules = loadDefaultRules()
  rules.config.level = level
  const config: PipelineConfig = {
    level,
    context: 'local' as RuleContext,
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: { global: rules, user: null, project: null, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
    disableFile: SENTINEL,
    haltFile: HALT_SENTINEL,
    overrideStore: { consume: () => false },
  }
  return new EnforcementPipeline(config)
}

function input(tool: string, args: Record<string, unknown>, session: string, level: ProtectionLevel = 'balanced'): Parameters<EnforcementPipeline['evaluate']>[0] {
  return {
    tool,
    args,
    cwd: '/tmp/keel-secret-confidence',
    session_id: session,
    turn_number: 1,
    context_tokens: 0,
    level,
    context: 'local' as const,
    agent: 'test-agent',
    subagent_of: null,
  }
}

// A pseudo-random, non-placeholder, non-sequential AKIA key. Generated
// once and hardcoded (not derived at runtime) so this suite is
// deterministic — it happens not to end in "EXAMPLE" and is not a
// uniform-repeated-character run, both checked directly in the unit
// tests above.
const REAL_AKIA = 'AKIATOGIXG0T74OFROQE'
const REAL_GHP = 'ghp_4asHsWl5wrobL3S7EBOMUmoiSkW3DEDsuQ27'
const KNOWN_PLACEHOLDER = 'AKIAIOSFODNN7EXAMPLE'
const UNIFORM_PLACEHOLDER_BODY = 'AKIA' + '0'.repeat(16)

describe('no-secrets-in-code (shipped defaults) with the local confidence filter', () => {
  beforeAll(() => {
    const sentinelPath = join(resolveHome(), '.keel', 'DISABLED')
    if (existsSync(sentinelPath)) rmSync(sentinelPath)
    const haltPath = join(resolveHome(), '.keel', 'HALTED')
    if (existsSync(haltPath)) rmSync(haltPath)
  })

  afterAll(() => {
    rmSafe(join(SENTINEL, '..'))
    rmSafe(join(HALT_SENTINEL, '..'))
  })

  it('MUST-FIX: AWS\'s own canonical documentation placeholder key no longer denies', async () => {
    const p = makePipeline()
    const r = await p.evaluate(input('WriteFile', {
      filePath: 'docs/aws-setup.md',
      content: `Set your credentials, e.g. aws_access_key_id = ${KNOWN_PLACEHOLDER}`,
    }, 'known-placeholder'))
    expect(r.action).toBe('allow')
    expect(r.rule_id).toBeNull()
  })

  it('the known placeholder clears regardless of file path — docs, README, tests, plain source, all allow', async () => {
    const paths = ['docs/notes.md', 'README.md', 'src/foo.test.ts', 'config.example.json', 'src/plain.ts']
    for (const filePath of paths) {
      const p = makePipeline()
      const r = await p.evaluate(input('WriteFile', { filePath, content: `key = "${KNOWN_PLACEHOLDER}"` }, `placeholder-${filePath}`))
      expect(r.action, `expected allow for ${filePath}`).toBe('allow')
    }
  })

  it('a genuinely low-entropy / uniform-repeated-character fake string matching the pattern shape allows, not just downgrades', async () => {
    const p = makePipeline()
    const r = await p.evaluate(input('WriteFile', {
      filePath: 'src/config.ts',
      content: `const k = "${UNIFORM_PLACEHOLDER_BODY}"`,
    }, 'uniform-placeholder'))
    expect(r.action).toBe('allow')
    expect(r.rule_id).toBeNull()
  })

  it('SECURITY REGRESSION GUARD: a real-shaped, non-placeholder AWS key still denies exactly as before (warn-once, then block)', async () => {
    const p = makePipeline()
    const call = () => input('WriteFile', { filePath: 'src/config.ts', content: `const k = "${REAL_AKIA}"` }, 'real-secret')
    const first = await p.evaluate(call())
    expect(first.rule_id).toBe('no-secrets-in-code')
    expect(first.action).toBe('warn')
    const second = await p.evaluate(call())
    expect(second.rule_id).toBe('no-secrets-in-code')
    expect(second.action).toBe('deny')
  })

  it('SECURITY REGRESSION GUARD: the SAME real-shaped key denies identically in a docs/README/test/example path — no path-based bypass exists', async () => {
    const paths = ['README.md', 'docs/setup.md', 'src/foo.test.ts', 'config.example.json']
    for (const filePath of paths) {
      const p = makePipeline()
      const call = () => input('WriteFile', { filePath, content: `const k = "${REAL_AKIA}"` }, `real-secret-${filePath}`)
      const first = await p.evaluate(call())
      expect(first.rule_id, `expected a match for ${filePath}`).toBe('no-secrets-in-code')
      expect(first.action, `expected warn (first hit) for ${filePath}`).toBe('warn')
      const second = await p.evaluate(call())
      expect(second.action, `expected deny (second hit) for ${filePath} — a docs/test path must NOT weaken detection`).toBe('deny')
    }
  })

  it('a real-shaped GitHub token still denies (no fake checksum silently accepting it)', async () => {
    const p = makePipeline()
    const call = () => input('WriteFile', { filePath: 'src/config.ts', content: `const t = "${REAL_GHP}"` }, 'real-ghp')
    const first = await p.evaluate(call())
    expect(first.rule_id).toBe('no-secrets-in-code')
    expect(first.action).toBe('warn')
    const second = await p.evaluate(call())
    expect(second.action).toBe('deny')
  })

  it('REGRESSION GUARD (audit item 1): label-only patterns (no redact_span) are completely untouched by the confidence filter — a PEM private-key header still denies unconditionally', async () => {
    const p = makePipeline()
    const call = () => input('WriteFile', { filePath: 'docs/example.md', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIExampleKeyBodyHere\n-----END RSA PRIVATE KEY-----' }, 'pem-header')
    const first = await p.evaluate(call())
    expect(first.rule_id).toBe('no-secrets-in-code')
    expect(first.action).toBe('warn')
    const second = await p.evaluate(call())
    expect(second.action).toBe('deny')
  })

  it('REGRESSION GUARD (audit item 1): the aws_secret_access_key label pattern still denies unconditionally, even in a docs-shaped path', async () => {
    const p = makePipeline()
    const call = () => input('WriteFile', { filePath: 'README.md', content: 'aws_secret_access_key: some-value-here' }, 'label-only')
    const first = await p.evaluate(call())
    expect(first.rule_id).toBe('no-secrets-in-code')
    expect(first.action).toBe('warn')
    const second = await p.evaluate(call())
    expect(second.action).toBe('deny')
  })

  it('a clean write with no secret-shaped content still allows normally', async () => {
    const p = makePipeline()
    const r = await p.evaluate(input('WriteFile', { filePath: 'src/plain.ts', content: 'export const x = 1' }, 'clean'))
    expect(r.action).toBe('allow')
    expect(r.rule_id).toBeNull()
  })
})
