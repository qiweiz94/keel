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
    // Regression: `message` saying so is only readable by a human. Before
    // `scan_truncated` existed, a caller that branches on the verdict
    // programmatically (a dashboard, an alerting rule, a test asserting "no
    // secret leaked") had NO field to check — a clean `allow` on a
    // truncated scan looked byte-identical to a clean `allow` on a FULLY
    // scanned output. `scan_truncated: true` is the honest signal.
    expect(r.scan_truncated).toBe(true)
  })

  it('a secret WITHIN the scan bound in an otherwise-long output is still caught', async () => {
    const p = makePipeline()
    const filler = 'x'.repeat(1024)
    const text = `${filler}AKIAABCDEFGHIJKLMNOP${filler}`
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    expect(r.redacted_output).not.toContain('AKIAABCDEFGHIJKLMNOP')
    // This output is long but NOT past MAX_OUTPUT_SCAN_CHARS — the scan was
    // complete, so the honest-truncation signal must be absent (not just
    // falsy-by-omission in a way that could be confused with `false`).
    expect(r.scan_truncated).toBeUndefined()
  })

  it('a redact verdict on TRUNCATED output ALSO carries scan_truncated: true — the unscanned tail is not silently implied clean by a successful redact elsewhere', async () => {
    const p = makePipeline()
    const filler = 'x'.repeat(300 * 1024)
    // The secret sits in the SCANNED prefix (before the filler that pushes
    // total length past MAX_OUTPUT_SCAN_CHARS), so it IS caught — but the
    // verdict must still flag that content past the bound went unlooked-at,
    // exercising the `evaluateOutput()` branch `scan_truncated` is set on
    // OTHER than the plain-allow one covered above.
    const text = `AKIAABCDEFGHIJKLMNOP${filler}`
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    expect(r.redacted_output).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(r.scan_truncated).toBe(true)
  })

  it('an UNTRUNCATED clean scan carries no scan_truncated field at all', async () => {
    const p = makePipeline()
    const r = await p.evaluateOutput(outputInput('build succeeded, 0 errors'))
    expect(r.action).toBe('allow')
    expect(r.scan_truncated).toBeUndefined()
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

// ── overlapping redact_span:true patterns (false-confidence regression) ───
//
// evaluateOutput() used to test EVERY pattern against the ORIGINAL
// `scanText`, but mutate a single `redacted` string SEQUENTIALLY as each
// pattern was found — `redacted = redacted.replace(...)`. Two overlapping
// `redact_span: true` patterns then broke the "credited == actually
// mutated" invariant: the second pattern's `re.test(scanText)` probe still
// passed (it runs against the untouched original), so it was pushed onto
// `matchedRuleIds` — but its own `.replace()` call ran against the
// ALREADY-MUTATED `redacted` string, where the first pattern's replacement
// had already consumed or shifted the bytes the second pattern's regex was
// looking for. Its `.replace()` silently matched nothing, and the region it
// claimed to have redacted survived VERBATIM in the output while still
// being listed as successfully redacted.
const OVERLAP_RULES = `version: 1
rules:
  - id: full-secret
    type: content
    patterns:
      - regex: "SECRETVALUE"
        redact_span: true
    action: deny
    message: "Prefix half of an overlapping-secret pattern — deliberately does NOT cover the trailing digits, so a real overlap fix (not just luck) is required to remove them too."
  - id: tail-secret
    type: content
    patterns:
      - regex: "VALUE[0-9]{4}"
        redact_span: true
    action: deny
    message: "Staggered pattern whose span overlaps full-secret's tail — deliberately, for this test."
  - id: nested-prefix
    type: content
    patterns:
      - regex: "AKIA[0-9A-Z]{4}"
        redact_span: true
    action: deny
    message: "Narrow pattern nested inside no-secrets-wide's span — same start, shorter end."
  - id: wide-secret
    type: content
    patterns:
      - regex: "AKIA[0-9A-Z]{16}"
        redact_span: true
    action: deny
    message: "Wide pattern that fully contains nested-prefix's span."
`

function makeOverlapPipeline(): EnforcementPipeline {
  const parsed = parseRulesContent(OVERLAP_RULES, '/tmp/output-redaction-overlap-rules.md')
  expect(validateRules(parsed.rules)).toEqual([])
  return new EnforcementPipeline({
    level: 'balanced',
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

// ── redact_widen (fix/output-redaction-span) ──────────────────────────
//
// The three shipped label/header-only patterns (`aws_secret_access_key
// [\t ]*[:=]`, `BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY`, `-----BEGIN
// PRIVATE KEY-----`) used to detect-but-never-redact: their match span
// covers only the label/header, not the secret bytes that follow it, so
// evaluateOutput() correctly refused to mutate them (see the "redact_span
// correctness" block above). `redact_widen` (opt-in, output-path-only —
// types.ts's doc comment on KeelRule.patterns[].redact_widen) extends a
// label match forward, bounded, to cover the value/body that follows it,
// so those three patterns can now actually redact the secret instead of
// just flagging it. These tests use a dedicated rules fixture (not
// CONTENT_RULES above) so the pre-existing "span-UNSAFE... NEVER mutates"
// tests keep proving the field is opt-in: a pattern with no redact_widen
// set is completely untouched by this feature.
const WIDEN_RULES = `version: 1
rules:
  - id: no-pem-blocks-widen
    type: content
    patterns:
      - regex: "-----BEGIN PRIVATE KEY-----"
        redact_widen: pem
    action: deny
    message: "PEM private key material."
  - id: no-aws-secret-label-widen
    type: content
    patterns:
      - regex: "aws_secret_access_key[\\t ]*[:=]"
        redact_widen: line
    action: deny
    message: "AWS secret access key label."
`

function makeWidenPipeline(): EnforcementPipeline {
  const parsed = parseRulesContent(WIDEN_RULES, '/tmp/output-redaction-widen-rules.md')
  expect(validateRules(parsed.rules)).toEqual([])
  return new EnforcementPipeline({
    level: 'balanced',
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

describe('evaluateOutput() — redact_widen widens a label/header match to cover the secret that follows it', () => {
  it('a full PEM private key body is ENTIRELY redacted — header, base64 body, AND footer all gone, not just the BEGIN line', async () => {
    const p = makeWidenPipeline()
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEA\nAoIBAQC7VJTUt9Us8cKj\nsomeMoreBase64MaterialHere1234567890=='
    const text = `key follows:\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\ndone`
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    expect(r.rule_id).toBe('no-pem-blocks-widen')
    expect(r.redacted_output).toBeDefined()
    // The discriminating assertions: the actual key MATERIAL — not just the
    // BEGIN header — must be gone. A bug that only widened to the next
    // newline (stopping right after the header line) would still leave
    // every one of these base64 lines present.
    expect(r.redacted_output).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEA')
    expect(r.redacted_output).not.toContain('AoIBAQC7VJTUt9Us8cKj')
    expect(r.redacted_output).not.toContain('someMoreBase64MaterialHere1234567890==')
    expect(r.redacted_output).not.toContain('-----BEGIN PRIVATE KEY-----')
    expect(r.redacted_output).not.toContain('-----END PRIVATE KEY-----')
    // Content before and after the PEM block is untouched.
    expect(r.redacted_output).toContain('key follows:')
    expect(r.redacted_output).toContain('done')
    expect(r.redacted_output).toContain('[redacted-by-keel:no-pem-blocks-widen]')
    // The footer WAS found within the bound, so this is a clean, complete
    // widen — never flagged incomplete.
    expect(r.redaction_incomplete_rule_ids).toBeUndefined()
  })

  it('aws_secret_access_key=<value> redacts BOTH the label and the value — a following unrelated line of output is left completely untouched', async () => {
    const p = makeWidenPipeline()
    const text = 'aws_secret_access_key=abc123\nNEXT LINE OF LOG OUTPUT'
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    expect(r.rule_id).toBe('no-aws-secret-label-widen')
    // Both the label AND the value are gone — this is the exact assertion
    // the pre-widen behavior failed (it left the label AND the value both
    // fully present, having refused to mutate at all).
    expect(r.redacted_output).not.toContain('aws_secret_access_key')
    expect(r.redacted_output).not.toContain('abc123')
    // Correctness discipline (task requirement): the widen must stop at the
    // actual value boundary (the newline), never swallow the following,
    // unrelated line.
    expect(r.redacted_output).toContain('NEXT LINE OF LOG OUTPUT')
    expect(r.redacted_output).toBe('[redacted-by-keel:no-aws-secret-label-widen]\nNEXT LINE OF LOG OUTPUT')
    expect(r.redaction_incomplete_rule_ids).toBeUndefined()
  })

  it('a quoted aws_secret_access_key value stops at the line, not at the quote or a mid-value space', async () => {
    const p = makeWidenPipeline()
    const text = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG bPxRfiCYEXAMPLEKEY"\nafter'
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    expect(r.redacted_output).not.toContain('wJalrXUtnFEMI')
    expect(r.redacted_output).not.toContain('bPxRfiCYEXAMPLEKEY')
    expect(r.redacted_output).toContain('after')
  })

  it('a PEM block with NO matching END footer within the bounded window degrades safely: redacts up to the cap, does not hang, does not swallow the rest of a large output, and still flags something was detected', async () => {
    const p = makeWidenPipeline()
    // No END footer anywhere in this text at all — a malformed/truncated
    // capture, or an adversarial attempt to make the widen scan unboundedly.
    const filler = 'A'.repeat(64 * 1024) // 64KB, comfortably past the 8KB PEM widen cap
    const text = `-----BEGIN PRIVATE KEY-----\n${filler}`
    const started = Date.now()
    const r = await p.evaluateOutput(outputInput(text))
    // Does not hang — a generous but finite budget for a pathological case.
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r.action).toBe('redact')
    expect(r.rule_id).toBe('no-pem-blocks-widen')
    // Flags the redaction as possibly incomplete — the programmatic signal,
    // not just prose in the message.
    expect(r.redaction_incomplete_rule_ids).toEqual(['no-pem-blocks-widen'])
    expect(r.message.toLowerCase()).toContain('incomplete')
    // Does NOT swallow the rest of a large output: the vast majority of the
    // 64KB filler — everything past the ~8KB bounded cap — must survive
    // untouched in the output, proving this degraded to a BOUNDED redaction
    // (well over half the original text survives) rather than either (a)
    // redacting nothing (leaving the header exposed) or (b) redacting the
    // entire remainder of the output. (Only ~8KB of the ~64KB is ever
    // consumed by the redaction span + its short marker, so this bound is
    // generous on purpose — it does not depend on the exact cap value.)
    expect(r.redacted_output!.length).toBeGreaterThan(text.length / 2)
    expect(r.redacted_output).toContain('A'.repeat(1024)) // untouched filler tail survives
  })

  it('an aws_secret_access_key value with NO newline within the bounded window also degrades safely, flagged incomplete', async () => {
    const p = makeWidenPipeline()
    const filler = 'B'.repeat(16 * 1024) // past the 4KB line-widen cap
    const text = `aws_secret_access_key=${filler}`
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    expect(r.redaction_incomplete_rule_ids).toEqual(['no-aws-secret-label-widen'])
    // The tail of the filler, past the bounded cap, survives untouched.
    expect(r.redacted_output).toContain('B'.repeat(1024))
  })

  it('a PEM block WITH its END footer found within the bound is NOT flagged incomplete, even in a large surrounding output', async () => {
    const p = makeWidenPipeline()
    const filler = 'C'.repeat(64 * 1024)
    const text = `${filler}\n-----BEGIN PRIVATE KEY-----\nshortbody\n-----END PRIVATE KEY-----\n${filler}`
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    expect(r.redacted_output).not.toContain('shortbody')
    expect(r.redaction_incomplete_rule_ids).toBeUndefined()
  })

  it('does NOT affect a pattern with redact_span: true in the SAME output — the two mechanisms compose independently', async () => {
    const parsed = parseRulesContent(`version: 1
rules:
  - id: no-full-secret
    type: content
    patterns:
      - regex: "AKIA[0-9A-Z]{16}"
        redact_span: true
    action: deny
    message: "Full secret."
  - id: no-pem-blocks-widen
    type: content
    patterns:
      - regex: "-----BEGIN PRIVATE KEY-----"
        redact_widen: pem
    action: deny
    message: "PEM private key material."
`, '/tmp/output-redaction-widen-compose.md')
    expect(validateRules(parsed.rules)).toEqual([])
    const p = new EnforcementPipeline({
      level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(), flowTracker: new FlowTracker(),
      overrideStore: noopOverrideStore,
      ruleHierarchy: { global: null, user: null, project: parsed, local: null },
      ruleVersion: 1, allowedFixTransforms: true,
    })
    const text = 'AKIAABCDEFGHIJKLMNOP\n-----BEGIN PRIVATE KEY-----\nbodyhere\n-----END PRIVATE KEY-----'
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    expect(r.redacted_output).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(r.redacted_output).not.toContain('bodyhere')
    expect(r.redacted_rule_ids).toEqual(expect.arrayContaining(['no-full-secret', 'no-pem-blocks-widen']))
  })

  it('a pattern with NO redact_widen set stays opt-out: unaffected regression check reusing the original CONTENT_RULES fixture', async () => {
    // Regression guard, not a new mechanism test: CONTENT_RULES' own
    // no-aws-secret-label/no-pem-blocks rules (above) have no redact_widen,
    // so this is the same assertion as the "span-UNSAFE... NEVER mutates"
    // tests above, re-run here to make the opt-in boundary explicit right
    // next to the widen tests that exercise the opted-IN behavior.
    const p = makePipeline()
    const text = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEA\n-----END PRIVATE KEY-----'
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('allow')
    expect(r.redacted_output).toBeUndefined()
  })

  it('a rule mixing an UNMARKED pattern with a redact_span/redact_widen pattern does not duplicate its id in redacted_rule_ids or the message', async () => {
    // A single content rule with two patterns: one plain (no redact_span,
    // no redact_widen — lands in the internal "span-unsafe" bucket) and one
    // redact_widen (lands in the "matched/mutated" bucket). Both patterns
    // matching the same output is the case that used to produce a
    // duplicate rule id across the two internal buckets when they were
    // concatenated into the public redacted_rule_ids/message without
    // dedup.
    const parsed = parseRulesContent(`version: 1
rules:
  - id: mixed-pattern-rule
    type: content
    patterns:
      - regex: "UNMARKED_LABEL"
      - regex: "-----BEGIN PRIVATE KEY-----"
        redact_widen: pem
    action: deny
    message: "Mixed pattern safety within one rule."
`, '/tmp/output-redaction-dedup.md')
    expect(validateRules(parsed.rules)).toEqual([])
    const p = new EnforcementPipeline({
      level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(), flowTracker: new FlowTracker(),
      overrideStore: noopOverrideStore,
      ruleHierarchy: { global: null, user: null, project: parsed, local: null },
      ruleVersion: 1, allowedFixTransforms: true,
    })
    const text = 'UNMARKED_LABEL and -----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----'
    const r = await p.evaluateOutput(outputInput(text))
    expect(r.action).toBe('redact')
    // The id appears exactly ONCE, not twice, in redacted_rule_ids.
    expect(r.redacted_rule_ids).toEqual(['mixed-pattern-rule'])
    // And exactly once in the human-readable message too.
    const occurrences = (r.message.match(/mixed-pattern-rule/g) || []).length
    expect(occurrences).toBe(1)
  })

  it('trace-honesty invariant: evaluateOutput() itself never records or claims anything — it is a pure text-in, verdict-out function, same as every other redact_span consumer', async () => {
    // evaluateOutput() has no trace-writing of its own (see pipeline.ts's
    // header comment on this method and docs/exfil.md's "recordRedaction"
    // discussion): the ONLY place a "redact" trace entry is ever written is
    // a host integration (plugin.ts's recordRedaction), called strictly
    // AFTER it has actually applied redacted_output back onto the real
    // output object. This pipeline-level test pins the half of that
    // invariant this file can see: a widen-driven redact verdict is still
    // produced by a call that touches NOTHING but its own return value —
    // no sequence/flow tracker contamination, no persisted state — so a
    // caller applying (or not applying) redacted_output is the only thing
    // that can ever make a trace claim true or false.
    const sequenceDetector = new SequenceDetector()
    const flowTracker = new FlowTracker()
    const seqSpy = vi.spyOn(sequenceDetector, 'record')
    const flowSpy = vi.spyOn(flowTracker, 'record')
    const parsed = parseRulesContent(WIDEN_RULES, '/tmp/output-redaction-widen-trace.md')
    const p = new EnforcementPipeline({
      level: 'balanced', context: 'local', cache: new ActionCache({ maxSize: 100 }),
      contentTracker: new ContentTracker(), sequenceDetector, flowTracker,
      overrideStore: noopOverrideStore,
      ruleHierarchy: { global: null, user: null, project: parsed, local: null },
      ruleVersion: 1, allowedFixTransforms: true,
    })
    const r = await p.evaluateOutput(outputInput('aws_secret_access_key=abc123\ndone'))
    expect(r.action).toBe('redact')
    expect(seqSpy).not.toHaveBeenCalled()
    expect(flowSpy).not.toHaveBeenCalled()
  })
})

describe('evaluateOutput() — overlapping redact_span:true patterns never leave a "redacted" span exposed', () => {
  it('STAGGERED overlap: the trailing digits a buggy sequential mutation would leave exposed are gone, and every contributing rule is honestly credited only for bytes actually removed', async () => {
    const p = makeOverlapPipeline()
    // "SECRETVALUE1234": full-secret's pattern "SECRETVALUE" matches ONLY
    // positions [7,18) (just the prefix, no digits). tail-secret's pattern
    // "VALUE[0-9]{4}" matches [13,22) ("VALUE1234") — a STAGGERED overlap:
    // tail-secret's span extends 4 bytes PAST full-secret's end. The pre-fix
    // bug processed full-secret first (mutating the shared string), then
    // tested tail-secret against the ORIGINAL text (passed -> credited) but
    // replaced against the ALREADY-MUTATED string (found nothing left to
    // match, since "VALUE" was gone) — so the trailing "1234" survived
    // verbatim in the output while tail-secret was still listed as having
    // redacted it.
    const text = 'token: SECRETVALUE1234 end'
    const r = await p.evaluateOutput(outputInput(text))

    expect(r.action).toBe('redact')
    // The discriminating assertion: these exact trailing digits are what a
    // buggy sequential-mutation implementation leaves exposed right after
    // full-secret's placeholder. An assertion that only checked the FULL
    // "SECRETVALUE1234" string is gone would pass even with the bug present
    // (the prefix alone being replaced already breaks that literal
    // substring) — this checks the REMNANT specifically.
    expect(r.redacted_output).not.toContain('1234')
    expect(r.redacted_output).not.toContain('SECRETVALUE1234')
    expect(r.redacted_output).not.toContain('VALUE1234')
    // Both rules contributed a span to the (merged) redacted region, so
    // both are honestly credited — this is NOT the pre-fix bug: the pre-fix
    // bug credited a rule whose bytes were NOT actually removed. Here they
    // truly were, jointly.
    expect(r.redacted_rule_ids).toEqual(expect.arrayContaining(['full-secret', 'tail-secret']))
    // Exactly ONE placeholder was written for the merged region — the two
    // patterns' overlapping claims collapsed into a single honest span,
    // not two independent (and mutually corrupting) replacements.
    expect((r.redacted_output!.match(/\[redacted-by-keel:/g) || []).length).toBe(1)
  })

  it('NESTED overlap (same start, one pattern fully inside the other): the tail bytes past the narrower pattern\'s end are gone too, not left exposed', async () => {
    const p = makeOverlapPipeline()
    // nested-prefix matches "AKIAABCD" (the first 8 chars); wide-secret
    // matches the full "AKIAABCDEFGHIJKLMNOP" (20 chars) starting at the
    // SAME position — nested-prefix's span is entirely inside wide-secret's.
    // The pre-fix bug processed nested-prefix FIRST (declared first in the
    // rules list), mutating the string down to just its own 8-char span,
    // then tested wide-secret against the original (passed -> credited) but
    // its replace() found nothing in the already-mutated string — so
    // "EFGHIJKLMNOP" (bytes 9-20 of the original key) survived verbatim
    // while wide-secret was listed as having redacted the whole thing.
    const text = 'key: AKIAABCDEFGHIJKLMNOP done'
    const r = await p.evaluateOutput(outputInput(text))

    expect(r.action).toBe('redact')
    // The discriminating assertion: this is the exact tail a buggy
    // process-narrower-then-wider ordering leaves behind.
    expect(r.redacted_output).not.toContain('EFGHIJKLMNOP')
    expect(r.redacted_output).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(r.redacted_output).not.toContain('AKIAABCD')
    expect(r.redacted_rule_ids).toEqual(expect.arrayContaining(['wide-secret', 'nested-prefix']))
    // Still exactly one placeholder — the nested span didn't get its own,
    // separate (and redundant/corrupting) replacement pass.
    expect((r.redacted_output!.match(/\[redacted-by-keel:/g) || []).length).toBe(1)
  })

  it('two DISJOINT (non-overlapping) matches are unaffected by overlap resolution — each keeps its own independent placeholder', async () => {
    const p = makeOverlapPipeline()
    const text = 'first: SECRETVALUE1111 --- second: AKIAABCDEFGHIJKLMNOP'
    const r = await p.evaluateOutput(outputInput(text))

    expect(r.action).toBe('redact')
    expect(r.redacted_output).not.toContain('SECRETVALUE1111')
    expect(r.redacted_output).not.toContain('AKIAABCDEFGHIJKLMNOP')
    // Two independent, non-overlapping redactions -> two placeholders.
    expect((r.redacted_output!.match(/\[redacted-by-keel:/g) || []).length).toBe(2)
  })
})
