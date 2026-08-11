/**
 * Concurrency-probe worker (spawned as a real child process, not a
 * worker_thread — the hazard under test is separate OS processes racing
 * on a shared file, e.g. two hook invocations from parallel agent
 * sessions). Run via vite-node so it can import the .ts source directly.
 *
 * argv: [dir, iterations]
 * Increments the SAME circuit-breaker counter `iterations` times.
 */
import { StateManager } from '../../state-manager.js'

// A wide lock wait — much wider than the 5000ms production default —
// so this deliberately adversarial tight-loop probe (many processes,
// zero think-time between calls) never trips file-lock.ts's fail-safe
// (proceed unlocked past the wait bound) and turns a slow CI box into a
// false red. The property under test is "no lost updates under a real
// lock", not "the lock's own bounded-wait fail-safe never fires".
const [, , dir, iterationsArg] = process.argv
const iterations = Number(iterationsArg)
const sm = new StateManager(dir, { timeoutMs: 30_000 })
for (let i = 0; i < iterations; i++) {
  sm.recordCircuitBreaker('race-rule', 'Bash')
}
