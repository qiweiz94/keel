# Wave-2 Lane 5 — sequence + budget rules

Branch: `w2-seq`. Worktree: `/Users/nanoclaw/code/keel-w2-seq`.

## Summary

| Task | Outcome |
|---|---|
| 1. `test-before-commit` observe rule | Pure YAML — `session/proposals/test-before-commit.yaml`. No pipeline/verification.ts changes needed; `mode: observe` is already handled generically at the verification-boundary call site. |
| 2. `runaway-budget` observe rule | Pure YAML — `session/proposals/runaway-budget.yaml`, 2 rules (total tool calls, total Bash calls). `type: rate` already expresses a genuine cumulative long-window budget; no core change needed for those two. "Elapsed active time" was investigated and **honestly skipped** (see below) — not the same shape as a call-count budget, and the state primitives to do it safely don't exist yet. |
| 3. Sequencer match-surface fix | `packages/core/src/enforce/sequencer.ts` — additive fix, same class as the Wave-1 rate/diagnosis fix in `pipeline.ts`. |
| Core extension needed anywhere else? | One 2-line additive change: `category: 'verification'` added to `RuleCategory` (`types.ts`) and `validCategories` (`rule-parser.ts`) — required by task 1's mandated metadata, safe because nothing in the codebase exhaustively switches over `RuleCategory` (verified by grep). |
| `verification.ts` | **NOT TOUCHED.** Confirmed unnecessary for task 1 (see below). It has the same raw-JSON-haystack class bug at `boundary()` line 126/130 (`JSON.stringify(stripContentArgs(input.args))` against `boundary.pattern`) — flagged loudly for whichever lane owns that file this wave; not fixed here per the assignment boundary. |

## Task 1 — `test-before-commit`

`packages/core/src/enforce/pipeline.ts`'s `violation()` (called from both the
`type: verification` boundary check at line ~205-213 and the `type: rate`
check at line ~287) already special-cases `rule.mode === 'observe'`
generically: it computes `enforcedAction(rule, input)` (the action the rule
WOULD take), returns `action: 'allow'` with `observed_action: <would>`, and
never reaches the code path that actually blocks/warns. This is rule-type
agnostic — setting `mode: observe` on the existing `verification` rule shape
(same trigger/satisfy/boundaries shape as the shipped
`source-change-requires-test`) was sufficient. No extension to
`verification.ts` was needed to express "observe at the commit boundary."

Design decisions, documented in the proposal file itself:
- Trigger: `write|edit|apply_patch|WriteFile` with `path: "src/"` (same
  trigger surface as `source-change-requires-test`, narrowed — no
  `package.json` co-trigger, since the task described the src/-edit shape
  specifically).
- Satisfy: same test-command pattern as the shipped rule.
- Boundaries: **commit only** (the shipped rule also gates `push`; this
  proposal is deliberately narrower, matching "would-be action warn at the
  commit boundary" in the task).
- `boundary.commit.action: warn` + top-level `action: warn` — the "would-be
  action" is warn, not deny, per the task and per the false-success/
  do-not-ship rationale in the rule's own `rationale` field.
- Full catalog metadata: `category: verification`, `severity: medium`,
  `confidence: medium`, `rationale`, `false_positives: [WIP commits,
  docs-only commits, fixture/data-only changes]`.

## Task 2 — `runaway-budget`

`StateManager.checkRateLimit` (and the pipeline's in-memory fallback,
pipeline.ts:275-282) is a fixed-window counter whose anchor (`windowStart`)
only resets when a gap LARGER than `window_seconds` occurs. For a
continuously-active session (calls seconds/minutes apart, nothing like a
4-hour idle gap), this behaves as a genuine cumulative budget across the
whole window — "N calls in a W-second budget" — not a sliding per-minute
rate. Confirmed empirically in
`packages/core/src/enforce/__tests__/proposal-runaway-budget.test.ts`
(499-call must-not-fire, 501-call must-fire, both at
`window_seconds: 14400`). **No core change needed.**

Two rules shipped, both pure YAML, both `mode: observe`,
`category: workflow`, `severity: low`, `confidence: high`:
- `runaway-budget-tool-calls`: `match: ".*"`, `window_seconds: 14400`,
  `max_calls: 500`. **`match: ".*"` is load-bearing, not decorative** — when
  `rule.match` is absent, pipeline.ts's rate handler falls back to
  `matchPattern = input.tool`, which keys the counter PER TOOL NAME and
  silently shards a "total calls" budget into N per-tool counters. This is
  documented inline in the proposal file so a future editor doesn't "clean
  up" the apparently-redundant `.*`.
- `runaway-budget-bash-calls`: `match: "Bash"` (same pattern the shipped
  `bash-rate-limit` rule uses), same window/threshold, scoped to Bash calls
  specifically (a Bash-only runaway loop can stay under the total-call
  ceiling).

### Elapsed active time — investigated and skipped (not built)

This is genuinely a different shape from a call-count budget: a sparse
session (e.g. one call every 30 minutes for 5 hours — far under
`max_calls: 500`) would never trip either rate rule above, yet has been
"active" longer than any reasonable budget. `type: rate`'s count-threshold
model cannot express "N seconds have elapsed since the first call,
regardless of how many calls happened" without a genuinely different
evaluation branch.

I drafted a "cumulative elapsed" extension (a new anchor timestamp, fired
when `now - anchor >= window_seconds` regardless of call count) and rejected
it before writing any code: `EnforceInput` carries no session-start
timestamp, and the natural key for such an anchor
(`${ruleId}:${matchPattern}`, mirroring the existing rate-key convention)
has **no `session_id`** and a 24h TTL. A brand-new session's FIRST call
would inherit an anchor left over from an unrelated PRIOR session that used
the same key, and the rule would report "session active for 4 hours" on a
session that had just started. That is a control that lies — worse than
shipping nothing — so I did not build it.

Doing this honestly needs a session-scoped primitive (an anchor keyed by
`session_id`, or a `session_started_at` field threaded onto `EnforceInput`)
that does not exist today. Notably, `type: session` /
`max_duration_minutes` is already declared in the type system for exactly
this shape but is deliberately in rule-parser.ts's `notImplemented` set
(`mcp, inheritance, meta, session, context` — validateRules rejects it
outright) and stubbed as a no-op in pipeline.ts:566-569
(`// Handled by context manager` — it isn't; `context-manager.ts` only
tracks token thresholds). Reviving that boundary is a real feature, not a
minimal extension, and wasn't this lane's mandate. Flagged as a follow-up
in the proposal file's header for the supervisor / a later wave.

Token budgets were excluded for the same class of honesty reason and were
explicitly out of scope per the task: `context_tokens` on `EnforceInput`
measures re-injection thresholds, not a consumption ceiling, and no other
token-count surface reaches the enforcement hook.

## Task 3 — sequencer.ts match-surface fix

`packages/core/src/enforce/sequencer.ts`'s `SequenceDetector.matchesTool`
built its `step.pattern` haystack as `JSON.stringify(args)` only — the exact
class Wave-1 Lane 1 fixed in `pipeline.ts` for `type: rate` and
`type: diagnosis` (see `__tests__/match-surface.test.ts`'s existing "rate
rule match surface" / "diagnosis rule match surface" suites, and
DECISIONS.md's note assigning this file to Wave-2 Lane 5). A JSON-escaped
haystack breaks quoted commands (`"` → `\"`) and end-of-string anchors
(`( |$)` can never match because the JSON string always continues with
`"}` after the value).

Fix (additive, mirrors the pipeline.ts fix's shape exactly): `matchesTool`
now takes the full `EnforceInput` (via `ActionRecord.input`, which was
already stored but unused for this purpose) instead of separate
`tool`/`args`, and tries `commandString(input)` (arg-utils.ts) first,
falling back to `JSON.stringify(args)` only if the command-string surface
doesn't match:

```ts
if (!regex.test(commandString(input)) && !regex.test(JSON.stringify(args))) return false
```

Nothing that matched before stops matching — the JSON surface is still
tried, just second. Tool-name matching (`step.tool`) and path matching
(`step.path`) were untouched; only `step.pattern` used the broken haystack.

Regression tests added to `packages/core/src/enforce/__tests__/
match-surface.test.ts` (the file Wave-1 already established for this bug
class), a new `describe('sequence rule match surface (type: sequence)')`
block, 3 cases:
1. Anchored/quoted command pattern across two sequence steps — **was red
   before the fix** (verified: reverting the sequencer.ts change reproduces
   `allow` forever instead of a violation).
2. Non-command arg value (a `WebFetch`-shaped URL) still matches via the
   JSON fallback — regression guard, proves the fix is additive.
3. Benign second step does not complete the sequence — must-allow.

## Verification.ts overlap — status for the supervisor

**Not touched.** Task 1 (`test-before-commit`) did not require any change to
`verification.ts` — `mode: observe` was already generic in `pipeline.ts`'s
`violation()`. `verification.ts`'s `boundary()` method (line 126) has the
same raw-`JSON.stringify` haystack class as the sequencer bug I fixed
(`const args = JSON.stringify(stripContentArgs(input.args || {}))` matched
against `boundary.pattern` at line 130), but fixing it was out of this
lane's mandate (another lane owns that file this wave per the task). This is
a **real, confirmed gap** — flagging it loudly: whichever lane owns
`verification.ts` this wave should apply the same
`commandString(input)`-first / `JSON.stringify`-fallback pattern to
`boundary()`'s pattern match, mirroring `sequencer.ts`'s fix and
`pipeline.ts`'s existing rate/diagnosis fix. No merge-order conflict is
expected — my changes don't touch `verification.ts` at all — but the
supervisor should sequence that lane's `verification.ts` fix so it lands
cleanly regardless of merge order relative to this branch.

## Fixtures (task 4) — all run through the real pipeline

`packages/core/src/enforce/__tests__/proposal-test-before-commit.test.ts`
(5 cases, loads the actual `session/proposals/test-before-commit.yaml` off
disk, no fixture duplicated in the test):
- MUST-FIRE: src/ edit → `git commit`, no test run → `action: 'allow'`,
  `observed_action: 'warn'`, message `[observe] would warn: ...`.
- MUST-FIRE: test run BEFORE the edit does not count → `npm test` → src/
  edit → `git commit` → fires exactly as above (proves the earlier test
  doesn't discharge an obligation that didn't exist yet).
- MUST-NOT-FIRE: src/ edit → passing `npm test` → `git commit` →
  `observed_action` undefined, `rule_id !== 'test-before-commit'`.
- MUST-NOT-FIRE: docs-only edit (`path: 'docs/guide.md'`, body deliberately
  contains the string `src/` to prove the `path: "src/"` trigger gate is
  what's doing the work, not an accidental non-match) → `git commit` →
  never armed.
- MUST-NOT-FIRE: bare `git commit --allow-empty` with no prior edit at all.

`packages/core/src/enforce/__tests__/proposal-runaway-budget.test.ts` (6
cases, loads `session/proposals/runaway-budget.yaml` off disk):
- `runaway-budget-tool-calls`: 499 calls must-not-fire; 501 calls must-fire
  (`observed_action: 'warn'`); 501 calls split across 4 different tool
  names still fire on one shared counter (proves `match: ".*"` is doing its
  job, not `matchPattern = input.tool` sharding).
- `runaway-budget-bash-calls`: 499 Bash calls must-not-fire; 501 Bash calls
  must-fire; 600 non-Bash calls never engage the Bash-specific budget at
  all.

`packages/core/src/enforce/__tests__/proposal-validation.test.ts` (3 cases):
runs BOTH proposal YAML files (as written on disk, not copy-pasted into the
test) through `validateRules()` — the same validator the CLI runs on every
shipped rule — and asserts zero errors, plus asserts every rule in both
files declares `mode: observe`. This is what caught the `category:
verification` gap before it reached the gate's mechanical paste (initial
draft used `category: verification` when only `destructive, exfil,
escalation, injection, resource, bypass, discipline, workflow` were valid;
fixed by extending `RuleCategory`/`validCategories`, not by picking a
different category, since `verification` is the correct semantic label and
nothing exhaustively switches over the enum).

`match-surface.test.ts`'s new `sequence rule match surface` block (3 cases,
listed above under Task 3).

### A path-resolution bug the fixtures caught in themselves

The three `proposal-*.test.ts` files initially resolved `session/proposals`
via a fixed `join(HERE, '..','..','..','..','..')`. That's correct from
`packages/core/src/enforce/__tests__/` but wrong from
`packages/cli/src/core/enforce/__tests__/` — `packages/cli`'s build step
copies the ENTIRE `packages/core/src` tree (including `__tests__`) into
`packages/cli/src/core` (see `packages/cli/package.json`'s build script), so
every file in `enforce/__tests__/` runs TWICE, at two different depths from
the repo root, whenever `npm run test --workspaces` runs (this is
pre-existing, shared-file behavior — not something this lane introduced).
`npm run test --workspace=@get-keel/core` alone didn't catch it; only the
full-workspace run did (`ENOENT ... packages/session/proposals/...`).
Fixed with a shared helper, `packages/core/src/enforce/__tests__/
repo-root.ts`, that walks upward from the test file's own directory looking
for a `session/proposals` marker instead of assuming a fixed depth. This is
a general lesson for this codebase, not just this lane: any new test file
under `packages/core/src/enforce/__tests__/` that reads a path relative to
the repo root needs `findRepoRoot`, not a hardcoded `..` count, or it will
pass under `npm run test --workspace=@get-keel/core` and fail under
`npm run test --workspaces`.

## Full verification run (unfiltered vitest, per the binding constraint)

Build first (binding constraint — never hand-edit `packages/cli/src/core/`
or `templates/keel-enforce.js`; both are regenerated by `npm run build`):

```
npm run build   # all 4 workspaces build clean
```

`git status` after build shows only the expected generated-file diff
(`packages/cli/templates/keel-enforce.js`, rebuilt from the opencode-plugin
bundle) plus my source edits — `packages/cli/src/core/` is gitignored
(confirmed via `git check-ignore`), so the regenerated copy never appears in
`git status`.

- `npm run test --workspace=@get-keel/core` (standalone): **18 test files,
  266 tests, 266 passed.**
- `npm run test --workspaces` (full, unfiltered, the actual gate check):
  - `@get-keel/core`: 18/18 files, 266/266 tests passed (part of the
    combined run).
  - `@get-keel/cli`: **47/48 files passed, 633/637 tests passed.** The 1
    failing file is `src/__tests__/level.test.ts`, 4 failing assertions —
    **confirmed pre-existing, not caused by this lane**: reproduced with
    `git stash` (this lane's changes fully removed) and re-run against the
    unmodified `b45aebf` tree — identical 4 failures, identical messages
    (ANSI/chalk escape codes breaking `toMatch(/Speed dial:\s*balanced/i)`
    and `toContain('global level: balanced → sprint')` assertions that
    don't account for color codes interleaved in the CLI's colored output).
    This matches DECISIONS.md's existing note that Lanes 1 and 3 both hit
    and independently confirmed the same 4 pre-existing failures. Not
    fixed here — out of this lane's scope, and fixing chalk-output
    assertions in an unrelated CLI test file risks exactly the kind of
    invasive, out-of-lane edit the binding constraints warn against.
  - `@get-keel/mcp-server`: no test files (pre-existing — `--passWithNoTests`).
  - `@get-keel/opencode-plugin`: **all 55 checks passed**
    (`scripts/load-test.js`), including the 3 existing sequence-rule
    checks (`sequence first violation warns`, `sequence repeat denies`,
    `sequence ignores unrelated calls`) and `dist matches canonical
    template` — confirms the sequencer.ts fix round-trips correctly
    through the bundled `templates/keel-enforce.js` used by the OpenCode
    plugin.

No new failures anywhere. Fail count: 0 (excluding the 4 confirmed
pre-existing, out-of-scope `level.test.ts` failures).

## Files touched

Core (packages/core/src, NOT the generated packages/cli/src/core mirror):
- `packages/core/src/types.ts` — added `'verification'` to `RuleCategory`.
- `packages/core/src/enforce/rule-parser.ts` — added `'verification'` to
  `validCategories`.
- `packages/core/src/enforce/sequencer.ts` — match-surface fix (task 3).
- `packages/core/src/enforce/__tests__/match-surface.test.ts` — added
  `sequence rule match surface` describe block (3 cases).
- `packages/core/src/enforce/__tests__/repo-root.ts` — new, shared
  repo-root-finding helper for the proposal fixture tests.
- `packages/core/src/enforce/__tests__/proposal-validation.test.ts` — new.
- `packages/core/src/enforce/__tests__/proposal-test-before-commit.test.ts`
  — new.
- `packages/core/src/enforce/__tests__/proposal-runaway-budget.test.ts` —
  new.

Proposals (for the supervisor's mechanical paste into DEFAULT_RULES_YAML in
BOTH `packages/cli/src/commands/install.ts` and
`packages/cli/src/commands/plugin.ts` at the Wave-2 gate — neither file was
touched by this lane):
- `session/proposals/test-before-commit.yaml` — 1 rule.
- `session/proposals/runaway-budget.yaml` — 2 rules
  (`runaway-budget-tool-calls`, `runaway-budget-bash-calls`); each needs its
  own `tests/rules/<id>/{must-block,must-allow}.yaml` fixture dir once
  pasted, per `packages/cli/src/__tests__/fixture-harness.test.ts`'s
  per-rule contract.

Not touched, explicitly: `packages/core/src/enforce/verification.ts`
(overlap flagged above), `packages/cli/src/commands/install.ts`,
`packages/cli/src/commands/plugin.ts` (DEFAULT_RULES_YAML — single-owner
elsewhere, per binding constraints), `templates/keel-enforce.js` (generated
— regenerated by `npm run build`, never hand-edited).
