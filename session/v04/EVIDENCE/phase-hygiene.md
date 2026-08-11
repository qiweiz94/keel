# v0.4 test-hygiene lane — evidence

Branch v04-hygiene, worktree /Users/nanoclaw/code/keel-v04-hygiene. Two assigned
bugs fixed; verification against the "real ~/.keel/state untouched" acceptance
bar surfaced four more real leakers of the same class, all fixed. Full list and
captures below.

## Bug 1 — level-reload.test.ts mutates the real ~/.keel/state

`packages/core/src/enforce/__tests__/level-reload.test.ts` set `process.env.HOME`
at describe-body scope (collection time) in two blocks ("dial level changes...",
"sprint auto-expiry..."), racing their own afterAll resets against each other.
Fix: moved the HOME capture/set into `beforeAll`, added an explicit
`KEEL_STATE_DIR` override alongside it (join(home, '.keel', 'state')), restored
both in `afterAll`.

The other two describe blocks in the same file ("rule level is a minimum-dial
filter", "dialAction()") were left untouched — confirmed via grep, not
inference: `dialPipeline()` never passes `stateManager` to `EnforcementPipeline`,
and `pipeline.ts` accesses it only via `config.stateManager?.` (optional
chaining, no default construction) — those blocks have no write path to disk
regardless of HOME, so isolating them would be a no-op.

## Bug 2 — ProblemLedger races on one shared ledger.json under blanket KEEL_STATE_DIR

`ledgerPath()` (problem-ledger.ts) prefers `KEEL_STATE_DIR` over the
HOME-derived fallback — already read per-call via a function, mirroring
state-manager.ts's `stateDir()` fix, so **no product change was needed** here.
The bug was purely in the tests: `ledger.test.ts` (two describe blocks) and
`match-surface.test.ts` (`withLedger()` helper) isolated only `HOME`, which
`ledgerPath()` ignores whenever `KEEL_STATE_DIR` is set in the outer
environment. Fix: added a per-test/per-call `KEEL_STATE_DIR` override
(`join(home, 'keel-state')`) alongside the existing `HOME` override in all
three places, restored afterward.

## Additional leakers found while proving the acceptance bar

The task's own acceptance bar — real `~/.keel/state` md5 unchanged across a
run — is stronger than "the two named files are fixed," and a bisection
(`for f in src/__tests__/*.test.ts; do <before-md5> ; npx vitest run "$f" ;
<after-md5> ; done`, run serially to remove the cross-file-parallelism
confound) turned up real, unconditional contamination beyond the two assigned
files:

- **`hook.test.ts`** — isolated `HOME` but not `KEEL_STATE_DIR` (same class as
  bug 2, blanket-mode only). Added `KEEL_STATE_DIR: join(tempHome, '.keel',
  'state')` to the hook subprocess env.
- **`cli.test.ts`** — its `run()` helper spawned the real built CLI with **no
  env override at all**, so `check --command "rm -rf /"` / `"git commit
  --no-verify"` (called 3x across the suite) hit the real
  `~/.keel/state/deny-first-time.json` unconditionally, in every mode. Added a
  `tempHome` (mkdtempSync in beforeAll, rmSync in afterAll) and passed
  `HOME`/`KEEL_STATE_DIR` through `run()`'s env.
- **`public-v1.test.ts`** — no HOME/KEEL_STATE_DIR isolation anywhere; its
  in-process `evaluateToolCall`/`initEnforce` calls (which correctly
  default-construct `StateManager` per call) were therefore hitting real state
  by construction, not defect. Added a file-level `beforeAll`/`afterAll` HOME +
  KEEL_STATE_DIR override; the two `execFileSync` calls needed no explicit env
  changes since they inherit the mutated `process.env`.
- **`daemon.ts` (product code, NOT a test file)** — `commands/daemon.ts` had
  `const sharedState = new StateManager()`, `const sharedLedger = new
  ProblemLedger()`, `const sharedResearchCache = new ResearchCache()` as
  **module-level constants**, evaluated once at import time — before
  `daemon.test.ts`'s `beforeEach` ever gets a chance to override
  `process.env.HOME`. This is the identical class of bug the repo's own
  comments on `state-manager.ts`'s `stateDir()` and `problem-ledger.ts`'s
  `ledgerPath()` already document and fix ("read per construction, not module
  load") — daemon.ts just never got the same treatment. In scope per the
  binding constraint allowing "adding an env-overridable dir to a tracker,
  mirroring an existing pattern." Fix: converted all three to lazily
  constructed singletons (`function sharedState() { return _sharedState ??=
  new StateManager() }`, same shape for the other two), updated every call
  site (`sharedState()`, `sharedLedger()`, `sharedResearchCache()`). No other
  module-level eager singleton of this class exists anywhere in the repo
  (checked via grep across cli/core/mcp-server/opencode-plugin src).
- **`packages/cli/vitest.config.ts` (structural root cause of the residual,
  hard-to-reproduce flake)** — packages/cli's build step copies
  `packages/core/src` wholesale into `packages/cli/src/core` (for bundling),
  which also copies core's own `__tests__` directories. Vitest's default
  include glob picked these up, so **every `packages/cli` test run was
  silently re-running the entire packages/core suite a second time** (409
  extra test cases — confirmed via `npx vitest list`), interleaved with
  packages/cli's own HOME/KEEL_STATE_DIR-mutating test files inside the same
  worker process. That is exactly the cross-file isolation race this lane
  exists to fix, just one layer up: individually-correct files could still
  race against their own duplicated copy, or against unrelated CLI files,
  because vitest's file parallelism put far more concurrently-running,
  env-mutating test files in play than anyone realized. This explains why
  fixes that were each individually verified clean (via single-file
  `vitest run <file>`) still left the *combined* `npm test` run leaking.
  Fix: `test.exclude: [...configDefaults.exclude, 'src/core/**']` in
  `packages/cli/vitest.config.ts`. Confirmed packages/cli's *own* test count
  (35 files / 662 passed + 14 skipped) plus packages/core's (26 files / 465
  passed + 2 skipped) sums exactly to the old combined "cli" numbers (61
  files / 1127 passed + 16 skipped) — proving the old run really was double
  -counting core's suite, not that real tests were lost.

## Verification

**Build** — `npm run build` (root): all four workspaces build clean,
including after the `daemon.ts` product-code change (tsc type-checks
`packages/cli` after copying the updated `packages/core/src` into
`src/core`).

**daemon.test.ts** (isolated) after the lazy-singleton refactor:
`Test Files 1 passed (1) / Tests 9 passed (9)`.

**Normal-mode full suite** (`npm test` from repo root):
- core: 26 files passed, 465 passed | 2 skipped
- cli: 35 files passed, 662 passed | 14 skipped (own scope only, post-exclude-fix)
- mcp-server: no tests (passWithNoTests)
- opencode-plugin: `node ./scripts/load-test.js` — all 54 checks PASS

**Real `~/.keel/state` md5, before vs. after the normal-mode run above:**

Before:
```
MD5 (circuit-breaker.json)  = 836bfe9687645b3d7033e5b657ee320d
MD5 (deny-first-time.json)  = cd2e078c5d36290a6249f637cdf71092
MD5 (ledger.json)           = 37110fd7f29709086074d2e0b32e4397
MD5 (oracle-failures.json)  = f8c1449aa9fe33856e6aa1f70acd81c9
MD5 (rate-counts.json)      = f974a2c852182429a382e64c1bb60796
MD5 (verification.json)     = 43238dc68eb7206aa7c2c8b3cf9edeb7
```
After: byte-identical, all six files, including `deny-first-time.json`
(`cd2e078c5d36290a6249f637cdf71092` unchanged). `diff` of the two md5 listings
is empty.

**Blanket-mode acceptance — `KEEL_STATE_DIR=$(mktemp -d) npm test`, 3
consecutive runs from repo root, full output each time:**

| Run | core | cli | opencode-plugin | Result |
|---|---|---|---|---|
| 1 | 26 files, 465 passed \| 2 skipped | 35 files, 662 passed \| 14 skipped | 54/54 PASS | GREEN |
| 2 | 26 files, 465 passed \| 2 skipped | 35 files, 662 passed \| 14 skipped | 54/54 PASS | GREEN |
| 3 | 26 files, 465 passed \| 2 skipped | 35 files, 662 passed \| 14 skipped | 54/54 PASS | GREEN |

Real `~/.keel/state` md5 checked again after the 3 blanket runs: identical to
the post-normal-mode snapshot above (blanket runs write to their own
`mktemp -d` dirs, not the real state dir, by construction of the fixes above).

**Per-file bisection** (`for f in packages/cli/src/__tests__/*.test.ts; do
<before-md5>; npx vitest run "$f" >/dev/null 2>&1; <after-md5>; [ mismatch ]
&& echo LEAKS; done`, serial — one file per vitest invocation, no
parallelism) run to completion after all fixes above: zero `LEAKS:` lines
across all files.

## Files changed

- `packages/core/src/enforce/__tests__/level-reload.test.ts` — bug 1 fix
  (HOME/KEEL_STATE_DIR moved into beforeAll/afterAll, both affected blocks)
- `packages/core/src/enforce/__tests__/ledger.test.ts` — bug 2 fix
  (KEEL_STATE_DIR added alongside HOME, both describe blocks)
- `packages/core/src/enforce/__tests__/match-surface.test.ts` — bug 2 fix
  (KEEL_STATE_DIR added to `withLedger()`)
- `packages/cli/src/__tests__/hook.test.ts` — KEEL_STATE_DIR added to hook
  subprocess env
- `packages/cli/src/__tests__/cli.test.ts` — tempHome + HOME/KEEL_STATE_DIR
  added to `run()`'s env (previously none at all)
- `packages/cli/src/__tests__/public-v1.test.ts` — file-level HOME/
  KEEL_STATE_DIR isolation added (previously none at all)
- `packages/cli/src/commands/daemon.ts` — **product code**, in-scope per the
  binding constraints' "env-overridable dir on a tracker" allowance: the
  three shared singletons converted from eager module-level `const` to
  lazily-constructed functions, mirroring the existing read-env-per
  -construction pattern
- `packages/cli/vitest.config.ts` — excluded the generated `src/core/**`
  copy from test discovery, stopping the silent double-execution of the
  entire packages/core suite inside packages/cli's own run

No files under `packages/cli/src/core/` (generated) or
`packages/cli/templates/keel-enforce.js` (generated) were edited.
