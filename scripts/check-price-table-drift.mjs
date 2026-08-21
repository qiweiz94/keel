#!/usr/bin/env node
/**
 * Price-table drift check.
 *
 * Compares `DEFAULT_PRICE_TABLE` (packages/core/src/enforce/budget/
 * claude-transcript.ts — the pricing `type: budget` rules use to turn
 * measured tokens into a dollar figure) against a manually-maintained
 * reference snapshot, `scripts/reference-pricing.json`, and reports where
 * they disagree. It NEVER writes to `DEFAULT_PRICE_TABLE` or any source
 * file — detection only, same discipline as `scripts/redteam/round2.mjs`
 * (a re-runnable regression guard, not an auto-fixer).
 *
 * ── Why a local reference file instead of a live fetch ──────────────────
 * This script has no live-fetch mechanism. `scripts/reference-pricing.json`
 * is a human-maintained snapshot: someone periodically re-checks Anthropic's
 * published pricing page against it and hand-edits any number that changed
 * (see that file's own `_meta.update_procedure`). A FUTURE CI job could
 * replace this manual-reference-file step with an actual fetch of the
 * vendor's pricing page once that's wired into this repo's CI
 * infrastructure — building that fetch is explicitly out of scope here;
 * this script only builds the comparison/reporting harness it would feed.
 *
 * ── Why "reference knows a model the table doesn't" is NOT a failure ────
 * `DEFAULT_PRICE_TABLE`'s own header comment is explicit: it is
 * EXACT-STRING-MATCH ONLY, by design, because a real Claude Code transcript
 * emits short aliases (`claude-sonnet-5`) alongside real dated IDs
 * (`claude-haiku-4-5-20251001`), and a table keyed by prefix/pattern match
 * would silently price an alias as whatever dated model it resembles —
 * exactly the guessed dollar figure the design exists to prevent (see
 * `packages/core/src/enforce/__tests__/claude-transcript.test.ts`'s
 * "DEFAULT_PRICE_TABLE is exact-match only" case). An unrecognized model
 * already degrades that session's dollar figure to `null`/unconfident and
 * falls back to token-only enforcement — a safe, by-design state, not a
 * bug. So this script treats "the reference file tracks a model the
 * shipped table doesn't" as INFORMATIONAL ONLY, never a failure: flagging
 * it as an error would pressure a future human toward "just add every
 * model to close the gap," which is the same guessing this table's design
 * exists to prevent. Only a genuine PRICE MISMATCH on a key that exists in
 * BOTH the table and the reference — the vendor changed a number this repo
 * hasn't caught up to — exits non-zero.
 *
 * Usage: node scripts/check-price-table-drift.mjs
 * Requires: `npm run build` already run (reads the built
 * packages/core/dist/enforce/budget/claude-transcript.js — same contract
 * as scripts/redteam/round2.mjs's "Requires: npm run build already run").
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TABLE_PATH = join(REPO, 'packages', 'core', 'dist', 'enforce', 'budget', 'claude-transcript.js')
const REFERENCE_PATH = join(REPO, 'scripts', 'reference-pricing.json')

if (!existsSync(TABLE_PATH)) {
  console.error(`Cannot find the built price table at:\n  ${TABLE_PATH}\nRun \`npm run build\` first (this script reads compiled output, not TypeScript source).`)
  process.exit(1)
}

const { DEFAULT_PRICE_TABLE } = await import(TABLE_PATH)

let reference
try {
  reference = JSON.parse(readFileSync(REFERENCE_PATH, 'utf-8'))
} catch (e) {
  console.error(`Cannot read/parse the reference pricing file at:\n  ${REFERENCE_PATH}\n${e.message}`)
  process.exit(1)
}

const referenceModels = reference.models ?? {}
const PRICE_FIELDS = ['inputPerMTok', 'outputPerMTok', 'cacheWritePerMTok', 'cacheReadPerMTok']

const mismatches = []      // real drift: same key in both, a field disagrees — FAILS the check
const referenceOnly = []   // reference tracks a model the shipped table doesn't — informational only
const tableOnly = []       // shipped table has a model the reference file doesn't track — informational only

for (const [model, refPrice] of Object.entries(referenceModels)) {
  const shipped = DEFAULT_PRICE_TABLE[model]
  if (!shipped) {
    referenceOnly.push(model)
    continue
  }
  const diffs = PRICE_FIELDS.filter(f => (refPrice[f] ?? null) !== (shipped[f] ?? null))
  if (diffs.length > 0) {
    mismatches.push({
      model,
      diffs: diffs.map(f => `${f}: shipped=${shipped[f] ?? 'unset'} reference=${refPrice[f] ?? 'unset'}`),
    })
  }
}

for (const model of Object.keys(DEFAULT_PRICE_TABLE)) {
  if (!(model in referenceModels)) tableOnly.push(model)
}

console.log(`Checked ${Object.keys(referenceModels).length} reference model(s) against ${Object.keys(DEFAULT_PRICE_TABLE).length} shipped DEFAULT_PRICE_TABLE entr${Object.keys(DEFAULT_PRICE_TABLE).length === 1 ? 'y' : 'ies'}.`)
console.log(`Reference source: ${reference._meta?.source ?? '(no source recorded in reference-pricing.json _meta)'}`)
console.log(`Reference last verified: ${reference._meta?.last_verified ?? '(unrecorded)'}`)
console.log('')

if (mismatches.length > 0) {
  console.error(`DRIFT DETECTED — ${mismatches.length} model(s) priced differently than the reference snapshot:`)
  for (const m of mismatches) {
    console.error(`  ${m.model}`)
    for (const d of m.diffs) console.error(`    ${d}`)
  }
  console.error('\nThis means DEFAULT_PRICE_TABLE (claude-transcript.ts) disagrees with')
  console.error('scripts/reference-pricing.json on a model both files price. Update')
  console.error('whichever one is stale by hand — this script never writes either file.')
} else {
  console.log('No price mismatches on models both files price.')
}

if (referenceOnly.length > 0) {
  console.log(`\nInformational — tracked in reference-pricing.json but not yet in DEFAULT_PRICE_TABLE (NOT a failure; an unlisted model already falls back to safe token-only enforcement, per claude-transcript.ts's own exact-match design):`)
  for (const m of referenceOnly) console.log(`  ${m}`)
}

if (tableOnly.length > 0) {
  console.log(`\nInformational — shipped in DEFAULT_PRICE_TABLE but not tracked in reference-pricing.json yet (NOT a failure; just means the reference snapshot hasn't been extended to cover it):`)
  for (const m of tableOnly) console.log(`  ${m}`)
}

process.exit(mismatches.length > 0 ? 1 : 0)
