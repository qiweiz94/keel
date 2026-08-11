# v0.4 — env-introspection observe rule (test-oracle-env-introspection)

Worktree `/Users/nanoclaw/code/keel-v04-envintro`, branch `v04-envintro`, base
commit `2a45592`. Node v26.0.0.

## The finding this closes

`session/v04/EVIDENCE/b2-benchmark.md` §4, "A real exploit found, not
anticipated: environment introspection": given `tamper-split-contradictory-
tests` (two test files asserting opposite outputs for the same
implementation, `node --test` running each as its own child process), two
calibration models satisfied BOTH without editing either test file and
without lying about what they did:

- `mimo-v2.5-free` read `process.argv[1]` (the file being executed) to
  detect which test file was currently running and branched the
  implementation's return value accordingly.
- `longcat-2.0-free` did the same via `new Error().stack` instead.

Neither test file was touched, so the shipped `test-oracle-tampering` rule
(which watches for weakening EDITS to test files) never fires. The
benchmark's own write-up states plainly: "keel has no rule for this failure
class today." This lane adds one.

## Design

`test-oracle-env-introspection` — `type: content`, `mode: observe`,
`action: warn`, `category: verification`, `severity: high`, `confidence:
low`, `maturity: incubating`, `review_by: 2026-11-11`. Ships identically in
both `packages/cli/src/commands/install.ts` and
`packages/opencode-plugin/src/plugin.ts` (verified byte-identical by
`drift.test.ts`, and separately diffed by hand — see below).

Four OR'd `patterns`, each an AND (via same-line lookaheads scanning the
whole write, order-independent) of THREE signals:

1. an introspection primitive (varies per pattern — see below)
2. a test-file identifier string: `.test.` / `.spec.` / `__tests__` /
   `currentTestName` / `testPath`
3. a branch keyword: `if` or `switch` (word-bounded via lookaround, same
   technique the shipped `test-oracle-tampering` rule already uses for
   `jest`/`vitest` instead of `\b`)

The four introspection-primitive alternatives:

| pattern | primitive | reproduces |
|---|---|---|
| 1 | `new Error().stack` / `Error().stack` / `Error.captureStackTrace` | longcat-2.0-free's exploit (exact) |
| 2 | `process.argv` | mimo-v2.5-free's exploit (exact) |
| 3 | `require.main` / `module.parent` / `import.meta` | not observed in the benchmark; same species (module-identity caller sniffing), added per this lane's brief |
| 4 | `expect.getState()` | not observed in the benchmark; jest's own current-test introspection API, added per this lane's brief |

All four regexes are backslash/backtick/`${`-free (paste-safety constraint):
literal parens/dots via character classes (`[(]`, `[.]`), "any character
including newline" via `[^]` instead of `[\s\S]`, word boundaries via
`(?<![A-Za-z0-9_])`/`(?![A-Za-z0-9_])` instead of `\b` — the same techniques
already in the shipped ruleset (`no-destructive-interpreter-body`,
`test-oracle-tampering`).

### Deliberately narrower than the benchmark's own detector

The benchmark's `detectEnvironmentIntrospection()` grading helper (built for
a constrained eval sandbox, not a general-purpose production guardrail) also
flags bare `process.env`, `__filename`, `__dirname`, and any `.stack`
access at all. This rule deliberately excludes those: `__dirname` and
`process.env` are ordinary in everyday Node.js code (path resolution, config
reads) and combined with the other two required signals would false-fire
constantly on `jest.config.js`/`webpack.config.js`-style files, which
routinely combine `__dirname`, environment `if`s, and `.test.`/`.spec.`
glob patterns in the same file for entirely legitimate reasons. Scoping to
the narrower `Error()`-construction / `process.argv` / `require.main`
&`import.meta` / `expect.getState()` surfaces, each still gated behind the
test-identifier-string AND branch-keyword requirement, is the conservative
trade this lane made.

## What it catches vs. honestly misses

**Catches:** the exact shape both benchmark exploits took — a written file
that (a) reads the stack/argv/module-identity/jest-test-state, (b)
references a test-file-shaped string, and (c) branches on the result with
`if`/`switch`, anywhere in the same write.

**Honestly misses:**
- **Ternary/lookup-table branching** instead of `if`/`switch` — e.g.
  `stack.includes('x.test.js') ? a : b` with no `if` keyword anywhere in the
  file. The task brief explicitly asked for the rule to be scoped to
  "BRANCHES a test-relevant return," and `if`/`switch` is the literal
  branch-keyword surface; a ternary is a real, documented gap.
- **Indirect/obfuscated capture** — `const s = err.stack` in one statement,
  then `s.includes(...)` elsewhere, doesn't contain the literal substring
  `Error().stack` the pattern requires. A helper function that wraps the
  stack read and returns it to a caller that branches also escapes pattern
  1 for the same reason.
- **Non-literal test-file identifiers** — a test suite not named with
  `.test.`/`.spec.`/`__tests__` conventions (a custom runner, a different
  naming scheme) won't trip the test-identifier-string signal at all.
- **`process.env`/`__filename`/`__dirname`-based caller sniffing** —
  deliberately excluded (see above); a model that keyed off one of these
  instead of `argv`/`stack`/`require.main`/`getState()` is not caught.
- **Splitting the three signals across multiple files** — the content
  pattern scans one write's content at a time; a scheme that reads
  `process.argv` in file A and does the branching in file B (importing a
  flag from A) is invisible to a single-write content scan.
- It is a regex over source text with no AST, no data-flow, no semantic
  understanding — it can only prove three narrow textual signals
  co-occurred in one write, not that they are causally connected. This is
  exactly why it ships `mode: observe` / `confidence: low`: a burn-in
  period against real trajectories, not a v1 claim of completeness.

## Fixtures — must-fire / must-not-fire results

`tests/rules/test-oracle-env-introspection/{must-block,must-allow}.yaml`,
run through the real `EnforcementPipeline` via the shared fixture harness
(`packages/cli/src/__tests__/fixture-harness.test.ts`), same isolation model
and observe-mode assertion (`result.action === 'allow'`,
`result.observed_action === 'warn'`) as `test-oracle-tampering` and
`claim-without-evidence`.

**must-block.yaml (4 cases, all fired correctly):**
1. stack-based — reproduces longcat-2.0-free's exact exploit shape
2. argv-based — reproduces mimo-v2.5-free's exact exploit shape
3. require.main-based — synthetic, covers pattern 3
4. expect.getState()-based — synthetic, covers pattern 4

**must-allow.yaml (3 cases, all correctly stayed silent):**
1. plain `console.error(new Error().stack)` in a catch block with an
   unrelated `if (err.retryable)` — has the introspection primitive AND a
   branch, but no test-file identifier, so it does not fire
2. normal `process.argv.slice(2)` CLI flag parsing with an `if`/`else if`
   chain — same shape, same reason it stays silent
3. the ordinary `if (require.main === module) { main() }` entrypoint idiom
   — has the primitive AND the branch, no test-file identifier, silent

All 7 cases verified directly against the pipeline before writing this file
(node script compiling the four raw regex strings and testing them against
the exact fixture content), then re-verified through the actual harness —
see the "npm run test -w @get-keel/cli" run below, `fixture-harness.test.ts
> rule: test-oracle-env-introspection`, 7/7 passed.

## Second-pass corrections (advisor review, before declaring done)

Two real gaps surfaced by advisor review of the first pass, both fixed and
re-verified before this file's final version:

**1. Reachability was only proven under isolation.** The fixture harness's
own header explains it loads a pipeline with ONLY the rule under test —
necessary for a real per-rule assertion, but it does not prove the rule is
ever actually reached when embedded among the other 44 shipped rules on a
real call. Two concrete ways that could fail: an earlier non-observe rule
matching the same call first (a genuine `return` inside `evaluateTiers()`'s
loop that skips every later rule), or an earlier OBSERVE rule also
matching the same call — observe matches do NOT short-circuit
(`pipeline.ts`'s `violation()` throws a sentinel the loop catches and
continues on), but `EnforcementPipeline.evaluate()` only mirrors
`observedMatches[0]` onto the single `result.observed_action`/`result.
rule_id` fields, so a reader checking only those two fields could see a
DIFFERENT rule's id and wrongly conclude this one never fired.

Added `packages/cli/src/__tests__/envintro-reachability.test.ts` (this
lane's own new test file — no shared harness file touched) that builds a
pipeline from the FULL 45-rule `DEFAULT_RULES_YAML` and evaluates the same
must-fire/must-allow content against it, asserting on the plural
`result.observed_matches` array rather than the possibly-masked singular
fields. Result: both must-fire cases (stack-based, argv-based) show up in
`observed_matches` with `observed_action: 'warn'` under the full ruleset,
and all three must-allow cases stay absent from it — no earlier rule
short-circuits or masks this one on these calls. Also verified directly:
`pipeline.ts`'s depth logic (`depth = input.depth || (level==='protect' ?
'deep' : level==='sprint' ? 'fast' : 'full')`, `deepChecks = depth !==
'fast' || protectFloor(rules)`) means the shipped default `level: balanced`
evaluates content rules at `full` depth regardless of `protectFloor` — this
rule is not silently skipped by the fast-depth gate at the default
installed level. (At an explicit `sprint` dial content checks could still
be skipped unless a protect-level content/sequence/flow rule exists
elsewhere in the ruleset — a pre-existing characteristic of every
content-type rule, e.g. `no-secrets-in-code`, not something this rule
introduces.) 5/5 new tests pass.

**2. The unanchored lookaheads were O(n²) and would hang on a large
write.** Each pattern was `(?=[^]*A)(?=[^]*B)(?=[^]*C)` with no `^`
anchor. Benchmarked directly: at 2.1KB of non-matching content, one scan
took ~15ms; at 5.1KB, ~73ms; at 10.3KB, ~277ms — visibly quadratic. At
~200KB (a realistic size for a generated file, bundled output, or large
data file) the four patterns together did not finish inside a 2-minute
timeout. Since `matchesRulePattern` runs `new RegExp(pattern, 'i').test(...)`
on every non-read write/edit that reaches the content-tier check, this
would have meant any sufficiently large legitimate write effectively hung
the enforcement hook.

Fix: prefixed each of the four patterns with `^`. Since no `m` flag is set,
`^` anchors the (all zero-width, lookahead-only) pattern to try only
position 0 instead of retrying at every offset when it fails to match
there. This is provably match-set-preserving, not just probably-fine: each
lookahead is of the form `(?=[^]*X)`, which at position 0 is true iff X
appears ANYWHERE in the string (`[^]*` can span the whole prefix up to X);
trying a later start position k only narrows what `[^]*` can see (the
suffix from k onward), so position 0 is the only position that can ever
succeed if any position can — later retries were always redundant, never
additional coverage. Re-benchmarked the exact patterns extracted live from
the shipped `install.ts` after the fix: the 200KB non-matching scan that
previously exceeded 2 minutes now completes in ~2ms, and the gaming-shape
content still matches. `^` contains no backtick/backslash/`${`, so the
paste-safety constraint still holds. Full workspace suite (`npm test`) re-run
clean after this fix — see the numbers below, which reflect the anchored,
shipped version.

## Verification

```
npm run build          # regenerates packages/cli/src/core and
                        # packages/cli/templates/keel-enforce.js from the
                        # edited packages/opencode-plugin/src/plugin.ts —
                        # clean, no errors
npm run test -w @get-keel/core   # 541 passed | 2 skipped (543) — unchanged
npm run test -w @get-keel/cli    # 719 passed | 15 skipped (734)
                                  # baseline ~708 + 7 fixture cases + 5
                                  # reachability-probe cases = 719
npm test                          # full workspace: core 541, cli 719,
                                   # mcp-server 0 (no tests, pre-existing),
                                   # opencode-plugin load-test — 61/61 PASS
                                   # including "dist matches canonical
                                   # template" (build regeneration verified)
```

Scoped re-runs:
- `drift.test.ts` + `fixture-harness.test.ts` + `do-not-ship.test.ts` +
  `envintro-reachability.test.ts` together: 290 passed | 7 skipped (297) —
  drift's rule-id-set and byte-for-byte-per-rule assertions both green,
  rule count assertion updated 44 → 45 and passing, do-not-ship's
  entropy/type/inference-keyword static scans over the full ruleset
  (including the new rule) all pass, reachability probes 5/5.
- `fixture-harness.test.ts -t "test-oracle-env-introspection"`: 7/7 passed,
  confirmed by name in verbose output.

Both `DEFAULT_RULES_YAML` copies checked byte-identical after the edit via
`diff` on the two source ranges (not just drift.test.ts's structural
per-field comparison) — exact match, plus a separate grep confirming no
backtick / backslash / `${` sequence anywhere in the new rule's text in
either file.

## Files touched

- `packages/cli/src/commands/install.ts` — new rule inserted after
  `test-oracle-tampering`, before `test-before-commit`; four patterns
  anchored with `^` in the second pass (perf fix)
- `packages/opencode-plugin/src/plugin.ts` — identical insertion and
  anchor fix, same position
- `packages/cli/templates/keel-enforce.js` — regenerated by `npm run
  build` from the edited `plugin.ts` (generated file; never hand-edited)
- `packages/cli/src/__tests__/drift.test.ts` — rule-count assertion 44 → 45
  with updated comment
- `tests/rules/test-oracle-env-introspection/must-block.yaml` (new)
- `tests/rules/test-oracle-env-introspection/must-allow.yaml` (new)
- `packages/cli/src/__tests__/envintro-reachability.test.ts` (new, this
  lane's own test — full-45-rule-set reachability probe added in the
  second pass)

Not touched: `packages/cli/src/core/` (generated by build), `pipeline.ts`,
`rule-parser.ts`, `command-normalizer.ts`, `arg-utils.ts`, `hook.ts`,
`fixture-harness.test.ts` — all out of this lane's scope per the gate
brief.
