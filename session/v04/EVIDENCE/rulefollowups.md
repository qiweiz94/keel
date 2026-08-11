# v0.4 M1 — ruleset-followups (G2 FP-tuning + interpreter-body coverage)

Two ruleset fixes that the A2 shell-parse layer (`command-normalizer.ts`,
`commandSurfaces()`) made possible but did not itself close (A2 exposes
surfaces; it does not edit `DEFAULT_RULES_YAML`). Node v26.0.0, branch
`v04-rulefollowups`, base commit `84ae527`.

## Task 1 — interpreter-body destructive coverage

**Gap (measured, documented in SECURITY.md before this lane and in
`shell-normalize-bypass.test.ts`'s `i3` case):**
`python3 -c "import shutil; shutil.rmtree('/')"` returned `allow`. A2
exposes the interpreter body (`import shutil; shutil.rmtree('/')`) as its
own matching surface, but no shipped rule's pattern targeted it.

**Fix:** new floor rule `no-destructive-interpreter-body` (both
`packages/cli/src/commands/install.ts` and
`packages/opencode-plugin/src/plugin.ts`, byte-identical bodies, verified by
`drift.test.ts`). `action: deny`, `level: protect`, same tier as
`no-destructive-commands` (`priority: 88`, `category: destructive`,
`severity: critical`, `mode: block`).

Patterns added (each requires a **literal root `/` or home `~` target** —
conservative by design, mirrors `no-destructive-commands`' own root/home
scoping so the rule does not become a blanket "any file op" block):

- `shutil.rmtree('/')` / `shutil.rmtree("/")` / `shutil.rmtree('~')`
- `os.system('rm -rf /')` / `os.system("rm -rf /")` (and `~`) — string form
- `subprocess.run/call/Popen/check_call/check_output('rm -rf /', shell=True)`
  — string form, same shape as `os.system`
- `subprocess.run/call/...(['rm', '-rf', '/'])` — argv-list form, requires
  `rm`, a flag containing both `r` and `f` (`-rf`, `-fr`, `--recursive
  --force`-ish), and the root/home target each as their **own quoted
  token** (not a bare substring search — see the adversarial near-miss
  fixtures below)
- `os.remove('/')`
- `fs.rmSync('/', ...)` / `fs.rmdirSync('~', ...)` (node; matched on the
  bare method name, not `fs.rmSync` literally, since real call sites are
  `require('fs').rmSync(...)` or `import`-bound — a literal `fs.` prefix
  requirement was tried first and measured to MISS the realistic
  `require('fs').rmSync(...)` shape; dropped)

**Benign cases that still allow (verified against the real compiled rule,
not just the isolated regex):**
- `python3 -c "print(1)"`, `node -e "console.log(1)"` (required by the task)
- `shutil.rmtree('./build')`, `shutil.rmtree('/home/user/build')` (absolute
  but not literal root), `shutil.rmtree(tmp_dir)` (a variable, not a
  literal path)
- `os.remove('/tmp/tempfile.txt')`, `fs.rmSync('./dist', ...)`
- `os.system('echo hello')` — no destructive verb
- **Adversarial near-miss, `subprocess.run(['terraform', 'apply',
  '-refresh=true', '-target=/infra'])`** — `terraform` contains the
  substring `rm` (`...refo**rm**`), `-refresh` contains both `r` and `f`,
  and `-target=/infra` has a leading `/`. An earlier draft of the
  `subprocess` pattern searched for `rm` and the flag as bare substrings
  anywhere within the call's parens and matched this — a real
  false-positive risk. Fixed by requiring `rm` and the flag to each be
  **their own quoted token** (`['"]rm['"]`, `['"]-[a-zA-Z-]*r[a-zA-Z-]*f
  [a-zA-Z-]*['"]`), which `terraform`/`-refresh` (not standalone quoted
  tokens matching those shapes) cannot satisfy. Also checked: `docker
  compose -f /app/docker-compose.yml up`, and a commit message literally
  containing the words "rm -rf" as one quoted string element — both allow.
- `os.system('git commit -m "rm -rf /"')` — the destructive-looking text is
  behind a *nested* quote inside the `os.system` string argument; the
  pattern's `[^'"]*` between the opening quote and `rm` cannot cross that
  inner quote boundary, so this correctly allows (same shape as the G2 echo
  discriminator, arrived at independently for this rule).

**Regex mechanics note (paste-safe YAML):** the match value uses a
YAML *single-quoted* scalar (`match: '...'`) instead of the double-quoted
style every other rule in this file uses, specifically so the pattern could
contain literal `"` characters (needed for `os.system("...")`-style double
-quoted Python strings) without needing a `\"` escape — a single-quoted YAML
scalar treats `"` as unremarkable and only requires doubling a literal `'`
(`''` → one `'`). No backslash, backtick, or `${` appears anywhere in the
new content; verified by hand-counting occurrences before writing and by a
byte-identical diff between both `DEFAULT_RULES_YAML` copies after.
Literal parens/dots/braces/dollar use the existing codebase convention of a
single-char bracket class (`[(]`, `[.]`, `[$]`) rather than a backslash
escape — same technique `no-destructive-commands` already used for `[$]
[{]?HOME[}]?`.

Fixtures: `tests/rules/no-destructive-interpreter-body/{must-block,
must-allow}.yaml` — 10 must-block cases (the flagship + one per pattern
variant), 13 must-allow cases (the two required benign one-liners + one
regression guard per conservative-scoping decision above, including both
adversarial near-misses).

## Task 2 — G2 false positive: `echo "rm -rf /"`

**Gap (measured, documented in SECURITY.md and
`shell-normalize-bypass.test.ts`'s `b3` case before this lane):**
`no-destructive-commands`' `rm` alternatives had no trailing `( |$)` after
some path targets (e.g. the `/` alternative: `.../(?!tmp|var/tmp)` — no
anchor on what precedes it either), so `echo "rm -rf /"` (printing the
string, not running it) matched the same as a real invocation and denied.
Same shape for `git commit -m "rm -rf /"`, `printf "rm -rf /"`.

**First approach tried and REJECTED:** anchor every `rm`-alternative to
`^` (string start). This is the fix that seemed obviously correct from the
surface mechanics (A2's compound/env-prefix splitting means a real `x &&
rm -rf /` or `FOO=1 rm -rf ~` still gets a clean "rm ..." surface starting
at position 0), and it initially made every existing fixture pass. It broke
a real, pre-existing, unrelated test:
`agentic-eval.test.ts`'s `sudo rm -rf /` case (`sudo` is a genuine command
prefix, not an env-assignment or a compound separator — A2 does not split
or strip it, so "rm" never reaches position 0 of any surface for a
`sudo`-prefixed command). This is exactly the class of regression the task
warned against ("do NOT weaken a real catch") — caught by running the FULL
core suite, not just the new/touched fixtures. Reverted.

**Fix that shipped:** a negative lookbehind, `(?<!["'])`, prefixed to each
of the 7 `rm`-flag alternatives and the `--no-preserve-root` alternative —
excluding a match only when "rm" is *immediately* preceded by a quote
character. This is the precise mechanism the task pointed at: A2 preserves
a whitespace-bearing quoted argument **verbatim, quotes included**, on
every surface (`command-normalizer.ts` module doc, point 1) — so in `echo
"rm -rf /"`, "rm" is quote-adjacent on the (only) surface that exists.
A real invocation is never quote-adjacent at its verb:
- `rm -rf /` — nothing precedes "rm" (start of string)
- `sudo rm -rf /` — a space precedes "rm" (the regression case; proves the
  lookbehind is narrower than the rejected `^`-anchor and doesn't reproduce
  its regression)
- `x && rm -rf /` — the compound-split surface's own "rm ..." sub-string
  starts clean
- `sh -c "rm -rf /"` — the *interpreter-body* surface exposes the DECODED
  (quote-stripped-regardless-of-whitespace) value, not the quoted raw text,
  so "rm" is unquoted there even though it's quoted in the raw surface

**Paste-safe mechanics:** switched this rule's `match` field from a
double-quoted to a single-quoted YAML scalar (same technique as Task 1),
because the lookbehind needs a literal `"` character. The pre-existing
`[ \t]` tab sequences inside the pattern were left completely untouched
(not re-encoded) — they already resolve to a real tab BYTE at the JS
template-literal layer *before* YAML ever parses the string, so the tab
handling is identical regardless of which YAML quote style wraps it
(verified via a Node+`yaml`-package round-trip before touching the source
files, then re-verified against the actual compiled rule).

Fixtures added to `tests/rules/no-destructive-commands/`:
- must-allow: `echo "rm -rf /"`, `echo 'rm -rf /'`, `git commit --signoff -m
  "rm -rf /"`, `printf "rm -rf /"`
- must-block (regression guards for the fix, not just the pre-existing
  cases): `x && rm -rf /`, `sh -c "rm -rf /"`

`shell-normalize-bypass.test.ts` (owned by the A2 lane but asserting on
this rule's exact behavior) had two assertions that documented the *old*
gaps as the honest current verdict — updated in place to assert the new,
correct verdicts (`i3`: allow → deny, rule_id now
`no-destructive-interpreter-body`; `b3`: deny → allow), plus two new cases
added to the same describe blocks: `echo 'rm -rf /'` (single-quoted) and
`sudo rm -rf /` (the regression guard, run through the full default
ruleset, not just the isolated fixture harness).

## Verification

- `npm run build` — clean, all 4 workspaces.
- Both `DEFAULT_RULES_YAML` copies verified byte-identical after every edit
  (`diff` on the extracted body, not just `drift.test.ts` — checked at each
  intermediate step, not only at the end).
- Real compiled rule verified directly (not just the isolated regex
  string): loaded `DEFAULT_RULES_YAML` through the actual
  `parseRulesContent()` from the built `packages/core/dist/keel-core.mjs`
  and ran both new/changed patterns against ~25 must-block/must-allow/
  adversarial strings before running the test suites.
- `packages/core` (`npm test`): **533 passed, 2 skipped** (was ~531 passed
  before this lane; +2 for the sudo-regression-guard and single-quote-echo
  cases added to `shell-normalize-bypass.test.ts`). 0 failures.
- `packages/cli` (`npm test`): **707 passed, 15 skipped** (was ~679 before
  this lane; +23 new fixture cases across the two rules' fixture files,
  fixture-harness's per-rule coverage check, plus the drift rule-count
  bump). 0 failures. Includes `do-not-ship.test.ts` (still 100% green —
  `rm -rf /` positive control unaffected, since it's a bare raw string with
  nothing preceding "rm") and `fixture-harness.test.ts`'s "every shipped
  rule has must-block + must-allow fixtures" check (now covers 44 rules).
- `drift.test.ts`'s rule-count assertion deliberately bumped 43 → 44 with a
  comment explaining the new rule (the exact "update this count
  deliberately" case the test's own name calls out).
- Root `npm test` (`npm run test --workspaces`, all 4 packages including
  `opencode-plugin`'s `load-test.js` and `mcp-server`): all green, no
  failures anywhere in the monorepo.
- No push/publish. No `keel dashboard --web` or `opencode` invoked. All
  pipeline/fixture tests use `mkdtempSync`/`KEEL_STATE_DIR` overrides, never
  real `~/.keel`.

## Files touched

- `packages/cli/src/commands/install.ts` — `DEFAULT_RULES_YAML`: lookbehind
  on `no-destructive-commands`, new `no-destructive-interpreter-body` rule
- `packages/opencode-plugin/src/plugin.ts` — same, byte-identical
- `tests/rules/no-destructive-commands/{must-block,must-allow}.yaml`
- `tests/rules/no-destructive-interpreter-body/{must-block,must-allow}.yaml`
  (new directory)
- `packages/cli/src/__tests__/drift.test.ts` — rule count 43 → 44
- `packages/core/src/enforce/__tests__/shell-normalize-bypass.test.ts` — two
  stale assertions updated to the new correct verdicts, two cases added
- `SECURITY.md` — items 3 and the echo-FP caveat updated from "open,
  out of scope for A2" to "closed, see ruleset-followups"

Not touched (per binding constraints): `pipeline.ts`, `command-normalizer.ts`,
`arg-utils.ts`, `rule-parser.ts`, `templates/keel-enforce.js`,
`packages/cli/src/core/`.
