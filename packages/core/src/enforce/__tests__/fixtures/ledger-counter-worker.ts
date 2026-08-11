/**
 * Concurrency-probe worker (see cb-worker.ts for the rationale).
 *
 * argv: [ledgerJsonPath, iterations]
 * Records `iterations` failing outcomes for the SAME (cwd, command) pair
 * — same problem_key — so `problem.failures` is a shared counter racing
 * across processes, same shape as StateManager's circuit breaker.
 */
import { ProblemLedger } from '../../problem-ledger.js'

const [, , ledgerJsonPath, iterationsArg] = process.argv
const iterations = Number(iterationsArg)
const ledger = new ProblemLedger(ledgerJsonPath)
for (let i = 0; i < iterations; i++) {
  ledger.recordOutcome('/shared/project', 'npm test', 1)
}
