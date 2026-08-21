/**
 * Concurrency-probe worker (spawned as a real child process — see
 * flow-store-worker.ts's own header comment for why real OS processes, not
 * worker_threads). Mirrors flow-store-worker.ts's shape for
 * PersistentInjectionStore (injection-store.ts) instead of
 * PersistentFlowStore.
 *
 * argv: [dir, sessionId, workerId, count]
 * Persists `count` distinct tags for the SAME sessionId, each tagged with
 * this worker's id and loop index so the parent test can verify every
 * single one survived the race with no lost updates.
 */
import { PersistentInjectionStore } from '../../injection-store.js'

const [, , dir, sessionId, workerId, countArg] = process.argv
const count = Number(countArg)
// Same wide lock-wait rationale as flow-store-worker.ts: this is a
// deliberately adversarial tight-loop probe, not a production timing
// scenario — the property under test is "no lost updates under a real
// lock", not "the lock's own bounded-wait fail-safe never fires".
const store = new PersistentInjectionStore(dir, { timeoutMs: 30_000 })
for (let i = 0; i < count; i++) {
  store.recordTag(sessionId, {
    source: 'tool_output',
    timestamp: Date.now(),
    originTool: `worker-${workerId}-tag-${i}`,
    ruleIds: ['injected-instructions-in-tool-output'],
    markerCount: 1,
    neutralized: false,
  })
}
