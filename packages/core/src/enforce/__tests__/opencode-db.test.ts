import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { measureOpenCodeSpend } from '../budget/opencode-db.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Point 6: OpenCode's own `session` table already carries a computed
 * `cost` (dollars) and per-kind token rollup columns directly on the row —
 * confirmed live against a real installed OpenCode's
 * `~/.local/share/opencode/opencode.db` schema shape. This suite never
 * touches that real personal database (per this lane's own instruction to
 * prefer synthetic fixtures) — it builds a synthetic db with the same
 * `session` table shape using `node:sqlite` and asserts the reader sums
 * the rollup columns and trusts OpenCode's own `cost` figure directly, with
 * NO per-model pricing logic on keel's side (unlike the Claude Code path).
 */

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-opencode-db-test-'))
})

afterEach(() => {
  rmSafe(dir)
})

async function makeDb(rows: Array<{ id: string; cost: number | null; tokens_input: number; tokens_output: number; tokens_reasoning: number; tokens_cache_read: number; tokens_cache_write: number; directory: string }>): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = join(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, cost REAL, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, directory TEXT
  )`)
  const insert = db.prepare('INSERT INTO session (id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, directory) VALUES (?,?,?,?,?,?,?,?)')
  for (const row of rows) {
    insert.run(row.id, row.cost, row.tokens_input, row.tokens_output, row.tokens_reasoning, row.tokens_cache_read, row.tokens_cache_write, row.directory)
  }
  db.close()
  return dbPath
}

describe('measureOpenCodeSpend — point 6, OpenCode session table rollup columns', () => {
  it('sums the token rollup columns and trusts the row\'s own cost directly (no pricing table)', async () => {
    const dbPath = await makeDb([
      { id: 'ses_abc', cost: 4.56, tokens_input: 1000, tokens_output: 2000, tokens_reasoning: 300, tokens_cache_read: 400, tokens_cache_write: 500, directory: '/tmp/proj' },
    ])
    const spend = await measureOpenCodeSpend(dbPath, 'ses_abc')
    expect(spend.unavailable).toBe(false)
    expect(spend.tokens).toBe(1000 + 2000 + 300 + 400 + 500)
    expect(spend.dollarsConfident).toBe(true)
    expect(spend.dollars).toBeCloseTo(4.56, 5)
  })

  it('handles heterogeneous non-Anthropic model sessions identically — no per-model lookup at all', async () => {
    // hy3 / deepseek-v4-flash / glm-5.1-style providers — OpenCode already
    // priced these itself; this reader has no model-awareness to get wrong.
    const dbPath = await makeDb([
      { id: 'ses_local', cost: 0, tokens_input: 500, tokens_output: 500, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, directory: '/tmp/proj' },
    ])
    const spend = await measureOpenCodeSpend(dbPath, 'ses_local')
    expect(spend.tokens).toBe(1000)
    expect(spend.dollarsConfident).toBe(true)
    expect(spend.dollars).toBe(0)
  })

  it('a row with a null/missing cost degrades dollars to unconfident, tokens still count', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const dbPath = join(dir, 'opencode-nullcost.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, directory TEXT)')
    db.prepare('INSERT INTO session (id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, directory) VALUES (?,NULL,?,?,?,?,?,?)')
      .run('ses_nullcost', 100, 100, 0, 0, 0, '/tmp/proj')
    db.close()

    const spend = await measureOpenCodeSpend(dbPath, 'ses_nullcost')
    expect(spend.tokens).toBe(200)
    expect(spend.dollarsConfident).toBe(false)
    expect(spend.dollars).toBeNull()
  })

  it('point 5 parity: no matching session row is a confident zero (genuinely nothing spent yet), NOT unavailable', async () => {
    const dbPath = await makeDb([])
    const spend = await measureOpenCodeSpend(dbPath, 'ses_never_existed')
    expect(spend.unavailable).toBe(false)
    expect(spend.tokens).toBe(0)
    expect(spend.dollarsConfident).toBe(true)
    expect(spend.dollars).toBe(0)
  })

  it('point 5: a missing database file is unavailable, never a confident zero', async () => {
    const spend = await measureOpenCodeSpend(join(dir, 'does-not-exist.db'), 'ses_abc')
    expect(spend.unavailable).toBe(true)
    expect(spend.dollarsConfident).toBe(false)
    expect(spend.dollars).toBeNull()
  })

  it('point 5: missing dbPath or sessionId is unavailable, never a confident zero', async () => {
    expect((await measureOpenCodeSpend(undefined, 'ses_abc')).unavailable).toBe(true)
    expect((await measureOpenCodeSpend(join(dir, 'x.db'), undefined)).unavailable).toBe(true)
  })
})
