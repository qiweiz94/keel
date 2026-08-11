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

const [, , dir, iterationsArg] = process.argv
const iterations = Number(iterationsArg)
const sm = new StateManager(dir)
for (let i = 0; i < iterations; i++) {
  sm.recordCircuitBreaker('race-rule', 'Bash')
}
