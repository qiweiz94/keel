# v0.4 M1/A2 — shell-parse normalization

Closes the regex-bypass classes described in SECURITY.md "Four classes of
evasion that no regex rule closes" by matching `type: command` rules against
a NORMALIZED command surface (in addition to the raw string) instead of the
raw string alone. Node v26.0.0, branch `v04-shellparse`, base commit
`0dab263`.

## What shipped

- **New file** `packages/core/src/enforce/command-normalizer.ts` —
  `normalizeCommand(raw, depth = 0): NormalizedCommand`. Hand-rolled,
  dependency-free (checked `packages/core/package.json` first — the only
  runtime dep is `yaml`; no shell-lexer lib in the tree, and the task calls
  for zero new deps). Tokenizes with quote-aware POSIX-ish word-splitting,
  splits compound commands on `;`/`&&`/`||`/`|`/`&`/newline (quote-aware, so
  a separator character inside a quoted span is not a boundary), does a
  single bounded left-to-right pass of literal `VAR=value` expansion for
  `$VAR`/`${VAR}`, strips leading env-assignment prefixes per sub-command,
  and extracts interpreter one-liner bodies (`sh|bash|dash|zsh|ksh -c`,
  `python(2/3)? -c`, `node -e/--eval`, `perl -e/-E/-p`), recursing one level
  into shell bodies. Full mechanism + every honest limit is documented in
  the module's header comment; do not re-derive it from this file, that
  comment is the source of truth.
- **Edited** `packages/core/src/enforce/arg-utils.ts` — added
  `commandSurfaces(input): string[]`, additive: `surfaces[0]` is always
  `commandString(input)` (the pre-existing raw text), so nothing that
  matched before this landed can stop matching. `commandString()` itself is
  UNCHANGED — callers that need the literal raw command (fix-mutation,
  the stuck-loop fingerprint via `recordAttemptOutcome`, `type:
  env`/`stuck`/`diagnosis`/`research` matching) keep using it directly and
  are untouched by this lane, on purpose: normalizing those surfaces would
  change fingerprint identity and dedup keys that have nothing to do with
  the bypass classes this lane targets.
- **Edited** `packages/core/src/enforce/pipeline.ts` — only the `type:
  command` matcher (`rule.match`/`rule.match_regex`/`rule.match_prefix`) now
  tests against `cmdSurfaces` (computed lazily once per `evaluate()` call
  via `cmdSurfaces ??= commandSurfaces(input)`, not per rule — the loop can
  iterate dozens of rules per call). No other rule type (`rate`, `time`,
  `stuck`, `diagnosis`, `env`, `research`) was touched — deliberately, to
  keep blast radius to exactly what the binding constraint named ("the
  command-matching call sites").

  **Two exceptions stay pinned to the raw string (`cmdStr`) only, found on
  review before landing — both would otherwise have broken the additive
  guarantee this whole lane rests on:**
  - `unless` patterns are checked against `cmdStr` alone, not the wider
    surface set. Widening `unless` with the same `some()` used for the
    match check is not conservative, it's subtractive — a normalized-only
    surface could satisfy an exception the raw string never satisfied,
    exempting a command that denied before this lane existed. (Regression
    test: `shell-normalize-bypass.test.ts` → "`unless` stays raw-only".)
  - A `fix`-actioned rule's TRIGGER (not just its mutation) is matched
    against `cmdStr` alone. `fixAction()` mutates and reports the raw
    command text unconditionally once called, and `violation()`'s own
    internal fix branch (reached if a rule is matched a different way) does
    the same without re-checking the pattern — so a normalized-only match
    on a `fix` rule would have produced a PHANTOM fix:
    `fix_result.original === fix_result.fixed`, a receipt claiming a
    mutation that the raw command never actually contained grounds for.
    Caught via `git com"m"it -m "..."` against the shipped
    `must-sign-commits` rule (`match: "git commit(?!.*--signoff)"`) — raw
    string never contains the substring `git commit`, only the normalized
    surface does. (Regression test: "a fix-actioned rule cannot
    phantom-fix off a normalized-only match".) Fix rules therefore get
    exactly their pre-A2 behavior end to end (no benefit from
    normalization) — an intentionally conservative choice, since
    auto-mutation is a different hazard class than the deny/prompt bypass
    classes this lane targets.

    Blast-radius note: `must-sign-commits` is `level: sprint`, `priority:
    60`; `no-destructive-commands` and `keel-control-gate` are `level:
    protect`. `pipeline.ts`'s tier-2/3 loop is first-match-wins over the
    full priority-sorted rule list, so on any command that ALSO matched a
    higher-priority floor pattern, the floor would have won before
    `must-sign-commits` was ever reached — the (now-closed) phantom-fix
    exposure was real but was confined to commands matching a `fix`-type
    rule's pattern via normalization AND no higher-priority rule's pattern
    at all, not "any `fix` rule, any time." The fix (raw-only gating) is
    unaffected by this scoping either way; noted here only so the finding
    isn't overstated.
- **Edited** `SECURITY.md` — "Four classes of evasion" rewritten with the
  measured before/after per class (below) and the honest residual per
  class, plus a caveat that the `echo "rm -rf /"` false positive predates
  this lane and is not something A2 could close under the additive
  constraint (nor is it this lane's rule-set to edit).
- **New tests**:
  `packages/core/src/enforce/__tests__/command-normalizer.test.ts` (17
  whitebox tests — tokenizer, compound-split, var-expansion bound,
  interpreter recursion + depth cap, perf caps, never-throws) and
  `packages/core/src/enforce/__tests__/shell-normalize-bypass.test.ts` (18
  tests: 15 against the REAL shipped `DEFAULT_RULES_YAML`, loaded the same
  way `threat-model.test.ts` does — never a hand-written test-only rule —
  plus 3 regression tests for the `unless`/`fix` raw-only gating above, 2 of
  which use a small local rule to isolate the exact mechanism being
  guarded).
- **Regenerated (not hand-edited)** `packages/cli/templates/keel-enforce.js`
  — this is `opencode-plugin`'s esbuild bundle of `plugin.ts`, which imports
  the core sources this lane changed; running the root `npm run build`
  (which builds `core` → `cli` → `mcp-server` → `opencode-plugin` in
  workspace order) regenerates it and `git status` confirmed it changed.
  `packages/cli/src/__tests__/drift.test.ts` independently guards that this
  template stays in sync with the two `DEFAULT_RULES_YAML` copies (which
  this lane did not touch) — green after the rebuild, see suite results.

## Method (reproducible)

Baseline verdicts were MEASURED against the current build before writing
the normalizer (`node -e` running the exact shipped regexes from
`packages/cli/src/commands/install.ts` against each corpus string), not
assumed — the advisor flagged that several of the task's "must be new
catches" bypass examples already denied on the raw string today because the
shipped patterns are unanchored substring searches. The table below
reports the MEASURED pre-A2 verdict and the MEASURED post-A2 verdict (via
`packages/core/src/enforce/__tests__/shell-normalize-bypass.test.ts`,
loading the real default rules).

## Per-bypass-class before/after (measured)

| command | rule under test | pre-A2 (measured) | post-A2 (measured) | class |
|---|---|---|---|---|
| `r"m" -rf /` | no-destructive-commands | allow | **deny** | 1 — NEW catch |
| `keel di"s"able` | keel-control-gate | allow | **deny** | 1 — NEW catch |
| `git push "--force" origin main` | no-force-push | allow | **deny** | 1 — NEW catch |
| `T=/; rm -rf $T` | no-destructive-commands | allow | **deny** | 2 — NEW catch |
| `sh -c 'r"m" -rf /'` | no-destructive-commands (via 1-level recursion) | allow | **deny** | 3 — NEW catch |
| `FOO=1 rm -rf ~` | no-destructive-commands | deny | deny | unchanged (unanchored raw match, pre-existing) |
| `x && rm -rf /` | no-destructive-commands | deny | deny | unchanged (unanchored raw match, pre-existing) |
| `sh -c "rm -rf /"` (unobfuscated) | no-destructive-commands | deny | deny | unchanged (unanchored raw match, pre-existing) |
| `python3 -c "import shutil; shutil.rmtree('/')"` | (no default rule targets it) | allow | allow | 3 — OPEN by design (surface exposed, no rule); honest, documented |
| `rm -rf node_modules` | must-not-fire | allow | allow | correct (no regression) |
| `git commit --signoff -m "force push is bad"` | must-not-fire | allow | allow | correct (no regression) |
| `echo "rm -rf /"` | must-not-fire per task; MEASURED pre-existing FP | **deny** (pre-existing, unrelated to A2) | deny (unchanged) | honest — additive constraint forbids narrowing this away; A2 does not worsen it |
| `git commit --signoff -m "rm -rf ."` | discriminator (proves quote-preservation) | allow | allow | correct — proves naive unconditional quote-stripping was NOT used |
| `git commit --signoff -m "git push --force"` | discriminator (proves quote-preservation) | allow | allow | correct — same proof for no-force-push |

Note on the `echo "rm -rf /"` row: this is NOT a new false positive
introduced by the normalizer. Measured directly against the shipped
`no-destructive-commands` regex with no normalizer involved: the pattern's
`rm[ \t]+-(rf|...)[ \t]+/(?!tmp|var/tmp)` alternative has no trailing
anchor requiring a word boundary after the matched path — the negative
lookahead only checks the literal text "tmp"/"var/tmp" does not follow, so
it is satisfied by a closing quote just as much as by end-of-string or a
space. This was true before command-normalizer.ts existed. The two
discriminator rows directly below it (`git commit -m "rm -rf ."` /
`git commit -m "git push --force"`, both `--signoff`-qualified to isolate
them from the unrelated shipped `must-sign-commits` fix rule) are the
actual proof that this lane's design does not make that class of
pre-existing issue worse: a naive "always strip quotes" implementation
would have turned both of those into NEW false positives (the bare `.` or
`--force` would then sit at end-of-string and satisfy an anchor it
currently does not), and they don't, because command-normalizer.ts only
strips a quoted run's quotes when that run contains no whitespace —
whitespace inside a quote means "this is one data argument," and it is
preserved verbatim, quotes included.

## Suite results

All numbers below are from the FINAL code (after the two raw-only-gating
fixes and the regenerated template), via `npx vitest run` — full output,
never piped through `grep`/`head` for pass/fail.

- `packages/core`: baseline 496 passed / 2 skipped (498) before this lane.
  After: **531 passed / 2 skipped (533)** — 35 new tests (17
  command-normalizer.test.ts + 18 shell-normalize-bypass.test.ts), zero
  regressions, zero pre-existing tests altered.
- `packages/core` build (`npm run build`): clean, `tsc` + esbuild bundle,
  no type errors.
- Root `npm run build` (all 4 workspaces — core → cli → mcp-server →
  opencode-plugin, in that order): clean. This is what regenerates
  `packages/cli/templates/keel-enforce.js` (opencode-plugin's esbuild
  bundle of `plugin.ts`) — confirmed changed via `git status` after the
  build, since `plugin.ts` imports the core sources this lane edited.
  `packages/cli/src/core/` (the CLI's vendored copy of `../core/src`, via a
  full `rmSync` + `cpSync`, not a partial copy) was verified to contain the
  new `command-normalizer.ts` file post-build, before running the CLI
  suite.
- `packages/cli` full suite (`npx vitest run`): baseline 674 passed / 14
  skipped (688). After: **674 passed / 14 skipped (688)** — unchanged, no
  regressions, including `drift.test.ts`'s independent check that
  `templates/keel-enforce.js` stays in sync with the two `DEFAULT_RULES_YAML`
  copies. (The CLI suite exercises the pipeline only through the
  vendored/compiled core it just rebuilt from source, so this is a real
  end-to-end check of the normalizer wired into the built artifact, not
  just the source tree.)

## Perf

Hot-path budget per pipeline.ts's own tiering comment: tier 2 (blocklist
regex match) is documented at ~0.01ms; the overall pipeline evaluate() call
is the <50ms budget referenced in the task. `commandSurfaces()` is computed
lazily once per `evaluate()` call (not per rule), memoized via
`cmdSurfaces ??= commandSurfaces(input)` in the tier-2/3 rule loop.

Normalizer in isolation (`normalizeCommand`, 2000 iterations after warmup,
`vite-node`, this machine):
- worst-case input (60 `;`-joined sub-commands + one `sh -c` recursion,
  1189 chars, near the 4000-char cap): **0.139ms/call**
- typical input (`npm test --workspace=packages/core`): **0.0074ms/call**

Full pipeline `evaluate()` against the REAL shipped default rules (fresh
pipeline per run — no tier-1 cache hits — 300 calls each, `vite-node`):
- benign command: p50 0.168ms, p95 0.361ms, max 16.275ms (one GC/JIT
  outlier; unrelated runs on the same command did not reproduce it)
- worst-case normalizer input: p50 0.327ms, p95 0.536ms, max 1.337ms

Both are roughly two orders of magnitude under the 50ms budget. The
`command-normalizer.test.ts` perf-caps suite also asserts (as a running
regression guard, not just a one-off measurement) that 200 calls on the
same worst-case string average under 5ms/call.

## Scope boundary honestly kept

- Did not hand-edit `packages/cli/src/core/` — it is the BUILD OUTPUT of the
  CLI's vendoring step (`rmSync` + `cpSync` of `../core/src`, see `packages/
  cli/package.json`'s `build` script) and was only ever regenerated by
  running `npm run build`, never edited directly.
- Did not hand-edit `templates/keel-enforce.js` — only regenerated by
  `npm run build` (see "What shipped" above), same as `packages/cli/src/core/`.
- Did not touch `rule-parser.ts`, `types.ts`, or `DEFAULT_RULES_YAML`
  (`packages/cli/src/commands/install.ts` / `packages/opencode-plugin/src/plugin.ts`)
  — confirmed identical before and after (`diff` of the two
  `DEFAULT_RULES_YAML` blocks is empty, as it was before this lane; neither
  copy was edited).
- Symlink redirection (class 4) was not attempted — documented in both the
  module header and SECURITY.md as out of scope, a runtime-fs concern.
