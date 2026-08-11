import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireLock, releaseLock, withFileLock } from '../file-lock.js'

/**
 * Unit tests for the two properties file-lock.ts's header comment claims
 * but that the cross-process races tests (state-manager-concurrency /
 * ledger-concurrency) don't directly exercise, because those tests only
 * ever see the HAPPY path (lock always eventually available). These
 * cover the two failure paths deterministically, in-process, with no
 * child processes needed:
 *
 *   1. The documented fail-safe: on a bounded timeout, `withFileLock`
 *      still runs `fn` unlocked, and `acquireLock` returns within its
 *      bound rather than hanging.
 *   2. Stale-lock reclaim: a lock abandoned by a dead/frozen holder
 *      does not wedge every future writer forever.
 *   3. Release-token ownership: a late release from a holder that was
 *      already reclaimed as stale must not delete the new holder's
 *      live lock (the reclaim-cascade this module's header warns about).
 */

const tmpDirs: string[] = []
function freshLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keel-file-lock-test-'))
  tmpDirs.push(dir)
  return join(dir, 'resource.json.lock')
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('file-lock — uncontended path', () => {
  it('acquireLock creates the lockfile and returns a token written into it', () => {
    const lockPath = freshLockPath()
    const token = acquireLock(lockPath)
    expect(token).not.toBeNull()
    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf-8')).toBe(token)
    releaseLock(lockPath, token!)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('withFileLock runs fn and releases the lock afterward', () => {
    const lockPath = freshLockPath()
    let ran = false
    const result = withFileLock(lockPath, () => {
      ran = true
      expect(existsSync(lockPath)).toBe(true) // held while fn runs
      return 42
    })
    expect(ran).toBe(true)
    expect(result).toBe(42)
    expect(existsSync(lockPath)).toBe(false) // released after
  })
})

describe('file-lock — fail-safe on timeout (never hangs, never drops the write)', () => {
  it('acquireLock returns null within its bound when the lock is held and not stale', () => {
    const lockPath = freshLockPath()
    writeFileSync(lockPath, 'someone-else:holds-this') // simulate another process's live lock

    const timeoutMs = 100
    const start = Date.now()
    const token = acquireLock(lockPath, { timeoutMs, staleMs: 60_000 }) // staleMs way beyond the wait — never reclaimed
    const elapsed = Date.now() - start

    expect(token).toBeNull()
    // Bounded: must not hang, and must not return near-instantly either
    // (that would mean it gave up without really trying/retrying).
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs * 0.5)
    expect(elapsed).toBeLessThan(timeoutMs + 2000) // generous slack for CI scheduling jitter
  })

  it('withFileLock still runs fn, unlocked, when the lock cannot be acquired in time', () => {
    const lockPath = freshLockPath()
    writeFileSync(lockPath, 'someone-else:holds-this')

    let ran = false
    const result = withFileLock(lockPath, () => {
      ran = true
      return 'fn ran despite no lock'
    }, { timeoutMs: 100, staleMs: 60_000 })

    expect(ran).toBe(true) // the fail-safe: the write is never silently skipped
    expect(result).toBe('fn ran despite no lock')
    // The held (not-ours) lockfile is untouched — we never acquired it,
    // so we must not have released/deleted someone else's lock either.
    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf-8')).toBe('someone-else:holds-this')
  })
})

describe('file-lock — stale-lock reclaim (a dead holder cannot wedge future writers forever)', () => {
  it('acquireLock reclaims a lockfile older than staleMs', () => {
    const lockPath = freshLockPath()
    writeFileSync(lockPath, 'dead-holder:never-released')
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(lockPath, longAgo, longAgo) // backdate mtime to simulate an abandoned lock

    const token = acquireLock(lockPath, { timeoutMs: 2000, staleMs: 100 })

    expect(token).not.toBeNull()
    expect(readFileSync(lockPath, 'utf-8')).toBe(token) // reclaimed: now OUR token, not the dead holder's
  })

  it('a lock younger than staleMs is NOT reclaimed even if held', () => {
    const lockPath = freshLockPath()
    writeFileSync(lockPath, 'live-holder:still-going')
    // No utimesSync — mtime is "now", well under any reasonable staleMs.

    const token = acquireLock(lockPath, { timeoutMs: 100, staleMs: 60_000 })

    expect(token).toBeNull() // correctly refused to steal a live lock
    expect(readFileSync(lockPath, 'utf-8')).toBe('live-holder:still-going')
  })
})

describe('file-lock — release only removes a lock this call actually owns', () => {
  it('releaseLock with a stale token is a no-op if the lockfile now holds a different token', () => {
    const lockPath = freshLockPath()
    const staleToken = acquireLock(lockPath)
    expect(staleToken).not.toBeNull()

    // Simulate another process reclaiming this lock as abandoned before
    // the original holder gets around to releasing it: it overwrites the
    // lockfile with its own token (what acquireLock does internally on
    // reclaim, reproduced directly here for a controlled assertion).
    writeFileSync(lockPath, 'reclaimer:new-token')

    // The original (stale) holder now calls release with ITS OLD token.
    releaseLock(lockPath, staleToken!)

    // Must NOT have deleted the reclaimer's live lock.
    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf-8')).toBe('reclaimer:new-token')
  })

  it('releaseLock without a token unconditionally removes the lockfile (legacy/simple call shape)', () => {
    const lockPath = freshLockPath()
    writeFileSync(lockPath, 'anything')
    releaseLock(lockPath)
    expect(existsSync(lockPath)).toBe(false)
  })
})
