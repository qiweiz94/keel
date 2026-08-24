import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { measureClaudeCodeSpend, DEFAULT_PRICE_TABLE, type ModelPrice } from '../budget/claude-transcript.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Live-verified findings this suite pins down as regression tests (see
 * types.ts's `max_tokens` comment and claude-transcript.ts's own header
 * for the full citations):
 *
 * Point 1 — `transcript_path` must be used DIRECTLY, never derived from
 * `cwd`. This module takes it as its only file-location input; there is no
 * slug-derivation code path to test here BY CONSTRUCTION (the fix is the
 * absence of that code, not a new branch), so this suite instead proves
 * the function behaves correctly when handed a real path, and fails safe
 * (never "0 spend, allowed") when handed none.
 *
 * Point 2 — a transcript containing lines whose snake_case `session_id`
 * points at a DIFFERENT (child/subagent) session must still have every
 * one of those lines' usage counted, because `transcript_path` already
 * identifies the correct file; there is no per-line session filter.
 *
 * Point 3 (SAFETY-CRITICAL) — an unrecognized model string (a short alias
 * like `claude-sonnet-5`, not an official dated model ID) must degrade the
 * WHOLE measurement's dollar figure to `null`/unconfident, while its
 * tokens still count. `<synthetic>` lines are skipped outright.
 *
 * Point 5 — a missing or unreadable transcript must report
 * `unavailable: true`, never `{ tokens: 0, ... }` presented as a confident
 * "no spend."
 */

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-claude-transcript-test-'))
})

afterEach(() => {
  rmSafe(dir)
})

function writeTranscript(lines: unknown[]): string {
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

const RECOGNIZED_MODEL = 'claude-haiku-4-5-20251001'
const KNOWN_PRICE_TABLE: Record<string, ModelPrice> = { [RECOGNIZED_MODEL]: { inputPerMTok: 1, outputPerMTok: 5 } }

function assistantLine(model: string, usage: Record<string, number>) {
  return { type: 'assistant', sessionId: 'parent-session', message: { model, usage } }
}

describe('measureClaudeCodeSpend — point 5, missing/unreadable transcript', () => {
  it('undefined transcriptPath → unavailable, never a confident zero', () => {
    const spend = measureClaudeCodeSpend(undefined)
    expect(spend.unavailable).toBe(true)
    expect(spend.dollarsConfident).toBe(false)
    expect(spend.dollars).toBeNull()
  })

  it('a transcriptPath pointing at a nonexistent file → unavailable, never a confident zero', () => {
    const spend = measureClaudeCodeSpend(join(dir, 'does-not-exist.jsonl'))
    expect(spend.unavailable).toBe(true)
    expect(spend.dollarsConfident).toBe(false)
    expect(spend.dollars).toBeNull()
  })
})

describe('measureClaudeCodeSpend — point 3 (SAFETY-CRITICAL), model normalization', () => {
  it('a recognized dated model ID: tokens AND a confident dollar figure', () => {
    const path = writeTranscript([
      assistantLine(RECOGNIZED_MODEL, { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ])
    const spend = measureClaudeCodeSpend(path, KNOWN_PRICE_TABLE)
    expect(spend.unavailable).toBe(false)
    expect(spend.tokens).toBe(2_000_000)
    expect(spend.dollarsConfident).toBe(true)
    expect(spend.dollars).toBeCloseTo(1 + 5, 5) // 1M in @ $1/M + 1M out @ $5/M
  })

  it('an ALIAS model string (not an official dated ID) with real usage: tokens count, dollars degrade to null — NEVER a guessed figure', () => {
    // Exactly the audit's own live-observed alias forms.
    for (const alias of ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5']) {
      const path = writeTranscript([assistantLine(alias, { input_tokens: 100, output_tokens: 200 })])
      const spend = measureClaudeCodeSpend(path, KNOWN_PRICE_TABLE)
      expect(spend.unavailable, alias).toBe(false)
      expect(spend.tokens, alias).toBe(300) // token-only enforcement never degrades
      expect(spend.dollarsConfident, alias).toBe(false)
      expect(spend.dollars, alias).toBeNull() // the actual safety property: no dollar figure at all
      expect(spend.unrecognizedModels, alias).toContain(alias)
    }
  })

  it('a SINGLE unrecognized model anywhere in the session degrades the WHOLE aggregate dollar figure, not just that line', () => {
    const path = writeTranscript([
      assistantLine(RECOGNIZED_MODEL, { input_tokens: 1_000_000, output_tokens: 0 }), // would be $1 alone
      assistantLine('claude-sonnet-5', { input_tokens: 100, output_tokens: 100 }),
    ])
    const spend = measureClaudeCodeSpend(path, KNOWN_PRICE_TABLE)
    expect(spend.dollarsConfident).toBe(false)
    // The dangerous shape point 3 warns against: a PARTIAL total ($1 from
    // the recognized line alone) silently presented as the session total.
    expect(spend.dollars).toBeNull()
    expect(spend.tokens).toBe(1_000_200) // tokens still sum across both lines
  })

  it('`<synthetic>` lines are skipped outright, never contribute tokens or break confidence', () => {
    const path = writeTranscript([
      { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 999_999, output_tokens: 999_999 } } },
      assistantLine(RECOGNIZED_MODEL, { input_tokens: 10, output_tokens: 10 }),
    ])
    const spend = measureClaudeCodeSpend(path, KNOWN_PRICE_TABLE)
    expect(spend.tokens).toBe(20)
    expect(spend.dollarsConfident).toBe(true)
  })

  it('DEFAULT_PRICE_TABLE is exact-match only — a prefix/pattern-similar unlisted model still degrades to unconfident', () => {
    const path = writeTranscript([assistantLine('claude-haiku-4-5-20251099', { input_tokens: 100, output_tokens: 100 })])
    const spend = measureClaudeCodeSpend(path, DEFAULT_PRICE_TABLE)
    expect(spend.dollarsConfident).toBe(false)
    expect(spend.dollars).toBeNull()
    expect(spend.tokens).toBe(200)
  })
})

describe('measureClaudeCodeSpend — point 2, nested-subagent session_id cross-references', () => {
  it('lines whose snake_case session_id points at a DIFFERENT session are still fully counted — no per-line session filter', () => {
    // Mirrors the live finding: 63% of assistant lines in a real parent
    // transcript carried a snake_case session_id that did NOT match the
    // file's own identity (they were Task/subagent cross-references to a
    // separate child .jsonl file) — yet every one of those lines
    // genuinely belongs to THIS file's own spend. The camelCase top-level
    // `sessionId` always matches the file's own identity; deliberately NOT
    // used as a filter either — see this module's own header comment for
    // why transcript_path alone already settles file identity.
    const path = writeTranscript([
      // A normal line for this session.
      { type: 'assistant', sessionId: 'parent-session-abc', message: { model: RECOGNIZED_MODEL, usage: { input_tokens: 100, output_tokens: 0 } } },
      // A line carrying a MISMATCHED snake_case session_id — a real
      // Task/subagent cross-reference into a totally different child
      // transcript file — that must NOT be excluded from this file's sum.
      {
        type: 'assistant',
        sessionId: 'parent-session-abc',
        session_id: 'child-subagent-session-xyz.jsonl',
        message: { model: RECOGNIZED_MODEL, usage: { input_tokens: 200, output_tokens: 0 } },
      },
      // A second mismatched cross-reference, different child.
      {
        type: 'assistant',
        sessionId: 'parent-session-abc',
        session_id: 'another-child-session-999.jsonl',
        message: { model: RECOGNIZED_MODEL, usage: { input_tokens: 300, output_tokens: 0 } },
      },
    ])
    const spend = measureClaudeCodeSpend(path, KNOWN_PRICE_TABLE)
    // If a naive implementation filtered on session_id (snake_case) !==
    // "this session's id", it would have dropped 500 of these 600 tokens.
    expect(spend.tokens).toBe(600)
    expect(spend.dollarsConfident).toBe(true)
  })
})

describe('measureClaudeCodeSpend — cache/thinking token fields all contribute', () => {
  it('sums input + output + cache_creation + cache_read + thinking tokens', () => {
    const path = writeTranscript([{
      type: 'assistant',
      message: {
        model: RECOGNIZED_MODEL,
        usage: {
          input_tokens: 10, output_tokens: 20,
          cache_creation_input_tokens: 30, cache_read_input_tokens: 40,
          output_tokens_details: { thinking_tokens: 50 },
        },
      },
    }])
    const spend = measureClaudeCodeSpend(path, KNOWN_PRICE_TABLE)
    expect(spend.tokens).toBe(10 + 20 + 30 + 40 + 50)
  })

  it('a corrupt/truncated line does not invalidate the rest of the file', () => {
    const path = join(dir, 'corrupt.jsonl')
    writeFileSync(path, `{"not valid json\n${JSON.stringify(assistantLine(RECOGNIZED_MODEL, { input_tokens: 42, output_tokens: 0 }))}\n`)
    const spend = measureClaudeCodeSpend(path, KNOWN_PRICE_TABLE)
    expect(spend.unavailable).toBe(false)
    expect(spend.tokens).toBe(42)
  })
})
