import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runWorkersConcurrently } from './fixtures/spawn-worker.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Cross-process safety for StateManager's read-modify-write cycle
 * (roadmap C2). Without a lock around load -> mutate -> save, two
 * processes each hold their own in-memory snapshot of a state file;
 * whichever saves second overwrites whatever the first wrote in between
 * — a lost update. This clobbers real enforcement state: a dropped
 * circuit-breaker increment lets a rule silently fail to trip at its
 * threshold; a dropped deny-first-time entry silently re-triggers a
 * "warn once" message forever (or drops it, letting a violation through
 * unwarned).
 *
 * These tests spawn real OS processes (see fixtures/spawn-worker.ts) that
 * import state-manager.ts directly, racing on ONE shared KEEL_STATE_DIR.
 *
 * Proven red->green manually while writing this test: with
 * `acquireLock()` in file-lock.ts temporarily forced to always return
 * `false` (no serialization, `fn()` runs unlocked every time — exactly
 * the pre-fix behavior), 5 processes x 50 increments against
 * `recordCircuitBreaker` landed at 113, 36, and 138 (three separate
 * trials) instead of 250 — reproducing the lost-update bug reliably.
 * Restored, the same probe lands at exactly 250 every time. See
 * session/v04/EVIDENCE/c2-concurrency.md for the full transcript.
 */

const tmpDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keel-state-concurrency-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    rmSafe(dir)
  }
})

describe('StateManager — cross-process lost-update safety', () => {
  it(
    'concurrent recordCircuitBreaker increments from N processes sum without loss',
    async () => {
      const dir = freshDir()
      const workers = 5
      const iterationsPerWorker = 40
      const expectedTotal = workers * iterationsPerWorker

      await runWorkersConcurrently(
        './cb-worker.ts',
        Array.from({ length: workers }, () => [dir, String(iterationsPerWorker)]),
      )

      const raw = JSON.parse(readFileSync(join(dir, 'circuit-breaker.json'), 'utf-8'))
      expect(raw['race-rule:Bash'].count).toBe(expectedTotal)
    },
    60_000,
  )

  it(
    'concurrent markFirstTime calls from N processes drop no distinct keys',
    async () => {
      const dir = freshDir()
      const workers = 5
      const keysPerWorker = 20

      await runWorkersConcurrently(
        './deny-worker.ts',
        Array.from({ length: workers }, (_, w) => [dir, String(w), String(keysPerWorker)]),
      )

      expect(existsSync(join(dir, 'deny-first-time.json'))).toBe(true)
      const raw = JSON.parse(readFileSync(join(dir, 'deny-first-time.json'), 'utf-8'))
      const keys = Object.keys(raw)
      expect(keys.length).toBe(workers * keysPerWorker)
      for (let w = 0; w < workers; w++) {
        for (let i = 0; i < keysPerWorker; i++) {
          expect(raw).toHaveProperty(`rule-w${w}-i${i}`)
        }
      }
    },
    60_000,
  )
})
