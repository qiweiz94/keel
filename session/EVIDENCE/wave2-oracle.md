# Wave-2 Lane 4 — test-oracle tampering detector — EVIDENCE

Branch: `w2-oracle` (worktree `/Users/nanoclaw/code/keel-w2-oracle`)

## What shipped

- `packages/core/src/enforce/oracle-tracker.ts` — `OracleTracker`: the
  recency window. Arms on a FAILING command matching a rule's `trigger`
  (same shape research rules use: `{ tools, pattern, exit: 'nonzero' }`),
  keyed `oracle:<ruleId>:<cwd>:<sessionId>` (session-scoped, like
  `ResearchTracker` — not cwd-only like `StuckTracker`/`VerificationTracker`,
  so one agent session's red run cannot arm the window for a DIFFERENT
  session editing the same repo). Persisted through `StateManager` (new
  `oracleFailures` state file, `oracle-failures.json`) so the window
  survives across process-per-call hosts — verified in
  `oracle.test.ts`'s "StateManager persistence" test, which constructs a
  brand-new `StateManager` + `OracleTracker` for the "read" half to prove
  no in-memory state is required to cross the gap.
- `packages/core/src/enforce/oracle-signatures.ts` — `detectWeakening`: the
  pure content-diff heuristics (see Signature taxonomy below). No I/O, no
  state, independently unit-tested.
- `packages/core/src/enforce/oracle-glob.ts` — `matchesTestGlob` /
  `matchesAnyTestGlob`: a correct globstar matcher for the oracle rule's
  `paths` surface. NOT a reuse of the pipeline's existing (shared, private)
  `pathMatches` — see "Bug found" below for why.
- `packages/core/src/enforce/pipeline.ts` — new `oracle` rule-type branch
  (two detection surfaces on one rule: command-surface via `match`,
  content-diff surface via `paths`), `oracleTracker` wired self-constructed
  in the constructor (`config.oracleTracker || new OracleTracker(config.
  stateManager)`) exactly like `verificationTracker`, so no host
  (cli/enforce.ts, daemon.ts, opencode-plugin/plugin.ts) needs updating —
  they already pass `stateManager`. `oracle` added to `statefulRules` (skips
  the Tier-1 allow-cache, since a verdict depends on tracker state the args
  hash can't see) and to `recordAttemptOutcome`'s per-call bookkeeping
  (placed before the `stuckTracker` early-return so it always runs).
- `packages/core/src/types.ts` — `'oracle'` added to `RuleType`;
  `'verification'` added to `RuleCategory` (the eight existing buckets have
  no home for `verification`/`oracle`-typed rules; no prior rule used this
  category since it didn't exist). Reused existing fields (`paths`, `match`,
  `trigger`, `window_seconds`) rather than adding new ones — documented
  inline.
- `packages/core/src/enforce/rule-parser.ts` — `'oracle'` added to
  `validTypes`; `'verification'` added to `validCategories`; a new
  validation requiring an oracle rule to declare a detection surface
  (`paths` or `match`) and a `trigger` (otherwise it can never fire, which
  is a worse failure mode than refusing to load).
- `session/proposals/test-oracle-tampering.yaml` — the default snippet,
  `mode: observe`, `action: warn`, full catalog metadata.
- `session/proposals/tests-read-only.yaml` — the opt-in blunt sibling,
  `type: filesystem`, `action: prompt`, clearly marked never-a-default.
- `packages/core/src/enforce/__tests__/oracle.test.ts` — 35 tests across
  three layers (signatures, tracker, full pipeline through the real
  proposal YAML) plus rule-parser validation and the tests-read-only.yaml
  sanity check.

## Design: two detection surfaces, one rule

1. **Content-diff surface** (`paths`): an edit to a file matching the
   test-file globs is diffed against its PRE-edit content — the Edit-tool
   shape (`oldString`/`newString`) diffs just the changed region directly
   from args (no disk read); the Write-tool shape (`content`/`text`, no
   `oldString`) diffs against on-disk content, mirroring how the existing
   `content`-type rule branch already reads files.
2. **Command-surface** (`match`): some tampering never produces a visible
   file diff at all — `jest -u` / `vitest --update-snapshot` rewrite
   `.snap` files as a SIDE EFFECT of the test runner, not via an Edit/Write
   tool call the pipeline observes. This is matched directly against the
   command string, same mechanism `command`-type rules already use.

Both surfaces gate on `OracleTracker.recentFailure()` before firing.

## Signature taxonomy (`oracle-signatures.ts`)

| id | trigger |
|---|---|
| `skip-added` | net increase in `it.skip(`/`describe.skip(`/`xit(`/`xdescribe(`/`@pytest.mark.skip`/`@pytest.mark.xfail`/`pytest.skip(`/`pytest.mark.skipif`/`t.Skip(`/`t.SkipNow(` |
| `only-added` | net increase in `it.only(`/`describe.only(`/`fit(`/`fdescribe(` — narrowing to one test silences every OTHER test, same effect as skip |
| `assertions-removed` | net decrease in `expect(`/`assert*(`/`self.assert*(`/bare `assert ` count (old minus new) |
| `test-block-deleted` | net decrease in `it(`/`test(`/`def test_*(` declaration count |
| `snapshot-file-rewrite` | the edited path ends in `.snap` or sits under `__snapshots__/` — content-agnostic, the write itself is the signal |
| `expected-value-rewrite` | a removed line and an added line share the same assertion-call prefix (e.g. `expect(cart.total).toBe(`) but differ after it — a line-diff pairing, not a full parser |
| `timeout-retry-inflation` | a `timeout`/`retries`/`retry`/`maxRetries` value increased by both ≥5 absolute AND ≥3× — tuned to not fire on routine bumps (1→2) while catching real sweeps (1→10, 2000→30000) |

All are heuristic (regex/line-diff over unparsed source, not an AST) —
documented as such in the shipped rule's `confidence: low`.

## Recency semantics

Default window: 900s (15 min), `rule.window_seconds`. A weakening pattern
with NO recorded failure inside the window produces **no finding at all**
in the shipped default — not a lower-severity finding, a silent pass. This
was a deliberate choice (not an oversight) made explicit in
`test-oracle-tampering.yaml`'s header comment: without the gate, "weakening
pattern present" alone fires on nearly every routine test-suite refactor,
drowning the actual signal. Verified by the "MUST-NOT-FIRE: test edit with
no recent failure" and "MUST-FIRE decays: ... outside the recency window"
fixtures below.

Window key is `(rule, cwd, session)` — session-scoped, matching
`ResearchTracker`'s obligation pattern, not `StuckTracker`/
`VerificationTracker`'s cwd-only scoping. Verified by "is session-scoped: a
different session in the same cwd sees no arm".

## Bug found and worked around (not fixed): `pipeline.ts`'s shared `pathMatches`

While wiring the content-diff surface, `paths: ["**/*.test.*", ...]`
against real file paths consistently returned `pathMatched: false` through
the pipeline's existing (private, shared) `pathMatches` method. Root cause,
confirmed by extracting the exact compiled regex and testing it directly:
that method's escape pass never escapes a bare `*` (only chars in
`[.+?^${}()|[\]\\]`), so its `\*` → `[^/]*` substitution has nothing to
act on — every bare star in a pattern survives into the final regex as an
inert quantifier on whatever character precedes it. `"**/*.test.*"` compiles
to `^.*/*\.test\.*$`, where the trailing `\.*` means "zero or more literal
dots", not "any extension" — it can never match `math.test.ts`.

This is **pre-existing and affects two already-shipped default rules**:
`**/.env*` does not match `.env.local`, and `**/id_rsa*` does not match
`id_rsa.pub` (both verified empirically against the compiled function; see
below). Both are false NEGATIVES in a credential-blocking rule. This is a
real finding, flagged here for whoever owns `no-secret-files` /
`pipeline.ts`'s `filesystem` branch — **not fixed as part of this lane**:
fixing a matcher shared by every already-shipped `filesystem`-type rule
needs its own dedicated verification across the whole ruleset, not a
byproduct of an unrelated new rule type. Empirical check (run outside the
suite, not committed as a test — this is someone else's bug to own):

```
**/.env* -> /repo/.env.local => false   (should be true)
**/id_rsa* -> /home/user/.ssh/id_rsa.pub => false   (should be true)
```

Workaround: `oracle-glob.ts` is a small, independently-correct globstar
matcher scoped ONLY to the `oracle` rule type's `paths` surface (never
touches the shared `pathMatches`, never changes behavior for any
already-shipped rule). Verified against 11 cases including the two
substring-false-positive guards (`**/tests/**` must not match
`nottests/x.ts`; `**/__snapshots__/**` must not match
`not__snapshots__extra/x.ts`).

`tests-read-only.yaml` (a real `filesystem`-type rule, so it DOES go
through the shared, buggy `pathMatches`) had its `paths` list adjusted to
concrete extensions (`**/*.test.ts`, `**/*.test.tsx`, ... `**/*.spec.jsx`)
plus directory-only globs (`**/tests/**`, `**/conftest.py`) instead of
wildcard-extension globs, specifically because those are the pattern shapes
the shared matcher gets right — documented inline in the proposal file.
Also found and fixed in the same rule: an `operations: [...]` filter that
would have silently NEVER matched anything, because no real host
integration populates `args.operation` (confirmed by grep across
cli/opencode-plugin/mcp-server) — `no-secret-files`, the shipped precedent
for a `filesystem`-type rule, omits `operations` for the same reason.
Removed, with an inline comment explaining why.

## Fixture results (must-fire / must-not-fire, through the real pipeline)

All run against `session/proposals/test-oracle-tampering.yaml` loaded and
parsed exactly as shipped (`parseRulesContent` + `validateRules`, zero
errors), through a real `EnforcementPipeline` with a real `StateManager`
pointed at an isolated `KEEL_STATE_DIR` temp dir.

| Fixture | Expectation | Result |
|---|---|---|
| Failing `vitest run`, then edit adding `.skip(` to the failing spec | MUST-FIRE | ✓ `allow` / `observed_action: warn`, rule_id `test-oracle-tampering` |
| Failing `npm test`, then deletion of the failing test block | MUST-FIRE | ✓ `allow` / `observed_action: warn` |
| Failing `jest`, then `jest -u` (command-surface) | MUST-FIRE | ✓ `allow` / `observed_action: warn`, message contains `command-surface` |
| Test edit with no recent failure | MUST-NOT-FIRE | ✓ `allow` / `observed_action: undefined` |
| Adding NEW tests after a failure (pure addition) | MUST-NOT-FIRE | ✓ `allow` / `observed_action: undefined` |
| Refactor renaming a test, assertions preserved | MUST-NOT-FIRE | ✓ `allow` / `observed_action: undefined` |
| Docs edit in `tests/README.md` | MUST-NOT-FIRE | ✓ `allow` / `observed_action: undefined` |
| Passing test run (exit 0) — window never arms | MUST-NOT-FIRE | ✓ `allow` / `observed_action: undefined` |
| Weakening edit outside the recency window (`window_seconds: -1`) | MUST-NOT-FIRE | ✓ `allow` / `observed_action: undefined` |

`mode: observe` verified structurally too: `rule.mode === 'observe'`,
`rule.action === 'warn'`, `rule.confidence === 'low'`,
`rule.severity === 'high'` — asserted directly against the parsed YAML, so
a future accidental edit to the proposal file that flips any of these trips
a test, not just a behavior change nobody notices.

## Honest false-positive discussion (also in the shipped YAML)

- Legitimate refactor (rename, reorganize) with every assertion preserved
  — no assertion/test-block/skip count delta, does not fire regardless of
  recency. Covered by a fixture.
- Intentional snapshot update after a real UI change, run within the
  window of an UNRELATED failing test in the same session's suite run —
  the window is per (rule, cwd, session), not per file or failing-test
  name, so a monorepo-wide failing run can arm the window for an unrelated,
  legitimate snapshot refresh moments later. Not fully fixable without
  per-test attribution the pipeline doesn't have visibility into.
- Removing a genuinely obsolete test shortly after an unrelated failure in
  the same suite invocation — same root cause as above (trigger is the
  whole command's exit code, not evidence of which test failed).
- Fixing a wrong expected value IN THE TEST (test asserted the wrong thing)
  is indistinguishable from rewriting a correct expectation to dodge a
  failure — this is exactly why the rule ships `confidence: low` and
  `mode: observe` rather than blocking.

## Verification run

- `npm run build` (all four workspaces) — clean.
- `packages/core` — `284/284` passing (includes the new 35).
- `packages/cli` — `651/655` passing. The 4 failures are
  `src/__tests__/level.test.ts` ANSI/chalk-stripping assertions —
  **confirmed pre-existing**: reproduced independently by stashing every
  change in this worktree (`git stash --include-untracked`, rebuilding,
  running `level.test.ts` alone against base commit `b45aebf`) — same 4
  failures, same messages, before any of this lane's code existed. Also
  independently documented by two other Wave-1 lanes in
  `session/DECISIONS.md` (lanes 1 and 3) as reproducing on the base commit.
  Not touched by this lane (no file under `packages/cli/src/commands/` or
  `packages/cli/src/__tests__/level.test.ts` was edited).
- `packages/opencode-plugin` — `node ./scripts/load-test.js` — all 54
  checks pass, including "dist matches canonical template" (confirms
  `templates/keel-enforce.js` was correctly regenerated from source, not
  hand-edited).
- `packages/mcp-server` — no test files (`--passWithNoTests`), unaffected.

No fixture attempts failed twice (the two real debugging cycles — the
`pathMatches` glob bug and the `operations:` dead-filter bug — were each
diagnosed and fixed in one pass once root-caused; neither triggered the
"fail twice → stop, report" threshold).

## Gate readiness: `tests/rules/test-oracle-tampering/`

`packages/cli/src/__tests__/fixture-harness.test.ts` requires every rule in
`DEFAULT_RULES_YAML` to have `tests/rules/<id>/{must-block,must-allow}.yaml`
with at least one case each. This rule is not in `DEFAULT_RULES_YAML` yet
(single-owner elsewhere per this lane's mandate — the supervisor pastes the
snippet at the Wave-2 gate), so that harness check does not exercise this
rule today. The fixture directory is shipped anyway, ahead of the merge, so
the gate does not hard-fail the moment the snippet lands:

- `must-allow.yaml` — two real, unskipped cases (verified directly against
  the shipped rule through a real pipeline, not just asserted): a
  weakening edit with no recorded failure, and a docs edit under `tests/`.
  Both genuinely evaluate to `allow` with no special-casing needed from the
  harness.
- `must-block.yaml` — the three real must-fire scenarios (same ones proven
  in `oracle.test.ts`), each marked `skip: true` with a `reason`. Two
  independent, unrelated gaps in the SHARED harness (not this rule) block
  asserting these there today:
  1. `expectedActionFor()` has no observe-mode awareness — it maps
     `action: warn` to expecting `result.action === 'warn'`, but an
     observe-mode match returns `action: 'allow'` /
     `observed_action: 'warn'` by construction (`pipeline.ts`'s
     `violation()`). No case for an observe-mode rule can pass this
     assertion regardless of whether the rule fired.
  2. `evaluateCase()` never calls `pipeline.recordAttemptOutcome()`, and
     `StepDef` has no `exit:` field to route there. Without that channel a
     fixture case cannot express "a failing test run happened, THEN this
     edit followed it" — the shape this rule's recency gate requires.
  Both are flagged for the harness's owner (Wave-1 Lane 2) — a future
  `exit:` field on `StepDef` plus observe-mode handling in
  `expectedActionFor` would let these three cases un-skip as written.
  Real, currently-passing coverage for all three lives in
  `packages/core/src/enforce/__tests__/oracle.test.ts`.
- The coverage assertion itself (`per-rule fixture coverage`) counts
  `doc.cases` length before the skip/no-skip split, so skipped must-block
  cases still satisfy "has ≥1 case" once the rule is merged into
  `DEFAULT_RULES`.

## Re-verified after merge into a DEFAULT_RULES-shaped set

The KNOWN-FP PROBES block in `fixture-harness.test.ts` runs the full
`DEFAULT_RULES` set — which doesn't include this rule today, so those
probes are trivially unaffected by it right now. To check the state AFTER
the supervisor merges the snippet (not just assume it), the same six probe
commands were replayed through a real pipeline with only this rule loaded:
`rsync -av`, `rsync .env` (after a `Read` of `.env`), an `async` function
write, `npm run sync-assets`, a `git commit --signoff` mentioning "sync",
and `echo $SYNC_STATUS_TOKEN_NAME`. All six returned `allow` with
`rule_id: null` — none of them are test-runner commands (the `trigger`
match), none touch a test-file path (the `paths` match), and none carry a
jest/vitest update-snapshot flag (the `match` match), so none reach far
enough into the oracle branch to matter. Also confirmed `buildPipeline` in
that test file passes no `stateManager`, so even a rule that DID match
would find `OracleTracker` in-memory-only there — consistent with, not a
cause of, the all-allow result.

## Known limitations (not covered by the fixture list, documented honestly)

- **Deleting the whole test FILE** (`rm src/math.test.ts`, or an
  MCP/shell delete tool) is caught by NEITHER surface: the content-diff
  surface needs a write/edit call with a path in `args` (a `Bash rm` has
  no `args.path`), and the command-surface `match` only recognizes
  jest/vitest update-snapshot flags, not deletion. A test file quietly
  disappearing after a failing run is arguably the starkest tampering
  signature in the whole taxonomy and this rule does not see it. Filling
  this gap would need either a `filesystem`-type rule watching `delete`
  operations on the same `paths` (compare `tests-read-only.yaml`'s
  approach, which — as an opt-in blunt instrument — DOES catch deletes) or
  teaching the oracle branch to also recognize `rm`/`delete` commands whose
  argument matches the test-file globs. Left out of this lane's scope; not
  exercised by any of the required fixtures.
- **`level: sprint` makes the detector inert twice over**, not once: the
  shipped rule declares `level: balanced`, so at the sprint dial
  `mergeRules` filters it out of the active rule set entirely before the
  pipeline ever looks at it (`rule-parser.ts`'s dial-rank filter). Separately,
  even a hypothetical `level`-less oracle rule would still be skipped at
  sprint because `depth` becomes `'fast'` there and the whole oracle branch
  is gated behind `deepChecks` (matching how `content`/`sequence`/`flow`
  rules are already gated — Tier 5/6 checks are opt-out at the fast dial).
  Neither mechanism was documented anywhere before this note.

## `RuleCategory` addition kept minimal (merge-collision risk)

`types.ts`'s `RuleCategory` gained one bare member, `'verification'`, on
the same line as the existing eight — not a separate line with an inline
justification comment. Other Tier-3 lanes shipping the same wave
(`claim-without-evidence`, `test-before-commit`) plausibly need the same
category and may add the identical single-token member independently; a
character-identical line is far more likely to merge cleanly than two
differently-worded versions of the same idea (see `session/DECISIONS.md`'s
note on the `KEEL_STATE_DIR` line landing identically across three lanes
for the same reason). The justification for the category itself — none of
the existing eight buckets (`destructive`, `exfil`, `escalation`,
`injection`, `resource`, `bypass`, `discipline`, `workflow`) fit a rule
whose type IS `verification` or `oracle` — lives here instead of inline in
`types.ts`.
