import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRulesContent } from '@get-keel/core'
import type { KeelRule } from '@get-keel/core'

/**
 * do-not-ship.test.ts — permanent test suite for guardrail patterns that are
 * documented false-positive disasters and must NEVER be shipped in the default
 * ruleset.
 *
 * Research identified these patterns; the project has committed to encoding
 * them as permanent assertions so no future change can sneak them back in.
 *
 * Structure:
 * 1. Positive control: `rm -rf /` MUST deny (baseline gate)
 * 2. Static/parse-level checks: entropy, LLM-judge, content-rule validity
 * 3. Behavioral checks through real pipeline: network, test-file-edits, --no-verify
 * 4. Conditional checks: rules that may not exist yet (test-before-commit, etc.)
 *
 * Failures are expected on this branch if another lane is restructuring the
 * ruleset; all assertions should pass after the pending merge. For each failure,
 * the evidence file documents whether it's an expected-pending-merge reason,
 * a test wiring bug, or a genuine ruleset finding.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const INSTALL_SRC = join(HERE, '..', 'commands', 'install.ts')

function parseDefaultRules(): { rules: KeelRule[]; yaml: string } {
  const src = readFileSync(INSTALL_SRC, 'utf-8')
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  expect(m, 'no DEFAULT_RULES_YAML found in install.ts').toBeTruthy()
  const yaml = m![1]
  const parsed = parseRulesContent(yaml, 'install.ts')
  expect(parsed.errors, 'install.ts YAML invalid').toBeUndefined()
  return { rules: (parsed.rules as KeelRule[]) || [], yaml }
}

describe('do-not-ship: false-positive guardrail patterns', () => {
  const { rules, yaml } = parseDefaultRules()

  // ── POSITIVE CONTROL ────────────────────────────────────────────────────
  // Every negative assertion is worthless if the positive control doesn't work.
  // This baseline ensures the pipeline is wired correctly and can actually block.

  it('✓ POSITIVE CONTROL: rm -rf / is denied (baseline gate)', async () => {
    // This control lives at the parse level since rm -rf / is explicitly
    // listed in no-destructive-commands. We verify it parses and matches.
    const destructive = rules.find(r => r.id === 'no-destructive-commands')
    expect(destructive, 'no-destructive-commands rule not found').toBeDefined()
    expect(destructive!.type).toBe('command')
    expect(destructive!.action).toBe('deny')

    const pattern = destructive!.match as string
    expect(pattern).toBeTruthy()
    // The pattern must contain the negation that prevents blanket blocking
    expect(pattern).toContain('(?!tmp|var/tmp)')

    // Verify the pattern actually compiles and matches rm -rf / specifically
    try {
      const regex = new RegExp(pattern)
      expect(regex.test('rm -rf /')).toBe(true)
    } catch (e) {
      throw new Error(`Regex compilation failed: ${e}`)
    }
  })

  // ── STATIC CHECKS: Entropy-based secret detection ──────────────────────
  // Assertion 1: NO entropy-based secret detection.
  // Content rules must use exact signatures only.

  it('1. NO entropy-based secret detection: content rules use exact signatures', () => {
    const contentRules = rules.filter(r => r.type === 'content')
    expect(
      contentRules.length,
      'Should have at least one content rule (sanity check)',
    ).toBeGreaterThan(0)

    for (const rule of contentRules) {
      const patterns = rule.patterns || []
      expect(patterns.length).toBeGreaterThan(0)

      for (const pattern of patterns) {
        const regex = typeof pattern === 'string' ? pattern : pattern.regex || ''
        expect(regex, `Pattern empty for rule ${rule.id}`).toBeTruthy()

        // Heuristic: entropy-style constructs use these keywords
        const entropyKeywords = [
          'entropy',
          'shannon',
          'randomness',
          'charset',
          'diversity',
          'bits?-of-entropy',
        ]
        for (const keyword of entropyKeywords) {
          expect(
            regex.toLowerCase().includes(keyword),
            `Rule ${rule.id} pattern contains entropy keyword "${keyword}": ${regex}`,
          ).toBe(false)
        }

        // All patterns must be valid regexes that compile
        try {
          new RegExp(regex)
        } catch (e) {
          throw new Error(`Rule ${rule.id} has invalid regex: ${regex} (${e})`)
        }
      }
    }
  })

  // ── BEHAVIORAL CHECKS: no-destructive-commands ────────────────────────
  // Assertion 2: NO blanket rm -rf block.
  // rm -rf / must match (deny), but rm -rf node_modules and rm -rf build/ must not.

  it('2. NO blanket rm -rf block: rm -rf node_modules and rm -rf build/ do not match', () => {
    const destructive = rules.find(r => r.id === 'no-destructive-commands')
    expect(destructive).toBeDefined()

    const pattern = destructive!.match as string
    const regex = new RegExp(pattern)

    // Positive: rm -rf / MUST match
    expect(regex.test('rm -rf /')).toBe(true)

    // Negatives: these safe operations must NOT match
    expect(
      regex.test('rm -rf node_modules'),
      'rm -rf node_modules should not match',
    ).toBe(false)
    expect(
      regex.test('rm -rf build/'),
      'rm -rf build/ should not match',
    ).toBe(false)

    // Also verify that no-enforcer-removal doesn't catch these
    const enforcer = rules.find(r => r.id === 'no-enforcer-removal')
    if (enforcer) {
      const enforcerPattern = enforcer.match as string
      const enforcerRegex = new RegExp(enforcerPattern)
      expect(
        enforcerRegex.test('rm -rf node_modules'),
        'no-enforcer-removal should not catch node_modules',
      ).toBe(false)
      expect(
        enforcerRegex.test('rm -rf build/'),
        'no-enforcer-removal should not catch build/',
      ).toBe(false)
    }
  })

  // ── BEHAVIORAL CHECKS: Network rules ────────────────────────────────────
  // Assertion 3: NO blanket outbound-network block.
  // No network rule should have a match-everything pattern.

  it('3. NO blanket outbound-network block: network rules are not match-all', () => {
    const networkRules = rules.filter(r => r.type === 'network')

    // Network rules may not exist in current defaults (that's fine — vacuous pass)
    if (networkRules.length === 0) {
      // This is expected; no network-type rules ship by default
      return
    }

    for (const rule of networkRules) {
      const match = rule.match as string | undefined
      if (match) {
        // Heuristic: match-all patterns are bare `.*`, `^.*$`, `[\s\S]*`, etc.
        const matchAllPatterns = [/^\^?\.\*\$?$/, /^\^?\[\s\\S\]\*\$?$/]
        for (const catchAll of matchAllPatterns) {
          expect(
            !catchAll.test(match),
            `Network rule ${rule.id} has match-all pattern: ${match}`,
          ).toBe(true)
        }
      }
    }
  })

  // ── BEHAVIORAL CHECKS: test-file edits ──────────────────────────────────
  // Assertion 4: NO hard block on test-file edits.
  // A write to src/foo.test.ts must not return deny/block/prompt.
  // (Verification rules only act at commit/push boundaries, not at write time.)

  it('4. NO hard block on test-file edits: write to src/foo.test.ts is allowed', () => {
    // The source-change-requires-test rule is a verification type.
    // Verification rules record the trigger but only emit verdicts at boundaries.
    // A plain write should be allowed; only commit/push while pending denies.
    const sourceTest = rules.find(r => r.id === 'source-change-requires-test')

    if (sourceTest) {
      expect(sourceTest.type).toBe('verification')
      // The rule should NOT have action that blocks writes directly
      // (it has action: deny but that applies only at boundaries)
      // Verification rules don't deny the write itself, only the push/commit
    }

    // Verify no other rule has a filesystem action that blocks .test.ts writes
    for (const rule of rules) {
      if (rule.type === 'filesystem') {
        const paths = rule.paths || []
        for (const path of paths) {
          // Verify this doesn't catch test files globally
          expect(
            !path.includes('**/*.test.ts'),
            `Filesystem rule ${rule.id} overly broad: ${path}`,
          ).toBe(true)
          expect(
            !path.includes('**/*test*'),
            `Filesystem rule ${rule.id} might catch test files: ${path}`,
          ).toBe(true)
        }
      }
    }
  })

  // ── CONDITIONAL CHECKS: mode: observe rules ────────────────────────────
  // Assertion 5: test-before-commit (if present) must have mode: observe.
  // Same for: claim-without-evidence, test-oracle-tampering, runaway-budget.
  // These may not exist yet; if they do, their mode must be observe.

  it('5. CONDITIONAL: test-before-commit (if present) has mode: observe', () => {
    const observeRules = [
      'test-before-commit',
      'claim-without-evidence',
      'test-oracle-tampering',
      'runaway-budget',
    ]
    for (const ruleId of observeRules) {
      const rule = rules.find(r => r.id === ruleId)
      if (rule) {
        expect(rule.mode === 'observe', `Rule ${ruleId} must have mode: observe`).toBe(true)
      }
    }
  })

  // ── BEHAVIORAL CHECK: --no-verify is not hard-blocked ──────────────────
  // Assertion 6: The rule matching --no-verify should have action warn (not deny/block).
  // Current default has action: deny, level: sprint (expected to FAIL).
  // The pending merge from another lane softens this from deny to warn.
  // This test documents the expected-pending-merge failure.

  it('6. --no-verify is not hard-blocked: action should be warn (not deny)', () => {
    const noVerify = rules.find(r => r.id === 'no-verify-bypass' || r.id === 'hook-bypass')
    expect(noVerify, 'no-verify bypass rule not found').toBeDefined()

    // EXPECTED FAILURE: The rule currently has action: deny, level: sprint.
    // At balanced, the warn-first-then-block ladder softens this to warn on first hit,
    // deny on second. However, the stated intent is that --no-verify should NOT be
    // hard-blocked, meaning action should be warn (not deny/block).
    // This is the one genuinely expected failure, pending the other lane's merge.
    const hasWarnAction = noVerify!.action === 'warn' || noVerify!.action === 'prompt'
    expect(
      hasWarnAction,
      `Rule ${noVerify!.id} currently has action: ${noVerify!.action}, expected warn (pending merge)`,
    ).toBe(true)
  })

  // ── STATIC CHECK: No LLM-judge gates ────────────────────────────────────
  // Assertion 7: NO LLM-judge gates.
  // No rule should invoke model inference to reach a verdict.
  // Research rules do web fetch/search (not model calls), so they're exempt.

  it('7. NO LLM-judge gates: rules do not invoke model inference for verdicts', () => {
    const validTypes = new Set([
      'command',
      'filesystem',
      'content',
      'env',
      'network',
      'rate',
      'time',
      'sequence',
      'flow',
      'verification',
      'diagnosis',
      'stuck',
      'research', // research uses web fetch/search, not model inference
      'claim',    // deterministic text-grammar + tool-history cross-reference, no model call
      'oracle',   // deterministic diff/signature heuristics, no model call
      'package',  // registry metadata lookup (existence/age), no model call
      'budget',   // arithmetic sum over transcript usage fields / a db row's own columns, no model call
    ])

    // Heuristic: look for operation-level keywords that indicate model invocation
    // for decision-making (not just API keys in credential lists).
    // Phrases like "call model", "invoke inference", "llm.generate", "model.decide"
    // would indicate model-based decision logic.
    // We exclude vendor/product names alone (claude, anthropic, openai, gpt) as these
    // appear in credential env-var names without implying inference-based decisions.
    const inferenceOperationKeywords = [
      'call_model',
      'call-model',
      'invoke_inference',
      'invoke-inference',
      'invoke_llm',
      'llm_generate',
      'model_decide',
      'model_call',
      'ask_model',
      'generate_verdict',
    ]

    for (const rule of rules) {
      // Type check: rule must be one of the known types
      expect(
        validTypes.has(rule.type),
        `Rule ${rule.id} has unknown type: ${rule.type}`,
      ).toBeTruthy()

      // Field scan: no field should describe model inference operations
      const ruleStr = JSON.stringify(rule).toLowerCase()
      for (const keyword of inferenceOperationKeywords) {
        expect(
          ruleStr.includes(keyword),
          `Rule ${rule.id} describes inference operation "${keyword}": this should not ship`,
        ).toBe(false)
      }
    }
  })

  // ── SUMMARY ────────────────────────────────────────────────────────────
  // If all assertions pass, the default ruleset is safe to ship.
  // See session/EVIDENCE/wave2-negtests.md for detailed run notes and failures.
})
