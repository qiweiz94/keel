import { readFileSync } from 'node:fs'
import type { BudgetSpend } from '../budget-tracker.js'

/**
 * Per-million-token pricing for one model, in dollars. `cacheWritePerMTok`/
 * `cacheReadPerMTok` fall back to `inputPerMTok`/10% of it respectively
 * when a table entry omits them (Anthropic's cache-read discount is
 * roughly an order of magnitude off the base input rate; cache-write is
 * commonly close to the base input rate) — an approximation, not a
 * pinned-per-model fact, so a table entry can always override it.
 */
export interface ModelPrice {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok?: number
  cacheReadPerMTok?: number
}

/**
 * EXACT-STRING-MATCH ONLY, deliberately. This is the safety-critical half
 * of `type: budget` (see the audit finding this closes): real
 * `message.model` values observed live on THIS machine, across ordinary
 * Claude Code sessions — including keel's own live-verify fixture
 * sessions — include short aliases (`claude-sonnet-5`, `claude-opus-4-8`,
 * `claude-fable-5`) that are NOT official Anthropic model IDs, alongside
 * `<synthetic>` (always all-zero usage, skipped outright — see
 * `measureClaudeCodeSpend`) and ordinary dated IDs
 * (`claude-haiku-4-5-20251001`). A pricing table keyed by prefix/pattern
 * match would silently treat an alias as if it priced like whatever dated
 * ID it happens to resemble — exactly the "guessed dollar figure" this
 * design must never produce. Only a byte-exact key hit counts as
 * recognized; everything else (alias, unknown dated ID, anything) falls
 * through to token-only enforcement for that line, per
 * `measureClaudeCodeSpend`'s own comment.
 *
 * The one entry below is illustrative — a real deployment should keep
 * this current from the vendor's published pricing page; nothing in this
 * module's CORRECTNESS depends on the number being exactly right, only on
 * the exact-match/no-guessing DISCIPLINE around it, which is what the
 * caller is expected to inject or override this table for, not hand-edit
 * scattered pricing constants elsewhere.
 */
export const DEFAULT_PRICE_TABLE: Record<string, ModelPrice> = {
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
}

/** A completed Claude Code JSONL transcript line carrying token usage — the fields this reader actually consumes, not the full schema. */
interface TranscriptLine {
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      output_tokens_details?: { thinking_tokens?: number }
    }
  }
}

function lineTokenCount(usage: NonNullable<TranscriptLine['message']>['usage']): number {
  if (!usage) return 0
  return (usage.input_tokens || 0)
    + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.output_tokens_details?.thinking_tokens || 0)
}

function lineCost(usage: NonNullable<TranscriptLine['message']>['usage'], price: ModelPrice): number {
  if (!usage) return 0
  const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok
  const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok * 0.1
  return ((usage.input_tokens || 0) / 1_000_000) * price.inputPerMTok
    + ((usage.output_tokens || 0) + (usage.output_tokens_details?.thinking_tokens || 0)) / 1_000_000 * price.outputPerMTok
    + ((usage.cache_creation_input_tokens || 0) / 1_000_000) * cacheWrite
    + ((usage.cache_read_input_tokens || 0) / 1_000_000) * cacheRead
}

/**
 * Sum token/dollar spend from a Claude Code session transcript.
 *
 * `transcriptPath` MUST come from the host's own hook payload
 * (`body.transcript_path` on Claude Code's PreToolUse/PostToolUse/Stop
 * payloads — see `packages/cli/src/commands/hook.ts`'s `ParsedCall.
 * transcriptPath`), never derived by slugifying `cwd`: Claude Code's own
 * slug convention replaces `/`, `.`, AND literal `-` all with `-`, which
 * is provably lossy (`/Users/foo/my-project`, `/Users/foo/my.project`,
 * and `/Users/foo/my/project` all slugify identically) — a derived path
 * can silently point at the wrong session's transcript, or none.
 *
 * Every line in the file at `transcriptPath` is summed — NO per-line
 * filtering by `session_id`/`sessionId`. This is deliberate, not an
 * oversight: a live transcript on this machine showed 63% of assistant
 * lines carry a snake_case `session_id` that does NOT match the file's
 * own identity — those are Task/subagent cross-references to OTHER,
 * separate `.jsonl` files, not evidence the line doesn't belong here. The
 * file's own camelCase top-level `sessionId` DOES always match the file's
 * own identity (confirmed by checking a child transcript directly), which
 * is exactly why point 1's fix — trusting `transcript_path` directly
 * rather than deriving or matching on any session field — sidesteps the
 * whole identity-matching class: once the correct FILE is open, every
 * line physically in it belongs to this session's own spend, full stop.
 *
 * Model normalization (safety-critical, see DEFAULT_PRICE_TABLE's own
 * comment): a line's `message.model` is looked up by exact string match
 * only. `<synthetic>` is skipped outright (always carries all-zero usage
 * on this machine's fixtures). Any OTHER model not found in `priceTable`
 * still contributes its tokens to the running total (token-only
 * enforcement never degrades) but flips `dollarsConfident` to `false` for
 * the WHOLE measurement — one unrecognized model anywhere in the session
 * means the aggregate dollar figure is null, never a partial total
 * silently presented as the true one (that partial-total shape is
 * literally the under-reporting bug this design exists to prevent).
 */
export function measureClaudeCodeSpend(
  transcriptPath: string | undefined,
  priceTable: Record<string, ModelPrice> = DEFAULT_PRICE_TABLE,
): BudgetSpend {
  if (!transcriptPath) {
    return { tokens: 0, dollars: null, dollarsConfident: false, unavailable: true, unrecognizedModels: [] }
  }

  let raw: string
  try {
    raw = readFileSync(transcriptPath, 'utf-8')
  } catch {
    // Missing, unreadable, or a directory/symlink loop — all "cannot
    // measure," never "0 spend, under budget." See BudgetTracker.record()'s
    // own comment for how the caller must handle this.
    return { tokens: 0, dollars: null, dollarsConfident: false, unavailable: true, unrecognizedModels: [] }
  }

  let tokens = 0
  let dollars = 0
  let dollarsConfident = true
  const unrecognizedModels = new Set<string>()

  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    let line: TranscriptLine
    try {
      line = JSON.parse(trimmed) as TranscriptLine
    } catch {
      continue // one corrupt/truncated line does not invalidate the rest of the file
    }
    const model = line.message?.model
    if (model === '<synthetic>') continue
    const usage = line.message?.usage
    if (!usage) continue

    const count = lineTokenCount(usage)
    tokens += count
    if (count === 0) continue

    if (model && priceTable[model]) {
      dollars += lineCost(usage, priceTable[model])
    } else {
      dollarsConfident = false
      if (model) unrecognizedModels.add(model)
    }
  }

  return {
    tokens,
    dollars: dollarsConfident ? dollars : null,
    dollarsConfident,
    unavailable: false,
    unrecognizedModels: [...unrecognizedModels],
  }
}
