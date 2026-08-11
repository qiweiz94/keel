# v0.4 mergeguard lane — closing the mode/match floor-override residual

Escalated from `session/v04/EVIDENCE/phase-3-redteam.md` §(a): `mergeRules`
(rule-parser.ts, pre-fix line 457-459) rejected a lower-scope override of a
`level: protect` floor that weakened its **action**, but compared the action
field only. Two neutralization vectors stayed open even though the override
kept `action: deny` + `level: protect`:

1. **mode** — adding `mode: observe` to the override silences the floor
   (`pipeline.ts`'s `effectiveAction()` short-circuits an observe-mode match
   to `allow`).
2. **match** — replacing `match`/`paths`/`patterns` with a pattern that
   never fires on the real dangerous command disables the floor for that
   command while leaving the id, action, and level untouched.

This lane closes both, in `packages/core/src/enforce/rule-parser.ts`'s
`mergeRules`, by extending the existing dedup-loop check rather than
rewriting it. **This document went through one review round with the
supervising advisor after the first implementation; both rounds are
recorded below because the first round's own e2e test turned out to be
vacuous — see "Review round 1" for how that was caught and fixed.**

## Semantics implemented (final)

**MODE_STRENGTH** (new constant, mirrors the existing `ACTION_STRENGTH`
shape):

```
block / undefined (2, tied) — strongest: fully enforcing
> warn (1)                  — surfaced with escalation, not a hard block
> observe (0)                — weakest: evaluated, never interrupts
```

`undefined` is tied with `block`, not treated as weaker — a floor authored
with no explicit `mode` is fully enforcing per `RuleMode`'s own doc comment
in types.ts, and must not be penalized relative to a rule that spells out
`mode: block`.

**Enforcement-surface rule (revised from "matching-surface" after review
round 1 — see below)**: rather than freezing an enumerated list of
match-shaped field names (`match`/`match_prefix`/`match_regex`/`paths`/
`patterns`), the final version compares by **exclusion**: strip
`action`/`mode`/`level`/`scope` (handled by their own checks) and a small
explicit allowlist of pure catalog metadata (`message`, `rationale`,
`remediation`, `false_positives`, `review_by`, `category`, `severity`,
`confidence`, `maturity` — informational tags with no read path in
`pipeline.ts` today) from both the floor and the candidate, then require
the remainder to be **byte-identical** via `JSON.stringify`.

This closes the originally-named vector (`match`/`paths`/`patterns`) but
also, by construction and without needing their own named entry, closes:
`exclude`/`operations` narrowing a filesystem floor, `except` widening a
network floor's allowlist, `schedule` retiming a time floor, `type`
swapping a floor's check class outright, and `priority` — confirmed live
in `pipeline.ts`'s tier-2/3 loop, which is **first-match-wins over the
full priority-sorted rule list** (`for (const rule of rules) { ... if
(matches) return this.violation(...) }`), so an override that demotes a
floor's `priority` below an unrelated weaker rule matching the same
command means the floor is never reached on that call at all — a real
vector, not a hypothetical, and NOT covered by the original enumerated
`MATCHING_SURFACE_FIELDS` list.

Any field not on the metadata allowlist is frozen by default, including
fields added to `KeelRule` after this guard was written — the allowlist
has to be extended deliberately to loosen the guard for a new field; the
freeze does not have to be extended to keep catching one.

**Combined override-acceptance rule** for a `level: protect` floor:

> A lower-scope override of a `level: protect` floor is honored **only**
> if it is itself `level: protect` **AND** same-or-stronger on action
> (`ACTION_STRENGTH`) **AND** same-or-stronger on mode (`MODE_STRENGTH`)
> **AND** has an identical enforcement surface (`sameEnforcementSurface`).
> Failing any one axis rejects the **whole** override — the floor already
> in the merged map stands untouched, unchanged on every field (no partial
> merging). Strict tightening on any axis (e.g. `mode: observe` → unset,
> `warn` → `deny`) combined with an identical surface is still honored — a
> floor can burn in under `mode: observe` and later be promoted to
> enforcing by a more specific scope.

Implementation: `packages/core/src/enforce/rule-parser.ts`, `mergeRules`'s
dedup loop —

```ts
if (existing.level === 'protect') {
  const actionOk = rule.level === 'protect' && ACTION_STRENGTH[rule.action] >= ACTION_STRENGTH[existing.action]
  const modeOk = modeStrength(rule.mode) >= modeStrength(existing.mode)
  const surfaceOk = sameEnforcementSurface(existing, rule)
  const tightensOrEqual = actionOk && modeOk && surfaceOk
  if (!tightensOrEqual) continue  // weakening override on some axis — keep the floor
}
```

`sameEnforcementSurface` strips `OVERRIDE_COSMETIC_FIELDS` and
`OVERRIDE_STRENGTH_CHECKED_FIELDS` from both rules, then compares the
remainder with `JSON.stringify`.

## Review round 1 — advisor caught a vacuous e2e test

The first implementation used an enumerated `MATCHING_SURFACE_FIELDS =
['match', 'match_prefix', 'match_regex', 'paths', 'patterns']` and passed
the full suite (481/481 core, 674/674 cli). Before committing that as
final, the supervising advisor reviewed the transcript and flagged two
issues, both confirmed empirically before acting on them (never taken on
say-so alone, per this lane's own working discipline):

1. **The pipeline-level `mode: observe` test was a false green.** Its
   `.keel.local.yaml` override omitted `match` entirely (relying on the
   shipped floor's default), so it differed from the floor on the match
   field too — meaning it was rejected by the (correct) match check, and
   the test would pass even with `modeOk` deleted from the guard entirely.
   **Verified by mutation**: temporarily removed `modeOk` from
   `tightensOrEqual`, rebuilt, reran just the two mode-related test files.
   Result: the **unit-level** mode test (`rule-parser.test.ts`, which
   explicitly set the same `match: 'push.*--force'` on both floor and
   override) correctly went red. The **pipeline-level** mode test
   (`protect-floor-mode-match-override.test.ts`) stayed green — proving it
   never exercised the mode axis at all. Fixed by rewriting the pipeline
   test to clone the real shipped `no-force-push` rule object (not
   hand-type its regex into YAML) and change only `mode`/`message`,
   guaranteeing every other field byte-identical to the real floor —
   `makePipelineWithClonedFloorOverride()` in the test file. Re-ran the
   same mutation after the fix: this time BOTH the unit and pipeline mode
   tests went red with `modeOk` removed, and both pass with it restored.
2. **The field-enumeration approach under-covers.** `exclude`/`operations`
   (filesystem floors), `except` (network floors), and `priority`
   (reordering past the tier loop's first-match-wins semantics) are all
   real neutralization vectors on shipped floor types (`no-rules-tampering`,
   `no-enforcer-removal` are filesystem rules with `paths`/`exclude`), and
   none were in the original enumerated list. Fixed by inverting to the
   exclusion-based `sameEnforcementSurface` design above, which covers
   these and any future `KeelRule` field by default. Three new unit tests
   added to `rule-parser.test.ts` to lock this in (filesystem `exclude`,
   network `except`, command `priority` — see below).

## Before / after

### Unit level (`mergeRules` return value) — `rule-parser.test.ts`

Red (pre-fix), the two tests that exercise the originally-named vectors:

```
 ❯ src/enforce/__tests__/rule-parser.test.ts (23 tests | 2 failed)
     × a local override that KEEPS action deny + level:protect but adds mode:observe is rejected
       AssertionError: expected 'observe' to be undefined
     × a local override that KEEPS action deny + level:protect but replaces `match` with a non-matching pattern is rejected
       AssertionError: expected 'this-never-matches-anything' to be 'push.*--force'
```

Green (final): all pass; full file 30/30 (26 original + 4 mode/match +
3 exclude/except/priority — see suite run below for the file total).

### Pipeline level (real `EnforcementPipeline.evaluate()`, not just `mergeRules`) —
`protect-floor-mode-match-override.test.ts`

Red (pre-fix, first implementation — before the review-round-1 rewrite):

```
 ❯ src/enforce/__tests__/protect-floor-mode-match-override.test.ts (3 tests | 2 failed)
     × adding `mode: observe` to no-force-push (keeping deny+protect) does NOT let `git push --force` through
       AssertionError: expected [ 'deny', 'block' ] to include 'allow'
     × replacing `match` on no-force-push with a non-matching pattern (keeping deny+protect) does NOT let `git push --force` through
       AssertionError: expected [ 'deny', 'block' ] to include 'allow'
```

Red (post-review-round-1 rewrite, confirming the FIXED mode test is no
longer vacuous — reproduced via the `modeOk`-removal mutation described
above):

```
 ❯ src/enforce/__tests__/protect-floor-mode-match-override.test.ts (3 tests | 1 failed)
     × adding `mode: observe` to no-force-push (keeping deny+protect, everything else byte-identical to the floor) does NOT let `git push --force` through
       AssertionError: expected [ 'deny', 'block' ] to include 'allow'
 ❯ src/enforce/__tests__/rule-parser.test.ts (26 tests | 1 failed)
     × a local override that KEEPS action deny + level:protect but adds mode:observe is rejected
```

Both prove the live-vulnerability shape end to end: a `.keel.local.yaml`
that keeps `action: deny` + `level: protect` on `no-force-push` but adds
`mode: observe` (with every other field, including `match`, cloned
byte-identical from the real floor), or that redefines its `match` to a
pattern that never fires, made a real `git push --force origin <branch>`
call through the real pipeline return `allow`. (Test commands target a
non-`main` branch so the result isolates the `no-force-push` floor from
the separate, legitimate, non-floor `no-push-to-main` prompt rule that
also matches pushes straight to `main`/`master` — that rule firing
`prompt` would have masked whether the floor itself was neutralized.)

The third test in that file (a floor authored under `mode: observe`
promoted to enforcing by a more specific scope) passed even pre-fix — the
existing action-based check already didn't block tightening, and this
guard change preserves that.

Green (final): all 3 pass.

### Full suite, final

```
$ npm run build   # core -> tsc/esbuild, then vendored into packages/cli/src/core
  (clean build, no errors)

$ npm run test -w @get-keel/core
 Test Files  27 passed (27)
      Tests  484 passed | 2 skipped (486)

$ npm run test -w @get-keel/cli
 Test Files  36 passed (36)
      Tests  674 passed | 14 skipped (688)
```

Baseline before this lane: core 474 passed / 2 skipped (26 files), cli 674
passed / 14 skipped (36 files). Final delta: core +10 tests (474 → 484: 4
mode/match unit tests + 3 pipeline e2e tests + 3 exclude/except/priority
unit tests from review round 1). cli is untouched (674 = 674, 0 new/changed
tests): the fix is entirely inside `packages/core/src/enforce/rule-parser.ts`,
which the cli build vendors in at `npm run build` time — `packages/cli/templates/keel-enforce.js`
changes are the regenerated opencode-plugin bundle, not a hand edit.

## Mutation verification performed (both rounds)

Beyond the required red-before-fix, each round's guard change was verified
by deliberately breaking the fix and confirming the RIGHT tests catch it,
not just SOME test:

- Round 1 (pre-review): mutated `tightensOrEqual` to drop `matchOk` →
  confirmed the match-weakening tests (unit + e2e) went red, action/mode
  tests stayed green.
- Round 2 (post-review): mutated `tightensOrEqual` to drop `modeOk` →
  confirmed BOTH the unit-level AND (now-fixed) pipeline-level mode tests
  went red. This is the check that caught round 1's vacuous e2e test — the
  same mutation against round 1's version left the pipeline test green.

All mutations were reverted (`cp` from a pre-mutation backup, diffed to
confirm exact restoration) before the final build/test/commit.

## Regression check — non-floor rules stay freely overridable

`rule-parser.test.ts`'s existing regression test (`a NON-floor rule (no
level) is still freely overridable...`) and one added for this lane (`a
NON-floor rule is still freely overridable on mode and match...`) both
pass: a rule with no `level: protect` is untouched by any of these checks —
`existing.level === 'protect'` gates the whole guard, exactly as before.

## Files touched

- `packages/core/src/enforce/rule-parser.ts` — `MODE_STRENGTH`,
  `modeStrength()`, `OVERRIDE_COSMETIC_FIELDS`,
  `OVERRIDE_STRENGTH_CHECKED_FIELDS`, `sameEnforcementSurface()` added;
  `mergeRules`' dedup loop extended (not rewritten) from a single
  `actionOk`-shaped check to `actionOk && modeOk && surfaceOk`.
- `packages/core/src/enforce/__tests__/rule-parser.test.ts` — 7 new tests:
  mode-weakening rejected, match-weakening rejected, mode-tightening
  honored, non-floor mode/match regression, plus (review round 1)
  filesystem `exclude` rejected, network `except` rejected, command
  `priority` demotion rejected — appended to the existing `mergeRules —
  floor rules cannot be weakened by scope` describe block.
- `packages/core/src/enforce/__tests__/protect-floor-mode-match-override.test.ts`
  — new file, 3 pipeline-level (end-to-end) tests; the mode test rebuilt in
  review round 1 to clone the real floor rather than hand-type YAML.
- `SECURITY.md` — "Residual on floor overrides" section rewritten to state
  the mode/enforcement-surface axes are now closed, with the exact
  combined rule and the exclusion-list rationale.
- `packages/cli/src/core/**` and `packages/cli/templates/keel-enforce.js` —
  NOT hand-edited; regenerated by `npm run build` from the core sources
  above, per this lane's binding constraints.

Not touched, not in scope for this lane: the four evasion classes SECURITY.md
already documents as open (intra-token quoting, variable indirection,
interpreter escape hatches beyond the self-protection case, symlink
redirection) — none of those are floor-override neutralization, they are
regex/matcher limitations on the rules themselves.
