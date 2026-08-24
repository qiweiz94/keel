/**
 * Concurrency-probe worker (spawned as a real child process, not a
 * worker_thread — the hazard under test is separate OS processes racing on
 * a shared file, e.g. two `keel hook` invocations from parallel agent tool
 * calls in the same session). Run via vite-node so it can import the .ts
 * source directly. Mirrors fixtures/cb-worker.ts's shape for
 * PersistentFlowStore (flow-store.ts) instead of StateManager.
 *
 * argv: [dir, sessionId, workerId, count]
 * Persists `count` distinct tags for the SAME sessionId, each source
 * labeled with this worker's id and loop index so the parent test can
 * verify every single one survived the race with no lost updates.
 */
import { PersistentFlowStore } from '../../flow-store.js'

const [, , dir, sessionId, workerId, countArg] = process.argv
const count = Number(countArg)
// A wide lock wait — much wider than the 5000ms production default — so
// this deliberately adversarial tight-loop probe (many processes, zero
// think-time between calls) never trips file-lock.ts's own fail-safe
// (proceed unlocked past the wait bound) and turns a slow CI box into a
// false red. The property under test is "no lost updates under a real
// lock", not "the lock's own bounded-wait fail-safe never fires" — same
// reasoning as cb-worker.ts.
const store = new PersistentFlowStore(dir, { timeoutMs: 30_000, staleMs: 15_000 })
for (let i = 0; i < count; i++) {
  store.recordTag(sessionId, {
    source: `sensitive-path:worker-${workerId}-tag-${i}`,
    timestamp: Date.now(),
    originTool: 'Bash',
  })
}
