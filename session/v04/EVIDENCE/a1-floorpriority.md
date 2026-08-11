# v0.4 A1 (floor-priority lane) — closing different-id priority shadowing

Closes the residual documented in SECURITY.md as "different-id priority
shadowing": `mergeRules`' dedup loop only ever arbitrates a collision on a
**matching rule id**; it never compared a floor to a rule with a
**different** id. A lower-scope config could add a brand-new rule, under
its own id, with a higher `priority` and an action that matches the same
dangerous command but allows/warns/prompts it — `pipeline.ts`'s tier-2/3
loop is first-match-wins over the full priority-sorted list of ALL rules
regardless of id, so that new rule returned before the floor was ever
reached on a matching call. Node v26.0.0, worktree
`keel-v04-floorpriority`, branch `v04-floorpriority`, base commit
`2a45592`.

Scope: `packages/core/src/enforce/rule-parser.ts` (`mergeRules` + the
merged-rule ordering) and its tests only. `pipeline.ts`, `types.ts`,
`DEFAULT_RULES_YAML`, `arg-utils.ts`, `command-normalizer.ts`, `hook.ts`
untouched.

## Reproduce (pre-fix): the different-id allow rule shadows the floor

Before any code change, added two new test files asserting the SECURE
(desired) behavior, then ran them against the unmodified `rule-parser.ts`
(temporarily `git stash`-ed my own edit to isolate this) to confirm they
fail — i.e. the vulnerability reproduces through the real `mergeRules` +
`EnforcementPipeline.evaluate()` path, not just a hypothesis:

```
$ git stash push -- packages/core/src/enforce/rule-parser.ts
$ npx vitest run src/enforce/__tests__/protect-floor-priority-shadow.test.ts src/enforce/__tests__/rule-parser.test.ts

 ❯ src/enforce/__tests__/rule-parser.test.ts (30 tests | 2 failed)
     × a different-id, priority-999, action:allow rule is sorted AFTER a level:protect floor regardless of priority
     × a different-id, priority-999, action:warn rule is also sorted AFTER the floor (not just allow)
 ❯ src/enforce/__tests__/protect-floor-priority-shadow.test.ts (4 tests | 3 failed)
     × a different-id, priority-999, action:allow rule matching the same command does NOT let `git push --force` through
     × a different-id, priority-999, action:warn rule matching the same command also does not shadow the floor
     × a different-id, priority-999, action:prompt rule matching the same command also does not shadow the floor

AssertionError: expected [ 'deny', 'block' ] to include 'allow'
AssertionError: expected [ 'deny', 'block' ] to include 'warn'
AssertionError: expected [ 'deny', 'block' ] to include 'prompt'

 Test Files  2 failed (2)
      Tests  5 failed | 29 passed (34)
```

Confirmed through the real `EnforcementPipeline`: a `.keel.local.yaml`
adding

```yaml
version: 1
rules:
  - id: my-allow
    type: command
    action: allow
    priority: 999
    match: "git push.*--force"
    message: "shadow attempt"
```

against the shipped `no-force-push` floor (`priority: 82`, `level:
protect`, `action: deny`) let `git push --force origin some-feature-branch`
through as `allow` — the floor never ran. Same result for `action: warn`
and `action: prompt` different-id rules: the vector is not specific to
`allow`; any action that returns a verdict before the floor gets a turn
defeats it (a `prompt` result reaching the caller instead of a `deny` is
still a shadowed floor, even though a human gate exists downstream of it —
the floor's own guarantee, "denies on the first hit, no gate," was still
broken).

## Fix

`mergeRules`' final sort (the only place the merged, deduped rule list is
ordered before `pipeline.ts` iterates it first-match-wins) now assigns
every rule to one of three FIXED tiers — `mode: observe`, then
`level: protect` floors, then everything else — evaluated in that order
regardless of declared `priority`, with `priority` breaking ties only
within a tier:

```ts
const rank = (rule: KeelRule): number => {
  if (rule.mode === 'observe') return 0
  if (rule.level === 'protect') return 1
  return 2
}
return Array.from(deduped.values()).sort((a, b) => {
  const rankDiff = rank(a) - rank(b)
  if (rankDiff !== 0) return rankDiff
  return (b.priority || 0) - (a.priority || 0)
})
```

Chosen approach: **(a) from the task brief** — floors always sort before
non-floor rules regardless of declared `priority`, rather than (b)
teaching `pipeline.ts` to treat an allow/warn/prompt match specially when
a floor also matches the same call. (a) is strictly simpler and stays
entirely inside `mergeRules`, the file this lane owns; (b) would require
either touching `pipeline.ts` (out of scope — another lane owns it) or
adding a second, parallel notion of "does this override a floor" that
`mergeRules` already has no visibility into at the point pipeline.ts
evaluates (it only sees the flat sorted list, not "which of these ids is a
floor for which other id"). Floors becoming a tier evaluated to exhaustion
before any non-floor rule gets a chance to short-circuit is the same shape
`sameEnforcementSurface` already uses for a floor's own `priority` field in
the same-id case (freezing it against being demoted from within), just
applied at the ordering step instead of the dedup step, since there is no
id collision here for dedup to arbitrate against.

### Two refinements found before declaring done

**1. `mode: observe` needed a carve-out.** Running the full suite before
calling this done surfaced a real regression: a plain "floors always
first" sort broke an existing, correct pipeline.test.ts case where a
`mode: observe` rule was expected to still record its shadow verdict on a
call where a floor also matched and denied. `mode: observe` is checked
FIRST in `pipeline.ts`'s `violation()`, before the action switch, for
every rule type in the tiered loop — a match is recorded via
`OBSERVE_CONTINUE` and evaluation falls through, no matter what `action`
the observe rule declares. It is therefore structurally incapable of
shadowing anything regardless of where it sorts, so evaluating it first
(tier 0, ahead of floors too) is free and strictly stronger than merely
leaving it un-reordered.

**2. The first version of the observe carve-out was a pairwise comparator,
and pairwise was wrong — caught by `advisor()` before commit, not by any
test I had written.** The first fix compared `a` and `b` directly
(`aFloor && b.mode !== 'observe' → floor first`, else fall through to
priority) instead of assigning fixed tiers. That comparator is
intransitive: with three rules present — a floor at priority 82, a
different-id shadow rule at priority 999, and an observe rule at priority
90 (strictly between the other two) — floor-vs-shadow is forced
(floor first, by the special case), but floor-vs-observe and
observe-vs-shadow both fall through to plain priority, giving
observe(90) > floor(82) and shadow(999) > observe(90). That's a cycle:
shadow < floor < observe < shadow. `Array.prototype.sort` on an
intransitive comparator produces an output that depends on the sort
implementation's internal comparison sequence (V8's TimSort), not
something derivable from the rule alone — so the "floor always beats
shadow" guarantee I was about to write into SECURITY.md as CLOSED was not
actually true once a third, in-between-priority rule was in the mix. My
own two-rule tests could not see this (a cycle needs three elements to
manifest); the advisor asked for the three-rule case specifically and it
would have failed under the pairwise comparator. Replaced with the
fixed-tier `rank()` function above, which is a strict total order by
construction (comparing tier numbers alone never depends on priority),
verified against the three-rule case both at the `mergeRules` unit level
and end-to-end through `EnforcementPipeline` (see "Tests added" below).

## Fix confirmed: reproduce → fix transition

Restored the fix (`git stash pop`) and, after landing the fixed-tier
refinement above, re-ran the same test files plus the sibling floor test
files (same-id override guard, first-hit regression):

```
$ npm run build
$ npx vitest run src/enforce/__tests__/protect-floor-priority-shadow.test.ts \
    src/enforce/__tests__/rule-parser.test.ts \
    src/enforce/__tests__/protect-floor-mode-match-override.test.ts \
    src/enforce/__tests__/protect-floor-first-hit.test.ts

 Test Files  4 passed (4)
      Tests  47 passed (47)
```

The same different-id `.keel.local.yaml` shapes that let the force-push
through pre-fix (`action: allow`/`warn`/`prompt`, `priority: 999`) now all
return `deny`/`block` with `result.rule_id === 'no-force-push'` — the
floor, not the shadow rule — including the three-rule transitivity shape
(floor + shadow + in-between-priority observe rule) that the first
(pairwise) version of the fix would have gotten wrong.

## Tests added (final set, after the tiering fix)

- `packages/core/src/enforce/__tests__/rule-parser.test.ts` — new describe
  block "mergeRules — a different-id rule cannot priority-shadow a
  level:protect floor" (8 tests):
  - different-id `action: allow`, `priority: 999` sorts after the floor
  - different-id `action: warn`, `priority: 999` sorts after the floor
  - non-floor priority ordering AMONG non-floor rules is unaffected
    (regression)
  - with no floor involved at all, merge order matches a plain priority
    sort exactly (regression)
  - a `mode: observe` non-floor rule sorts AHEAD of a floor even at equal
    (default) priority (tier beats the default-0 tie)
  - a `mode: observe` non-floor rule sorts ahead of a floor even with a
    LOWER declared priority (proves tier beats priority outright, not just
    a tie)
  - a `mode: warn` (not observe) rule with a higher priority IS still
    pushed behind the floor (proves the tier-0 carve-out is specific to
    `mode: observe`, not "any declared mode")
  - **transitivity**: floor + different-id shadow rule + an observe rule
    with priority strictly between the two, all three present — asserts
    the exact full order (`['my-observe', 'no-force-push', 'my-allow']`),
    not just the pairwise floor-before-shadow relation, since that
    pairwise relation is exactly what a broken comparator could get right
    by accident while still being non-transitive overall
- `packages/core/src/enforce/__tests__/protect-floor-priority-shadow.test.ts`
  (new file, 5 tests, pipeline-level, mirrors the structure of the sibling
  `protect-floor-mode-match-override.test.ts`):
  - different-id `action: allow`, `priority: 999` matching `git push
    --force` does not let it through
  - different-id `action: warn`, `priority: 999` — same
  - different-id `action: prompt`, `priority: 999` — same
  - non-floor priority ordering still governs first-match-wins with no
    floor in play (regression, synthetic non-floor-vs-non-floor rules)
  - **transitivity, end to end**: the same three-rule shape (floor +
    shadow + in-between-priority observe) through the real
    `EnforcementPipeline` — asserts the floor still denies
    (`result.rule_id === 'no-force-push'`) AND that the observe rule still
    got to record (`observed_matches` contains it), proving both the
    security property and the pre-existing observe guarantee hold
    simultaneously

## Regression check: non-floor priority ordering + same-id guard

- `mergeRules — floor rules cannot be weakened by scope` (the prior lane's
  same-id override guard, 11 tests) — all still pass unmodified; this
  lane's change is a sort applied AFTER that dedup loop runs, so it cannot
  affect which rule the dedup loop picks for a given id.
- `protect-floor-first-hit.test.ts` (block-on-first-hit regression, 5
  tests) — all still pass; floor-first ordering doesn't change *whether* a
  floor blocks on the first hit, only *when in the loop* it gets evaluated
  relative to other rules.
- Full core suite: 554 passed, 2 skipped (baseline ~541 + 13 new tests in
  this lane's final set = 554, exact match — no other test count moved).
- Full cli suite: 708 passed, 14 skipped (baseline ~708, unchanged — this
  lane never touches `packages/cli/src/core` source directly; `npm run
  build` re-vendors `packages/core/src` into it before running cli tests,
  per the binding constraint).

## Verification commands (full, unpiped output — not grepped for
pass/fail)

```
$ npm run build            # all 4 workspaces built clean
$ cd packages/core && npx vitest run
 Test Files  33 passed (33)
      Tests  554 passed | 2 skipped (556)
$ cd packages/cli && npx vitest run
 Test Files  37 passed (37)
      Tests  708 passed | 14 skipped (722)
```

Ran the cli suite four times total across this lane for confidence (it exercises rate
limits / time windows and has a machine-load-guarded perf test,
`perf-budget.test.ts`, that self-skips under load rather than flaking red —
see its own skip message). Three runs: 708 passed / 14 skipped. One run:
707 passed / 15 skipped (the perf-budget test self-skipped under load that
run) with zero failures. One earlier run showed a single transient failure
in an unrelated timing-sensitive test that did not reproduce on immediate
re-run and is not in the `rule-parser.ts`/`protect-floor-*` files this
lane touches — every run of this lane's OWN new/modified test files
(`rule-parser.test.ts`, `protect-floor-priority-shadow.test.ts`,
`protect-floor-mode-match-override.test.ts`, `protect-floor-first-hit.test.ts`)
passed 100% of the time, every run.

## SECURITY.md updated

- The "Also not covered, and a distinct residual..." paragraph (under
  "Residual on floor overrides, host-agnostic") is replaced with a
  "**Residual on different-id priority shadowing — CLOSED**" writeup
  describing the exact ordering guarantee, the observe-mode carve-out and
  why it's safe, and pointers to this evidence file and the new tests.
- The stale "One residual remains open and is documented not fixed..."
  paragraph under "Keel controls are user-owned" (left un-updated by the
  prior same-id-guard lane, and already self-contradicting the "CLOSED"
  section above it before this lane started) is corrected to state both
  the same-id and different-id residuals are closed, with pointers to both
  writeups and this evidence file.

## What this does NOT close (stated honestly, matching the existing
SECURITY.md style)

- `mergeRules` still has no notion of "these two different ids target the
  same dangerous command" — nothing here validates or flags an
  overlapping `match` across independently-authored rule ids. The
  floor-first ordering guarantee holds regardless of what a different-id
  rule's `match` looks like (a floor that matches is now ALWAYS evaluated
  before any non-floor, non-observe rule reached by `pipeline.ts`'s
  tier-2/3 first-match-wins loop), which is what closes the exploitable
  consequence without requiring that harder, more speculative cross-rule
  detection. This guarantee is scoped to that loop specifically — the
  earlier `statefulRules` pass (verification/claim/research obligations)
  is a separate loop this pass did not need to reorder, since those types
  gate on trigger/boundary state rather than an arbitrary `match` an
  attacker-authored rule could point at the same command text a floor
  matches.
- Same pre-existing caveat as the same-id guard: this requires a
  *pre-existing* `.keel.local.yaml` (or lower-scope `rules.yaml`);
  *writing* such a file remains blocked on every agent path
  (`no-self-protection-write` for shell, `no-rules-tampering` for the tool
  channel including `file_path`), so authoring the override is still a
  user's own-config choice, not a one-command agent bypass.
- A `level: protect` floor with `mode: observe` (burning in) is still
  exempt from ITS OWN floor-first treatment being meaningful in practice —
  it sorts ahead of shadow-capable rules like any floor, but since its own
  `mode: observe` means it never returns a verdict either, "sorting first"
  doesn't make it enforce; that's unchanged, pre-existing, intended
  behavior for a floor that hasn't finished burning in (see SECURITY.md's
  existing "Combined rule" paragraph).
