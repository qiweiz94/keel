import type { BudgetSpend } from '../budget-tracker.js'

/**
 * Reads OpenCode's own rollup columns straight off its `session` table
 * (`~/.local/share/opencode/opencode.db` by default — confirmed live on
 * this machine, real installed OpenCode version). This is the OpenCode
 * counterpart of budget/claude-transcript.ts, and it is a COMPLETELY
 * SEPARATE implementation on purpose, not a variant of the transcript
 * reader forced through a shared abstraction: OpenCode does not write
 * per-session JSONL transcript files at all, and its `session` row already
 * carries `cost` computed in DOLLARS by OpenCode itself (spanning wildly
 * heterogeneous providers/models — `opencode-go`, `ollama-local`,
 * `gemini-local`, `hy3`, `deepseek-v4-flash`, `glm-5.1` — a keel-side
 * pricing table would be hopeless for these and unnecessary, since
 * OpenCode has already solved model pricing internally). No model-
 * normalization logic lives here for that reason: there is no per-model
 * lookup to get wrong.
 *
 * Uses `node:sqlite` (Node's built-in SQLite binding, present on this
 * package's minimum supported Node version). Imported dynamically
 * (`await import(...)`, this package is ESM throughout) and defensively:
 * OpenCode's own plugin host may run under a runtime where this module is
 * unavailable, and a missing/broken binding must degrade to
 * `unavailable: true` — the same fail-loud-not-fail-open posture as a
 * missing transcript on the Claude Code side — never throw out of this
 * function and never silently report zero spend.
 */
export async function measureOpenCodeSpend(dbPath: string | undefined, sessionId: string | undefined): Promise<BudgetSpend> {
  if (!dbPath || !sessionId) {
    return { tokens: 0, dollars: null, dollarsConfident: false, unavailable: true, unrecognizedModels: [] }
  }

  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare(
        'SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = ?',
      ).get(sessionId) as Record<string, unknown> | undefined

      if (!row) {
        // A real, readable database with no matching row is a genuine
        // "no spend recorded yet for this session" — not the same failure
        // shape as "could not read the source at all." Confidently zero,
        // not unavailable.
        return { tokens: 0, dollars: 0, dollarsConfident: true, unavailable: false, unrecognizedModels: [] }
      }

      const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0
      const tokens = num(row.tokens_input) + num(row.tokens_output) + num(row.tokens_reasoning)
        + num(row.tokens_cache_read) + num(row.tokens_cache_write)
      const costValue = row.cost
      const dollarsConfident = typeof costValue === 'number' && Number.isFinite(costValue)
      return {
        tokens,
        dollars: dollarsConfident ? (costValue as number) : null,
        dollarsConfident,
        unavailable: false,
        unrecognizedModels: [],
      }
    } finally {
      db.close()
    }
  } catch {
    // Missing db file, missing `session` table, missing `node:sqlite`
    // binding on this runtime, a locked/corrupt db — all "cannot measure,"
    // never "0 spend, under budget." See BudgetTracker.record()'s own
    // comment for how the caller must handle this.
    return { tokens: 0, dollars: null, dollarsConfident: false, unavailable: true, unrecognizedModels: [] }
  }
}
