import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProblemLedger, problemKey } from '../problem-ledger.js'
import { commandFingerprint } from '../command-fingerprint.js'
import { runWorkersConcurrently } from './fixtures/spawn-worker.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Cross-process safety for ProblemLedger's read-modify-write cycle
 * (roadmap C2) — same hazard as state-manager-concurrency.test.ts,
 * applied to ledger.json. A lost update here means a dropped fix-attempt
 * count (a `stuck` problem never crosses its 3-failure threshold) or a
 * dropped problem entry entirely (another process's ledger.recordOutcome
 * never observed downstream — the `diagnosis` rule sees no active
 * problem and never gates the fix it should have).
 *
 * Proven red->green manually while writing this test, the same way as
 * the state-manager probe (acquireLock() forced to return false ->
 * counts well under the expected total; restored -> exact total every
 * time). See session/v04/EVIDENCE/c2-concurrency.md.
 */

const tmpDirs: string[] = []
function freshLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keel-ledger-concurrency-'))
  tmpDirs.push(dir)
  return join(dir, 'ledger.json')
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    rmSafe(dir)
  }
})

describe('ProblemLedger — cross-process lost-update safety', () => {
  it(
    'concurrent recordOutcome calls for the SAME problem sum failures without loss',
    async () => {
      const ledgerPath = freshLedgerPath()
      const workers = 5
      const iterationsPerWorker = 40
      const expectedTotal = workers * iterationsPerWorker

      await runWorkersConcurrently(
        './ledger-counter-worker.ts',
        Array.from({ length: workers }, () => [ledgerPath, String(iterationsPerWorker)]),
      )

      const ledger = new ProblemLedger(ledgerPath)
      const problems = ledger.problems()
      expect(problems.length).toBe(1)
      expect(problems[0].failures).toBe(expectedTotal)
    },
    60_000,
  )

  it(
    'concurrent recordOutcome calls for DISTINCT problems drop no entries',
    async () => {
      const ledgerPath = freshLedgerPath()
      const workers = 5
      const problemsPerWorker = 20

      await runWorkersConcurrently(
        './ledger-distinct-worker.ts',
        Array.from({ length: workers }, (_, w) => [ledgerPath, String(w), String(problemsPerWorker)]),
      )

      const raw = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { problems: Record<string, unknown> }
      expect(Object.keys(raw.problems).length).toBe(workers * problemsPerWorker)

      // Every worker's problems must be individually present (not just
      // the right total count — a coincidental overwrite that dropped
      // one key while duplicating another would still pass a count-only
      // check). Reconstruct each expected key the same way the worker
      // fixture derived it and confirm the ledger recorded it, with the
      // failure count the single call for that key should have produced.
      const ledger = new ProblemLedger(ledgerPath)
      const fp = commandFingerprint('npm test')
      for (let w = 0; w < workers; w++) {
        for (let i = 0; i < problemsPerWorker; i++) {
          const key = problemKey(`/shared/worker-${w}/iter-${i}`, fp)
          const problem = ledger.problem(key)
          expect(problem, `missing problem for worker ${w} iter ${i}`).toBeDefined()
          expect(problem?.failures).toBe(1)
        }
      }
    },
    60_000,
  )
})
