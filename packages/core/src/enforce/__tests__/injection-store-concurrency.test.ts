import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runWorkersConcurrently } from './fixtures/spawn-worker.js'
import { rmSafe } from './helpers/fs-safe.js'
import { PersistentInjectionStore } from '../injection-store.js'

/**
 * Cross-process safety for PersistentInjectionStore's load -> merge ->
 * persist cycle. Mirrors flow-store-concurrency.test.ts's proof for
 * PersistentFlowStore exactly, for the same reason: without withFileLock()
 * serializing the read-modify-write, two `keel hook` processes racing on
 * the SAME session's tag list each hold their own in-memory snapshot, and
 * the second save() overwrites whatever the first wrote — a lost tag. A
 * dropped tag here doesn't corrupt anything security-critical (this store
 * backs a warn/observe rule, never a deny floor — see injection-store.ts's
 * fail-safe doc comment), but it would quietly make the next-call scrutiny
 * gate less reliable than intended under real concurrent tool calls (e.g.
 * a detection recorded by the CLI hook process racing the opencode plugin's
 * own write-back on a sub-agent path).
 */

const tmpDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keel-injection-store-concurrency-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    rmSafe(dir)
  }
})

describe('PersistentInjectionStore — cross-process lost-update safety', () => {
  it(
    'concurrent recordTag calls from N processes, same session, land every tag with no loss or corruption',
    async () => {
      const dir = freshDir()
      const workers = 3
      const tagsPerWorker = 10 // stays under MAX_TAGS_PER_SESSION (50) so none are evicted by the bound, not the race
      const sessionId = 'shared-concurrent-session'

      await runWorkersConcurrently(
        './injection-store-worker.ts',
        Array.from({ length: workers }, (_, w) => [dir, sessionId, String(w), String(tagsPerWorker)]),
      )

      const store = new PersistentInjectionStore(dir)
      const tags = store.peekPending(sessionId)
      expect(tags.length, 'every worker\'s tags must have survived the race').toBe(workers * tagsPerWorker)

      const seen = new Set(tags.map(t => t.originTool))
      expect(seen.size).toBe(workers * tagsPerWorker)
      for (let w = 0; w < workers; w++) {
        for (let i = 0; i < tagsPerWorker; i++) {
          expect(seen.has(`worker-${w}-tag-${i}`), `missing worker ${w} tag ${i}`).toBe(true)
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

      await runWorkersConcurrently(
        './injection-store-worker.ts',
        Array.from({ length: workers }, (_, w) => [dir, `session-${w}`, String(w), String(tagsPerWorker)]),
      )

      const store = new PersistentInjectionStore(dir)
      for (let w = 0; w < workers; w++) {
        const tags = store.peekPending(`session-${w}`)
        expect(tags.length, `session-${w} should have exactly this worker's tags`).toBe(tagsPerWorker)
        expect(tags.every(t => t.originTool.startsWith(`worker-${w}-`))).toBe(true)
      }
    },
    60_000,
  )

  it(
    'two processes calling consumePending for DIFFERENT rule ids against the SAME tag both succeed with no lost update (Lane G per-rule mark model)',
    async () => {
      const dir = freshDir()
      const sessionId = 'shared-consume-session'
      const tagId = 'the-one-shared-tag'
      const store = new PersistentInjectionStore(dir)
      store.recordTag(sessionId, {
        source: 'tool_output',
        timestamp: Date.now(),
        originTool: 'Read',
        ruleIds: ['injected-instructions-in-tool-output'],
        markerCount: 1,
        neutralized: false,
        id: tagId,
      })

      const results = await runWorkersConcurrently(
        './injection-store-consume-worker.ts',
        [
          [dir, sessionId, 'untrusted-content-next-call', tagId],
          [dir, sessionId, 'untrusted-content-derived-call', tagId],
        ],
      )
      const counts = results.map(r => JSON.parse(r.stdout).consumedCount as number)
      // Each worker's OWN rule id must have successfully marked the tag —
      // neither can lose to the other under the race.
      expect(counts, `expected both workers to consume exactly once each — got ${JSON.stringify(counts)}`).toEqual([1, 1])

      const finalStore = new PersistentInjectionStore(dir)
      expect(finalStore.peekPending(sessionId, 'untrusted-content-next-call')).toEqual([])
      expect(finalStore.peekPending(sessionId, 'untrusted-content-derived-call')).toEqual([])
      // Unfiltered peek: the tag is still there (marked, not deleted) with BOTH rule ids recorded.
      const [survivor] = finalStore.peekPending(sessionId)
      expect(survivor).toBeDefined()
      expect(survivor.consumedBy?.sort()).toEqual(['untrusted-content-derived-call', 'untrusted-content-next-call'])
    },
    60_000,
  )
})
