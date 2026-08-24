/**
 * Concurrency-probe worker (see cb-worker.ts for the rationale — real OS
 * processes, not worker_threads, because the hazard under test is
 * specifically multi-process: concurrent `keel allow` invocations, or
 * `keel allow` racing the enforcement pipeline's own `consume()` calls,
 * against the same overrides.json).
 *
 * argv: [home, workerId, count]
 * Grants `count` DISTINCT rule-id overrides (one worker's keys never
 * overlap another's) — a lost update here means this worker's grant()
 * call got overwritten by another process's stale in-memory snapshot
 * before it saved, silently dropping the override `keel allow` just told
 * the user had succeeded.
 */
import { FileRuleOverrideStore } from '../../overrides.js'

// See cb-worker.ts: a wide lock wait keeps this adversarial probe from
// tripping file-lock.ts's own bounded-wait fail-safe under CI load.
const [, , home, workerId, countArg] = process.argv
const count = Number(countArg)
const store = new FileRuleOverrideStore(home, { timeoutMs: 30_000, staleMs: 15_000 })
for (let i = 0; i < count; i++) {
  store.grant(`rule-w${workerId}-i${i}`, { expires_at: Date.now() + 3_600_000, mode: 'window' })
}
