/**
 * Concurrency-probe worker for `consumePending`'s per-rule MARK model
 * (Lane G) — mirrors injection-store-worker.ts's shape, spawned as a real
 * child process for the same reason (a genuine multi-process hazard, not a
 * worker_threads simulation of one).
 *
 * argv: [dir, sessionId, ruleId, tagId]
 * Calls `consumePending(sessionId, ruleId, [tagId])` ONCE and prints
 * `{ consumedCount }` as JSON to stdout, so the parent test can verify
 * every worker's own rule id independently marked the SAME tag with no
 * lost update — the property under test is "two different rule ids
 * consuming the same tag concurrently both succeed", the mark-not-delete
 * analogue of the existing recordTag lost-update probe.
 */
import { PersistentInjectionStore } from '../../injection-store.js'

const [, , dir, sessionId, ruleId, tagId] = process.argv
// Same wide lock-wait rationale as injection-store-worker.ts: a
// deliberately adversarial tight-race probe, not a production timing
// scenario.
const store = new PersistentInjectionStore(dir, { timeoutMs: 30_000 })
const consumed = store.consumePending(sessionId, ruleId, [tagId])
process.stdout.write(JSON.stringify({ consumedCount: consumed.length }))
