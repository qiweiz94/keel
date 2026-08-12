import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hookVerdict } from '../commands/hook.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * v1 M2-B1 — the slopsquatting deny-on-retry fix (deliverable #3: "this
 * also fixes the slopsquatting deterministic-deny-on-retry degradation on
 * exit-code hosts").
 *
 * pipeline.ts's `type: package` branch fires `scheduleBackgroundVerification`
 * with `void` on a cache miss — never awaited on the hot path, by design
 * (see package-verifier.test.ts's "pipeline: type package rule" describe
 * block header comment for the full two-phase design: an uncached package
 * always prompts FAST on the first attempt, and only a background fill
 * landing in the disk cache turns a genuinely nonexistent name into a
 * deterministic deny on the NEXT attempt). That promise settles fine in a
 * long-lived host process. `keel hook <host>` is NOT long-lived:
 * `hookCommand` calls `process.exit()` right after rendering the verdict,
 * which used to tear down the event loop before the background lookup ever
 * got a turn — so a hallucinated package name prompted on EVERY retry
 * instead of ever converging to a deny, forever. `flushBackgroundWork`
 * (enforce.ts) + the `packageVerifierOnBackgroundStart` capture it feeds
 * are the fix: `hookVerdict` now awaits every promise captured during its
 * OWN call, bounded, before returning — giving the background fill in
 * THIS process an actual chance to finish and write
 * `KEEL_STATE_DIR/package-verifier.json` before the caller's
 * `process.exit()` runs.
 *
 * Two SEPARATE `hookVerdict()` calls below simulate exactly what two
 * separate exit-code-host process invocations look like: each one calls
 * `initEnforce()` fresh (a brand-new `EnforcementPipeline` and a brand-new
 * `PackageVerifierCache` that re-reads `KEEL_STATE_DIR/package-verifier.json`
 * from disk — see enforce.ts's own `initEnforce`), exactly as two separate
 * `node dist/index.js hook claude-code` processes would.
 *
 * In-process (not a real subprocess via `spawnSync`) specifically so
 * `vi.stubGlobal('fetch', ...)` can stand in for the npm registry
 * deterministically — this sandbox's own network policy was found
 * empirically to hang/abort a CHILD process's fetch to a server listening
 * in the parent test-runner process, which made a real subprocess +
 * localhost-HTTP-server version of this test unusable here (not a defect
 * in the code under test). `hookVerdict` is a pure function with no
 * `process.exit` to fight — same reasoning fail-closed.test.ts's stdin
 * stream-error test already uses for the same tradeoff.
 */

const HALLUCINATED_PKG = 'totally-hallucinated-m2b1-pkg-does-not-exist'

const PACKAGE_RULES = `version: 1
rules:
  - id: unverified-package-install
    type: package
    action: prompt
    age_days: 30
    message: "This package install could not be verified against the npm registry — confirm the name and publisher before proceeding."
`

/**
 * Mocks global fetch as a 404-everything registry, tracking call count.
 *
 * The `setTimeout` delay is deliberate, not incidental: an instantly-
 * resolving mock settles via pure microtask ticks, which happen anyway
 * while `hookVerdict`'s OWN promise chain unwinds — that made an earlier
 * version of this test pass identically whether or not
 * `flushBackgroundWork` actually awaited anything, silently proving
 * nothing (caught by deliberately mutating the fix out and re-running
 * this suite — it stayed green, which is what sent this comment here). A
 * real macrotask delay can only be bridged by an explicit await on the
 * event loop, which is exactly the property `flushBackgroundWork` (not
 * “time passing between test files”) is responsible for.
 */
function stubRegistry(delayMs = 40) {
  let calls = 0
  vi.stubGlobal('fetch', vi.fn((_url: string | URL) => {
    calls++
    return new Promise<Response>(resolve => {
      setTimeout(() => resolve(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })), delayMs)
    })
  }))
  return { callCount: () => calls }
}

function withStdin<T>(payload: string, run: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'stdin')!
  let delivered = false
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: {
      isTTY: false,
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (delivered) return Promise.resolve({ done: true, value: undefined })
            delivered = true
            return Promise.resolve({ done: false, value: Buffer.from(payload) })
          },
        }
      },
    },
  })
  return run().finally(() => Object.defineProperty(process, 'stdin', real))
}

describe('slopsquatting deny-on-retry across process.exit() (v1 M2-B1)', () => {
  let home = ''

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'keel-pkgflush-home-'))
    mkdirSync(join(home, '.keel'), { recursive: true })
    writeFileSync(join(home, '.keel', 'rules.yaml'), PACKAGE_RULES, 'utf-8')
    process.env.HOME = home
    process.env.KEEL_STATE_DIR = join(home, '.keel', 'state')
  })

  afterAll(() => {
    rmSafe(home)
    vi.unstubAllGlobals()
  })

  it('first attempt: fast prompt, not-yet-checked — never blocks waiting on the registry, but the background lookup still reaches it before this call returns', async () => {
    const registry = stubRegistry()
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: `npm install ${HALLUCINATED_PKG}` } })

    const verdict = await withStdin(payload, () => hookVerdict('claude-code', { cwd: home }))

    expect(verdict.blocked).toBe(true) // prompt blocks on claude-code, same exit code as deny
    expect(verdict.exitCode).toBe(2)
    expect(verdict.stderr).toContain('not yet checked')

    // The point of `flushBackgroundWork`: by the time hookVerdict RETURNS
    // (which is when hookCommand's process.exit() would fire in real use),
    // the background fetch already reached the registry. Zero here would
    // mean the fix regressed back to the pre-lane fire-and-forget-and-die
    // behavior.
    expect(registry.callCount()).toBeGreaterThan(0)
  })

  it('second attempt (a FRESH initEnforce() — the same reset every real subprocess gets — same KEEL_STATE_DIR): the cache is warm, so this is a deterministic deny, not another prompt', async () => {
    stubRegistry() // fresh mock; the cache from the previous call is what should matter, not a live lookup
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: `npm install ${HALLUCINATED_PKG}` } })

    const verdict = await withStdin(payload, () => hookVerdict('claude-code', { cwd: home }))

    expect(verdict.blocked).toBe(true)
    expect(verdict.exitCode).toBe(2)
    expect(verdict.stderr).toContain('does not exist')
    expect(verdict.stderr).not.toContain('not yet checked')
  })
})
