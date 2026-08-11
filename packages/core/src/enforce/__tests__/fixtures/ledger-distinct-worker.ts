/**
 * Concurrency-probe worker (see cb-worker.ts for the rationale).
 *
 * argv: [ledgerJsonPath, workerId, count]
 * Records `count` DISTINCT problems (`cwd` varies per worker+iteration,
 * which problemKey() hashes verbatim — commandFingerprint() strips
 * numeric literals from `command`, so distinctness must come from `cwd`,
 * not the command string). A lost update here means one process's
 * ledger.problems entry for a key that ONLY that process ever wrote
 * vanished because a concurrent save() clobbered it with a stale
 * in-memory `problems` map that never had that key.
 */
import { ProblemLedger } from '../../problem-ledger.js'

const [, , ledgerJsonPath, workerId, countArg] = process.argv
const count = Number(countArg)
const ledger = new ProblemLedger(ledgerJsonPath)
for (let i = 0; i < count; i++) {
  ledger.recordOutcome(`/shared/worker-${workerId}/iter-${i}`, 'npm test', 1)
}
