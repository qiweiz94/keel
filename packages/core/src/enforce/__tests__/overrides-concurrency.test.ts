import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileRuleOverrideStore } from '../overrides.js'
import { runWorkersConcurrently } from './fixtures/spawn-worker.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Cross-process safety for FileRuleOverrideStore's read-modify-write
 * cycle — same hazard class as state-manager-concurrency.test.ts and
 * ledger-concurrency.test.ts, applied to overrides.json. Before this
 * lane, FileRuleOverrideStore used its own hand-rolled lock (an
 * unconditional `unlinkSync` in `finally`, no ownership token), which
 * reproduces the exact stale-lock reclaim-cascade file-lock.ts's own
 * header comment warns against: holder A stalls past the staleness
 * check, waiter B reclaims (deletes A's lock, creates its own), A wakes
 * up and unconditionally unlinks in its `finally` — deleting B's live
 * lock, not its own, letting a third process in while B still believes
 * it holds it. A lost update here means a dropped `keel allow` grant (a
 * user is told an override succeeded, but the write never lands) or,
 * worse, a single-use `once` override consumed by more than one
 * process — see the second test below.
 *
 * These tests spawn real OS processes (see fixtures/spawn-worker.ts)
 * that import overrides.ts directly, racing on ONE shared overrides.json
 * (via a shared `home` directory — FileRuleOverrideStore resolves
 * `<home>/.keel/overrides.json`).
 */

const tmpDirs: string[] = []
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keel-overrides-concurrency-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    rmSafe(dir)
  }
})

describe('FileRuleOverrideStore — cross-process lost-update safety', () => {
  it(
    'concurrent grant() calls from N processes drop no distinct entries',
    async () => {
      const home = freshHome()
      const workers = 5
      const grantsPerWorker = 20

      await runWorkersConcurrently(
        './overrides-worker.ts',
        Array.from({ length: workers }, (_, w) => [home, String(w), String(grantsPerWorker)]),
      )

      const raw = JSON.parse(readFileSync(join(home, '.keel', 'overrides.json'), 'utf-8'))
      const keys = Object.keys(raw)
      expect(keys.length).toBe(workers * grantsPerWorker)
      for (let w = 0; w < workers; w++) {
        for (let i = 0; i < grantsPerWorker; i++) {
          expect(raw).toHaveProperty(`rule-w${w}-i${i}`)
        }
      }
    },
    60_000,
  )

  it(
    'concurrent consume() calls against a SHARED "once" override let exactly one process win it',
    async () => {
      const home = freshHome()
      const directory = join(home, '.keel')
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, 'overrides.json'),
        JSON.stringify({ 'shared-once-rule': { expires_at: Date.now() + 3_600_000, mode: 'once' } }),
      )

      const workers = 8
      const results = await runWorkersConcurrently(
        './overrides-consume-once-worker.ts',
        Array.from({ length: workers }, () => [home]),
      )

      const wins = results.filter((r) => r.stdout.includes('RESULT:true')).length
      const losses = results.filter((r) => r.stdout.includes('RESULT:false')).length
      expect(wins).toBe(1)
      expect(losses).toBe(workers - 1)

      // The override must be gone from disk — consumed, not merely
      // "seen" by the winner while a lost update left a stale copy on
      // disk.
      const raw = JSON.parse(readFileSync(join(directory, 'overrides.json'), 'utf-8'))
      expect(raw).not.toHaveProperty('shared-once-rule')
    },
    60_000,
  )
})
