import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Unit tests for the safety-checked kill algorithm behind `keel halt
 * --kill` (run-kill.ts). Every OS interaction (liveness, identity, own
 * pgid, the actual signal, sleeping) is injected via `KillDeps` — this
 * suite never sends a real signal or touches a real process, per this
 * lane's own constraint (no spawning/killing real long-running processes
 * during verification). Real wiring is instead covered by run.test.ts's
 * subprocess-level tests using trivial, fast, self-terminating commands.
 */

let home = ''
const originalHome = process.env.HOME
const originalKeelHome = process.env.KEEL_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'keel-run-kill-test-'))
  process.env.HOME = home
  delete process.env.KEEL_HOME
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalKeelHome === undefined) delete process.env.KEEL_HOME
  else process.env.KEEL_HOME = originalKeelHome
  rmSafe(home)
})

const IDENTITY_A = { startTime: 'posix-lstart:Thu Aug 20 12:00:00 2026', command: 'claude --dangerous', bootId: 'darwin-boot:1' }
const IDENTITY_B = { startTime: 'posix-lstart:Thu Aug 20 12:05:00 2026', command: 'unrelated-process', bootId: 'darwin-boot:1' }

async function withEntry(overrides: Partial<{ pid: number; pgid: number; unverified: boolean }> = {}) {
  const { writeProvisionalEntry, upgradeEntry, readRunStateEntry } = await import('../commands/run-state.js')
  const pid = overrides.pid ?? 4242
  const pgid = overrides.pgid ?? pid
  writeProvisionalEntry(pid, pgid, ['claude', '--dangerous'])
  if (!overrides.unverified) upgradeEntry(pid, IDENTITY_A)
  return readRunStateEntry(pid)!
}

function fakeDeps(overrides: Partial<import('../commands/run-kill.js').KillDeps> = {}) {
  const calls: Array<{ target: number; signal: string }> = []
  const base: import('../commands/run-kill.js').KillDeps = {
    checkAlive: () => 'alive',
    getIdentity: () => IDENTITY_A,
    getOwnPgid: () => 99999,
    sendSignal: (target, signal) => { calls.push({ target, signal }) },
    // A REAL (small) delay, not an instant no-op: killOne's escalation loop
    // gates on wall-clock `Date.now() < deadline`, so an instant fake sleep
    // makes the loop spin as fast as the JS engine allows instead of
    // actually respecting the grace window — the SIGTERM-then-grace-then-
    // SIGKILL tests below need the grace window to be real, or they can't
    // deterministically observe "still alive when the window closes".
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    listDescendants: () => [],
  }
  return { deps: { ...base, ...overrides }, calls }
}

describe('killSupervisedRuns: no tracked run', () => {
  it('returns empty results when RUN_STATE has no entries', async () => {
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results, ambiguous } = await killSupervisedRuns({})
    expect(results).toEqual([])
    expect(ambiguous).toBeUndefined()
  })
})

describe('killSupervisedRuns: start-time mismatch (simulated PID reuse)', () => {
  it('refuses to signal and marks the entry stale, never touching pid/start_time', async () => {
    const entry = await withEntry()
    const { deps, calls } = fakeDeps({ getIdentity: () => IDENTITY_B }) // a DIFFERENT process now at this pid
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({}, deps)
    expect(results).toHaveLength(1)
    expect(results[0].outcome).toEqual({ kind: 'start-time-mismatch' })
    expect(calls).toEqual([]) // no signal was ever sent

    const { readRunStateEntry } = await import('../commands/run-state.js')
    const stillThere = readRunStateEntry(entry.pid)!
    expect(stillThere.stale).toBe(true)
    expect(stillThere.pid).toBe(entry.pid)
    expect(stillThere.identity).toEqual(entry.identity) // recorded identity itself is untouched
  })
})

describe('killSupervisedRuns: pgid 0/1 refusal', () => {
  it.each([0, 1])('refuses to signal pgid %i', async (pgid) => {
    // Construct a tampered/corrupt entry directly — writeProvisionalEntry
    // always uses pgid === pid for a real spawn, so pgid 0/1 can only arise
    // from a corrupted/hand-edited RUN_STATE file, exactly the case this
    // check defends against.
    const { writeProvisionalEntry, upgradeEntry } = await import('../commands/run-state.js')
    writeProvisionalEntry(5555, pgid, ['x'])
    upgradeEntry(5555, IDENTITY_A)
    const { deps, calls } = fakeDeps()
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({}, deps)
    expect(results[0].outcome).toEqual({ kind: 'refused-pgid-0-or-1' })
    expect(calls).toEqual([])
  })
})

describe('killSupervisedRuns: refuses to signal keel\'s own process group', () => {
  it('never signals when the recorded pgid equals getOwnPgid()', async () => {
    await withEntry({ pid: 7777, pgid: 7777 })
    const { deps, calls } = fakeDeps({ getOwnPgid: () => 7777 })
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({}, deps)
    expect(results[0].outcome).toEqual({ kind: 'refused-own-pgid' })
    expect(calls).toEqual([])
  })

  it('refuses (fails closed) when own pgid cannot be determined at all', async () => {
    await withEntry({ pid: 7778 })
    const { deps, calls } = fakeDeps({ getOwnPgid: () => null })
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({}, deps)
    expect(results[0].outcome).toEqual({ kind: 'refused-own-pgid-unknown' })
    expect(calls).toEqual([])
  })
})

describe('killSupervisedRuns: SIGTERM -> grace -> SIGKILL escalation', () => {
  it('sends SIGTERM, waits out the FULL grace window, and only escalates to SIGKILL if still alive after it', async () => {
    const entry = await withEntry({ pid: 8888, pgid: 8888 })
    let aliveCallCount = 0
    const { deps, calls } = fakeDeps({
      checkAlive: () => {
        aliveCallCount++
        // killOne probes liveness THREE times before it can even consider
        // SIGKILL: (1) the pre-signal liveness check, (2) immediately after
        // sending SIGTERM, (3) the one grace-window poll below. Only the
        // post-SIGKILL confirmation (4th) call reports gone.
        return aliveCallCount <= 3 ? 'alive' : 'gone'
      },
    })
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({ graceMs: 60 }, deps)
    expect(results[0].outcome).toEqual({ kind: 'killed', via: 'SIGKILL' })
    expect(calls.map(c => c.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(calls.every(c => c.target === -entry.pgid)).toBe(true)
    expect(aliveCallCount).toBeGreaterThanOrEqual(4) // pre-signal + post-SIGTERM + >=1 grace poll + post-SIGKILL confirm

    const { readRunStateEntry } = await import('../commands/run-state.js')
    expect(readRunStateEntry(entry.pid)).toBeNull() // cleared on confirmed kill
  }, 10_000)

  it('does NOT escalate to SIGKILL when the process dies during the SIGTERM grace window', async () => {
    const entry = await withEntry({ pid: 8889, pgid: 8889 })
    let aliveCallCount = 0
    const { deps, calls } = fakeDeps({
      checkAlive: () => {
        aliveCallCount++
        // Alive for the pre-signal check and immediately after SIGTERM;
        // gone by the first grace-window poll.
        return aliveCallCount <= 2 ? 'alive' : 'gone'
      },
    })
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({ graceMs: 5000 }, deps) // long window — must exit EARLY on the dead check, not wait it out
    expect(results[0].outcome).toEqual({ kind: 'killed', via: 'SIGTERM' })
    expect(calls.map(c => c.signal)).toEqual(['SIGTERM'])

    const { readRunStateEntry } = await import('../commands/run-state.js')
    expect(readRunStateEntry(entry.pid)).toBeNull()
  }, 10_000)

  it('reports kill-unconfirmed (and keeps the entry) when SIGKILL cannot be confirmed to have landed', async () => {
    const entry = await withEntry({ pid: 8890, pgid: 8890 })
    const { deps } = fakeDeps({ checkAlive: () => 'alive' }) // never dies, no matter what
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({ graceMs: 60 }, deps)
    expect(results[0].outcome).toEqual({ kind: 'kill-unconfirmed' })

    const { readRunStateEntry } = await import('../commands/run-state.js')
    expect(readRunStateEntry(entry.pid)).not.toBeNull() // NOT cleared — operator can retry
  }, 10_000)
})

describe('killSupervisedRuns: genuinely-dead recorded process', () => {
  it('cleans up gracefully with no crash and no signal sent', async () => {
    const entry = await withEntry({ pid: 9999 })
    const { deps, calls } = fakeDeps({ checkAlive: () => 'gone' })
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({}, deps)
    expect(results[0].outcome).toEqual({ kind: 'already-dead' })
    expect(calls).toEqual([])

    const { readRunStateEntry } = await import('../commands/run-state.js')
    expect(readRunStateEntry(entry.pid)).toBeNull()
  })
})

describe('killSupervisedRuns: not-ours (EPERM) refusal', () => {
  it('never signals a pid that exists but cannot be characterized as ours', async () => {
    await withEntry({ pid: 10000 })
    const { deps, calls } = fakeDeps({ checkAlive: () => 'not-ours' })
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({}, deps)
    expect(results[0].outcome).toEqual({ kind: 'not-ours' })
    expect(calls).toEqual([])
  })
})

describe('killSupervisedRuns: unverified entry', () => {
  it('refuses to signal an entry whose identity was never confirmed', async () => {
    await withEntry({ pid: 10001, unverified: true })
    const { deps, calls } = fakeDeps()
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({}, deps)
    expect(results[0].outcome).toEqual({ kind: 'unverified' })
    expect(calls).toEqual([])
  })
})

describe('killSupervisedRuns: disambiguation across multiple tracked runs', () => {
  it('refuses to guess when more than one run is tracked and no target is given', async () => {
    await withEntry({ pid: 11001 })
    await withEntry({ pid: 11002 })
    const { deps, calls } = fakeDeps()
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results, ambiguous } = await killSupervisedRuns({}, deps)
    expect(results).toEqual([])
    expect(ambiguous).toHaveLength(2)
    expect(calls).toEqual([])
  })

  it('targets exactly one when --kill-pid (options.pid) is given', async () => {
    await withEntry({ pid: 11003 })
    await withEntry({ pid: 11004 })
    const { deps } = fakeDeps({ checkAlive: () => 'gone' })
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({ pid: 11003 }, deps)
    expect(results).toHaveLength(1)
    expect(results[0].pid).toBe(11003)
  })

  it('reports not-tracked for a pid with no recorded entry', async () => {
    await withEntry({ pid: 11005 })
    const { deps } = fakeDeps()
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({ pid: 99999999 }, deps)
    expect(results).toEqual([{ pid: 99999999, outcome: { kind: 'not-tracked' } }])
  })

  it('targets every tracked entry with --kill-all (options.all)', async () => {
    await withEntry({ pid: 11006 })
    await withEntry({ pid: 11007 })
    const { deps } = fakeDeps({ checkAlive: () => 'gone' })
    const { killSupervisedRuns } = await import('../commands/run-kill.js')
    const { results } = await killSupervisedRuns({ all: true }, deps)
    expect(results.map(r => r.pid).sort()).toEqual([11006, 11007])
  })
})

describe('run-state.ts: process identity primitives', () => {
  it('identitiesMatch compares startTime and command exactly, and only lets bootId narrow when BOTH sides have it', async () => {
    const { identitiesMatch } = await import('../commands/run-state.js')
    expect(identitiesMatch(IDENTITY_A, IDENTITY_A)).toBe(true)
    expect(identitiesMatch(IDENTITY_A, IDENTITY_B)).toBe(false)
    expect(identitiesMatch(IDENTITY_A, { ...IDENTITY_A, bootId: '' })).toBe(true) // one side unavailable — not a mismatch
    expect(identitiesMatch(IDENTITY_A, { ...IDENTITY_A, bootId: 'darwin-boot:2' })).toBe(false) // both present, differ — a reboot
  })

  it('checkAlive distinguishes ESRCH (gone) from EPERM (alive, not ours)', async () => {
    const { checkAlive } = await import('../commands/run-state.js')
    const esrch = () => { const e: NodeJS.ErrnoException = new Error('no such process'); e.code = 'ESRCH'; throw e }
    const eperm = () => { const e: NodeJS.ErrnoException = new Error('not permitted'); e.code = 'EPERM'; throw e }
    const ok = () => {}
    expect(checkAlive(1, ok)).toBe('alive')
    expect(checkAlive(1, esrch)).toBe('gone')
    expect(checkAlive(1, eperm)).toBe('not-ours')
  })

  it('parses Linux /proc/<pid>/stat starttime (field 22) correctly, including a comm field containing spaces/parens', async () => {
    const { getProcessIdentity } = await import('../commands/run-state.js')
    // comm = "my (weird) proc", state=S, ... 18 more fields before starttime,
    // with starttime = 123456 at post-comm index 19.
    const midFields = Array(19).fill('0') // fields[0]=state .. fields[18], all before starttime
    const stat = `4242 (my (weird) proc) S ${midFields.slice(1).join(' ')} 123456 extra fields here`
    const identity = getProcessIdentity(4242, {
      platform: 'linux',
      readFile: ((path: string) => {
        if (path === '/proc/4242/stat') return stat
        if (path === '/proc/4242/cmdline') return 'node\0app.js\0'
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }) as typeof readFileSync,
      exec: (() => { throw new Error('should not shell out on Linux when /proc succeeds') }) as any,
    })
    expect(identity).not.toBeNull()
    expect(identity!.startTime).toBe('linux-stat:123456')
    expect(identity!.command).toBe('node app.js')
  })

  it('falls back to null (fail-closed) when /proc/<pid>/stat is unreadable and no ps fallback is wired for the platform under test', async () => {
    const { getProcessIdentity } = await import('../commands/run-state.js')
    const identity = getProcessIdentity(4242, {
      platform: 'linux',
      readFile: (() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) as any,
      exec: (() => { throw new Error('ps unavailable') }) as any,
    })
    expect(identity).toBeNull()
  })
})
