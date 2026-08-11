# Wave-1 Lane-1 — match-surface repair

Worktree: `/Users/nanoclaw/code/keel-w1-matchfix`, branch `w1-matchfix`.
Node: `v26.0.0` (>= 22.12 required). `npm ci` completed clean (1 pre-existing
high-severity advisory, unrelated to this lane, not touched).

## 1. Sweep of the file (what actually needed fixing)

Read `packages/core/src/types.ts` (EnforceInput/KeelRule shapes) and all 885
lines of `packages/core/src/enforce/pipeline.ts`, plus `arg-utils.ts`,
`sequencer.ts`, `verification.ts`, and `policy-engine.ts` for the same
`JSON.stringify(args)`-as-haystack pattern.

**Finding that changes the task's premise:** the task brief describes the bug
as "command-rule matching builds its haystack as
`${input.tool} ${JSON.stringify(input.args)}`" and cites pipeline.ts lines
~260 and ~440. Empirically, `type: command` rule matching (the literal
"command-rule" case, pipeline.ts ~326-364) was **already repaired** — it goes
through `commandString()` (`arg-utils.ts`), which extracts `args.command` /
`args.cmd` as a string or joined array before falling back to
`JSON.stringify(stripContentArgs(args))`. Probed directly (see §2) before
touching anything: plain command, quoted command, and array command all
already matched correctly for `type: command`. The literal two-cited lines
(260, 440) are **not** `type: command` — they are `type: rate` and
`type: diagnosis`, both of which read `rule.match` but never route through
`commandString`. Those two are where the real, currently-live bug is.

One more shape was genuinely broken even for `type: command`:
**one-level-nested args** (`{ args: { command: '...' } }`, i.e. the same
wrapper shape MCP calls use, but on a plain tool name). `commandString` only
unwrapped that nesting when `input.tool` contained `mcp__`; a non-MCP tool
with the same shape fell through to the JSON fallback and lost anchored
matches. Fixed in `arg-utils.ts`.

**Diagnosis rules are not command rules.** `type: diagnosis` intentionally
matches the **content** of a write (e.g. `content: 'refactor'` inside a
`WriteFile` call) to decide whether a complex change needs a stated root
cause first — not a shell command. `commandString` strips content-bearing
keys (`content`, `text`, `patchText`, ...) specifically so *command* rules
don't false-positive on file bodies that merely mention a command name.
Swapping the diagnosis haystack to `commandString` would silently blind the
diagnosis gate to the exact thing it watches for. Confirmed empirically:
`ledger.test.ts` (existing, untouched) has two tests that depend on
`content: 'refactor'` reaching the diagnosis match — verified they still
pass after the fix (§4). So the diagnosis fix is **additive**: try the
command-string surface too, but keep the JSON surface primary so neither
match can be lost.

**`sequencer.ts` (`step.pattern` vs `JSON.stringify(args)`) and
`verification.ts` (`matcher.pattern` vs `JSON.stringify(args)`)** have the
same JSON-haystack shape but are separate matching surfaces (sequence/
verification, not command matching), out of this lane's scope per the task
brief ("only change core pipeline surfaces this lane" / "filesystem/content
etc. have their own surfaces"). Reported here, not touched.

**`packages/core/src/policy-engine.ts`** (the legacy `ToolCallEvent`-based
engine) was also swept: its `command_rules` matching already uses
`String(event.args.command || '')` directly (lines 115, 168, 242, 354) — no
JSON-haystack bug there. Nothing to fix in policy-engine.ts.

## 2. Probe confirming the diagnosis, before writing the real tests

Ad hoc probe (`probe.test.ts`, deleted before commit — not part of the
shipped test suite) against the **unmodified** code:

```
rm -rf / result   {"action":"warn", "rule_id":"no-destructive-commands", ...}      # type:command, plain — matched
quoted result     {"action":"deny", "rule_id":"no-destructive-commands", ...}      # type:command, quoted — matched
array result      {"action":"deny", "rule_id":"no-destructive-commands", ...}      # type:command, array — matched
benign result     {"action":"allow","rule_id":null, ...}                          # type:command, benign — correctly allowed
nested result     {"action":"allow","rule_id":null, ...}                          # type:command, ONE-LEVEL NESTED — BUG
rate result 1     {"action":"allow","rule_id":null, ...}
rate result 2     {"action":"allow","rule_id":null, ...}                          # type:rate, quoted+anchored — BUG (never matches, ever)
```

This is what sent the fix to `arg-utils.ts` (nested unwrap) and
`pipeline.ts` (rate + diagnosis fallback), instead of touching the
already-correct `type: command` code path.

## 3. Regression tests — BEFORE (failing) output

File: `packages/core/src/enforce/__tests__/match-surface.test.ts` (11 tests).
Captured by `git stash`-ing `arg-utils.ts` + `pipeline.ts` back to the
pre-fix committed state and running only this file:

```
 RUN  v4.1.10 /Users/nanoclaw/code/keel-w1-matchfix/packages/core

 ✓ command match surface (type: command) > matches args = {"command": "rm -rf /"} (characterization — already correct) 10ms
 ✓ command match surface (type: command) > matches a command containing double quotes despite JSON-escaping risk (characterization) 1ms
 ✓ command match surface (type: command) > matches args.command as an array (characterization) 1ms
 × command match surface (type: command) > matches a one-level-nested args.args.command shape (was red before the fix) 3ms
   → expected 'allow' not to be 'allow' // Object.is equality
 ✓ command match surface (type: command) > does not match a benign command (must-allow) 1ms
 × rate rule match surface (type: rate) > matches a quoted command against an end-anchored pattern (was red before the fix) 1ms
   → expected 'allow' not to be 'allow' // Object.is equality
 ✓ rate rule match surface (type: rate) > still matches against the bare tool name (regression guard) 1ms
 ✓ rate rule match surface (type: rate) > does not engage the rate window for a non-matching command (must-allow) 1ms
 ✓ diagnosis rule match surface (type: diagnosis) > still matches file CONTENT, not a command (regression guard — must not regress) 21ms
 × diagnosis rule match surface (type: diagnosis) > also matches a quoted command via the additive command surface 19ms
   → expected 'allow' to be 'redirect' // Object.is equality
 ✓ diagnosis rule match surface (type: diagnosis) > does not match unrelated content or commands (must-allow) 19ms

 Test Files  1 failed (1)
      Tests  3 failed | 8 passed (11)
   Start at  02:33:37
   Duration  335ms
```

Exactly the 3 scenarios identified as genuinely broken fail (nested command,
rate anchored/quoted, diagnosis anchored/quoted-via-command-surface). Every
must-allow test and every regression-guard test (tool-name rate match,
diagnosis content match, diagnosis non-match) already passes against the
unmodified code — confirming those are correctly-scoped characterization/
regression tests, not manufactured red.

## 4. Fix applied

`packages/core/src/enforce/arg-utils.ts` — `commandString()`: after the
existing direct `args.command`/`args.cmd` extraction, unwrap one level of
nesting (`args.args.command` / `args.args.cmd`) for **any** tool, not only
`mcp__`-named ones, before falling back to
`JSON.stringify(stripContentArgs(args))`.

`packages/core/src/enforce/pipeline.ts`:
- `type: rate` match (~line 260): try `${tool} ${commandString(input)}`
  first, fall back to the old `${tool} ${JSON.stringify(input.args)}`
  surface (kept so a rate rule targeting a non-command arg value, or the
  bare tool name, keeps matching — verified by the tool-name regression
  test).
- `type: diagnosis` match (~line 440-455): try the existing raw-args JSON
  haystack **first** (primary — this is what content-matching depends on),
  fall back to `${tool} ${commandString(input)}` (reusing the `cmdStr`
  already computed above for the `fallback_pattern` check). Purely additive:
  neither surface can cause a previously-matching case to stop matching.

`type: command` matching itself was not touched — it was already correct
except for the nested-args shape, which is fixed at its actual source
(`commandString`) rather than duplicated per-callsite in pipeline.ts.

## 5. Regression tests — AFTER (passing) output

```
 RUN  v4.1.10 /Users/nanoclaw/code/keel-w1-matchfix/packages/core

 ✓ command match surface (type: command) > matches args = {"command": "rm -rf /"} (characterization — already correct) 10ms
 ✓ command match surface (type: command) > matches a command containing double quotes despite JSON-escaping risk (characterization) 1ms
 ✓ command match surface (type: command) > matches args.command as an array (characterization) 1ms
 ✓ command match surface (type: command) > matches a one-level-nested args.args.command shape (was red before the fix) 1ms
 ✓ command match surface (type: command) > does not match a benign command (must-allow) 0ms
 ✓ rate rule match surface (type: rate) > matches a quoted command against an end-anchored pattern (was red before the fix) 1ms
 ✓ rate rule match surface (type: rate) > still matches against the bare tool name (regression guard) 1ms
 ✓ rate rule match surface (type: rate) > does not engage the rate window for a non-matching command (must-allow) 0ms
 ✓ diagnosis rule match surface (type: diagnosis) > still matches file CONTENT, not a command (regression guard — must not regress) 19ms
 ✓ diagnosis rule match surface (type: diagnosis) > also matches a quoted command via the additive command surface 16ms
 ✓ diagnosis rule match surface (type: diagnosis) > does not match unrelated content or commands (must-allow) 17ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  02:33:43
   Duration  322ms
```

All 11 pass, including the 3 that were red in §3.

## 6. Full suite — core (fixed state)

```
 RUN  v4.1.10 /Users/nanoclaw/code/keel-w1-matchfix/packages/core

 Test Files  14 passed (14)
      Tests  245 passed (245)
   Start at  02:34:56
   Duration  649ms
```

## 7. Build

`npm run build` (workspace-root) succeeded: `@get-keel/core`,
`@get-keel/cli` (regenerates `src/core/` from `../core/src` and runs `tsc`),
`@get-keel/mcp-server`, `@get-keel/opencode-plugin` (regenerates
`packages/cli/templates/keel-enforce.js`). No edits were made to
`packages/cli/src/core/` or `packages/cli/templates/keel-enforce.js` by
hand — both are the build's own output from the edited `packages/core/src`
sources.

## 8. Full suite — cli (fixed state, post-build)

```
 Test Files  1 failed | 42 passed (43)
      Tests  4 failed | 559 passed (563)
   Start at  02:35:04
   Duration  11.68s
```

The 4 failures are all in `src/__tests__/level.test.ts` (`keel level` /
`keel status` output-formatting assertions comparing stdout against plain
text like `project level: balanced → protect`, which the actual output wraps
in ANSI color/inverse escape codes — e.g. received
`[7m[37m[27mbalanced[7m[31m[32m →
[37mprotect...`). **Confirmed pre-existing and unrelated to this
lane**: re-ran `packages/cli/src/__tests__/level.test.ts` alone with
`arg-utils.ts`/`pipeline.ts` `git stash`-reverted to the pre-fix committed
state (same rebuild) — identical 4 failures, identical assertion text,
before any change in this lane existed. Not touched; out of scope for
match-surface repair. `drift.test.ts` and `convergence.test.ts` (flagged as
likely to need the rebuild, since they compare generated rule catalogs
against source and reference `no-destructive-commands`) were run explicitly
and pass: 10/10.

```
 ✓ drift.test.ts > rules drift: install.ts vs plugin.ts > enforces the same rule ids
 ✓ drift.test.ts > rules drift: install.ts vs plugin.ts > matches the same patterns and actions per rule
 ✓ drift.test.ts > rules drift: install.ts vs plugin.ts > has no unanchored rm -rf / false-positive (BUG 1)
 ✓ drift.test.ts > rules drift: install.ts vs plugin.ts > gates plain git rebase / reset / push -d / gh release delete (GAP 3)
 ✓ drift.test.ts > rules drift: install.ts vs plugin.ts > built template is regenerated with the same rules
 ✓ convergence.test.ts > one engine, not two > the CLI exposes the same engine contract as core
 ✓ convergence.test.ts > one engine, not two > the CLI shim contains no implementation
 ✓ convergence.test.ts > one engine, not two > signing and receipts are also single-sourced
 ✓ convergence.test.ts > one engine, not two > core ships the fixes that previously existed only in the CLI copy
 ✓ convergence.test.ts > policy-absence semantics are the same at every entry point > the gateway applies defaults when no policy file exists, like the CLI

 Test Files  2 passed (2)
      Tests  10 passed (10)
```

## 9. Real ~/.keel isolation (binding constraint check)

While verifying nothing touched the real `~/.keel`, found that
`EnforcementPipeline` defaults `overrideStore` to `new FileRuleOverrideStore()`
(rooted at real `homedir()`) whenever a test doesn't pass one explicitly, and
`violation()` calls `overrideStore.consume(rule.id)` on every deny/block
verdict — which does `mkdirSync(real ~/.keel, {recursive:true})` plus a lock
file, even when no override is ever armed. This is a **pre-existing** gap in
the repo: only 3 of the existing tests in `pipeline.test.ts` pass an explicit
`overrideStore`; the rest (e.g. "warns on first violation, denies on second",
"escalates after repeated denials") already reach the real-`~/.keel` code
path today, unrelated to this lane. Confirmed via `~/.keel/traces/*.jsonl`
containing entries from those exact pre-existing test fixtures
(`protected-command`, `no-fix-command`, `src/a.ts`) with timestamps matching
full-suite runs.

Out of scope to fix repo-wide (touches shared test infrastructure other
lanes may depend on), but this lane's own binding constraint ("tests must
never touch the real ~/.keel") applies to `match-surface.test.ts`. Added a
`noopOverrideStore` stub (`consume: () => false`) passed into every
`makePipeline()` call in that file. Verified with `stat` before/after
running `match-surface.test.ts` alone: `~/.keel/overrides.json` and
`~/.keel/state/*.json` mtimes are unchanged by this suite's run. The
pre-existing suite's writes (from `pipeline.test.ts`/`ledger.test.ts`/CLI
`install.test.ts` etc.) are not this lane's to fix and were not touched.

A separate, related finding from a parallel lane: `StateManager`'s
`STATE_DIR` constant (`packages/core/src/enforce/state-manager.ts`) does not
honor `KEEL_STATE_DIR` (unlike `ProblemLedger`, which does). Checked whether
this affects this lane's tests: `match-surface.test.ts` never constructs a
`StateManager` (no `stateManager` passed into `PipelineConfig`), and the
diagnosis tests isolate `ProblemLedger` via `process.env.HOME` pointed at a
`mktemp -d` directory (same convention as the pre-existing `ledger.test.ts`),
which correctly stays off the real `~/.keel` since `ProblemLedger` does
honor `HOME`. Per the coordinating message's own stated condition ("if your
tests don't touch pipeline state at all, you may skip this"), the
`state-manager.ts` edit was intentionally NOT applied here — it is out of
this lane's assigned scope (match-surface repair) and editing a shared
source file outside that scope risks colliding with whichever lane owns it.
Flagging for the orchestrator to route.

## 10. Existing tests updated

None. No existing test encoded the buggy JSON surface as its assertion —
all pre-existing tests (`pipeline.test.ts`, `ledger.test.ts`, `drift.test.ts`,
`convergence.test.ts`, and the rest of the 245/245 core + 559/563 cli suite)
pass unmodified against the fixed code.

## Summary

- Files changed: `packages/core/src/enforce/arg-utils.ts`,
  `packages/core/src/enforce/pipeline.ts`.
- New test file: `packages/core/src/enforce/__tests__/match-surface.test.ts`
  (11 tests: 3 genuinely-red-before-fix, 8 characterization/regression
  guards that were already correct and stay correct).
- `type: command` matching: unchanged except the nested-args fix (now
  correct for plain string, quoted, array, and one-level-nested shapes).
- `type: rate` matching: now tries the real command string before falling
  back to the raw-args JSON surface.
- `type: diagnosis` matching: now tries the raw-args JSON surface (primary,
  content-preserving) then the command-string surface (additive) — content
  matching is unchanged, command matching gained.
- `type: filesystem`/`content`/`network`/`env`/`stuck`/`time`/`research`
  matching: untouched, out of scope.
- `sequencer.ts` `step.pattern` and `verification.ts` `matcher.pattern` have
  the same JSON-haystack shape but are separate surfaces — reported, not
  fixed (out of this lane's scope per task brief).
- `policy-engine.ts` (legacy engine): swept, no JSON-haystack bug found —
  it already matches against the raw command string.
- Untested / out of scope: `sequencer.ts` and `verification.ts` pattern
  matching (flagged above); the 4 pre-existing `level.test.ts` ANSI-output
  failures (confirmed unrelated, present before this lane's change).
