import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireLock, releaseLock, withFileLock, classifyLockError, writeFileAtomic } from '../file-lock.js'
import { rmSafe } from './helpers/fs-safe.js'

// vi.spyOn cannot touch native ESM module exports directly ("Module
// namespace is not configurable in ESM"), and a plain vi.mock('node:fs')
// would also intercept file-lock.ts's OWN internal fs calls used by every
// other test in this file, not just the two below that need to inject a
// failure. This indirection is a pass-through by default (every existing
// test in this file is unaffected) and is only ever reassigned, then
// restored, inside the two writeFileAtomic tests that need it.
const mockState = vi.hoisted(() => ({
  renameSyncOverride: null as typeof import('node:fs').renameSync | null,
  realRenameSync: null as unknown as typeof import('node:fs').renameSync,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  mockState.realRenameSync = actual.renameSync
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) =>
      (mockState.renameSyncOverride ?? actual.renameSync)(...args),
  }
})

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
    rmSafe(dir)
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

/**
 * classifyLockError is a pure function of (code, flavor) specifically so
 * the Windows-only contention codes are deterministically testable on
 * this macOS build machine — see the function's doc in file-lock.ts.
 * These do not touch the real filesystem; they test the classification
 * decision that acquireLock's catch block now delegates to, which used
 * to be a hardcoded `!== 'EEXIST'` check that treated every Windows
 * sharing-violation code as a fatal error instead of contention.
 */
describe('classifyLockError — Windows sharing-violation codes are contention, not fatal', () => {
  it('EEXIST is contention on both flavors (the original, only-ever-POSIX case)', () => {
    expect(classifyLockError('EEXIST', 'posix')).toBe('contention')
    expect(classifyLockError('EEXIST', 'win32')).toBe('contention')
  })

  it('EBUSY is contention on win32 but fatal on posix', () => {
    expect(classifyLockError('EBUSY', 'win32')).toBe('contention')
    expect(classifyLockError('EBUSY', 'posix')).toBe('fatal')
  })

  it('EPERM is contention on win32 but fatal on posix', () => {
    expect(classifyLockError('EPERM', 'win32')).toBe('contention')
    expect(classifyLockError('EPERM', 'posix')).toBe('fatal')
  })

  it('EACCES is fatal on both flavors (a real permissions problem, not lock contention)', () => {
    expect(classifyLockError('EACCES', 'win32')).toBe('fatal')
    expect(classifyLockError('EACCES', 'posix')).toBe('fatal')
  })

  it('an undefined code is fatal (do not spin on something backoff cannot fix)', () => {
    expect(classifyLockError(undefined, 'win32')).toBe('fatal')
  })
})

/**
 * writeFileAtomic — added after ledger-concurrency.test.ts and
 * state-manager-concurrency.test.ts intermittently lost 1-3 of 200
 * increments on real windows-latest CI even with the lock itself healthy.
 * Root cause: every store's save() wrapped write-tmp-then-rename in a bare
 * catch-and-ignore, so a single transient rename contention silently
 * dropped the write instead of retrying it, and the in-memory mutation
 * that produced it was gone the moment the next lock holder reloaded from
 * disk. These inject a failure via renameSyncOverride (EEXIST classifies
 * as contention on every platform, same as the real Windows EBUSY/EPERM
 * this exists for, so the retry loop's actual logic is exercised
 * deterministically here rather than only trusted by inference from the
 * classifyLockError unit tests above).
 */
describe('writeFileAtomic — retries transient rename contention instead of silently dropping the write', () => {
  afterEach(() => {
    mockState.renameSyncOverride = null
  })

  it('retries past a transient rename failure and still writes the content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-write-atomic-test-'))
    tmpDirs.push(dir)
    const target = join(dir, 'state.json')

    let calls = 0
    mockState.renameSyncOverride = ((...args: Parameters<typeof import('node:fs').renameSync>) => {
      calls += 1
      if (calls < 3) {
        const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException
        err.code = 'EEXIST'
        throw err
      }
      return mockState.realRenameSync(...args)
    }) as typeof import('node:fs').renameSync

    const ok = writeFileAtomic(target, JSON.stringify({ n: 1 }))

    expect(ok).toBe(true)
    expect(calls).toBe(3) // two forced failures, then the real rename
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ n: 1 })
  })

  it('gives up and returns false, without throwing, on a fatal (non-contention) error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-write-atomic-test-'))
    tmpDirs.push(dir)
    const target = join(dir, 'state.json')

    mockState.renameSyncOverride = (() => {
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    }) as typeof import('node:fs').renameSync

    let threw = false
    let ok = true
    try {
      ok = writeFileAtomic(target, JSON.stringify({ n: 1 }))
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(ok).toBe(false)
    expect(existsSync(target)).toBe(false) // never landed at the real path
  })

  it('KNOWN-HEALTHY: an uncontended write succeeds on the first attempt, no retries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keel-write-atomic-test-'))
    tmpDirs.push(dir)
    const target = join(dir, 'state.json')

    const ok = writeFileAtomic(target, JSON.stringify({ n: 42 }), { mode: 0o600 })

    expect(ok).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ n: 42 })
  })
})
