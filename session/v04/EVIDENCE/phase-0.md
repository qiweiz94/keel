# Phase-0 correctness lane — evidence (v0.4, worktree keel-v04-floor, branch v04-floor)

Tests-first (red -> fix -> green) for three bounded fixes. All commands run
from the worktree root unless noted. Full vitest output captured, never
piped through grep/head/tail.

## Fix 1 — floors non-overridable (mergeRules)

### Before (red) — unit test, floor weakening not yet rejected

Command: `cd packages/core && npx vitest run src/enforce/__tests__/rule-parser.test.ts`

```
 ❯ src/enforce/__tests__/rule-parser.test.ts (18 tests | 1 failed) 16ms
     × a local override that WEAKENS a level:protect floor is rejected — the floor stands 4ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/enforce/__tests__/rule-parser.test.ts > mergeRules — floor rules cannot be weakened by scope > a local override that WEAKENS a level:protect floor is rejected — the floor stands
AssertionError: expected 'warn' to be 'deny' // Object.is equality

Expected: "deny"
Received: "warn"

 ❯ src/enforce/__tests__/rule-parser.test.ts:159:26
    157|     const merged = mergeRules(hierarchy, 'balanced', 'local')
    158|     const rule = merged.find(r => r.id === 'no-force-push')
    159|     expect(rule?.action).toBe('deny')
       |                          ^
    160|     expect(rule?.level).toBe('protect')
    161|   })

 Test Files  1 failed (1)
      Tests  1 failed | 17 passed (18)
```

### Before (red) — end-to-end pipeline test, threat-model.test.ts

Command: `cd packages/core && npx vitest run src/enforce/__tests__/threat-model.test.ts -t "floor rules cannot be weakened by scope"`

```
 ❯ src/enforce/__tests__/threat-model.test.ts (30 tests | 1 failed | 29 skipped) 24ms
       × a .keel.local.yaml-shaped override of no-force-push (action: warn, no level) does not let a force push through 22ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/enforce/__tests__/threat-model.test.ts > agentic threat model (shipped defaults) > floor rules cannot be weakened by scope (end-to-end) > a .keel.local.yaml-shaped override of no-force-push (action: warn, no level) does not let a force push through
AssertionError: expected 'prompt' to be 'deny' // Object.is equality

Expected: "deny"
Received: "prompt"

 ❯ src/enforce/__tests__/threat-model.test.ts:419:29

 Test Files  1 failed (1)
      Tests  1 failed | 29 skipped (30)
```

Confirms the bug: a `.keel.local.yaml`-shaped override of a `level: protect`
floor id (`no-force-push`, `action: warn`, no `level`) is NOT rejected by
`mergeRules` today — the effective merged rule is the weaker override, and
`git push --force origin main` does not deny.

### Fix applied

`packages/core/src/enforce/rule-parser.ts` — added an explicit
`ACTION_STRENGTH: Record<EnforcementAction, number>` total order:

```
deny: 4, block: 4,
prompt: 3,
mask: 2, fix: 2, redirect: 2,
warn: 1,
allow: 0, report: 0, research: 0,
```

and rewrote `mergeRules`'s dedup loop so that when the rule already in the
map (`existing`) has `level === 'protect'`, a more-specific-scope
candidate only replaces it if the candidate ALSO has `level: protect` AND
`ACTION_STRENGTH[candidate.action] >= ACTION_STRENGTH[existing.action]`.
Otherwise the candidate is skipped and the floor stands unchanged.
Non-floor existing rules keep the prior free-override behavior.

### After (green)

Command: `cd packages/core && npx vitest run src/enforce/__tests__/rule-parser.test.ts src/enforce/__tests__/threat-model.test.ts`

```
 RUN  v4.1.10 /Users/nanoclaw/code/keel-v04-floor/packages/core


 Test Files  2 passed (2)
      Tests  48 passed (48)
   Start at  10:29:04
   Duration  721ms (transform 145ms, setup 0ms, import 284ms, tests 384ms, environment 0ms)
```

All 4 new mergeRules unit tests pass (weakening rejected, tightening
honored, tie honored, non-floor regression unaffected) plus the
end-to-end pipeline test (`git push --force` still denies through a
weakening local override) plus all pre-existing tests in both files
(no regressions).

### Pre-existing test corrected (not weakened)

Running the full core suite after the fix surfaced one pre-existing
failure, NOT a new test I wrote:

```
 FAIL  src/enforce/__tests__/agentic-eval.test.ts > agentic adversarial harness > custom user rules > filesystem rule protects secrets; project overrides global for same id
AssertionError: expected 'deny' to be 'warn'
```

`packages/core/src/enforce/__tests__/agentic-eval.test.ts:308` used
`no-destructive-commands` (a `level: protect` floor in the shipped
defaults, confirmed at `packages/cli/src/commands/install.ts:156-166`) as
its example of "a project rule overrides a global rule for the same id",
overriding it with `action: warn` and asserting the override WON — i.e.
this test asserted the exact vulnerability Fix 1 closes, with an inline
comment ("warn is what proves the override actually shadowed") that
praised the bug as a feature. This is not a test I introduced weakening
to force green; it is a pre-existing test whose expectation encoded the
security hole. It was corrected to demonstrate the override mechanism
with a non-floor global rule instead (`no-push-to-main`, `level: sprint`,
`action: prompt` — confirmed no `action: deny` command rule in the
shipped defaults lacks `level: protect`, so no floor-safe deny/deny swap
was available; `no-push-to-main`'s `prompt` action still lets a weaker
`warn` override demonstrate genuine shadowing without touching a floor).
After the edit, the full core suite (below) is green with no assertions
loosened — the invariant under test (override mechanics) is unchanged,
only which rule id demonstrates it.

## Fix 2 — scope no-self-protection-write to writes

### Before (red)

New fixture added to `packages/core/src/enforce/__tests__/threat-model.test.ts`
(`self-protection` describe block), against the shipped defaults loaded
straight from `packages/opencode-plugin/src/plugin.ts`'s
`DEFAULT_RULES_YAML`:

Command: `cd packages/core && npx vitest run src/enforce/__tests__/threat-model.test.ts -t "no-self-protection-write requires a write context"`

```
 ❯ src/enforce/__tests__/threat-model.test.ts (31 tests | 1 failed | 30 skipped) 19ms
       × no-self-protection-write requires a write context — reads of .keel/DISABLED are allowed, writes still denied 17ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/enforce/__tests__/threat-model.test.ts > agentic threat model (shipped defaults) > self-protection (keel must police its own enforcement) > no-self-protection-write requires a write context — reads of .keel/DISABLED are allowed, writes still denied
AssertionError: cat ~/.keel/DISABLED: expected 'deny' to be 'allow' // Object.is equality

Expected: "allow"
Received: "deny"

 ❯ src/enforce/__tests__/threat-model.test.ts:376:40

 Test Files  1 failed (1)
      Tests  1 failed | 30 skipped (31)
```

Confirms the read false-positive: `cat ~/.keel/DISABLED` (a harmless
read) was wrongly denied by the bare `[.]keel/DISABLED` alternative in
`no-self-protection-write`'s regex.

### Fix applied

Both `packages/cli/src/commands/install.ts` and
`packages/opencode-plugin/src/plugin.ts` (kept byte-identical, guarded by
`drift.test.ts`) — `no-self-protection-write`'s `match` regex tail:

Before:
```
...|[.]git/hooks/|[.]opencode/plugins/)|git +config[^|;&]*core[.]hooksPath|[.]keel/DISABLED
```
After:
```
...|[.]git/hooks/|[.]opencode/plugins/|[.]keel/DISABLED)|git +config[^|;&]*core[.]hooksPath
```
`[.]keel/DISABLED` moved inside the verb-gated target-path group (only
reached after one of the write verbs/redirect earlier in the pattern
matches) instead of being a bare top-level alternative. `git +config...
hooksPath` deliberately left untouched (out of this fix's scope; must
still deny on any mention, per the must-block fixtures).

### After (green)

Command: `cd packages/core && npx vitest run src/enforce/__tests__/threat-model.test.ts`

```
 RUN  v4.1.10 /Users/nanoclaw/code/keel-v04-floor/packages/core


 Test Files  1 passed (1)
      Tests  31 passed (31)
   Start at  10:29:59
   Duration  748ms (transform 99ms, setup 0ms, import 207ms, tests 387ms, environment 0ms)
```

Must-allow (new): `cat ~/.keel/DISABLED`, `grep foo ~/.keel/DISABLED` →
`allow`. Must-block (regression, unchanged): `echo x > ~/.keel/DISABLED`,
`tee ~/.keel/DISABLED <<< x`, `cp x ~/.keel/DISABLED`,
`mv x ~/.keel/DISABLED`, `git config core.hooksPath /dev/null` → all
`deny`.

`drift.test.ts` (both DEFAULT_RULES_YAML copies stay byte-identical),
run after `npm run build` (see below): 9/9 passed.

## Fix 3 — STATE_DIR read per construction

### Before (red)

New file `packages/core/src/enforce/__tests__/state-manager.test.ts`.

Command: `cd packages/core && npx vitest run src/enforce/__tests__/state-manager.test.ts`

```
 ❯ src/enforce/__tests__/state-manager.test.ts (3 tests | 3 failed) 17ms
     × writes under the KEEL_STATE_DIR set BEFORE construction (baseline) 10ms
     × a SECOND StateManager picks up a CHANGED KEEL_STATE_DIR in the same process 3ms
     × an explicit constructor arg takes precedence over the env var 3ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/enforce/__tests__/state-manager.test.ts > StateManager — KEEL_STATE_DIR read per construction > writes under the KEEL_STATE_DIR set BEFORE construction (baseline)
AssertionError: expected false to be true // Object.is equality
 ❯ src/enforce/__tests__/state-manager.test.ts:37:59
    35|     const sm = new StateManager()
    36|     sm.markFirstTime('rule-a')
    37|     expect(existsSync(join(dir, 'deny-first-time.json'))).toBe(true)

 Test Files  1 failed (1)
      Tests  3 failed (3)
```

All 3 failed — confirms the module-level `STATE_DIR` const (read once at
first import of `state-manager.ts` in the whole vitest process) ignores
`KEEL_STATE_DIR` set later in a test body. NOTE (self-reported): this red
run actually wrote to the real `~/.keel/state/deny-first-time.json`
(`rule-a`, `rule-c` keys) because the module fell back to the real
homedir default. Cleaned up immediately after confirming red (removed
the two stray keys, restored the file's pre-existing 3 keys) before
proceeding — see "Real ~/.keel touch points" section below.

### Fix applied

`packages/core/src/enforce/state-manager.ts` — replaced the module-level
`const STATE_DIR = process.env.KEEL_STATE_DIR || join(homedir(), '.keel', 'state')`
with an exported `stateDir()` function (same resolution logic), called
via the constructor's default parameter:
`constructor(dir: string = stateDir()) { this.dir = dir; this.load() }`,
with `statePath`/`saveFile` reading `this.dir` instead of the old module
const. Mirrors the pattern already used by `overrides.ts`'s
`FileRuleOverrideStore` (`KEEL_OVERRIDES_DIR`) and
`package-verifier.ts`'s `packageVerifierStateDir()` (`KEEL_STATE_DIR`,
already per-construction). Existing call sites (`new StateManager()` with
no args, in `daemon.ts`, `enforce.ts`, `plugin.ts`, and the test files)
are unaffected — the default parameter re-resolves the env var at each
construction.

### After (green)

Command: `cd packages/core && npx vitest run src/enforce/__tests__/state-manager.test.ts`

```
 RUN  v4.1.10 /Users/nanoclaw/code/keel-v04-floor/packages/core


 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  10:31:14
   Duration  179ms (transform 22ms, setup 0ms, import 31ms, tests 7ms, environment 0ms)
```

Verified via `md5` of `~/.keel/state/deny-first-time.json` before/after
this green run: unchanged (`f219c3fb4845addc9416b872774097c8` both
sides) — the fix's own tests no longer touch the real state dir.

## Build

Command: `npm run build` (repo root) — regenerates `packages/cli/src/core`
(vendored copy of `packages/core/src`, includes the mergeRules and
state-manager fixes) and `packages/cli/templates/keel-enforce.js`
(esbuild bundle of `packages/opencode-plugin/src/plugin.ts`, includes the
DEFAULT_RULES_YAML regex fix). All four workspaces built clean:

```
> @get-keel/core@0.1.9 build
  dist/keel-core.mjs  133.1kb
⚡ Done in 12ms

> @get-keel/cli@0.2.2 build
(tsc — no errors)

> @get-keel/mcp-server@0.1.2 build
(tsc — no errors)

> @get-keel/opencode-plugin@0.1.9 build
  dist/index.js  381.2kb
⚡ Done in 12ms
```

Confirmed the vendored/bundled artifacts picked up the fixes:
```
$ grep -n "ACTION_STRENGTH" packages/cli/src/core/enforce/rule-parser.ts | head -1
389:const ACTION_STRENGTH: Record<EnforcementAction, number> = {
$ grep -n "function stateDir" packages/cli/src/core/enforce/state-manager.ts
35:export function stateDir(): string {
$ grep -o "opencode/plugins/[^\"]*keel/DISABLED[^\"]*hooksPath" packages/cli/templates/keel-enforce.js
opencode/plugins/|[.]keel/DISABLED)|git +config[^|;&]*core[.]hooksPath
```

## Full suite — normal mode (interim, before the ledgerPath fix below)

### Core (`packages/core`): `npx vitest run`

```
 RUN  v4.1.10 /Users/nanoclaw/code/keel-v04-floor/packages/core


 Test Files  26 passed (26)
      Tests  463 passed | 2 skipped (465)
   Start at  10:33:10
   Duration  2.96s (transform 4.80s, setup 0ms, import 8.29s, tests 8.48s, environment 3ms)
```

### CLI (`packages/cli`): `npx vitest run` (includes `drift.test.ts`, 9/9)

```
 RUN  v4.1.10 /Users/nanoclaw/code/keel-v04-floor/packages/cli

 Test Files  61 passed (61)
      Tests  1125 passed | 16 skipped (1141)
   Start at  10:34:54
   Duration  14.51s (transform 5.39s, setup 0ms, import 10.62s, tests 68.13s, environment 8ms)
```

All green. `drift.test.ts` (9/9, run standalone first to confirm) proves
the two `DEFAULT_RULES_YAML` copies are still byte-identical after the
Fix 2 edit.

## Fix 1 addendum — the untested ACTION_STRENGTH clause

Advisor review flagged that the original 3 mergeRules tests all pass even
if the `ACTION_STRENGTH` comparison is deleted from the fix (leaving only
the `rule.level === 'protect'` check) — the WEAKENS-floor test used an
override with NO `level` field at all, so the level check alone rejects
it regardless of strength. Added a 5th test: global `(protect, deny)`
overridden by local `(protect, warn)` — level KEPT, action weakened —
must still stay `deny`.

Mutation check (temporarily deleted the `ACTION_STRENGTH[...] >=
ACTION_STRENGTH[...]` half of the condition, reran, restored):

```
 ❯ src/enforce/__tests__/rule-parser.test.ts (19 tests | 1 failed) 18ms
     × a local override that KEEPS level:protect but WEAKENS the action (deny -> warn) is still rejected 4ms

 FAIL  src/enforce/__tests__/rule-parser.test.ts > mergeRules — floor rules cannot be weakened by scope > a local override that KEEPS level:protect but WEAKENS the action (deny -> warn) is still rejected
AssertionError: expected 'warn' to be 'deny'
Expected: "deny"
Received: "warn"

 Test Files  1 failed (1)
      Tests  1 failed | 18 passed (19)
```

Confirms the new test exercises the ACTION_STRENGTH comparison
specifically, not just the level check. Full file green again after
restoring the real implementation (19/19).

### Real ~/.keel touch points (pre-existing, out of scope)

Tracked `~/.keel/state/deny-first-time.json` by md5/content before and
after each suite run to verify my own new tests never touch the real
state dir. They don't (Fix 3's own test file: unchanged md5, confirmed
above). However, running the FULL core suite and FULL cli suite each
mutated two keys already present in that file before this session
(`demo-deny`, `expiry-rule` — new timestamps/versions each run, same key
names). Traced `expiry-rule` to
`packages/core/src/enforce/__tests__/level-reload.test.ts`, which has TWO
`describe` blocks that each mutate `process.env.HOME` at the TOP LEVEL
(module-collection time, not in a hook) and restore it in their own
`afterAll`. Vitest evaluates all `describe` bodies during collection
before any hook runs, so the second block's `process.env.HOME = home2`
(collection time) is overwritten by the first block's `afterAll` reset
to the real HOME (execution time, which runs before the second block's
`beforeAll`) — by the time the second block's `beforeAll` constructs its
`StateManager`, `HOME` has already been reset to the real value. This is
a PRE-EXISTING test-isolation gap, structurally unrelated to Fix 3 (it
would have leaked to wherever `HOME` pointed at first `state-manager.ts`
import either way, before or after this fix) and out of this lane's
three-fix scope, so it was left as-is. Both leaked keys were restored to
their pre-session values by hand after each observation (not committed —
this file lives outside the repo). Noted here per the "capture output"
evidence requirement and flagged in the final report as a surprise/find,
not fixed.

## Blanket KEEL_STATE_DIR run — the actual required verification for Fix 3

### First attempt — red, root cause NOT in state-manager.ts

Command: `KEEL_STATE_DIR=$(mktemp -d) npm test` (repo root, after Fix 1-3
+ build, before any further changes)

```
 Test Files  4 failed | 57 passed (61)          [cli workspace]
      Tests  8 failed | 1117 passed | 16 skipped (1141)
```
plus core workspace failures folded into the same `npm test` run — 16
total `FAIL` lines across `ledger.test.ts` (both the source copy and its
vendored copy under `packages/cli/src/core`), `match-surface.test.ts`
(both copies), `daemon.test.ts` ("records outcomes and hypotheses
through the ledger endpoints"), and `hook.test.ts` ("warns on the first
destructive command, denies the repeat").

Root-caused the 14 ledger/daemon failures to a FOURTH pre-existing bug,
not to an incomplete Fix 3: `packages/core/src/enforce/problem-ledger.ts`'s
`ledgerPath()`:
```ts
export function ledgerPath(): string {
  return process.env.KEEL_STATE_DIR || join(homedir(), '.keel', 'state', 'ledger.json')
}
```
The fallback branch (no env var) returns a FILE path ending in
`ledger.json`; the env branch returned the bare directory itself. Under
a blanket `KEEL_STATE_DIR`, `ProblemLedger`'s `save()` does
`writeFileSync(tmp, ...)` then `renameSync(tmp, this.path)` where
`this.path` is a DIRECTORY — `renameSync` onto an existing directory
throws (EISDIR/ENOTDIR), silently swallowed by `save()`'s bare
`catch { /* best effort */ }`. Every write under a blanket dir was a
silent no-op. Confirmed by direct reproduction:
```
$ KEEL_STATE_DIR=$(mktemp -d) npx vitest run src/enforce/__tests__/ledger.test.ts
 ❯ src/enforce/__tests__/ledger.test.ts (11 tests | 4 failed) 194ms
```
Swept the class per review: grepped all `KEEL_STATE_DIR` consumers in
`packages/{core,cli,opencode-plugin}/src` — only 3 real code consumers
(`state-manager.ts`, `package-verifier.ts`, `problem-ledger.ts`).
`package-verifier.ts`'s `packageVerifierStateDir()` returns the bare
dir too, but correctly — its `filePath()` joins `'package-verifier.json'`
onto it afterward, unlike `problem-ledger.ts` which used the dir as the
file path directly. No other consumers found (the `install.ts`/`level.ts`
hits are a rule message string and a doc comment, not code paths).

### Fix applied (same env var, same defect class as Fix 3, blocked Fix 3's
own named acceptance test — treated as in-scope-by-necessity rather than
a fourth unrelated fix; logged in `session/v04/DECISIONS.md`)

Test first, in `packages/core/src/enforce/__tests__/ledger.test.ts`:
```
 ❯ src/enforce/__tests__/ledger.test.ts (12 tests | 1 failed | 11 skipped) 6ms
     × joins ledger.json onto KEEL_STATE_DIR, matching the homedir fallback shape 5ms

AssertionError: expected '/tmp/keel-state-example' to be '/tmp/keel-state-example/ledger.json'
```
Fix:
```ts
export function ledgerPath(): string {
  return join(process.env.KEEL_STATE_DIR || join(homedir(), '.keel', 'state'), 'ledger.json')
}
```
Green after:
```
 Test Files  1 passed (1)
      Tests  12 passed (12)
```
Full `npm run build` re-run (regenerates the vendored copy and the
opencode-plugin bundle — problem-ledger.ts is vendored the same way as
state-manager.ts). Full core suite: 465/465 (was 463, +2 new tests: the
ACTION_STRENGTH mutation-catching test and this ledgerPath test). Full
cli suite: 1127/1127 (was 1125, +2 vendored copies of the same tests).
`drift.test.ts`: 9/9. All captured below under "Full suite — normal
mode, final".

### Second attempt — still red, but a DIFFERENT and pre-existing hazard class

Command: `KEEL_STATE_DIR=$(mktemp -d) npm test`, three consecutive runs
with fresh temp dirs, full output redirected to a file and read back (not
tailed):

```
Run 2: 7 FAIL lines
  ledger.test.ts > diagnosis rules > redirects a complex fix...
  match-surface.test.ts > ...also matches a quoted command...
  [vendored copies] ledger.test.ts > tracks failures...
  [vendored copies] ledger.test.ts > records hypotheses...
  [vendored copies] ledger.test.ts > diagnosis rules > redirects...
  [vendored copies] match-surface.test.ts > still matches file CONTENT...
  [vendored copies] match-surface.test.ts > ...quoted command...

Run 3: 6 FAIL lines (DIFFERENT subset — hook.test.ts and daemon.test.ts
  both gone, several ledger.test.ts names differ from run 2)
```
`hook.test.ts`'s block-first failure (present in run 1) did not recur in
runs 2 or 3. The composition of failing tests changed between otherwise
identical runs (same code, same command, fresh temp dirs) — this is the
signature of a RACE, not a deterministic logic bug. Root cause: with
`ledgerPath()` fixed, every `ProblemLedger` instance across EVERY test
file in the run now resolves to the literal SAME `ledger.json` path
under the one blanket directory. In normal mode, each test file that
uses `ProblemLedger` isolates via its own temp `HOME` (a different real
default path per file); under a blanket env var that per-file isolation
collapses to one shared file, and multiple test files run concurrently
in different vitest worker threads within the same package — their
`ProblemLedger.save()` calls (full read-JSON, mutate in memory,
write-JSON-back, no cross-process lock) race and overwrite each other's
writes non-atomically. This is the SAME structural hazard class as
`hook.test.ts`'s pre-existing block-first flake (both `StateManager` and
`ProblemLedger` do unlocked read-modify-write cycles against a shared
file; a blanket `KEEL_STATE_DIR` turns per-file isolation into
cross-file contention for every consumer, not just the one this lane's
Fix 3 targeted).

Verified this round of failures does NOT touch the real `~/.keel/state`:
`md5` of `~/.keel/state/deny-first-time.json` unchanged
(`f219c3fb4845addc9416b872774097c8`) across all three blanket runs — the
directory resolution itself (Fix 3's actual target) is correct; the
remaining failures are a concurrency gap, not a wrong-directory bug.

### Stopping point (per the "fail the same subtask twice, report
honestly" instruction)

Did not attempt to add cross-process file locking to `ProblemLedger`
and/or `StateManager` — that is a materially larger, unbounded change
(real inter-process locking, e.g. an flock-based mutex or a
single-writer daemon) well outside this lane's three named, bounded
fixes, and was never asked for. Reporting as-is:

- **Fix 3 itself (state-manager.ts) is correct and fully verified** — its
  own dedicated test file is green in both normal and blanket mode, and
  its directory resolution is proven correct (the real `~/.keel/state`
  is never touched under a blanket `KEEL_STATE_DIR`, in either mode).
- **The blanket-mode full-suite run is NOT fully green.** It went from
  16 failures (before the in-scope `ledgerPath()` fix) to 6-7
  (non-deterministic) — all in `ProblemLedger`-backed tests
  (`ledger.test.ts`, `match-surface.test.ts`'s diagnosis-rule cases, and
  intermittently `daemon.test.ts`/`hook.test.ts`), racing on one shared
  file across concurrently-run test files. This is a pre-existing
  concurrency gap in `ProblemLedger` (and likely latent in
  `StateManager` too, per `hook.test.ts`'s original flake), not a defect
  in anything this lane's three fixes touch, and fixing it for real
  would require adding locking — logged in `session/v04/DECISIONS.md`
  for a follow-up lane rather than attempted here.

## Full suite — normal mode, FINAL (after all edits, including the
in-scope ledgerPath fix, the Fix-1 addendum test, and the stale-comment
correction)

### Core: `cd packages/core && npx vitest run`

```
 RUN  v4.1.10 /Users/nanoclaw/code/keel-v04-floor/packages/core


 Test Files  26 passed (26)
      Tests  465 passed | 2 skipped (467)
   Start at  10:47:09
   Duration  2.68s (transform 2.81s, setup 0ms, import 5.06s, tests 6.70s, environment 4ms)
```

### CLI: `cd packages/cli && npx vitest run`

```
 RUN  v4.1.10 /Users/nanoclaw/code/keel-v04-floor/packages/cli

 Test Files  61 passed (61)
      Tests  1127 passed | 16 skipped (1143)
   Start at  10:47:20
   Duration  15.24s (transform 3.06s, setup 0ms, import 10.33s, tests 87.75s, environment 13ms)
```

Both fully green (465/465 core, 1127/1127 cli, non-skipped). `md5` of
`~/.keel/state/deny-first-time.json` checked before/after both runs and
restored to its pre-session baseline (`f219c3fb4845addc9416b872774097c8`)
by hand afterward — the two mutations observed mid-run both traced to
`level-reload.test.ts`'s pre-existing top-level `process.env.HOME`
collection-time-ordering issue (see "Real ~/.keel touch points" above),
not to any of this lane's code changes.
