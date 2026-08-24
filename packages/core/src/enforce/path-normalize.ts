import { win32, posix } from 'node:path'

/**
 * Centralized path-flavor handling for every path/glob comparison in the
 * enforcement engine (filesystem rules in pipeline.ts, flow-tracker.ts's
 * source/sink matching, the legacy .keel.yaml policy-engine.ts matcher,
 * oracle-glob.ts, and the state/ledger/trace dir helpers).
 *
 * Windows problem this closes: every one of those call sites grew its own
 * ad hoc `path.startsWith('/')` "is this absolute" check and its own
 * `/`-only glob/prefix comparison, both quietly POSIX-only. On Windows,
 * `pathStr.startsWith('/')` is false for an ordinary absolute path
 * (`C:\Users\x\.env`) or a UNC share (`\\server\share\.env`), and a value
 * normalized with backslashes never matches a YAML-authored pattern
 * written with forward slashes (`**\/.env`). NTFS is also
 * case-insensitive, so `.ENV` and `.env` must compare equal there and must
 * NOT there (POSIX).
 *
 * Design choice (see the module's advisor review / EVIDENCE doc): this
 * does NOT unify the several different glob-matching *semantics* already
 * living in pipeline.ts, flow-tracker.ts, policy-engine.ts, and
 * oracle-glob.ts — those differ on purpose (documented in oracle-glob.ts's
 * header: pipeline.ts's `pathMatches` has a shipped-rule-dependent `*`
 * conversion bug that oracle-glob.ts deliberately does NOT reuse).
 * Rewriting glob semantics is a separate, ruleset-wide verification
 * project. What IS centralized here is the flavor-aware, testable-without-
 * a-Windows-machine PRIMITIVES every one of those matchers now calls
 * before running its own pattern logic: absolute-path detection,
 * separator normalization (UNC-safe), drive-letter case-folding, and a
 * case-fold predicate. Every matcher gets Windows-correct on those axes
 * without changing what it matches on POSIX (verified by the existing
 * suites staying green) or changing its own glob dialect.
 *
 * Every function takes an explicit `flavor` and defaults it to
 * `currentFlavor()`, which reads `process.platform` at CALL time (never
 * cached at module load). That is what makes the win32 behavior
 * deterministically unit-testable on this macOS build machine: tests pass
 * `flavor: 'win32'` explicitly and exercise `path.win32` directly, so
 * they run — and can fail — on any host. Do not read `process.platform`
 * into a module-level constant anywhere in this file; a value cached at
 * import time makes `vi.stubGlobal('process', ...)` a silent no-op in
 * tests that import after the real module graph has already loaded.
 */

export type PathFlavor = 'posix' | 'win32'

/** `process.platform`, read fresh on every call — see module header. */
export function currentFlavor(): PathFlavor {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

function impl(flavor: PathFlavor) {
  return flavor === 'win32' ? win32 : posix
}

/**
 * True if `p` is absolute under `flavor`'s rules. Replaces every
 * `!x.startsWith('/')` "is this relative" guess in the codebase — that
 * guess is wrong for a Windows absolute path (`C:\...`, `\\server\share`),
 * and separately, `win32.isAbsolute('C:foo')` is correctly `false`
 * (drive-relative, not absolute) where a naive `/^[A-Za-z]:/` regex would
 * say true.
 */
export function isAbsolutePath(p: string, flavor: PathFlavor = currentFlavor()): boolean {
  return !!p && impl(flavor).isAbsolute(p)
}

/**
 * Resolve `rawPath` against `cwd` only if it is not already absolute.
 * The flavor-correct replacement for the repeated
 * `rawPath && !rawPath.startsWith('/') ? resolve(cwd, rawPath) : rawPath`
 * idiom (pipeline.ts x3, flow-tracker.ts x1): that idiom treated any
 * Windows-absolute path as relative-to-cwd, which is harmless when the
 * real `path.resolve` is doing the resolving (it also detects the path is
 * already absolute and returns it unchanged) but was never actually
 * correct, and made the intent untestable without a real Windows host.
 */
export function resolveMaybeRelative(rawPath: string, cwd: string, flavor: PathFlavor = currentFlavor()): string {
  if (!rawPath) return rawPath
  return isAbsolutePath(rawPath, flavor) ? rawPath : impl(flavor).resolve(cwd, rawPath)
}

/**
 * Canonicalize a path STRING for cross-platform comparison:
 *   - backslashes -> forward slashes
 *   - a genuine leading UNC prefix (`\\server\share` on win32) is
 *     preserved as exactly two leading slashes, never collapsed to one
 *     (which would silently turn a UNC root into a bare posix-looking
 *     path) and never left un-normalized (mixed `\`/`/` UNC paths compare
 *     unequal to themselves otherwise)
 *   - runs of 2+ slashes elsewhere ARE collapsed to one
 *   - a drive letter is uppercased (`c:` -> `C:`) so `c:\x` and `C:\x`
 *     compare equal
 * This does NOT resolve `.`/`..` segments, does NOT make a relative path
 * absolute (callers needing that call `resolveMaybeRelative` first), and
 * deliberately does NOT strip a trailing slash: several call sites in
 * this codebase treat a pattern like `"src/"` as a plain SUBSTRING match
 * (`value.includes(pattern)` — verification.ts's trigger-path matching,
 * sequencer.ts's step-path matching), where the trailing slash is load-
 * bearing — it's what anchors the match to a real path-segment boundary
 * and stops `"src"` from also matching `"src-backup/"` or `"resources/"`.
 * An earlier version of this function stripped it, which silently widened
 * every substring-style consumer's matches; the glob-style consumers
 * (pipeline.ts's `pathMatches`, which strips it explicitly, itself, in
 * its own prefix branch) already did their own stripping before this
 * util existed and still do, unaffected.
 * Patterns loaded from YAML are already `/`-separated, so canonicalizing
 * a pattern is normally a no-op; canonicalizing the VALUE (the real
 * argument path from a tool call) is where this earns its keep — it's
 * what lets `**\/.keel/rules.yaml` match `C:\proj\.keel\rules.yaml`.
 */
export function canonicalizePath(p: string, flavor: PathFlavor = currentFlavor()): string {
  if (!p) return p
  const isUnc = flavor === 'win32' && /^[\\/]{2}/.test(p)
  let s = p.replace(/\\/g, '/')
  if (isUnc) {
    s = '//' + s.replace(/^\/+/, '').replace(/\/{2,}/g, '/')
  } else {
    s = s.replace(/\/{2,}/g, '/')
  }
  s = s.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toUpperCase()}:`)
  return s
}

/**
 * Case-fold a canonicalized path for comparison. NTFS (and therefore every
 * Windows filesystem path argument keel evaluates) is case-insensitive —
 * `.ENV` and `.env` are the SAME file — so a case-sensitive glob/prefix
 * match on win32 both under- and over-matches. POSIX filesystems are
 * case-sensitive, so this is a no-op there. Apply to both the value and
 * the pattern before comparing.
 */
export function foldCase(p: string, flavor: PathFlavor = currentFlavor()): string {
  return flavor === 'win32' ? p.toLowerCase() : p
}

/** Canonicalize + case-fold in one call — the normal thing a matcher wants. */
export function normalizeForMatch(p: string, flavor: PathFlavor = currentFlavor()): string {
  return foldCase(canonicalizePath(p, flavor), flavor)
}

/** Full equality of two paths under `flavor`'s separator/case rules. */
export function pathsEqual(a: string, b: string, flavor: PathFlavor = currentFlavor()): boolean {
  return normalizeForMatch(a, flavor) === normalizeForMatch(b, flavor)
}
