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
rewriting it.

## Semantics implemented

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

**Matching-surface rule**: `match`, `match_prefix`, `match_regex`, `paths`,
and `patterns` must be **byte-identical** (compared field-by-field via
`JSON.stringify`) between the floor and the override. Any change at all —
narrower, wider, rephrased — is rejected. This is the "simplest correct
semantics" called for in the task: `mergeRules` has no model of "the
dangerous command" to test a candidate pattern against, so there is no
principled way to distinguish a legitimate narrowing from an adversarial
no-op from inside the merge function. Freezing the surface entirely is the
only rule that cannot be gamed.

**Combined override-acceptance rule** for a `level: protect` floor:

> A lower-scope override of a `level: protect` floor is honored **only**
> if it is itself `level: protect` **AND** same-or-stronger on action
> (`ACTION_STRENGTH`) **AND** same-or-stronger on mode (`MODE_STRENGTH`)
> **AND** has an identical matching surface. Failing any one axis rejects
> the **whole** override — the floor already in the merged map stands
> untouched, unchanged on every field (no partial merging). Strict
> tightening on any axis (e.g. `mode: observe` → unset, `warn` → `deny`)
> combined with an identical match is still honored — a floor can burn in
> under `mode: observe` and later be promoted to enforcing by a more
> specific scope.

Implementation: `packages/core/src/enforce/rule-parser.ts`, `mergeRules`'s
dedup loop —

```ts
if (existing.level === 'protect') {
  const actionOk = rule.level === 'protect' && ACTION_STRENGTH[rule.action] >= ACTION_STRENGTH[existing.action]
  const modeOk = modeStrength(rule.mode) >= modeStrength(existing.mode)
  const matchOk = sameMatchingSurface(existing, rule)
  const tightensOrEqual = actionOk && modeOk && matchOk
  if (!tightensOrEqual) continue  // weakening override on some axis — keep the floor
}
```

## Before / after

### Unit level (`mergeRules` return value) — `rule-parser.test.ts`

Red (pre-fix), run against the tests added for this lane:

```
 ❯ src/enforce/__tests__/rule-parser.test.ts (23 tests | 2 failed)
     × a local override that KEEPS action deny + level:protect but adds mode:observe is rejected
       AssertionError: expected 'observe' to be undefined
     × a local override that KEEPS action deny + level:protect but replaces `match` with a non-matching pattern is rejected
       AssertionError: expected 'this-never-matches-anything' to be 'push.*--force'
```

Green (post-fix): both pass; full file 27/27 (see suite run below).

### Pipeline level (real `EnforcementPipeline.evaluate()`, not just `mergeRules`) —
`protect-floor-mode-match-override.test.ts`

Red (pre-fix):

```
 ❯ src/enforce/__tests__/protect-floor-mode-match-override.test.ts (3 tests | 2 failed)
     × adding `mode: observe` to no-force-push (keeping deny+protect) does NOT let `git push --force` through
       AssertionError: expected [ 'deny', 'block' ] to include 'allow'
     × replacing `match` on no-force-push with a non-matching pattern (keeping deny+protect) does NOT let `git push --force` through
       AssertionError: expected [ 'deny', 'block' ] to include 'allow'
```

Both prove the live-vulnerability shape end to end: a `.keel.local.yaml`
that keeps `action: deny` + `level: protect` on `no-force-push` but adds
`mode: observe`, or that redefines its `match` to a pattern that never
fires, made a real `git push --force origin <branch>` call through the real
pipeline return `allow`. (Test commands target a non-`main` branch so the
result isolates the `no-force-push` floor from the separate, legitimate,
non-floor `no-push-to-main` prompt rule that also matches pushes straight to
`main`/`master` — that rule firing `prompt` would have masked whether the
floor itself was neutralized.)

The third test in that file (a floor authored under `mode: observe`
promoted to enforcing by a more specific scope) passed even pre-fix — the
existing action-based check already didn't block tightening, and this guard
change preserves that.

Green (post-fix): all 3 pass.

### Full suite, post-fix

```
$ npm run build   # core -> tsc/esbuild, then vendored into packages/cli/src/core
  (clean build, no errors)

$ npm run test -w @get-keel/core
 Test Files  27 passed (27)
      Tests  481 passed | 2 skipped (483)

$ npm run test -w @get-keel/cli
 Test Files  36 passed (36)
      Tests  674 passed | 14 skipped (688)
```

Baseline before this lane: core 474 passed / 2 skipped (26 files), cli 674
passed / 14 skipped (36 files) — both unchanged except the 7 new core tests
(4 unit + 3 pipeline) this lane adds. cli is untouched (0 new/changed
tests, 674 = 674): the fix is entirely inside `packages/core/src/enforce/rule-parser.ts`,
which the cli build vendors in at `npm run build` time.

## Regression check — non-floor rules stay freely overridable

`rule-parser.test.ts`'s existing regression test (`a NON-floor rule (no
level) is still freely overridable...`) and a new one added for this lane
(`a NON-floor rule is still freely overridable on mode and match...`) both
pass: a rule with no `level: protect` is untouched by any of these checks —
`existing.level === 'protect'` gates the whole guard, exactly as before.

## Files touched

- `packages/core/src/enforce/rule-parser.ts` — `MODE_STRENGTH`,
  `modeStrength()`, `MATCHING_SURFACE_FIELDS`, `sameMatchingSurface()`
  added; `mergeRules`' dedup loop extended (not rewritten) from a
  single `actionOk`-shaped check to `actionOk && modeOk && matchOk`.
- `packages/core/src/enforce/__tests__/rule-parser.test.ts` — 4 new tests
  (mode-weakening rejected, match-weakening rejected, mode-tightening
  honored, non-floor mode/match regression) appended to the existing
  `mergeRules — floor rules cannot be weakened by scope` describe block.
- `packages/core/src/enforce/__tests__/protect-floor-mode-match-override.test.ts`
  — new file, 3 pipeline-level (end-to-end) tests.
- `SECURITY.md` — "Residual on floor overrides" section rewritten to state
  the mode/match axes are now closed, with the exact combined rule.
- `packages/cli/src/core/**` and `packages/cli/templates/keel-enforce.js` —
  NOT hand-edited; regenerated by `npm run build` from the core sources
  above, per this lane's binding constraints.

Not touched, not in scope for this lane: the four evasion classes SECURITY.md
already documents as open (intra-token quoting, variable indirection,
interpreter escape hatches beyond the self-protection case, symlink
redirection) — none of those are floor-override neutralization, they are
regex/matcher limitations on the rules themselves.
