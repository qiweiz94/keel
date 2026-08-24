/**
 * Concurrency-probe worker (see cb-worker.ts for the rationale).
 *
 * argv: [dir, workerId, count]
 * Marks `count` DISTINCT rule ids first-time-violated (one worker's keys
 * never overlap another's) — a lost update here means the file this
 * worker's markFirstTime() call wrote to got overwritten by another
 * process's stale in-memory snapshot before it saved, silently dropping
 * this worker's "warn once" entries.
 */
import { StateManager } from '../../state-manager.js'

// See cb-worker.ts: a wide lock wait keeps this adversarial probe from
// tripping file-lock.ts's own bounded-wait fail-safe under CI load.
const [, , dir, workerId, countArg] = process.argv
const count = Number(countArg)
const sm = new StateManager(dir, { timeoutMs: 30_000, staleMs: 15_000 })
for (let i = 0; i < count; i++) {
  sm.markFirstTime(`rule-w${workerId}-i${i}`)
}
