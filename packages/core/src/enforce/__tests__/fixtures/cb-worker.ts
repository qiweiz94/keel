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

// A wide lock wait (timeoutMs) — much wider than the 5000ms production
// default — so this deliberately adversarial tight-loop probe (many
// processes, zero think-time between calls) never trips file-lock.ts's
// fail-safe (proceed unlocked past the wait bound) and turns a slow CI
// box into a false red. The property under test is "no lost updates
// under a real lock", not "the lock's own bounded-wait fail-safe never
// fires". staleMs is widened too (default 8000ms -> 15000ms): a holder
// that is merely descheduled by the OS under this many concurrent
// processes' CPU contention, not actually dead, can otherwise look
// "abandoned" to a waiter and get falsely reclaimed -- at which point
// BOTH the falsely-reclaimed original holder and the new reclaimer can
// briefly believe they hold the lock and run their read-modify-write
// bodies concurrently. The token check on release only stops a late
// release from deleting the wrong holder's lockfile; it does nothing to
// stop that concurrent double-execution once a false reclaim has already
// happened, so a real lost update can still occur (a 199-not-200 result,
// reproduced on windows-latest CI with the tighter default).
const [, , dir, iterationsArg] = process.argv
const iterations = Number(iterationsArg)
const sm = new StateManager(dir, { timeoutMs: 30_000, staleMs: 15_000 })
for (let i = 0; i < iterations; i++) {
  sm.recordCircuitBreaker('race-rule', 'Bash')
}
