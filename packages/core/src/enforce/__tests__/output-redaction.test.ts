import { describe, it, expect, vi } from 'vitest'
import { EnforcementPipeline } from '../pipeline.js'
import { ActionCache, ContentTracker } from '../cache.js'
import { SequenceDetector } from '../sequencer.js'
import { FlowTracker } from '../flow-tracker.js'
import { parseRulesContent, validateRules } from '../rule-parser.js'
import type { EnforceInput } from '../../types.js'

/**
 * sprint/lane-c2 — real output capture + redaction.
 *
 * `EnforcementPipeline.evaluateOutput()` reuses the SAME `type: content`
 * regex patterns that already gate what gets WRITTEN to a file
 * (`no-secrets-in-code`, `DEFAULT_RULES_YAML` in
 * packages/cli/src/commands/install.ts) against a completed tool call's OWN
 * output text — the input side of `packages/opencode-plugin/src/plugin.ts`'s
 * `tool.execute.after` mutation, live-verified to actually change what an
 * OpenCode session's model receives (see
 * session/transcripts/opencode-tool-execute-after-mutation-probe.txt and
 * docs/exfil.md's "Output redaction" section). This file tests the pipeline
 * method directly — no live CLI, no real filesystem/home touching — see
 * `stuck.test.ts`'s header comment for why `noopOverrideStore` is used.
 */

const noopOverrideStore = { consume: () => false, peek: () => null, list: () => ({}) }

// Mirrors the shipped `no-secrets-in-code` rule's shape (install.ts's
// DEFAULT_RULES_YAML) closely enough to exercise the same matcher: two
// SPAN-SAFE patterns (`redact_span: true` — the match IS the whole secret),
// plus a second, unrelated content rule (`no-pem-blocks`) and a third
// (`no-aws-secret-label`) whose patterns are deliberately SPAN-UNSAFE (no
// `redact_span`) — a match on a LABEL/HEADER, not the secret bytes
// themselves, the exact shape a real bug (caught in review before this
// landed) mutated incorrectly. See types.ts's `redact_span` doc comment.
// Also an `mode: observe` rule to prove observe-mode content matches are
// recorded but never mutate — a different reason, same "never mutate"
// outcome as the span-unsafe rules.
const CONTENT_RULES = `version: 1
rules:
  - id: no-secrets-in-code
    type: content
    patterns:
      - regex: "AKIA[0-9A-Z]{16}"
        redact_span: true
      - regex: "sk-[A-Za-z0-9_-]{24,}"
        redact_span: true
    action: deny
    message: "Hardcoded credentials must not be written."
  - id: no-pem-blocks
    type: content
    patterns:
      - regex: "-----BEGIN PRIVATE KEY-----"
    action: deny
    message: "PEM private key material."
  - id: no-aws-secret-label
    type: content
    patterns:
      - regex: "aws_secret_access_key[\\t ]*[:=]"
    action: deny
    message: "AWS secret access key label."
  - id: observe-only-token
    type: content
    mode: observe
    patterns:
      - regex: "OBSERVE_TOKEN_[0-9]{4}"
    action: warn
    message: "Observe-only token pattern (never mutates)."
  - id: prefix-only-rule
    type: content
    patterns:
      - prefix: "DANGER:"
    action: warn
    message: "Prefix-only pattern has no redaction span."
`

function makePipeline(yaml = CONTENT_RULES, level: 'sprint' | 'balanced' | 'protect' = 'balanced'): EnforcementPipeline {
  const parsed = parseRulesContent(yaml, '/tmp/output-redaction-rules.md')
  expect(validateRules(parsed.rules)).toEqual([])
  return new EnforcementPipeline({
    level,
    context: 'local',
    cache: new ActionCache({ maxSize: 100 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    overrideStore: noopOverrideStore,
    ruleHierarchy: { global: null, user: null, project: parsed, local: null },
    ruleVersion: 1,
    allowedFixTransforms: true,
  })
}

function outputInput(toolOutput: string | undefined, extra: Partial<EnforceInput> = {}): EnforceInput {
  return {
    tool: 'bash',
    args: { command: 'cat secrets.env' },
    cwd: '/tmp/redact-project',
    session_id: 'redact-session',
    turn_number: 1,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'test',
    subagent_of: null,
    tool_output: toolOutput,
    ...extra,
  }
}

describe('evaluateOutput() — real output capture + redaction', () => {
  it('MUST-REDACT: tool output containing a shipped secret pattern is redacted, attributed to the matching rule', async () => {
    const p = makePipeline()
    const r = await p.evaluateOutput(outputInput('token: AKIAABCDEFGHIJKLMNOP\ndone'))
    expect(r.action).toBe('redact')
    expect(r.rule_id).toBe('no-secrets-in-code')
    expect(r.redacted_output).toBeDefined()
    expect(r.redacted_output).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(r.redacted_output).toContain('[redacted-by-keel:no-secrets-in-code]')
    expect(r.redacted_rule_ids).toEqual(['no-secrets-in-code'])
  })

  it('MUST-NOT-FIRE: clean tool output stays allow, with no redacted_output', async () => {
    const p = makePipeline()
    const r = await p.evaluateOutput(outputInput('build succeeded, 0 errors'))
    expect(r.action).toBe('allow')
    expect(r.redacted_output).toBeUndefined()
    expect(r.redacted_rule_ids).toBeUndefined()
  })

  it('MUST-NOT-FIRE: empty/undefined tool_output is a no-op, not a crash', async () => {
    const p = makePipeline()
    const empty = await p.evaluateOutput(outputInput(''))
    expect(empty.action).toBe('allow')
    const undef = await p.evaluateOutput(outputInput(undefined))
    expect(undef.action).toBe('allow')
  })

  it('redacts MULTIPLE independent matches from the SAME rule, and from DIFFERENT span-safe rules, in one scan', async () => {
    const p = makePipeline()
    const text = [
      'first key: AKIAABCDEFGHIJKLMNOP',
      'second key: AKIAZYXWVUTSRQPONMLK',
      'api key: sk-abcdefghijklmnopqrstuvwx',
    ].join('\n')
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    expect(r.redacted_rule_ids).toContain('no-secrets-in-code')
    expect(r.redacted_output).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(r.redacted_output).not.toContain('AKIAZYXWVUTSRQPONMLK')
    expect(r.redacted_output).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })

  // ── redact_span correctness (found in review before this shipped) ──────
  //
  // no-secrets-in-code's real shipped patterns are DETECTORS, not redaction
  // spans. `AKIA[0-9A-Z]{16}` matches exactly the secret — safe. But
  // `aws_secret_access_key[\t ]*[:=]` and `BEGIN ... PRIVATE KEY` match only
  // a LABEL or HEADER; the actual secret sits AFTER the match. Blindly
  // replacing the match span there would strip the label and leave the real
  // secret sitting right next to a "[redacted]" marker, verbatim — a
  // false-confidence signal worse than no redaction at all. These three
  // tests are the ones that actually discriminate that bug from a fix: an
  // assertion that only checks the LABEL is gone (not the body/value) would
  // pass even with the bug present.

  it('a span-UNSAFE label pattern (aws_secret_access_key=) NEVER mutates — the real key value stays fully present, uncut', async () => {
    const p = makePipeline()
    const text = 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY'
    const r = await p.evaluateOutput(outputInput(text))
    // No span-safe rule matched (the AWS-shaped value here is not
    // AKIA-prefixed), so nothing was mutated at all — the honest choice
    // over a partial, misleading redaction.
    expect(r.action).toBe('allow')
    expect(r.redacted_output).toBeUndefined()
    expect(r.redacted_rule_ids).toEqual(['no-aws-secret-label'])
    expect(r.message).toContain('no-aws-secret-label')
    expect(r.message.toLowerCase()).toContain('does not bound the secret')
  })

  it('a span-UNSAFE PEM header pattern NEVER mutates — the key BODY (not just the header) stays fully present', async () => {
    const p = makePipeline()
    const text = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEA\nAoIBAQC7VJTUt9Us8cKj\n-----END PRIVATE KEY-----'
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('allow')
    expect(r.redacted_output).toBeUndefined()
    // The discriminating assertion: the BODY line, not the header, is what
    // a partial-span bug would have let through unredacted while claiming
    // "redacted before delivery."
    expect(r.redacted_rule_ids).toEqual(['no-pem-blocks'])
  })

  it('a span-safe match and a span-UNSAFE match in the SAME output: the safe one redacts, the unsafe one\'s value survives fully intact', async () => {
    const p = makePipeline()
    const text = [
      'AKIAABCDEFGHIJKLMNOP',
      'aws_secret_access_key=wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY',
    ].join('\n')
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact') // driven by the AKIA match alone
    expect(r.redacted_output).not.toContain('AKIAABCDEFGHIJKLMNOP')
    // The AWS secret's real VALUE must be fully present, unmutated — this
    // is the exact assertion the original bug failed.
    expect(r.redacted_output).toContain('wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY')
    expect(r.redacted_rule_ids).toEqual(expect.arrayContaining(['no-secrets-in-code', 'no-aws-secret-label']))
  })

  it('a `mode: observe` content rule NEVER mutates output — recorded, not redacted (the same restraint every other rule type gets)', async () => {
    const p = makePipeline()
    const r = await p.evaluateOutput(outputInput('sample: OBSERVE_TOKEN_4471'))
    // No enforcing rule matched, so the verdict is allow, not redact — an
    // observe-mode match must never itself cause a live mutation.
    expect(r.action).toBe('allow')
    expect(r.redacted_output).toBeUndefined()
    expect(r.redacted_rule_ids).toEqual(['observe-only-token'])
    expect(r.message).toContain('observe-only-token')
  })

  it('an observe-mode match alongside a REAL redact still redacts only the enforcing rule\'s span, and reports both ids', async () => {
    const p = makePipeline()
    const r = await p.evaluateOutput(outputInput('AKIAABCDEFGHIJKLMNOP and OBSERVE_TOKEN_4471'))
    expect(r.action).toBe('redact')
    expect(r.redacted_output).not.toContain('AKIAABCDEFGHIJKLMNOP')
    // The observe-only token is recorded as matched but its span is NEVER
    // rewritten — it must still be present verbatim in the candidate text.
    expect(r.redacted_output).toContain('OBSERVE_TOKEN_4471')
    expect(r.redacted_rule_ids).toEqual(expect.arrayContaining(['no-secrets-in-code', 'observe-only-token']))
  })

  it('a `prefix`-only pattern has no redaction span and is skipped without error', async () => {
    const p = makePipeline()
    const r = await p.evaluateOutput(outputInput('DANGER: something happened'))
    expect(r.action).toBe('allow')
  })

  it('an invalid regex in a rule is skipped, not thrown', async () => {
    // Deliberately bypasses makePipeline()'s validateRules() assertion — a
    // rule this malformed is already rejected by `keel validate` at author
    // time (confirmed above: validateRules() flags it). This test is about
    // evaluateOutput()'s OWN defense if one somehow still reaches the
    // pipeline (e.g. a stale in-memory hierarchy from before a fix), not
    // about the authoring-time gate.
    const parsed = parseRulesContent(`version: 1
rules:
  - id: broken-regex
    type: content
    patterns:
      - regex: "(unterminated["
    action: deny
    message: "broken"
`, '/tmp/output-redaction-broken.md')
    expect(validateRules(parsed.rules)).not.toEqual([]) // confirms the authoring-time gate DOES catch this
    const p = new EnforcementPipeline({
      level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(), flowTracker: new FlowTracker(),
      overrideStore: noopOverrideStore,
      ruleHierarchy: { global: null, user: null, project: parsed, local: null },
      ruleVersion: 1, allowedFixTransforms: true,
    })
    await expect(p.evaluateOutput(outputInput('anything at all'))).resolves.toMatchObject({ action: 'allow' })
  })

  it('no `type: content` rules configured at all is a clean allow, not an error', async () => {
    const p = makePipeline('version: 1\nrules: []\n')
    const r = await p.evaluateOutput(outputInput('AKIAABCDEFGHIJKLMNOP'))
    expect(r.action).toBe('allow')
  })

  it('text past the scan bound is left unredacted there, and the result says so rather than claiming a clean scan', async () => {
    const p = makePipeline()
    const filler = 'x'.repeat(300 * 1024)
    const text = `${filler}AKIAABCDEFGHIJKLMNOP`
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('allow')
    expect(r.message.toLowerCase()).toContain('scanned')
  })

  it('a secret WITHIN the scan bound in an otherwise-long output is still caught', async () => {
    const p = makePipeline()
    const filler = 'x'.repeat(1024)
    const text = `${filler}AKIAABCDEFGHIJKLMNOP${filler}`
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    expect(r.redacted_output).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })

  it('does NOT contaminate sequence/flow tracker state — spies on both trackers directly, same shape as evaluateClaim()\'s own no-contamination test', async () => {
    const sequenceDetector = new SequenceDetector()
    const flowTracker = new FlowTracker()
    const seqSpy = vi.spyOn(sequenceDetector, 'record')
    const flowSpy = vi.spyOn(flowTracker, 'record')
    const parsed = parseRulesContent(CONTENT_RULES, '/tmp/output-redaction-rules.md')
    const p = new EnforcementPipeline({
      level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(), sequenceDetector, flowTracker,
      overrideStore: noopOverrideStore,
      ruleHierarchy: { global: null, user: null, project: parsed, local: null },
      ruleVersion: 1, allowedFixTransforms: true,
    })
    await p.evaluateOutput(outputInput('AKIAABCDEFGHIJKLMNOP'))
    expect(seqSpy).not.toHaveBeenCalled()
    expect(flowSpy).not.toHaveBeenCalled()
  })

  it('runs at the sprint dial too — a stated choice, not gated on the input-side "skip content checks for speed" trade-off', async () => {
    const p = makePipeline(CONTENT_RULES, 'sprint')
    const r = await p.evaluateOutput(outputInput('AKIAABCDEFGHIJKLMNOP', { level: 'sprint' }))
    expect(r.action).toBe('redact')
  })

  it('is a live method the real pipeline exposes (guards against a future signature/rename drift)', () => {
    const p = makePipeline()
    expect(typeof p.evaluateOutput).toBe('function')
  })
})
