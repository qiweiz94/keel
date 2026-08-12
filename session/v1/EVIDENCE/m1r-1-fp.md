# M1r-1 — floor false-positive tuning

Worktree: `/Users/nanoclaw/code/keel-v1-m1r-1-fp`, branch `v1-m1r-1-fp` (based on
`v0.4-thesis`). Task: block-tier floor rules must not false-positive on
ordinary safe dev commands, while all true destructive positives still
BLOCK. SPEC §8 target: ~0% FP on a first denial.

## Headline

The FP as literally attributed by session/v04/AUDIT.md ("no-destructive-commands
blocks a safe single-file `git checkout -- <file>`") **does not reproduce
against `no-destructive-commands`** — that rule's match text has no
`checkout` alternative at all, confirmed by direct regex inspection and by
`git log -S"checkout" -- packages/opencode-plugin/src/plugin.ts`, which
returns exactly one commit across the rule's entire history, and it is not
`no-destructive-commands`.

The pattern that actually matches `git checkout -- file.ts` is a different
rule: `root-cause-before-refactor`, `type: diagnosis`, whose unanchored
match `(rm -rf|git checkout -- |git reset --hard|migrate|refactor)` catches
any single-file checkout, and any bare "migrate"/"refactor" substring
anywhere in a command or write's JSON args (including inside unrelated
paths, e.g. `src/migrations/x.ts`). It shipped `mode: observe` from the
single commit that introduced it (`0070664`, 2026-08-11 04:16 — *before*
the audit note that flagged this was written at 14:41 the same day), so a
match never actually interrupted anything: `pipeline.ts`'s `violation()`
throws `OBSERVE_CONTINUE` for `mode: observe` rules and the pipeline
returns `allow`. The live host's own `~/.keel/rules.yaml` carries the same
unpromoted pattern (verified, read-only, no write). So the FP has been
inert in practice — but it is a real overbroad pattern sitting one
`mode: observe → mode: warn/deny` promotion away from firing for real, and
an existing repo fixture (`tests/rules/root-cause-before-refactor/must-block.yaml`)
had baked the single-file-checkout FP in as the *expected* trigger example.

**Fix**: scoped `root-cause-before-refactor`'s match pattern so the corpus
below passes on **pattern grounds**, not mode grounds — it will still be
correct once the rule is eventually promoted.

## Provenance check (read-only)

```
$ grep -n -B8 -A3 'match: "(rm -rf|git checkout -- ' ~/.keel/rules.yaml
  - id: root-cause-before-refactor
    type: diagnosis
    mode: observe
    ...
    match: "(rm -rf|git checkout -- |git reset --hard|migrate|refactor)"
```
Confirms the live host's rules.yaml already had `mode: observe` — the audit
note's "blocks" language described the observe-mode `[observe] would
redirect: ...` log line, not an actual interruption.

## Regex changed

File: `packages/cli/src/commands/install.ts` and
`packages/opencode-plugin/src/plugin.ts` (identical, guarded by
`drift.test.ts`), rule `root-cause-before-refactor`:

Before:
```
(rm -rf|git checkout -- |git reset --hard|migrate|refactor)
```

After:
```
(rm -rf|git[ \t]+checkout[ \t]+(--[ \t]+)?([.]|:/)([ \t]|$)|git reset --hard|(?<![A-Za-z])migrate(?![A-Za-z])|(?<![A-Za-z])refactor(?![A-Za-z]))
```

Changes:
1. `git checkout -- ` (bare, unanchored) → scoped to whole-tree discard
   forms only: `git checkout -- .`, `git checkout .`, `git checkout -- :/`
   (with `--` optional and a literal `[ \t]`/`$` boundary after the target
   so `.gitignore` etc. do not match the bare `.` alternative). A
   single-file `git checkout -- <file>` no longer matches at all — the
   documented FP.
2. `migrate` / `refactor` → anchored with `(?<![A-Za-z])` / `(?![A-Za-z])`
   (no `\b`, consistent with this ruleset's paste-safety convention — no
   backslash-as-escape metachars, no backtick, no `${` inside the
   template-literal-wrapped YAML). Prevents matching inside unrelated path
   segments (`src/migrations/x.ts`, `src/migrateUsers.ts`) while keeping
   the literal words as full-word matches (`migrate`, `refactor` — same
   literal-substring set as before, just boundary-anchored, so it can only
   shrink the match set, never grow it).

Also added `false_positives:` documentation entries to both rule blocks
recording the fix, consistent with this ruleset's existing convention.

Both files edited identically; `npm run build` regenerates
`packages/cli/templates/keel-enforce.js` (drift.test.ts's canonical-template
check stays green — see full suite run below).

## Corpus — `keel evaluate`, isolated scratch HOME per call

Ran via `packages/cli/dist/index.js evaluate --tool bash --args '{"command":"..."}' --level protect`,
with `HOME` pointed at a fresh scratch dir per call (installed via
`keel install --project`, never touching the real `~/.keel`).

### SAFE corpus (expect: allow or warn — never deny/block)

| command | action | rule_id |
|---|---|---|
| `git status` | allow | - |
| `git checkout -- file.ts` | allow | - |
| `git checkout main` | allow | - |
| `git restore file` | allow | - |
| `npm install` | allow | - |
| `npm ci` | allow | - |
| `rm -rf node_modules` | allow | - |
| `rm -rf dist` | allow | - |
| `rm -rf build` | allow | - |
| `ls -la` | allow | - |
| `cat file` | allow | - |
| `mkdir -p x/y` | allow | - |
| `mv a b` | allow | - |
| `cp a b` | allow | - |
| `grep -r foo .` | allow | - |

### TRUE POSITIVE corpus (expect: deny/block, first hit — protect floor)

| command | action | rule_id |
|---|---|---|
| `rm -rf /` | deny | no-destructive-commands |
| `rm -rf ~` | deny | no-destructive-commands |
| `r"m" -rf /` | deny | no-destructive-commands |
| `T=/; rm -rf $T` | deny | no-destructive-commands |
| `git push --force` | deny | no-force-push |
| `git reset --hard main` | deny | protected-branch-reset |
| `python3 -c "shutil.rmtree('/')"` | deny | no-destructive-interpreter-body |
| `sudo rm -rf /` | deny | no-destructive-commands |

All 8 true positives still block, on the FIRST hit (protect-floor
block-first semantics), via their pre-existing rules — none of them route
through `root-cause-before-refactor`, so tightening its pattern cannot
weaken any of them.

Note: an early run of this corpus (before isolating `HOME` per call)
surfaced `bash-rate-limit` (a separate, unrelated `level: sprint`,
`mode: warn` rule — 30 Bash calls/60s) warning on later SAFE commands once
state accumulated across ~20 sequential CLI invocations sharing one HOME.
Not a floor rule, not a regression, and `warn` satisfies the SAFE corpus's
own acceptance criterion regardless — but re-ran with a fresh HOME per call
for a clean table isolating the floor rules' own verdict.

## Committed regression test

`packages/cli/src/__tests__/floor-fp.test.ts` — 29 cases, two passes:

1. **As shipped** (`DEFAULT_RULES_YAML`, `mode: observe` included) — the
   SAFE and TRUE-POSITIVE corpus tables above, run through the real
   `EnforcementPipeline` built from install.ts's actual source (same
   technique as this repo's existing `drift.test.ts` /
   `fixture-harness.test.ts`, not a hand-copied duplicate of the rule
   text — avoids the classic "test asserts against its own fixture, not
   the real thing" trap).
2. **Enforcing** (a deep-cloned copy of `DEFAULT_RULES_YAML` with only
   `root-cause-before-refactor`'s `mode: observe` field stripped, under an
   ACTIVE PROBLEM recorded in the ledger — the only state that arms this
   rule at all). This pass is why the test isn't tautological: pass 1
   alone would pass even with an unchanged or broader pattern, precisely
   because `mode: observe` always resolves to `allow` regardless of what
   matched (that's how the original FP stayed inert). Pass 2 asserts:
   - `git checkout -- file.ts` → `allow` (the fixed FP)
   - `git checkout main` → `allow`
   - write to `src/migrations/001_init.ts` → `allow` (path substring, the
     fixed migrate/refactor anchoring)
   - `git checkout -- .` → `redirect`, rule `root-cause-before-refactor`
     (whole-tree discard still caught)
   - `git checkout .` → `redirect`, same rule (bare form, which the
     *original* unanchored pattern did not even catch — confirmed below)
   - `echo "starting a large refactor of the auth module"` → `redirect`,
     same rule (prose match still works)

### Red → green

Reverted `install.ts`/`plugin.ts` to the pre-fix pattern (`git stash`),
re-ran the new test file — 2 of 29 failed, exactly the two cases the fix
targets:

```
 ❯ src/__tests__/floor-fp.test.ts (29 tests | 2 failed) 847ms
     × does NOT redirect a single-file checkout/restore — the fixed FP
     × STILL redirects a bare whole-tree discard: git checkout .

 FAIL  ... does NOT redirect a single-file checkout/restore — the fixed FP
AssertionError: msg=Destructive or structural change without a recorded root cause. Investigate first.: expected 'redirect' to be 'allow'
Expected: "allow"
Received: "redirect"

 FAIL  ... STILL redirects a bare whole-tree discard: git checkout .
AssertionError: msg=Allowed (no matching rule): expected 'allow' to be 'redirect'
Expected: "redirect"
Received: "allow"

 Test Files  1 failed (1)
      Tests  2 failed | 27 passed (29)
```

(The second failure is a bonus finding: the *original* pattern's
`git checkout -- ` alternative required the literal `-- ` — it never even
caught the bare `git checkout .` whole-tree-discard form. The new pattern
does, via the optional `(--[ \t]+)?` group.)

Restored the fix (`git stash pop`), rebuilt, re-ran:

```
 RUN  v4.1.10 .../packages/cli
 Test Files  1 passed (1)
      Tests  29 passed (29)
```

## Existing fixture correction (real regression caught, not introduced)

`tests/rules/root-cause-before-refactor/must-block.yaml` had baked the
documented FP in as its *expected* trigger example:
`git checkout -- src/broken.ts` under an active problem, asserting
`observed_action: redirect`. Running the full suite after the regex change
caught this as a failing pre-existing test (not a new one I wrote):

```
FAIL  src/__tests__/fixture-harness.test.ts > rule: root-cause-before-refactor
  (action: redirect) > must-block (allow): an active failing problem, then a
  refactor with no hypothesis or diagnosis evidence recorded ...
AssertionError: expected null to be 'root-cause-before-refactor'
```

Fixed by updating the fixture's example to a genuinely destructive
whole-tree discard (`git checkout -- .`) and adding the single-file case to
`must-allow.yaml` (where it now correctly belongs), both cross-referencing
this evidence file. This is a correction of a fixture that encoded the bug
as intended behavior, not a weakened test — the intent (destructive change
without a recorded root cause gets flagged) is preserved; only the example
command changed from a false positive to a true positive.

## Full suite — before and after

Baseline (before any change), `npm test`:
- core: 556 passed, 1 failed (flaky perf timing test,
  `command-normalizer.test.ts` "stays fast on a worst-case adversarial
  command" — `5.022701875ms` vs a `<5ms` budget; passed cleanly (17/17) on
  isolated re-run, confirmed pre-existing and unrelated, not touched), 2
  skipped (559 total)
- cli: 751 passed, 15 skipped (766 total)
- opencode-plugin: 61/61 checks

Final (after the rule fix, the new test file, and the fixture correction),
full `npm test`:

```
> @get-keel/core@0.4.0 test
 Test Files  33 passed (33)
      Tests  557 passed | 2 skipped (559)

> @get-keel/cli@0.4.0 test
 Test Files  42 passed (42)
      Tests  781 passed | 15 skipped (796)

> @get-keel/mcp-server@0.4.0 test
No test files found, exiting with code 0

> @get-keel/opencode-plugin@0.4.0 test
PASS  dist matches canonical template
PASS  OpenCode auto-load probe
All checks passed
```

core: 557/559 (the flaky perf test passed this run — timing-dependent,
pre-existing, not part of this lane). cli: 781/796, +30 over baseline (29
new floor-fp.test.ts cases + 1 new must-allow.yaml fixture case).
opencode-plugin: 61/61, including `dist matches canonical template` (the
drift guard that would fail if install.ts/plugin.ts/the built template
disagreed after this change).

## Residual FPs not fixed in this lane

None found in the given corpus. Scope was deliberately narrow (the one
concrete FP named in the task plus its two immediate blast-radius items —
the un-`--`-anchored bare-checkout gap and the migrate/refactor path-
substring gap on the *same* rule). Did not sweep every other floor rule's
pattern for unrelated FP classes — out of scope for this lane.

## Files touched

- `packages/cli/src/commands/install.ts` — `root-cause-before-refactor`
  match pattern + `false_positives:` doc
- `packages/opencode-plugin/src/plugin.ts` — same, kept byte-identical
  (drift.test.ts)
- `packages/cli/templates/keel-enforce.js` — regenerated by `npm run
  build` (generated file, not hand-edited)
- `packages/cli/src/__tests__/floor-fp.test.ts` — new, 29 cases
- `tests/rules/root-cause-before-refactor/must-block.yaml` — corrected
  example (whole-tree discard, not single-file)
- `tests/rules/root-cause-before-refactor/must-allow.yaml` — added the
  single-file checkout case
- `session/v1/EVIDENCE/m1r-1-fp.md` — this file
