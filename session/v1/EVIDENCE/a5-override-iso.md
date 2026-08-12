# a5-override-iso — closing the override-store test-isolation leak (AUDIT §8b)

## TL;DR

AUDIT §8b's own *symptom* (a real armed override with a future `expires_at`
appearing in `~/.keel/overrides.json`) was real, but its *file attribution*
(`hook-command.test.ts`, `fixture-harness.test.ts`) does not match the
current codebase: neither file spawns the real CLI or constructs a real
`FileRuleOverrideStore` today — `fixture-harness.test.ts` already stubs
`overrideStore` (`stubOverrideStore()`), and `hook-command.test.ts` never
touches `EnforcementPipeline` at all. The actual, still-open leak is
different and was found by bisection: **8 test files in `packages/core`**
construct `EnforcementPipeline` in-process without supplying `overrideStore`,
so it defaults to a real `FileRuleOverrideStore` rooted at `resolveHome()`
(`KEEL_HOME` > `HOME` > `homedir()`). Every deny/warn/redirect verdict calls
`overrideStore.consume()` unconditionally, which touches disk even when no
override was ever armed — and, if a test's synthetic rule ID happens to
collide with a real pre-existing armed override, silently **deletes** it.
All 8 are now fixed with an in-memory stub (the same pattern
`match-surface.test.ts` already used), and a new `vitest` `globalSetup`
guard in `packages/core` fails the suite if it ever recurs. Verified by a
mutation test that reintroduces the leak and confirms the guard fires.

## STEP 1 — did the current suite actually leak?

### Confound: this repo runs several concurrent worktree lanes against the same real `~/.keel`

Before trusting any before/after diff of the real file, `ps aux` showed
multiple sibling worktrees (`keel-v1p2-a2-ifs`, `keel-v1p2-a3a4-install`,
`keel-v1p2-b1-exfil`, this lane) each running their own `keel daemon`
processes, and — twice during this session — another lane's own `npm test`
literally running *at the same moment* as mine:

```
nanoclaw  76693  ...  eval 'cd /Users/nanoclaw/code/keel-v1p2-a2-ifs && npm test ...'
```

So a naive "snapshot real `~/.keel/overrides.json` before/after my own
`npm test`" is confounded — any mtime change could belong to a sibling
lane, not this worktree's suite. All conclusions below are instead drawn
from **fully isolated `HOME` reproductions** (a scratch dir seeded with its
own `.keel/overrides.json`, immune to any other process on the machine),
which is reproducible and attributable with certainty.

### Real-`~/.keel` snapshots (for the record, confound noted)

Baseline run (before any change):
```
BEFORE  mtime 16:58:28  content {}
AFTER   mtime 16:59:53  content {}   (concurrent npm test — PID 76693 — was NOT yet running at this point)
```
Final run (after the fix, rebuilt):
```
BEFORE  mtime 17:16:54  content {}
AFTER   mtime 17:18:36  content {}   (concurrent npm test from keel-v1p2-a2-ifs, PID 16462/16464, confirmed running during this exact window)
```
Content stayed `{}` in both cases — consistent with either (a) no leak, or
(b) a content-preserving touch (see below). The isolated-`HOME`
reproduction resolves the ambiguity.

### Isolated-HOME reproduction: the leak is real, and it's in `packages/core`

Running this worktree's full `npm test --workspaces` with `HOME` fully
redirected to a scratch dir (no other process can touch it):

```
before mtime=1786575940 hash=8a80554c... (content "{}\n", from `echo`)
after  mtime=1786575946 hash=99914b93... (content "{}",   from FileRuleOverrideStore.write())
changed=YES
```

Bisecting by package (`npm test --workspace=packages/<pkg>` against a fresh
isolated `HOME` each time):

| package | touched isolated HOME's overrides.json? |
|---|---|
| core | **YES** |
| cli | no |
| mcp-server | no |
| opencode-plugin | no |

Bisecting every `packages/cli/src/__tests__/*.test.ts` file that spawns a
real subprocess (21 files, including `hook-command.test.ts` — which turned
out not to spawn anything — and `fixture-harness.test.ts`) individually
against a fresh isolated `HOME`: **none of them touched it.** Confirmed by
reading both files directly: `hook-command.test.ts` only imports
`renderVerdict`/`parsePayload` and never constructs `EnforcementPipeline`
or spawns anything; `fixture-harness.test.ts` does construct
`EnforcementPipeline` but already passes `overrideStore: stubOverrideStore()`
in `buildPipeline()` (line 206) — it was already fixed, presumably in an
earlier wave (the "wave-3 warnsurface lane" comment in `overrides.ts`
documents ongoing incremental hardening of this same class of bug).

Bisecting `packages/core/src/enforce/__tests__/*.test.ts` files that
construct `EnforcementPipeline` without any visible `overrideStore` (8
candidates found by grep) against fresh isolated `HOME`s each:

| file | touched isolated HOME's overrides.json? |
|---|---|
| `glob-matching.test.ts` | **YES** |
| `verification.test.ts` | **YES** |
| `audit.test.ts` | no (rule uses `mode: observe` — never reaches the deny/warn branch that calls `consume()`) |
| `oracle.test.ts` | **YES** |
| `ledger.test.ts` | no (empirically safe — rules use `action: redirect` but the test's `diagnosis`-type branch doesn't currently hit a hypothesis-missing case that calls `consume()`) |
| `research.test.ts` | no (empirically safe today) |
| `level-reload.test.ts` | **YES** |
| `stuck.test.ts` | **YES** |

**Root cause**, confirmed by reading `packages/core/src/enforce/pipeline.ts`
and `overrides.ts`:

```ts
// pipeline.ts
this.overrideStore = config.overrideStore || new FileRuleOverrideStore()
```
```ts
// overrides.ts, FileRuleOverrideStore constructor
this.directory = process.env.KEEL_OVERRIDES_DIR || join(home, '.keel')
```
`consume()` is called unconditionally on every deny/warn/redirect verdict
(`pipeline.ts:473,1262,1287`) and — even when no matching override is
armed — **still performs a full read + write of `overrides.json`** (see
`consume()`'s `if (!override) { ...; this.write(overrides); return false }`
branch). That explains the mtime-touch-with-preserved-content behavior seen
in every real-`~/.keel` snapshot above: none of these 8 files ever calls
`keel allow`, so they never *arm* anything — but they all still *touch*
the real store whenever `HOME`/`KEEL_HOME`/`KEEL_OVERRIDES_DIR` aren't
pinned to a tmp dir by the specific describe block.

**The dangerous case isn't the content-preserving touch — it's a rule-ID
collision.** If a real armed override happens to share a rule ID with one
of these tests' synthetic rules, `consume()` silently **deletes** it
(proven empirically below, in the mutation test).

## STEP 2 — the fix

Applied the exact pattern already established in `match-surface.test.ts`
(which documents the same root cause in its own header comment) to all 8
files: an in-memory `overrideStore` stub passed explicitly into every
`EnforcementPipeline` construction, so it never falls through to the
`FileRuleOverrideStore` default:

```ts
const noopOverrideStore = { consume: () => false, peek: () => null, list: () => ({}) }
```

Files changed (all under `packages/core/src/enforce/__tests__/` — the
canonical source; `packages/cli/src/core/**` is a build-time copy of this
directory and was regenerated by `npm run build`, never hand-edited, per
the lane's hard constraint):

- `glob-matching.test.ts` — 1 construction site
- `verification.test.ts` — 2 construction sites
- `oracle.test.ts` — 2 construction sites
- `level-reload.test.ts` — 3 construction sites (2 of the 3 already
  redirected `process.env.HOME` to a per-block tmp dir in `beforeAll` and
  were already safe; the third — `dialPipeline()` in the "minimum-dial
  filter" describe block — had no isolation at all and was the actual
  leak in this file. Stub added to all 3 for defense in depth.)
- `stuck.test.ts` — 1 construction site
- `audit.test.ts`, `ledger.test.ts`, `research.test.ts` — 1 site each,
  hardened even though empirically clean today (per the task's explicit
  "harden regardless" instruction) because they're one future rule-action
  change away from joining the leak, with nothing currently stopping it.

No hand-edits to `packages/cli/src/core/**` or `templates/keel-enforce.js`
— confirmed by `npm run build` regenerating the CLI's copy from the fixed
`packages/core/src` and the full suite passing afterward.

## The guard

`packages/core/vitest.config.ts` (new file) wires a `globalSetup` module:

`packages/core/src/enforce/__tests__/helpers/override-isolation-guard.ts`
(new file) snapshots real `~/.keel/overrides.json` (resolved the same way
`resolveHome()` does: `KEEL_HOME` > `HOME` > `homedir()`) once, before any
test file runs, and checks it again once, after the entire suite finishes.
It fails the run unless either:
- the file's content is byte-identical before and after, **or**
- the file was empty (absent or `{}`) **both** before and after.

That second clause is deliberately narrower than "still `{}` after" alone:
if the file had a genuine armed override *before* the suite ran (a real
`keel allow` a developer or agent ran by hand), the guard fails on ANY
change to it — including one that happens to leave it looking empty
afterward (i.e., a collision that silently deleted it), which the naive
"just check it's still `{}`" version would have let through as `PASS`.
This is also why the check is an in-memory content comparison, not an
mtime comparison: `consume()`'s content-preserving `{}` → `{}` rewrite still
bumps mtime on every deny/warn/redirect verdict in *any* correctly-isolated
test too (it happens against whatever `HOME` is live at construction time,
tmp dir or real), so an mtime-only guard would be permanently red or
flaky under this repo's concurrent-worktree development pattern.

Implemented as `globalSetup`/teardown (runs once, in vitest's main
process, wrapping the entire package run) rather than a per-file
`beforeAll`/`afterAll`, because file execution order isn't guaranteed —
a per-file check could pass by luck if it happened to run before an
offending file elsewhere in the suite.

### Guard verified both ways (known-bad and known-good)

1. **Known-good (current state):** full `packages/core` suite — 34 files,
   603 passed / 2 skipped, guard silent, `exit=0`.

2. **Known-bad (mutation test — reintroduced the leak):** temporarily
   removed the `overrideStore` stub from `stuck.test.ts`, seeded an
   *isolated* scratch `HOME`'s `overrides.json` with a real-looking armed
   override colliding with the test's synthetic rule ID (`no-test-loops`,
   future `expires_at`), ran just that file:
   ```
   before = {"no-test-loops": {"expires_at": 1786580222000}}
   after  = {}
   ```
   The unisolated pipeline's `consume('no-test-loops', ...)` matched the
   pre-armed override and deleted it as a side effect of an unrelated
   assertion — exactly the dangerous collision scenario. Result:
   ```
   Test Files  1 failed (1)   (unrelated assertion also broke: expected 'deny', got 'allow' — the fake override let the action through)
   error during close Error: override-isolation guard: real .../overrides.json
   changed during this test run and is no longer empty (before=..., after="{}").
   Some EnforcementPipeline construction in this suite is missing an explicit
   overrideStore stub (or HOME isolation) and defaulted to the real
   FileRuleOverrideStore — see match-surface.test.ts's noopOverrideStore for the fix.
   exit code 1
   ```
   Restored the fix, re-ran with the same pre-armed override present:
   `Test Files 1 passed (10 tests)`, guard silent, and the override file
   was untouched (`{"no-test-loops": {"expires_at": 1786580249000}}`,
   byte-identical modulo the timestamp I set).

This confirms the guard both stays silent on the fixed, correctly-isolated
suite and reliably fails the run when the exact class of regression this
lane exists to close is reintroduced.

## Full-suite verification (with output shown, never piped through grep/head/tail)

Baseline (before any change), from this worktree, full `npm test`:
```
core:              Test Files  34 passed (34)   Tests  603 passed | 2 skipped (605)
cli:               Test Files  47 passed (47)   Tests  833 passed | 14 skipped (847)
mcp-server:        Test Files  1 passed (1)     Tests  6 passed (6)
opencode-plugin:   All checks passed (63 PASS lines)
```

Final (after the fix, after `npm run build` regenerated `packages/cli/src/core`),
full `npm test`:
```
core:              Test Files  34 passed (34)   Tests  603 passed | 2 skipped (605)
cli:               Test Files  47 passed (47)   Tests  833 passed | 14 skipped (847)
mcp-server:        Test Files  1 passed (1)     Tests  6 passed (6)
opencode-plugin:   All checks passed (63 PASS lines)
```
Identical pass/skip counts — the fix and the new guard are purely additive
to test isolation; no behavior change, no regression.

## Answering the task's three questions directly

1. **Did the current suite actually leak?** Yes — but not via the two
   files AUDIT named (both already clean/inapplicable today). The real,
   still-open leak was 8 `packages/core` test files defaulting
   `EnforcementPipeline`'s `overrideStore` to the real filesystem. Content
   stayed `{}` in every observed real-`~/.keel` snapshot because none of
   these tests happen to arm or collide with anything today, but the
   mutation test proves the collision case is real and destructive, not
   hypothetical.

2. **Which tests were isolated, and how?** All 8 files listed under
   "STEP 2 — the fix" above, via an explicit in-memory `overrideStore`
   stub (`{ consume: () => false, peek: () => null, list: () => ({}) }`)
   passed into every `EnforcementPipeline({...})` construction — the same
   pattern `match-surface.test.ts` already used for this exact problem.
   (`hook-command.test.ts` needed no change — it never touches
   `EnforcementPipeline`. `fixture-harness.test.ts` needed no change — it
   already had the stub.)

3. **The committed guard proving real `~/.keel` stays untouched:**
   `packages/core/vitest.config.ts` + `packages/core/src/enforce/__tests__/
   helpers/override-isolation-guard.ts` (new `globalSetup`/teardown pair),
   verified to fire on a real reintroduction of the leak and stay silent
   on the fixed suite (see mutation test above).
