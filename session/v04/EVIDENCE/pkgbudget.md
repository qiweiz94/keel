# Package-lookup budget fix (v0.4)

Worktree `/Users/nanoclaw/code/keel-v04-pkgbudget` (branch `v04-pkgbudget`). Owned files:
`packages/core/src/enforce/pipeline.ts` (the `rule.type === 'package'` branch only) and
`packages/core/src/enforce/package-verifier.ts`. `packages/core/src/enforce/index.ts` (public
export list) and three collateral test files were also touched — see "Collateral test updates"
below for why each was necessary and in scope.

## The bug (measured by the perf lane, a4-perf.md §5.3)

`pipeline.ts`'s `type: package` branch called `checkPackages(specs, { totalTimeoutMs: 2000, ... })`
synchronously inside `evaluate()`. A cache MISS against a slow or unreachable npm registry blocked
that one `evaluate()` call for up to 2000ms — a ~40x violation of keel's own `<50ms` hot-path
promise. Directly measured before this fix (a4-perf.md, mocked fetch that never resolves until the
internal `AbortController` fires):

```
2003.8ms — action=prompt rule_id=unverified-package-install
2003.5ms — action=prompt rule_id=unverified-package-install
```

## The fix — cache-first, never blocks on the network

Two new functions in `package-verifier.ts`:

- `checkPackagesCacheOnly(specs, cache, now?)` — disk-cache read only, zero I/O, no `fetchImpl`
  parameter to even call. A fresh cached verdict (deny/prompt/allow) is used exactly as
  `checkPackages` would have used it. Anything with no fresh cache entry comes back as an
  `unverified` / new `not_yet_checked` reason — `decidePackageAction` already downgrades any
  `unverified` verdict to `prompt`, so this reuses the gate's existing "unverified → prompt,
  never deny on uncertainty" design instead of inventing a new action. Returns `misses`: the
  deduplicated specs that need a real lookup.
- `scheduleBackgroundVerification(misses, opts)` — fires `checkPackages` for the misses WITHOUT
  the caller awaiting it. `checkPackages` already populates the cache as each spec resolves
  (unchanged), so the next `checkPackagesCacheOnly` call for the same package sees a real verdict.
  Errors are swallowed (`.then(() => undefined, () => undefined)`) so a rejected lookup can never
  surface as an unhandled rejection in a host process. Returns the settlement promise purely so
  tests can await it deterministically.

`pipeline.ts`'s package branch now: (1) calls `checkPackagesCacheOnly` — fast, synchronous, no
network; (2) if there are misses, calls `scheduleBackgroundVerification` and fires it with `void`
— never `await`ed — optionally handing the settlement promise to a new test-only
`packageVerifierOnBackgroundStart` hook on `PipelineConfig` (never set by any production host);
(3) runs `decidePackageAction` on the (possibly placeholder) results exactly as before.

**Not done, deliberately (see advisor discussion during this lane):** did not add `.unref()`
anywhere. No new timer is created by this fix — the existing `fetchJsonCapped` abort timer stays
ref'd, because two existing tests (`timeout -> unverified/timeout`, the shared-budget test) depend
on it firing, and unref'ing it buys nothing: the mechanism that actually determines whether the
background fill completes is host lifetime (see the caveat below), not timer ref state.

## Accepted tradeoff — first attempt at an uncached nonexistent package prompts, not denies

The FIRST `evaluate()` call on a never-looked-up package name always returns `prompt` (reason
`not_yet_checked`), regardless of what the registry will eventually say — a same-call verdict is
structurally impossible without blocking on the network, which is the entire point of this fix.
Only a REPEAT of the same install, after the background lookup has landed a `not_found` verdict in
the cache, gets the deterministic `deny`. The human-approval prompt still stops a blind install on
the first attempt; it just isn't the instant deterministic deny the old synchronous path gave, at
the cost of blocking every miss for up to 2s.

## Host-dependent caveat — the retry guarantee does not hold everywhere

Whether "the deterministic deny lands on retry" is actually true depends on the host process's
lifetime, which this branch does not control:

- **Holds**: a long-lived pipeline host — the opencode plugin (`packages/opencode-plugin/src/plugin.ts`
  constructs one `EnforcementPipeline` per plugin load and reuses it for the whole session) and the
  MCP daemon. The background promise has the rest of the process's life to complete.
- **Does not hold today**: `packages/cli/src/commands/hook.ts` (the claude-code / codex / gemini /
  cursor `keel hook` path) calls `process.exit(verdict.exitCode)` immediately after rendering the
  first verdict (lines ~405, ~430). `process.exit()` terminates immediately regardless of any
  timer's ref state, killing the background promise before it can land a real verdict. For these
  hosts, a repeat install of the same uncached-then-hallucinated package will likely prompt again
  rather than deny, until some other call in the same session happens to keep the process alive
  long enough for the background fill to land, or the package gets looked up via a different path.

This is a real, load-bearing gap in the "prompt now, deny on retry" story for the majority of
today's shipped hosts. Fixing it is out of this branch's scope — `hook.ts` belongs to a different
lane, and doing so (e.g. detaching a child process, or not exiting until pending work drains) is a
host-integration decision, not a `pipeline.ts`/`package-verifier.ts` one. Flagged here so it is not
mistaken for a universal guarantee.

## Before / after measurement

All from `packages/core/src/enforce/__tests__/package-verifier.test.ts`, this exact worktree, this
exact commit (`npx vitest run ... --reporter=verbose`):

| scenario | before (old sync path, a4-perf.md) | after (this fix) |
|---|---|---|
| cache miss, registry hangs until internal 2000ms abort | 2003.8ms / 2003.5ms | **5.486ms** (regression test, asserted `<50ms`) |
| `checkPackagesCacheOnly`, 3 cached specs (deny+prompt+allow) | n/a (didn't exist) | **0.302ms** |
| `checkPackagesCacheOnly`, 1 uncached spec | n/a (didn't exist) | **0.063ms** |

The regression test (`REGRESSION: a cache-miss evaluate() call returns fast even when the registry
lookup hangs for the full internal budget`) uses the same `makeMockRegistry({..: 'timeout'})` mock
already used elsewhere in this file — a fetch that resolves only when the internal
`AbortController` fires (~2000ms). `evaluate()` returns in 5.486ms; the test then explicitly
`await`s the background-fill promise (via `packageVerifierOnBackgroundStart`) so it can assert the
background lookup does eventually settle rather than hanging the process forever — that's the
~2000ms in the test's own wall-clock duration (2033ms total), not in `evaluate()`.

## Tests

New/changed, all in `packages/core/src/enforce/__tests__/package-verifier.test.ts` unless noted:

- `checkPackagesCacheOnly + scheduleBackgroundVerification` describe block (6 new tests):
  cache-hit deny/prompt/allow correctness + timing, cache-miss placeholder + timing, miss
  dedup-by-name, background fill actually populates the cache (second cache-only check denies a
  previously-uncached nonexistent package), background fill never rejects on a throwing fetch,
  zero-misses short-circuits without touching `fetchImpl`.
- `pipeline: type "package" rule` describe block — rewritten as two-phase (phase 1: first
  `evaluate()` on an uncached package always prompts with a `not yet checked` message; phase 2:
  `await` the background settle via `packageVerifierOnBackgroundStart`, then a second `evaluate()`
  on the same command asserts the REAL verdict and its distinguishing message — not just the
  action, so the age_gate and scoped_not_public branches are still actually exercised, not merely
  passing because every miss now happens to return `prompt`). Includes the REGRESSION test above.

### Collateral test updates (same intentional behavior change, different files)

These three files assert the old same-call synchronous verdict on a cache miss; each is updated to
either add a background-settle retry phase or to accept `prompt` on the (now realistic) first
attempt, honestly reflecting the new contract rather than loosening the assertion:

- `packages/core/src/enforce/__tests__/agentic-eval.test.ts` — `prompt-gates on-the-fly package
  execution; allows installs and runs`. Pre-seeds the cache with a fresh `exists` verdict for
  `lodash` (simulating the realistic steady state of an already-verified package) so the test's
  actual intent — a known-good install is allowed — is still what's asserted, and adds an explicit
  assertion that a genuinely never-before-seen package prompts on its first attempt.
- `packages/cli/src/__tests__/proposal-fixture-harness.test.ts` (not edited directly — its data
  fixture was) — single-step harness by design (see its own file header: "no multi-step /
  precreate / repeat"), so a two-phase retry isn't expressible here.
- `tests/rules/unverified-package-install/must-block.yaml` — the "hallucinated package" case's
  `expect_action` changed from `deny` to `prompt`, with an updated note and file header explaining
  why (single-attempt harness sees only the first-attempt prompt; the deny-on-retry behavior is
  covered by the two-phase pipeline tests in `package-verifier.test.ts` instead).

Confirmed empirically, not assumed: `scheduleBackgroundVerification`'s call to `checkPackages` runs
synchronously up to its first internal `await` (standard JS async-function semantics), which means
`fetchImpl` IS invoked synchronously within the same `evaluate()` call even though its result is
never awaited — this is why `proposal-fixture-harness.test.ts`'s own `calls.length > 0` assertion
(added to catch a broken fetch-injection wiring) still passes unmodified for every package-rule
case.

## Verify

```
$ npm ci                                  # clean install, this worktree
$ npm run build                           # root, all 4 workspaces — clean, no errors
$ npm run test -w @get-keel/core
  32 test files passed | 539 passed | 2 skipped (541)   (baseline ~531; grew from 8 new tests)
$ npm run test -w @get-keel/cli
  37 test files passed | 678-679 passed | 14-15 skipped (693)
```

Full-suite runs on this box alternated between 679/14 and 678/15 across repeated runs — traced to
`perf-budget.test.ts`'s own `os.loadavg()` skip guard (pre-existing, unrelated to this fix, and
documented as load-dependent by that test's own header). Confirmed directly: running
`perf-budget.test.ts` alone with `--reporter=verbose` at a moment this box's 1-minute load was
14.9/16 cores did NOT skip and measured a real p99 of 1.380ms (best-of-3); a separate full-suite
run skipped it. Both are that test's own documented, load-dependent behavior — not a regression
introduced here.

No regressions in either suite. Node v26.0.0, per `node -v`.

## Shipped-prose audit — does any existing doc now say something false?

Checked whether any shipped text claims a nonexistent-package install is denied/blocked on its
first attempt, and whether any doc already took a4-perf.md §5.3's other offered option
("document the `<50ms` exception instead of fixing it"):

```
grep -rniE "hallucinat|slopsquat|does not exist|nonexistent|unfulfillable" docs/ README.md \
  packages/cli/src/commands/install.ts packages/opencode-plugin/src/plugin.ts
grep -rn "50ms" docs/ README.md
```

- **No doc took the "document the exception" route.** `session/v04/DECISIONS.md` (the
  coordinator's own log, not edited here) already recorded the fix as the chosen path before this
  lane started — nothing references a `<50ms`-except-package-miss carve-out anywhere in `docs/` or
  `README.md`.
- **`docs/tiers.md`'s table already lists `unverified-package-install`'s action as `prompt`**, not
  `deny` (line 103, with a footnote that this is the doc's own inference since the rule ships no
  `level:`/`mode:` field) — that line stays accurate. The narrative paragraph above it ("the first
  hit *is* the incident... a warn-once ladder is the wrong shape") is framed as the rationale for
  why this rule class skips a soft warm-up period, not as a same-call-deny claim — and that framing
  still holds: `prompt` is a `BLOCKING_ACTIONS` member (`packages/cli/src/commands/evaluate.ts`), so
  the first hit on an uncached package is still fully blocked, not merely warned. What the doc does
  not capture — worth a follow-up line for whoever next touches `docs/tiers.md` — is the two-phase
  nuance this fix introduces: that first-hit block is `prompt`/not-yet-checked for an uncached name,
  and only escalates to a same-verdict `deny` on a retry once the background lookup lands
  `not_found`. Not a false claim, just under-specified; not fixed here since `docs/tiers.md` is
  outside this lane's owned files.
- **`README.md`'s "Measured, not asserted" experiment claim (0% harm on "installing a nonexistent
  package")** is not falsified by this change either, for the same `BLOCKING_ACTIONS` reason: the
  experiment's guarded arm was blocked from proceeding, and `prompt` blocks exactly as `deny` did
  from the acting agent's point of view. Not verified by re-running the experiment (out of this
  lane's scope and budget) — flagged as "very likely still holds" on the `BLOCKING_ACTIONS` evidence
  above, not confirmed empirically.
