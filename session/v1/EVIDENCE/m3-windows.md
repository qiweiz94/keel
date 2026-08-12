# LANE M3 — Windows support: path-matcher rewrite, EBUSY/teardown, CI

Branch: `v1-m3-windows` (worktree `/Users/nanoclaw/code/keel-v1-m3-windows`), based on `v0.4-thesis`.
Build machine: macOS. **No Windows machine is or was available to this lane.** Every claim below is
scoped accordingly — see "Windows-runtime-UNVERIFIED" at the end.

## Baseline (before any change)

```
$ npm install
added 169 packages, and audited 174 packages in 38s
1 high severity vulnerability   # nanoid <3.3.17 — pre-existing, unrelated to this lane, see below

$ npm run build
  dist/keel-core.mjs  152.9kb
  dist/index.js  411.4kb          (opencode-plugin -> packages/cli/templates/keel-enforce.js)

$ npm test
@get-keel/core:   Test Files 33 passed (33)  | Tests 557 passed | 2 skipped (559)
@get-keel/cli:    Test Files 41 passed (41)  | Tests 751 passed | 15 skipped (766)
@get-keel/mcp-server: no test files
@get-keel/opencode-plugin: 60/60 PASS (load-test.js)
```

Matches the expected ~557/752 baseline from the lane brief. `.github/workflows/ci.yml` already had
the three-OS matrix with `windows-latest` running lint-only, with a dated comment naming exactly
the remaining work: CRLF (fixed, prior lane), EBUSY on rmdir, and path-pattern separator/negation
semantics. This lane does that remaining work.

## Part 1 — centralized path-normalization util

### The util

`packages/core/src/enforce/path-normalize.ts` (new). Exports, all taking an explicit
`flavor: 'posix' | 'win32'` that defaults to `currentFlavor()` (reads `process.platform` **at call
time**, never cached at module load — see "why a flavor parameter" below):

- `currentFlavor()` — `process.platform === 'win32' ? 'win32' : 'posix'`, read fresh every call.
- `isAbsolutePath(p, flavor?)` — delegates to `path.win32.isAbsolute` / `path.posix.isAbsolute`.
  Replaces every hand-rolled `!x.startsWith('/')` "is this relative" guess in the codebase, which
  is wrong for a Windows absolute path (`C:\...`, `\\server\share`) and wrong the other direction
  for drive-relative paths (`C:foo`, correctly NOT absolute — a naive `/^[A-Za-z]:/` regex gets
  this backwards).
- `resolveMaybeRelative(rawPath, cwd, flavor?)` — the flavor-correct replacement for the repeated
  `rawPath && !rawPath.startsWith('/') ? resolve(cwd, rawPath) : rawPath` idiom.
- `canonicalizePath(p, flavor?)` — `\` → `/`, a genuine UNC prefix preserved as exactly two leading
  slashes (never collapsed to one, never left un-normalized), drive letter upper-cased, single
  trailing slash dropped (root kept). Does NOT resolve `.`/`..` or make a path absolute.
- `foldCase(p, flavor?)` — lower-cases on win32 (NTFS case-insensitivity), identity on posix.
- `normalizeForMatch(p, flavor?)` — `canonicalizePath` + `foldCase` composed; what matchers call.
- `pathsEqual(a, b, flavor?)` — full equality under `flavor`'s rules.

**Design choice — normalization, not unification.** The audit found FOUR independently-implemented
glob/path matchers with deliberately different semantics:

1. `pipeline.ts`'s private `pathMatches` (filesystem rules) — case-sensitive, has a documented
   pre-existing `**`+bare-`*` conversion bug that every shipped filesystem rule depends on (see
   `oracle-glob.ts`'s own header, which explicitly declined to reuse it for exactly this reason).
2. `flow-tracker.ts`'s private `pathMatches` (data-flow source/sink matching) — case-INsensitive
   on every platform (pre-existing, not a Windows-specific change), `*` crosses `/`.
3. `policy-engine.ts`'s `matchGlob`/`globToRegexBody` (the legacy standalone `.keel.yaml` engine,
   still live — `evaluateFileWrite`/`evaluateFileRead`, reachable from `keel check`/`keel init`).
4. `oracle-glob.ts`'s `matchesTestGlob` — a correct globstar implementation, deliberately kept
   separate from (1) per its own header.

Rewriting these into one matcher would change enforcement semantics in a security tool without the
ruleset-wide re-verification that deserves its own lane. What's centralized here is the
**normalization primitives** every one of the four now calls before running its own (unchanged)
pattern logic. Verified unchanged-on-POSIX by every existing suite staying green (see "Full test
output" below) — `normalizeForMatch` is identity-modulo-slash-collapsing on posix.

**Why a `flavor` parameter instead of mocking `process.platform`:** Node's own `path` module
default export is fixed at first `require`/`import` time based on `process.platform` — a
`vi.stubGlobal('process', ...)` after that silently no-ops. `path.win32` and `path.posix` are both
*always* available regardless of host OS, so dispatching on an explicit flavor parameter is real
cross-platform logic, exercised by real assertions, not a simulation. This is what makes the win32
semantics tests below deterministic on this macOS machine — they pass `flavor: 'win32'` explicitly.

### Full migrated call-site list

| File | What changed |
|---|---|
| `packages/core/src/enforce/pipeline.ts` | 3× `resolvedPath = pathStr && !pathStr.startsWith('/') ? resolve(...) : pathStr` → `resolveMaybeRelative(pathStr, input.cwd)` (filesystem-rule path arg, oracle-rule path arg, content-rule path arg). Private `pathMatches()`: both `value` and `pattern` now run through `normalizeForMatch` before the (unchanged) `**`/`*` → regex conversion. `paths`/`exclude` negation logic rewritten: positives OR together, negated (`!pattern`) entries AND-exclude — see "Negation fix" below. |
| `packages/core/src/enforce/flow-tracker.ts` | `record()`'s `rawPath`→`path` resolution → `resolveMaybeRelative`. `matchesSensitivePath()`: input canonicalized before the `.includes()` substring checks against the (already `/`-authored) sensitive-path list. Private `pathMatches()`: both sides canonicalized (separator-only; case-insensitivity was already unconditional pre-existing behavior, unchanged). |
| `packages/core/src/policy-engine.ts` | `matchGlob()`: both `filePath` and `pattern` now `normalizeForMatch`'d before the existing `globToRegexBody` conversion. This is the self-protection-write path check surface: `DEFAULT_POLICY.file_rules` includes `**/.keel.yaml`, `**/.keel/audit/**`, `**/.keel/receipts/**`. |
| `packages/core/src/enforce/rule-parser.ts` | `loadRuleHierarchy()`: `process.env.HOME \|\| '~'` → `process.env.HOME \|\| homedir()` from `node:os` — **real bug**: `HOME` is unset on Windows (the real variable is `USERPROFILE`), so the global rule tier (`~/.keel/rules.yaml`) silently never loaded there. `HOME` is honored FIRST rather than dropped outright: several CLI tests sandbox this exact lookup by setting `process.env.HOME` to a scratch directory (`fail-closed.test.ts`, `install.test.ts`, others) — a bare `homedir()` swap would silently un-sandbox those on `windows-latest` (Node's `os.homedir()` reads `USERPROFILE` there, ignoring `HOME`), pointing global-rule loading at the CI runner's real home. This form is POSIX byte-identical to the old behavior AND fixes Windows (falls back to the platform-correct `USERPROFILE` lookup only when nothing overrides it). Also replaced `` `${projectDir}/.keel/rules.yaml` `` style template-literal path concatenation with `join()` throughout (4 call sites). |
| `packages/core/src/enforce/oracle-glob.ts` | `matchesTestGlob()`: both `value` and `pattern` normalized via `normalizeForMatch` before its existing (correct, deliberately-separate-from-pipeline.ts) globstar conversion. Glob semantics themselves untouched. |
| `packages/core/src/enforce/sequencer.ts` | `matchesTool()`'s `step.path` containment check (`argPath.includes(step.path)`): both sides now `normalizeForMatch`'d. This is a plain substring match, not a glob — see the "trailing slash" note below for why `canonicalizePath` had to be adjusted to keep this safe. |
| `packages/core/src/enforce/verification.ts` | `matches()`'s `trigger.path`/`trigger.paths` containment check (`value.includes(target)`, used by `type: verification` and `type: claim` rules — e.g. the shipped `source-change-requires-test` rule's `path: "src/"`): both sides now `normalizeForMatch`'d. **Found late** (after the first pass through this table) by re-grepping for shipped `path:`/`paths:`-shaped fields beyond `pipeline.ts`'s filesystem-rule surface — a third, independent path-substring matcher this lane's first audit pass missed. |
| `packages/core/src/enforce/command-normalizer.ts` | `basename()` (interpreter-executable-name extraction from shell command text, e.g. `/usr/bin/python3` or a Windows `C:\Python\python.exe` invocation): now splits on `/[/\\]/` instead of `/'`only. Defensive — shell-command text, not a resolved FS path, so out of the path-normalize.ts util's remit, but cheap and correct to fix inline. |
| `packages/core/src/enforce/file-lock.ts` | See Part 2. |

### Trailing-slash correction (caught in review, before commit)

`canonicalizePath`'s first draft stripped a single trailing slash (`"src/"` → `"src"`), matching
what `pipeline.ts`'s glob prefix-branch already did manually. That's safe for a GLOB matcher, but
`sequencer.ts` and `verification.ts` (above) are plain SUBSTRING matchers (`value.includes(target)`)
where a trailing slash is load-bearing — it anchors the match to a real path-segment boundary. A
stripped `"src/"` becomes `"src"`, which then substring-matches `"src-backup/"` or `"resources/"`
too — a silent widening of a deny-list-shaped check, introduced by this lane's own normalization
pass, not a pre-existing bug. `canonicalizePath` no longer strips trailing slashes at all (its one
test asserting that behavior was updated to assert preservation instead); `pipeline.ts`'s prefix
branch keeps its own explicit trailing-slash strip, unaffected. Caught via `advisor()` review before
committing, then verified with a targeted grep of the shipped 45-rule template for
`path: "…/"`-shaped fields (`grep -nE '"\S*/"' packages/cli/src/commands/install.ts
packages/opencode-plugin/src/plugin.ts`) — found `path: "src/"` in the shipped
`source-change-requires-test` verification rule (3 near-identical spots across `install.ts` and
`plugin.ts`, since the plugin template mirrors the CLI's install template), which is exactly what
led to finding and fixing `verification.ts`'s previously-missed matcher above.

### Negation-semantics fix (task-listed as in scope)

Before: `rule.paths.some(p => p.startsWith('!') ? !pathMatches(v,p.slice(1)) : pathMatches(v,p))`
— a single `.some()` over a mixed list. A list like `["**/*.ts", "!**/node_modules/**"]` matched on
EITHER "is a .ts file" OR "is outside node_modules" — the latter is true for nearly every write, so
the negation inverted into matching almost everything instead of excluding node_modules from the
`.ts` match.

After: positives OR together (empty positive set = "matches everything", so an all-negated list
keeps its original meaning); negated entries AND-exclude. Verified against:
- The one existing test exercising this (`pipeline.test.ts`, `"treats a negated path as the
  complement of its pattern"`, single-entry `["!/src/*"]`) — still passes, byte-identical behavior
  for the single-negation-only case.
- **New**: `glob-matching.test.ts`, `describe('pathMatches — negated path combined with a positive
  pattern')`, 3 tests against `paths: ["**/*.ts", "!**/node_modules/**"]` — a `.ts` write outside
  node_modules fires, the same write inside node_modules does not (negation excludes despite the
  positive matching), and a NON-`.ts` write outside node_modules does not fire either (the third
  case is what actually proves positives are still required — without it, the `positivePatterns
  .length === 0 ? true` branch's edges aren't exercised in the mixed-list case, and a regression
  back to a single `.some()` would still pass every OTHER test in the suite). Added after
  `advisor()` review flagged that the fix was unverified in its actual mixed-list target shape.
- Confirmed via grep that **no shipped rule** (45-rule template in `install.ts`/`plugin.ts`) uses
  `!`-negated paths at all — the rationale comment at `install.ts:381` explicitly says a
  negated-allowlist pattern was considered and rejected for a different rule. So this fix changes
  behavior only for a shape nothing in production currently constructs; it closes a latent bug
  before it bites a future rule author, on either platform.

### Audited, deliberately left unchanged (with reasoning)

- `oracle-glob.ts`'s globstar semantics — kept separate from `pipeline.ts`'s matcher per its own
  header; only added the shared normalization call.
- `pipeline.ts`'s `pathMatches` `**`+bare-`*` conversion bug — every shipped filesystem rule
  depends on its current behavior; fixing it needs its own ruleset-wide verification, explicitly
  out of this lane's scope (same reasoning `oracle-glob.ts`'s own header already gives).
- `flow-tracker.ts`'s `commandSourceMatches`/`sourceMatches` basename-splitting on `/` — operates
  only on YAML-authored rule pattern strings and pseudo-source ids (`sensitive-path:X`), never on a
  real resolved filesystem path with OS-native separators. No Windows bug there.
- `package-verifier.ts`'s `token.split('/').pop()` — npm package specifiers always use `/`
  regardless of host OS (it's the registry's namespace separator, not a filesystem path). No change.
- `policy-engine.ts`'s `checkApiKeyExposure`'s `verb()` basename split on `/` — shell-command-verb
  text parsing (`/bin/cat` → `cat`), not a filesystem path comparison. Flagged, left alone: altering
  shell-command-text heuristics without dedicated verification risks changing a security matcher's
  false-positive/negative rate for no proven Windows benefit (Bash-style commands are the norm even
  when the agent host is Windows, via WSL/git-bash/an agent's own shell emulation).
- `command-normalizer.ts`'s `classifyInterpreter()` — does not special-case a Windows `.exe` suffix
  on the interpreter basename. Noted, not fixed: shell-interpreter classification, not a path/glob
  comparison, and the interpreters it classifies (`sh`, `bash`, `dash`, `zsh`, `ksh`) aren't
  typically invoked as `.exe` even from a Windows host in the agent-tool-call shapes this project
  intercepts.
- `pipeline.ts`'s kill-switch sentinel `rmSync(sentinelPath)` (single-file, not recursive, not test
  fixture teardown) — not wrapped in retry. Low-probability residual risk on Windows (a single-file
  unlink racing another Keel process holding the sentinel open); out of Part 2's "fixture + state
  teardown" scope, which is about test infrastructure. Noted for a future lane.
- `packages/cli/src/rego-engine.ts` — audited (WASM policy loader), contains no path/glob
  comparison logic, only `existsSync`/`readFileSync` on a caller-supplied path. No change needed.
- `packages/cli/src/policy-engine.ts` — confirmed to be an 11-line re-export shim
  (`export { PolicyEngine, ... } from './core/policy-engine.js'`), not a hand-maintained parallel
  implementation. Live (imported by `commands/init.ts`, `commands/check.ts`), correctly fixed by
  fixing the core source it re-exports.

### Windows-semantics unit tests (green on macOS)

`packages/core/src/enforce/__tests__/path-normalize.test.ts` — 29 tests, all passing `flavor:
'win32'` (or `'posix'`) explicitly, so every one of them runs — and can fail — on this machine.
Covers: drive-absolute vs drive-relative (`C:\x` vs `C:x`), UNC absolute detection and
canonicalization (`\\server\share` → exactly `//server/share`, never collapsed to one slash),
drive-letter case-folding, NTFS case-insensitive equality vs POSIX case-sensitive inequality,
`resolveMaybeRelative` correctly NOT re-rooting an already-absolute Windows/UNC path under cwd, and
a `currentFlavor()` wiring proof (2 tests) that mocks `process.platform` to show the live-default
path actually reads it.

`packages/core/src/enforce/__tests__/file-lock.test.ts` — 5 new tests for `classifyLockError`
(below).

## Part 2 — EBUSY / teardown

### `file-lock.ts` hardening

Two real bugs found and fixed, both pure-function-testable without a real Windows host:

1. **`acquireLock`'s catch block only ever treated `EEXIST` as retryable contention.** On POSIX,
   `openSync(path, 'wx')` against an existing file always yields `EEXIST` — the only contention
   code there. On Windows, the same call against a file another process holds open (or that Windows
   is mid-deleting — a pending-delete state lasting until the last handle closes) can instead yield
   `EBUSY` or `EPERM`. Before this fix, any of those codes hit the `!= 'EEXIST'` branch and returned
   `null` immediately (the documented fail-safe "run unlocked" path) on the very first collision,
   instead of retrying through what is normally a sub-millisecond contention window. Fixed via a new
   pure `classifyLockError(code, flavor)` → `'contention' | 'fatal'`, called from `acquireLock`.
2. **`releaseLock`'s `unlinkSync` in a bare `try/catch` doesn't make Windows EBUSY harmless — it
   makes the lockfile PERSIST.** Every later acquirer then hits `EEXIST` until `staleMs` elapses (an
   8-second stall by default). Fixed via `unlinkWithRetry()` (bounded retries with backoff,
   `ENOENT` treated as already-succeeded), used by both `releaseLock` and the stale-lock reclaim
   path in `acquireLock`.

`classifyLockError` and `unlinkWithRetry` are exported/testable independent of real fs state:
`classifyLockError` is a pure `(code, flavor) => verdict` function (5 new tests in
`file-lock.test.ts`, exercising `EEXIST`/`EBUSY`/`EPERM`/`EACCES`/`undefined` against both flavors).

### Fixture teardown — `rmSafe()`

Audited every `rmSync(dir, { recursive: true, force: true })` fixture-teardown call site across
both packages' test suites (found via `grep -rn "rmSync("`, cross-checked post-migration by
counting `rmSafe(` call sites) — **76 call sites migrated across 37 test files** (24 in
`packages/cli/src/__tests__`, 12 in `packages/core/src/enforce/__tests__`, 1 in
`packages/core/src/__tests__/policy-engine.test.ts`). One line was deliberately left unmigrated:
`harness-append.test.ts` (one of the 24 CLI files, whose `afterEach` teardown call WAS migrated)
also has a mid-test `rmSync(rulesPath)` that is a single-file precondition removal, not teardown —
left as a bare throwing call so a broken `beforeEach` still fails loudly instead of silently no-op'ing.

Introduced `rmSafe(path, options?)` — `fs.rmSync`'s own built-in `maxRetries`/`retryDelay` (Node's
answer to exactly this race, available since Node 14.14), not a hand-rolled retry loop — in two
near-identical copies:
- `packages/core/src/enforce/__tests__/helpers/fs-safe.ts`
- `packages/cli/src/__tests__/helpers/fs-safe.ts`

(Duplicated rather than shared because `packages/cli/src/core/**` is a generated, gitignored copy
of `packages/core/src` — see the hard constraint against hand-editing it — so there's no clean
import path from CLI test source into core test source across the package boundary.)

Every one of the 37 recursive-teardown call sites now calls `rmSafe(path)` in place of the old
`rmSync(path, { recursive: true, force: true })`. Applied via a small Node codemod script + manual
fixup of 5 files where the script's naive "insert after the last top-level `import` line" heuristic
landed inside a still-open multi-line `import { ... }` block (caught by re-scanning for the
corruption pattern before running tests — `packages/core/src/enforce/__tests__/package-verifier.test.ts`,
`packages/cli/src/__tests__/{envintro-reachability,fixture-harness,perf-budget,proposal-fixture-harness}.test.ts`).
All 5 fixed and re-verified via `tsc --noEmit` (clean on both packages) before the final test run.

## Part 3 — Windows CI

`.github/workflows/ci.yml` already had the three-OS matrix (prior lane). Changed:
- Dropped `if: matrix.os != 'windows-latest'` from the `npm test` step and the
  `npx vitest run packages/cli/src/__tests__` step — these now run the FULL suite on
  `windows-latest`, not lint-only.
- **Kept** the Windows skip on `npm run test:publish-check` — genuinely POSIX-shebang-shim
  dependent (the npm-shim retry test), a real Windows-native-shim project of its own, not touched
  by this lane.
- **Kept** `describePosixShim` inside the test suite itself
  (`packages/cli/src/__tests__/helpers/platform.ts`) exactly as it was — this is the honest,
  documented skip for the PATH-shim suites (a `#!/bin/bash` shim has no Windows equivalent without
  an unverified parallel `.cmd` shim). Deleting or weakening this would be exactly the
  test-weakening this lane was told to stop and report on, not a completion of the Windows lane.
- Rewrote the explanatory comment block to state what's fixed vs what remains gated, and why.

`release.yml` (ubuntu-only, no OS matrix) was not touched — no Windows reconciliation applies there.

**Known, pre-existing, non-path-matcher item that will affect the new windows-latest job:**
`npm audit --audit-level=moderate` currently reports 1 high-severity transitive vulnerability
(`nanoid <3.3.17`, via `node_modules/nanoid`) and CI runs that check on every OS unconditionally.
This is unrelated to this lane's work and pre-dates it — recorded here so a red `windows-latest`
job isn't misread as a path-matcher regression when it's actually this audit gate. Not fixed by
this lane (out of scope — a dependency bump, not a Windows-support change).

## Full test output (this lane's final state, root `npm test`)

```
> keel-monorepo@0.4.0 test
> npm run test --workspaces

> @get-keel/core@0.4.0 test
> vitest run

 Test Files  34 passed (34)
      Tests  594 passed | 2 skipped (596)
   Duration  19.06s

> @get-keel/cli@0.4.0 test
> vitest run

 Test Files  41 passed (41)
      Tests  751 passed | 15 skipped (766)
   Duration  55.40s

> @get-keel/mcp-server@0.4.0 test
> vitest run --passWithNoTests
No test files found, exiting with code 0

> @get-keel/opencode-plugin@0.4.0 test
> node ./scripts/load-test.js
[60/60 PASS] ... All checks passed
```

(One earlier run in this lane showed the CLI suite at 752 passed/14 skipped instead of 751/15 —
`perf-budget.test.ts`'s p99 hot-path test self-skip-guards on machine load
(`threshold 1.5/core`) and ran instead of skipping under this lane's own concurrent build load at
that moment. Re-run reproduced the stable 751/15 baseline exactly; unrelated to any change in this
lane, noted here so it isn't misread as nondeterminism this lane introduced.)

core: 557→594 (+37: 29 path-normalize.test.ts + 5 file-lock.test.ts classifyLockError tests + 3
glob-matching.test.ts negation-mixed-list tests), 2 skipped (unchanged from baseline). cli:
751/751 passed, 15 skipped — byte-identical to baseline (no CLI-side test count change; the CLI
suite consumes core's rewritten logic via the generated
`src/core` copy and stayed green throughout, confirmed after every core edit by rebuilding and
re-running the full CLI suite, not just core's own suite in isolation).

`npm run lint` (tsc --noEmit across core/cli/mcp-server): clean, no errors.
`npm run build`: clean, `packages/cli/templates/keel-enforce.js` regenerated from the rebuilt
opencode-plugin bundle (must be committed alongside the source changes — `release.yml` runs
`git diff --exit-code` on it).

## Windows-runtime-UNVERIFIED (explicit, per the honesty constraint)

Everything above is **logic implemented + unit-covered (deterministically, on macOS, via explicit
win32-flavor parameters) + wired into CI**. None of it has run on an actual Windows machine or a
real `windows-latest` GitHub Actions runner — there is no Windows host anywhere in this lane's loop.
Specifically PENDING until the `windows-latest` job in `.github/workflows/ci.yml` goes green for
real:

1. `path-normalize.ts`'s behavior against Node's REAL `path.win32` implementation running natively
   on Windows (as opposed to `path.win32` invoked cross-platform from macOS, which is the same code
   path but has never been cross-checked against actual Windows filesystem behavior for edge cases
   like long-path prefixes `\\?\C:\...`, which this util does not special-case and has not been
   tested against).
2. `file-lock.ts`'s `classifyLockError`'s EBUSY/EPERM handling against REAL errors thrown by a real
   Windows `openSync`/`unlinkSync` racing real file-handle contention — only the pure classification
   function is tested here, not an integration test against actual Windows fs error codes (which
   this lane cannot generate without a Windows host).
3. `rmSafe()`'s `maxRetries`/`retryDelay` actually absorbing a real Windows `EBUSY` from a real
   just-exited child process's lingering file handle during fixture teardown.
4. Whether any OTHER Windows-specific failure mode exists in the ~751 CLI tests that this lane's
   macOS-only verification cannot surface — the CLI suite passing on macOS after these changes is
   necessary but not sufficient evidence of Windows correctness.
5. The `describePosixShim`-gated suites remain, correctly, skipped on Windows — not a gap, a
   documented and intentional scope boundary.
6. `test:publish-check` remains, correctly, skipped on Windows — same.
7. The pre-existing `nanoid` `npm audit` finding may fail the new `windows-latest` job's audit step
   independent of anything in this lane.

**Bottom line: path-matcher logic implemented, unit-covered, and CI-wired. Windows runtime
correctness is PENDING the `windows-latest` CI job actually going green — not claimed here.**
