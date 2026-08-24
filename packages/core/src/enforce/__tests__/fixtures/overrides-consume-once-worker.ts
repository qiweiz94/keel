/**
 * Concurrency-probe worker (see cb-worker.ts for the rationale).
 *
 * argv: [home]
 * Calls consume() ONCE against a single shared `mode: 'once'` override
 * that the parent test pre-writes to disk. `once` semantics mean AT MOST
 * ONE process across the whole fleet should ever see `consume()` return
 * true — a lost update (two processes each holding a stale in-memory
 * read of the override before either deletes it) lets more than one
 * process "win" the same single-use grant, which is exactly the
 * over-consumption failure mode the hand-rolled reclaim-cascade lock bug
 * this class of fix targets would produce. Prints the boolean result on
 * its own stdout line so the parent can count true/false across workers
 * without a second shared file to race on.
 */
import { FileRuleOverrideStore } from '../../overrides.js'

// See cb-worker.ts: a wide lock wait keeps this adversarial probe from
// tripping file-lock.ts's own bounded-wait fail-safe under CI load.
const [, , home] = process.argv
const store = new FileRuleOverrideStore(home, { timeoutMs: 30_000, staleMs: 15_000 })
const result = store.consume('shared-once-rule')
console.log(`RESULT:${result}`)
