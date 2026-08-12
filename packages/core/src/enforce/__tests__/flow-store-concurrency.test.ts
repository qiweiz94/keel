import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runWorkersConcurrently } from './fixtures/spawn-worker.js'
import { rmSafe } from './helpers/fs-safe.js'
import { PersistentFlowStore } from '../flow-store.js'

/**
 * Cross-process safety for PersistentFlowStore's load -> merge -> persist
 * cycle (AUDIT §5's b1-exfil lane). Mirrors
 * state-manager-concurrency.test.ts's proof for StateManager exactly, for
 * the same reason: without withFileLock() serializing the read-modify-
 * write, two `keel hook` processes racing on the SAME session's tag list
 * each hold their own in-memory snapshot, and the second save()
 * overwrites whatever the first wrote — a lost tag. A dropped tag here
 * doesn't corrupt anything security-critical (this store backs a
 * warn/observe rule, never a deny floor — see flow-store.ts's fail-safe
 * doc comment), but it WOULD quietly make the cross-call correlation this
 * lane exists to add less reliable than intended under real concurrent
 * agent tool calls.
 *
 * These tests spawn real OS processes (fixtures/flow-store-worker.ts) that
 * import flow-store.ts directly, racing on ONE shared directory AND one
 * shared session_id — the actual production shape (parallel tool calls
 * inside one agent session, e.g. sub-agents, both hitting `keel hook`).
 */

const tmpDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keel-flow-store-concurrency-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    rmSafe(dir)
  }
})

describe('PersistentFlowStore — cross-process lost-update safety', () => {
  it(
    'concurrent recordTag calls from N processes, same session, land every tag with no loss or corruption',
    async () => {
      const dir = freshDir()
      const workers = 3
      const tagsPerWorker = 10 // stays under MAX_TAGS_PER_SESSION (50) so none are evicted by the bound, not the race
      const sessionId = 'shared-concurrent-session'

      await runWorkersConcurrently(
        './flow-store-worker.ts',
        Array.from({ length: workers }, (_, w) => [dir, sessionId, String(w), String(tagsPerWorker)]),
      )

      const store = new PersistentFlowStore(dir)
      const tags = store.getTags(sessionId)
      expect(tags.length, 'every worker\'s tags must have survived the race').toBe(workers * tagsPerWorker)

      // No lost updates AND no corruption: every expected (worker, index)
      // pair is present exactly once.
      const seen = new Set(tags.map(t => t.source))
      expect(seen.size).toBe(workers * tagsPerWorker)
      for (let w = 0; w < workers; w++) {
        for (let i = 0; i < tagsPerWorker; i++) {
          expect(seen.has(`sensitive-path:worker-${w}-tag-${i}`), `missing worker ${w} tag ${i}`).toBe(true)
        }
      }
    },
    60_000,
  )

  it(
    'concurrent recordTag calls across DIFFERENT sessions stay isolated (no cross-session bleed under the race)',
    async () => {
      const dir = freshDir()
      const workers = 4
      const tagsPerWorker = 5

      // Each worker gets its OWN session id this time.
      await runWorkersConcurrently(
        './flow-store-worker.ts',
        Array.from({ length: workers }, (_, w) => [dir, `session-${w}`, String(w), String(tagsPerWorker)]),
      )

      const store = new PersistentFlowStore(dir)
      for (let w = 0; w < workers; w++) {
        const tags = store.getTags(`session-${w}`)
        expect(tags.length, `session-${w} should have exactly this worker's tags`).toBe(tagsPerWorker)
        expect(tags.every(t => t.source.startsWith(`sensitive-path:worker-${w}-`))).toBe(true)
      }
    },
    60_000,
  )
})
