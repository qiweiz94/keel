# Wave 3 · Lane 1 — Promotion pipeline (the friction-calibration payoff)

Worktree: `/Users/nanoclaw/code/keel-w3-promotion`, branch `w3-promotion`.

## 0. Environment

```
$ pwd && git branch --show-current && node --version
/Users/nanoclaw/code/keel-w3-promotion
w3-promotion
v26.0.0
$ npm ci
added 169 packages, and audited 174 packages in 1s
```

## 1. The prerequisite bug, confirmed before touching anything

`packages/core/src/enforce/pipeline.ts`'s `violation()` returned an
`EnforceResult` directly for `mode: observe` rules, and every call site is
`return this.violation(...)` inside one of two `for` loops in `evaluate()`.
That `return` exits `evaluate()` immediately — so a matched observe rule
didn't just skip its own enforcement, it terminated evaluation of the
*entire call*, hiding every lower-priority rule (observe or real) behind
it. This is the reverse of OPA Gatekeeper dryrun / Cloudflare WAF
log-mode, where a shadow policy records and evaluation continues.

## 2. The fix

`packages/core/src/enforce/pipeline.ts`:

- Added a module-scope `OBSERVE_CONTINUE` symbol (with a long header
  comment stating the invariant it depends on) and a `private
  observedMatches: Array<{rule_id, observed_action, message}>` instance
  field, reset at the top of every `evaluate()` call.
- `violation()`'s `mode: observe` branch now pushes to `observedMatches`
  and **throws** `OBSERVE_CONTINUE` instead of returning a result. Every
  existing `return this.violation(...)` call site is untouched — the
  throw is what makes that statement never complete.
- The two loops that ever call `violation()` (`for (const rule of
  statefulRules)` and the big tiered `for (const rule of rules)`) each
  wrap their body in `try { ... } catch (err) { if (err ===
  OBSERVE_CONTINUE) continue; throw err }` — record, then move to the
  next rule instead of exiting `evaluate()`.
- `evaluate()` itself is now a thin wrapper around a renamed
  `evaluateTiers()`: it resets `observedMatches`, calls `evaluateTiers()`
  (with a fail-safe catch for a stray escaped `OBSERVE_CONTINUE` — see the
  symbol's header comment for why an escape must degrade to `allow`, not
  reach the host, which rewrites any non-`[Keel]` throw into a hard
  block), then decorates the result:
  - `observed_matches` is always attached when non-empty (the complete,
    order-independent picture).
  - `observed_action` always mirrors `observedMatches[0]` — independent of
    the definitive verdict, since post-fix that verdict can be a REAL
    rule's deny/fix/prompt/warn instead of an observe-only bare allow.
  - `rule_id`/`rule_name`/`message` are borrowed from the first observed
    match **only** on a bare-allow verdict (no non-observe rule matched at
    all) — a definitive verdict from a real rule keeps its own identity.
- The tier-1 allow-cache write is now gated on `!this.observedMatches.length`
  too: a call that recorded an observe match must never cache a stale
  `allow`, or the next identical call would return from tier 1 before the
  rules loop — and the observe rule's shadow count — ever run again.

`packages/core/src/types.ts`: added `EnforceResult.observed_matches` and
`KeelConfig.promotion_fp_threshold`, both documented inline.

`packages/core/src/enforce/rule-parser.ts`: validates
`promotion_fp_threshold` (must be a number in `(0, 1]`), and adds
`DEFAULT_PROMOTION_FP_THRESHOLD = 0.001` + `winningPromotionThreshold()`
(project-over-global precedence, mirroring `winningLevelConfig()`).

## 3. Real bugs the fix surfaced (not hypothetical)

Running the pre-existing core suite after the fix, 5 tests failed — not
because the fix was wrong, but because they had baked in the OLD
short-circuit as "expected" behavior. Investigating each showed the
observe-continue bug was actively hiding two SHIPPED, real (`mode: block`)
enforcement rules whenever the observe rule `source-change-requires-test`
also matched on the same call:

```
$ npx vitest run src/enforce/__tests__/agentic-eval.test.ts src/enforce/__tests__/threat-model.test.ts
 FAIL  … > records (but does not enforce) commit/push boundaries …
AssertionError: expected 'fix' to be 'allow'
 FAIL  … > records (but does not enforce) a push boundary …
AssertionError: expected 'prompt' to be 'allow'
 Test Files  2 failed | 71 passed (76)
```

- `must-sign-commits` (mode: block, action: fix, priority 60) — auto-adds
  `--signoff` to `git commit`. Pre-fix, any `git commit` while
  `source-change-requires-test`'s observe boundary ALSO matched (i.e. an
  untested source change was on the books) silently skipped the
  auto-signoff, with nothing but a cosmetic `observed_action` to show for
  it.
- `no-push-to-main` (mode: block, action: prompt, priority 80) — approval
  gate on `git push … main`. Pre-fix, the exact same condition let a push
  straight to `main` sail through as a bare `allow` — the approval gate
  was silently disabled by an unrelated observe rule matching first.

Both are fixed by the observe-continue change: the real rule's verdict now
wins, and the observe rule's `observed_action` is still recorded
alongside it. The five tests were updated to assert the corrected
behavior (see `packages/core/src/enforce/__tests__/agentic-eval.test.ts`
and `threat-model.test.ts` — each edit is commented with the finding).

## 4. Tests for the fix itself

`packages/core/src/enforce/__tests__/pipeline.test.ts`'s "observe mode"
describe block gained four cases:

```
$ npx vitest run src/enforce/__tests__/pipeline.test.ts
 Test Files  1 passed (1)
      Tests  47 passed (47)
```

- `an observe match no longer blinds a later real deny rule on the same
  call` — deny still fires as the verdict; `observed_action`/
  `observed_matches` still carry the observe rule's would-be action. (a)
- (the same test doubles as (b): `observed_action` is asserted alongside
  the real verdict.)
- `two observe rules on the same call both record` — both land in
  `observed_matches`, bare allow verdict. (c)
- `a repeated identical call re-evaluates and re-records instead of
  returning a stale cached allow` — proves the tier-1 cache-write guard.

`packages/core/src/enforce/__tests__/claim.test.ts`'s "gate-integration
ordering" describe block (the documented order-dependent finding) is
rewritten per the prerequisite's instructions: both file-order variants
now assert the SAME invariant — `action: allow`, `observed_matches` has
both `source-change-requires-test` and `claim-without-evidence`, in
either declaration order:

```
$ npx vitest run src/enforce/__tests__/claim.test.ts
 Test Files  1 passed (1)
      Tests  25 passed (25)
```

## 5. Core suite, post-fix

```
$ npx vitest run --no-file-parallelism   # packages/core
 Test Files  24 passed (24)
      Tests  439 passed | 2 skipped (441)
```

(436 baseline + 3 new pipeline.test.ts cases; claim.test.ts's two
gate-integration tests were rewritten in place, net zero count change.)

## 6. Promotion computation (`packages/cli/src/commands/retrospective.ts`)

Reuses the existing trace reader (`loadTraceEntries`) and the existing
`isBefore()` before-hook filter (now exported) — no second parser.
`computePromotionReport(entries, rules, threshold, projectDir?)` is a pure
function: denominator = tracked before-hook evaluations; would-block
count = entries (top-level `rule_id`/`observed_action`, OR
`observed_matches[]`) where `observed_action` is
`deny`/`block`/`prompt`/`redirect`. Three recommendations, not two —
`insufficient_data` is distinct from `eligible`/`stay_observe`, gated on
`total_evaluations >= ceil(1/threshold)` (1000 evaluations at the default
0.001 threshold), so a rate of zero over a handful of calls is never
reported as proof of safety.

Two correctness findings from review, fixed before committing:

- **`redirect` is a would-block, not a soft signal.** `isWouldBlock`
  originally excluded it (`deny|block|prompt` only). Checked against
  `opencode-plugin/src/plugin.ts`'s `before()` hook: `if (result.action
  === 'redirect') { ... throw new Error('[Keel] REDIRECT ...') }` — it
  throws exactly like deny/block/prompt do; the tool call does not
  proceed. Three of the six rules this pipeline exists to serve
  (`no-repeat-loops`'s escalation ladder, `research-before-fix`,
  `root-cause-before-refactor`) use `redirect` as their primary
  interrupting action, so excluding it would have made every one of them
  measure a false-positive rate of zero no matter how often they actually
  fired — the promotion recommendation structurally blind to the
  interruptions it exists to count. Fixed; a test locks in that `redirect`
  now counts (`retrospective.test.ts`: "redirect DOES count as
  would-block").
- **A project-scoped rule's denominator was inflated by every other
  project's traffic.** `collectObserveRuleIds` returns `{id, scoped}` —
  `scoped: true` for a rule declared in a project/local rules.yaml.
  `computePromotionReport`'s `projectDir` parameter filters the
  denominator (and would-block count) to entries whose `cwd` falls under
  that project for scoped rules only; unscoped (global/user) rules keep
  the full trace stream, since they genuinely apply everywhere. Without
  this, a project-only rule's rate was diluted by calls it was never even
  loaded against, silently pushing it toward `eligible`.

```
$ npx vitest run src/__tests__/retrospective.test.ts   # packages/cli
 Test Files  1 passed (1)
      Tests  29 passed (29)
```

Covers: denominator counts only tracked before-hook entries (untracked
agent / after-hook entries excluded, denominator asserted nonzero);
insufficient_data below the evaluation floor even at a 0% rate; eligible
strictly below threshold, stay_observe at-or-above (an exactly-at-threshold
case is asserted `stay_observe`, not `eligible` — "below" is strict);
warn/fix recorded but not counted, redirect counted; the
`observed_matches` multi-match shape counted correctly per rule id; every
requested rule id reported even with zero matches; project-scoped
denominator excludes another project's traffic (and includes it when
`projectDir` is omitted); `collectObserveRuleIds` scope tagging + dedup
across the hierarchy (including a project-only rule with no global
declaration at all).

### Real CLI output sample (isolated HOME + KEEL_TRACES_DIR, no real user data)

```
$ ( cd "$WORKDIR" && env -i HOME="$HOMEDIR" PATH="$PATH" KEEL_TRACES_DIR="$HOMEDIR/.keel/traces" \
    node packages/cli/dist/index.js retrospective )

  ⚓ keel retrospective
  earliest → 2026-08-11
  …
  Promotion (mode: observe rules, threshold 0.01 = 1.00% would-block rate)
    demo-quiet-observer           eligible for promotion to warn
      1 would-block(s) in 150 evals, this project (0.667%) — eligible for promotion to warn
    demo-noisy-observer           eligible for promotion to warn
      0 would-block(s) in 150 evals, this project (0.000%) — eligible for promotion to warn
    Promote with: keel promote <rule-id> (run from your own terminal — never through the agent)
```

`promotion_fp_threshold: 0.01` was set in the project's rules.yaml
top-level for this demo (not hardcoded — `winningPromotionThreshold()`
reads it, project over global, default `DEFAULT_PROMOTION_FP_THRESHOLD =
0.001` otherwise). Both demo rules are project-scoped (declared only in
the demo project's rules.yaml, not global) — the "this project" label
confirms the denominator was correctly scoped to this project's own 150
synthetic traces, not some other project's traffic mixed in.

## 7. `keel promote` (`packages/cli/src/commands/promote.ts`)

TTY-gated with the exact guard `keel rules harness --append` uses
(`process.stdin.isTTY` + `KEEL_ALLOW_NON_TTY`, `packages/cli/src/commands/rules.ts:175`).
Surgical, comment-preserving line-based writer (`writeRuleMode`) mirroring
`level.ts`'s `writeRulesLevel`, scoped to one rule's block. Idempotent at
both the writer and command level.

```
$ node dist/index.js promote demo-quiet-observer < /dev/null
  `keel promote` edits your rules.yaml, so it must be run from your own terminal.
  Run `keel retrospective` to see promotion recommendations instead.
exit=1

$ KEEL_ALLOW_NON_TTY=1 node dist/index.js promote demo-quiet-observer < /dev/null
  ✓ demo-quiet-observer: mode observe → warn
  …/.keel/rules.yaml
exit=0

# rules.yaml after — inline comment preserved, only the mode: line changed:
  - id: demo-quiet-observer
    type: command
    match: "git push origin main"
    action: deny
    mode: warn
    # inline comment worth preserving
    message: "Would deny a push to main."

$ KEEL_ALLOW_NON_TTY=1 node dist/index.js promote demo-quiet-observer --to warn < /dev/null
  "demo-quiet-observer" is already mode: warn. No change.
exit=0
```

Unit tests (`packages/cli/src/__tests__/promote.test.ts`):

```
$ npx vitest run src/__tests__/promote.test.ts
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

Covers: comment/unrelated-rule preservation, block-boundary correctness
(a rule declared AFTER the target is untouched), inserting `mode:` when
absent, idempotency (byte-identical file on a repeat write), unknown-id
handling, the TTY refusal + `KEEL_ALLOW_NON_TTY` escape hatch + genuine-TTY
path, the observe→warn default ladder, an explicit `--to` override, and
"already at full enforcement" (no mode field, no `--to`) reporting nothing
to promote rather than erroring.

## 8. Agent cannot run `keel promote`

`keel-control-gate`'s `match` regex, in BOTH
`packages/opencode-plugin/src/plugin.ts` and
`packages/cli/src/commands/install.ts` (kept byte-identical —
`drift.test.ts` compares full rule objects between the two copies),
extended from:

```
"keel (disable|allow|level|enforce|install|uninstall)( |$)|keel rules [^|;&]*--append"
```

to:

```
"keel (disable|allow|level|enforce|install|uninstall|promote)( |$)|keel rules [^|;&]*--append"
```

`packages/cli/src/__tests__/control-gate.test.ts` gained a case
(`'keel promote no-repeat-loops'`) in the gated list — the file's own
header note ("every NEW mutating subcommand is un-gated by default")
means this had to be added by hand, not inferred.

## 9. Trace plumbing: the one write site that matters

`packages/opencode-plugin/src/plugin.ts`'s `before()` hook (the ONLY
production trace writer — `packages/cli/src/commands/enforce.ts`'s
`AuditLog` path writes `agent: 'unknown'`, which `isBefore()` already
filters out, so it was never the promotion data source) now also passes
`observed_matches: result.observed_matches` to `record()`, alongside the
existing `observed_action`. `TraceEntry` in retrospective.ts gained both
fields.

## 10. Full build + suites

```
$ npm run build   # from repo root, all four workspaces
> @get-keel/core build … dist/keel-core.mjs  131.7kb
> @get-keel/cli build … (tsc, clean)
> @get-keel/mcp-server build … (tsc, clean)
> @get-keel/opencode-plugin build … dist/index.js  375.7kb
```

```
$ npx vitest run --no-file-parallelism   # packages/core
 Test Files  24 passed (24)
      Tests  439 passed | 2 skipped (441)

$ npx vitest run --no-file-parallelism   # packages/cli
 Test Files  58 passed (58)
      Tests  1027 passed | 16 skipped (1043)
```

Baseline stated in the assignment: core ~436, cli ~997 (both approximate
in the assignment itself). Measured before any edit in this lane (core,
full suite): 436 passed. Measured after (§5): 439 passed — net +3, from
pipeline.test.ts's four new observe-continue cases offset by
claim.test.ts's two rewritten gate-integration tests collapsing into two
`it.each` variants (net zero there). The cli total above (1027 passed +
16 skipped, single-threaded) is the authoritative post-change number —
read that, not an arithmetic reconstruction from the assignment's
approximate baseline; it includes `promote.test.ts` (12 new tests),
`retrospective.test.ts`'s `computePromotionReport`/`collectObserveRuleIds`
describe blocks (14 tests, counted directly:
`sed -n '/describe(.computePromotionReport/,$p' … | grep -c '^\s*it('`),
and one new gated case in `control-gate.test.ts`.

### A pre-existing flake, found and ruled out during verification

Default (parallel-file) `npx vitest run` in `packages/cli` was
intermittently flaky — `public-v1.test.ts`'s "inherits the configured
protection level" failed once, `level-reload.test.ts`'s sprint-expiry test
failed on a different run, both passed clean on a third run, and
`--no-file-parallelism` (single-threaded) was 100% green across three
repeated runs. Checked each file's isolation directly: `level-reload.test.ts`
overrides `process.env.HOME` around its `StateManager` (properly
sandboxed); `public-v1.test.ts` does **not** — it calls `initEnforce()`/
`evaluateToolCall()` straight against the real `$HOME`, and this machine's
real `~/.keel/rules.yaml` has ~30 rules including three live `mode:
observe` ones. That is a real, pre-existing test-isolation gap in
`public-v1.test.ts`, independent of this lane (it predates every file this
lane touched, and neither failing test exercises `mode: observe`,
`violation()`, or `observed_matches`). Consistent with vitest's parallel
worker pool occasionally interleaving that file's real-`$HOME` access
against unrelated concurrent state. Reported here rather than silently
worked around, and not fixed (out of this lane's scope — it would mean
editing a test file this lane has no other reason to touch);
`--no-file-parallelism` is what every suite run in this evidence file
uses, and it was 100% green across all repeats.

## 11. Files touched

- `packages/core/src/enforce/pipeline.ts` — the observe-continue fix.
- `packages/core/src/types.ts` — `observed_matches`, `promotion_fp_threshold`.
- `packages/core/src/enforce/rule-parser.ts` — threshold validation + default + precedence helper.
- `packages/core/src/enforce/__tests__/pipeline.test.ts` — 4 new observe-continue cases.
- `packages/core/src/enforce/__tests__/claim.test.ts` — gate-integration ordering rewritten.
- `packages/core/src/enforce/__tests__/agentic-eval.test.ts`, `threat-model.test.ts` — 5 assertions corrected to the fixed (real-rule-wins) behavior.
- `packages/cli/src/commands/retrospective.ts` — promotion section, `computePromotionReport`, `collectObserveRuleIds`, exported `isBefore`, `KEEL_TRACES_DIR` read live.
- `packages/cli/src/commands/promote.ts` (new) — `keel promote`, `writeRuleMode`.
- `packages/cli/src/index.ts` — wires `keel promote`.
- `packages/cli/src/__tests__/retrospective.test.ts` — promotion pipeline tests.
- `packages/cli/src/__tests__/promote.test.ts` (new) — writer + command tests.
- `packages/cli/src/__tests__/control-gate.test.ts` — gated case for `keel promote`.
- `packages/opencode-plugin/src/plugin.ts` — `keel-control-gate` regex + `observed_matches` in the trace write.
- `packages/cli/src/commands/install.ts` — `keel-control-gate` regex (kept identical to plugin.ts).
- `packages/cli/templates/keel-enforce.js` — regenerated by `npm run build` (not hand-edited).
- `packages/cli/src/core/*` — regenerated by `npm run build` (not hand-edited, gitignored).

Never touched: `packages/cli/src/core/`, `packages/cli/templates/keel-enforce.js` by hand (both are build outputs, regenerated via `npm run build` per the binding constraint).
