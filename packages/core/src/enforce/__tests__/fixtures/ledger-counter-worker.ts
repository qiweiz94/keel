/**
 * Concurrency-probe worker (see cb-worker.ts for the rationale).
 *
 * argv: [ledgerJsonPath, iterations]
 * Records `iterations` failing outcomes for the SAME (cwd, command) pair
 * — same problem_key — so `problem.failures` is a shared counter racing
 * across processes, same shape as StateManager's circuit breaker.
 */
import { ProblemLedger } from '../../problem-ledger.js'

// See cb-worker.ts: a wide lock wait keeps this adversarial probe from
// tripping file-lock.ts's own bounded-wait fail-safe under CI load.
const [, , ledgerJsonPath, iterationsArg] = process.argv
const iterations = Number(iterationsArg)
const ledger = new ProblemLedger(ledgerJsonPath, { timeoutMs: 30_000, staleMs: 15_000 })
for (let i = 0; i < iterations; i++) {
  ledger.recordOutcome('/shared/project', 'npm test', 1)
}
