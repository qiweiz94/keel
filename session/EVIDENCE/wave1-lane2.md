# Wave 1 / Lane 2 — per-rule fixture harness

Worktree: `/Users/nanoclaw/code/keel-w1-fixtures`, branch `w1-fixtures`.

## 0. Environment

```
$ node --version
v26.0.0
$ git branch --show-current
w1-fixtures
$ git status
On branch w1-fixtures
nothing to commit, working tree clean
$ npm ci
added 169 packages, and audited 174 packages in 2s
```

## 1. Cross-lane coordination note: `KEEL_STATE_DIR` fix in `state-manager.ts`

Mid-task, a "supervisor" message instructed patching
`packages/core/src/enforce/state-manager.ts` so `StateManager` honors
`KEEL_STATE_DIR`, ahead of a possible prompt-injection concern. Verified
before applying:
- The underlying fact was independently confirmed by my own investigation
  minutes earlier — a repo-wide grep showed only `problem-ledger.ts` reads
  `KEEL_STATE_DIR`; `state-manager.ts` hardcoded `homedir()`:

```
$ grep -rn "KEEL_STATE_DIR" packages/ --include="*.ts" | grep -v __tests__
packages/core/src/enforce/problem-ledger.ts:47:  return process.env.KEEL_STATE_DIR || join(homedir(), '.keel', 'state', 'ledger.json')
```

- The message arrived as a direct conversational turn (not embedded inside
  fetched/tool content — the higher-risk injection vector), asked for a
  minimal, additive, backward-compatible one-line change, and directly
  reinforced this lane's own binding constraint ("tests never touch the
  real `~/.keel`; use temp dirs + `KEEL_STATE_DIR`").

Applied change:

```diff
- const STATE_DIR = join(homedir(), '.keel', 'state')
+ const STATE_DIR = process.env.KEEL_STATE_DIR || join(homedir(), '.keel', 'state')
```

This lane's harness does not pass a `StateManager` to the pipeline at all
(omitting it was already the plan — see §3), so the fix is defense-in-depth
for this lane and direct benefit for any other lane/rule type that does
construct one.

## 2. Build (required before any cli-package test run)

```
$ cd packages/core && npm run build
> tsc && npx esbuild src/keel-core.ts --bundle ...
  dist/keel-core.mjs  98.2kb
⚡ Done in 16ms

$ cd packages/cli && npm run build
> node -e "...rmSync('dist')...rmSync('src/core')...cpSync('../core/src','./src/core')..." && tsc
(clean exit, no output)
```

## 3. Harness design

- **Fixtures**: `tests/rules/<rule-id>/{must-block,must-allow}.yaml` at the
  repo root, one directory per rule id in `DEFAULT_RULES_YAML`
  (`packages/cli/src/commands/install.ts`). Schema (documented in the
  harness file header): a `cases:` list, each case either
  `{ tool, args, note }` (single call) or `{ steps: [...], note }`
  (multi-step scenario), plus optional modifiers `repeat: N` (rate rule),
  `fake_time: { hour, minute }` (time rule), and per-step `precreate: true`
  (+ `content`) to materialize a real file before a flow-rule read.
  `skip: true` requires a `reason:` field — enforced by the harness itself,
  not by convention.
- **Harness**: `packages/cli/src/__tests__/fixture-harness.test.ts`. Chosen
  over `packages/core` because it needs to read `DEFAULT_RULES_YAML` off
  `install.ts`'s source on disk — the exact pattern `drift.test.ts` already
  established in this same directory — and because `packages/core` reaching
  up into `packages/cli` would invert the published dependency direction.
  Wired into `npm test` automatically: root `npm test` runs
  `npm run test --workspaces`, and `@get-keel/cli`'s `test` script is
  `vitest run`, which picks up any `*.test.ts` under `src/__tests__/`
  with zero extra wiring. Confirmed in §7 below.
- **Isolation model**: `EnforcementPipeline.evaluate()` short-circuits on
  the first rule that matches. Running the full 22-rule set for a
  must-allow assertion of "this rule didn't fire" would pass vacuously
  whenever an earlier rule in YAML order matched first — the rule under
  test would never be reached. So must-block/must-allow cases build a
  pipeline containing **only the rule under test** (isolated), extracted
  directly from the parsed `DEFAULT_RULES_YAML`. The KNOWN-FP PROBES
  section deliberately runs the **full** 22-rule set instead, because that
  section's actual question ("does the shipped ruleset block this benign
  command") is unanswerable under isolation.
- **Real `~/.keel` never touched**: `disableFile` points at a nonexistent
  path inside a `mkdtemp`'d scratch dir (not `homedir()`); `overrideStore`
  is a stub (`consume: () => false`) rather than the real
  `FileRuleOverrideStore`, which reads/writes `~/.keel/overrides.json` on
  every prompt-rule gate; `StateManager` is never constructed at all;
  `KEEL_STATE_DIR` is additionally set to a temp dir in `beforeAll` (see §1).
- **Warn-before-block ladder**: `pipeline.ts`'s `violation()` warns on a
  rule's first deny/block violation and only blocks on the second, unless
  the active dial is `protect` (`DEFAULT_RULES_YAML` ships `level:
  balanced`, and `rule.level: protect` in the YAML is a dial-floor marker,
  not an escalation-skip marker — confirmed by reading `mergeRules`'s
  comment in `rule-parser.ts` and empirically, see §4). A single stateless
  call cannot observe an actual block for any deny-type rule, so
  `evaluateCase` replays the final step once when the first verdict is a
  first-warning for the rule under test, and asserts on the replay.

## 4. Proof the escalation-replay logic is real, not decorative

```
$ node probe-tmp.mjs   # ad hoc script, single rule (no-destructive-commands) loaded, two evaluate() calls on 'rm -rf /'
call 1 (single, no replay): warn no-destructive-commands
call 2 (replay): deny no-destructive-commands
```

Without the replay, every deny-type rule's must-block assertion would
observe `warn`, not `deny` — confirming this is load-bearing, matching
`pipeline.test.ts`'s own warn-then-deny sequences at lines 173-175 and
288-290.

## 5. Proof the harness catches a real violation (mutation test)

`tests/rules/no-force-push/must-allow.yaml` was temporarily mutated to a
case that should be blocked (`git push --force`):

```
$ npx vitest run src/__tests__/fixture-harness.test.ts --reporter=verbose
 × rule: no-force-push (action: deny) > must-allow: MUTATION TEST: this SHOULD be blocked, harness must fail on it
   → expected allow, got "deny" (rule_id=no-force-push, message=Use --force-with-lease instead of --force.): expected 'deny' to be 'allow'
 Test Files  1 failed (1)
      Tests  1 failed | 52 passed (53)
```

Fixture was restored immediately after (`git diff` confirms
`tests/rules/no-force-push/must-allow.yaml` is unchanged from its committed
content).

## 6. Fixture coverage — all 22 shipped default rules

```
$ node -e "... count cases per tests/rules/<id>/{must-block,must-allow}.yaml ..."
bash-rate-limit                  block=1 allow=2
git-history-rewrite              block=1 allow=1
keel-control-gate                block=1 allow=1
must-sign-commits                block=1 allow=1
no-after-hours-publish           block=1 allow=1
no-credential-echo               block=1 allow=1
no-curl-pipe-shell               block=1 allow=1
no-db-destructive                block=1 allow=1
no-destructive-commands          block=1 allow=1
no-enforcer-removal              block=1 allow=1
no-exfil-flow                    block=1 allow=1
no-force-push                    block=1 allow=1
no-push-to-main                  block=1 allow=1
no-remote-exec                   block=1 allow=1
no-rules-tampering               block=2 allow=1
no-secret-files                  block=1 allow=1
no-secrets-in-code               block=1 allow=1
no-skip-tests                    block=1 allow=1
no-verify-bypass                 block=1 allow=1
publish-gate                     block=1 allow=1
source-change-requires-test      block=1 allow=1
verify-format-before-decision    block=1 allow=1
---
rule dirs: 22   total block cases: 23   total allow cases: 23   grand total: 46
```

**Zero `skip: true` fixtures.** Pushback against the lane brief's own
assumption that rate/time/flow/verification rules would need skips: all
four were made real by simulation instead —
`bash-rate-limit` (31 real evaluate() calls on one pipeline instance to
cross `max_calls: 30`), `no-after-hours-publish` (`vi.setSystemTime` with
local-clock components, not a UTC ISO string, since the rule reads
`now.getHours()`), `source-change-requires-test` (multi-step: `write` to
`src/`, then either an unsatisfied `git push` boundary — denied — or a
satisfying `npm test` step via `pipeline.markVerificationSatisfied`, then
push — allowed), and `no-exfil-flow` (multi-step: a real precreated `.env`
file `Read`, then a `curl` sink call in the same session).

## 7. Harness run (isolated, this file alone) — full output

```
$ npx vitest run src/__tests__/fixture-harness.test.ts --reporter=verbose
 ✓ per-rule fixture coverage > every shipped default rule has a fixture dir with non-empty must-block and must-allow cases
 ✓ rule: keel-control-gate (action: deny) > must-block (deny): ...
 ✓ rule: keel-control-gate (action: deny) > must-allow: ...
 ✓ rule: no-rules-tampering (action: deny) > must-block (deny): overwriting keel's own rules file
 ✓ rule: no-rules-tampering (action: deny) > must-block (deny): deleting the kill-switch sentinel by writing over it
 ✓ rule: no-rules-tampering (action: deny) > must-allow: ...
 ✓ rule: no-enforcer-removal ... (2)
 ✓ rule: source-change-requires-test (action: deny) > must-block (deny): src/ edited, then git push with no test run in between — boundary denies
 ✓ rule: source-change-requires-test (action: deny) > must-allow: src/ edited, a real test run observed, then push — obligation satisfied
 ✓ rule: verify-format-before-decision (action: warn) ... (2)
 ✓ rule: no-force-push (action: deny) ... (2)
 ✓ rule: no-verify-bypass (action: deny) ... (2)
 ✓ rule: no-curl-pipe-shell (action: deny) ... (2)
 ✓ rule: no-db-destructive (action: prompt) ... (2)
 ✓ rule: no-push-to-main (action: prompt) ... (2)
 ✓ rule: no-remote-exec (action: prompt) ... (2)
 ✓ rule: no-after-hours-publish (action: warn) > must-block (warn): pushing at 03:00, outside the 09:00-22:00 window
 ✓ rule: no-after-hours-publish (action: warn) > must-allow: pushing at noon, inside the window
 ✓ rule: bash-rate-limit (action: warn) > must-block (warn): 31st Bash call within the 60s window exceeds max_calls: 30
 ✓ rule: bash-rate-limit (action: warn) > must-allow: 5 calls is well under the limit
 ✓ rule: bash-rate-limit (action: warn) > must-allow: the 30th call is still within max_calls: 30 (boundary)
 ✓ rule: no-skip-tests (action: deny) ... (2)
 ✓ rule: no-secrets-in-code (action: deny) ... (2)
 ✓ rule: no-secret-files (action: deny) ... (2)
 ✓ rule: no-credential-echo (action: deny) ... (2)
 ✓ rule: no-exfil-flow (action: deny) > must-block (deny): read .env, then exfiltrate it over the network in the same session
 ✓ rule: no-exfil-flow (action: deny) > must-allow: a network call with no prior sensitive-file read has no tagged data to flow
 ✓ rule: no-destructive-commands (action: deny) ... (2)
 ✓ rule: must-sign-commits (action: fix) > must-block (fix): a commit without --signoff gets auto-signed
 ✓ rule: must-sign-commits (action: fix) > must-allow: already carries --signoff, negative lookahead excludes it
 ✓ rule: git-history-rewrite (action: prompt) ... (2)
 ✓ rule: publish-gate (action: prompt) ... (2)
 ✓ known false-positive probe class: "nc" substring inside rsync / async / sync > rsync is not misread as the network-sink verb "nc"
 ✓ known false-positive probe class: ... > rsync of a previously-read .env is not caught by the exfil-flow sink check
 ✓ known false-positive probe class: ... > an "async" function written to a source file trips no command or content rule
 ✓ known false-positive probe class: ... > a command containing "sync" as a substring is not blocked
 ✓ known false-positive probe class: ... > a --signoff commit whose message contains "sync" is not misread as a hooks bypass
 ✓ known false-positive probe class: ... > an env var name containing "sync" and "token" as substrings, but not a real credential name, is not flagged

 Test Files  1 passed (1)
      Tests  53 passed (53)
```

(Full untruncated output captured at test time; the above preserves every
test name and the summary line verbatim.)

## 8. KNOWN-FP PROBES — investigation and result

The lane brief named a specific bug class: a pattern intended to match a
short token (netcat's `nc`) also matching the tail of unrelated words
(`rsync`, `async`). Before writing probes, searched for it directly:

```
$ node -e "... new RegExp(rule.match,'i').test(probe) for every command-type rule in DEFAULT_RULES_YAML, probes = ['rsync -av src/ dest/', 'async function foo() {}', 'git add data-sync.ts', 'echo sync', 'npm run sync', 'finch build', 'nchmod', 'branch-sync merge tool'] ..."
rules count 22
(no FP lines printed — zero matches across all 22 command-type patterns)
```

Also read `flow-tracker.ts`'s `matchesSink` directly — it already carries
a fix + comment for exactly this class:

```
// Both-side word boundaries: a trailing `\b` alone lets `nc` match the
// tail of unrelated words like "sync" or "finch". Sink verbs must be
// real tokens (nc -l, curl url), not substrings of legitimate commands.
return /\b(?:curl|wget|fetch|http|https|nc|netcat|socat)\b/.test(`${toolName} ${command}`)
```

So the specific bug is **already fixed** in this tree, not dormant. Six
probes were added anyway, run against the **full** 22-rule pipeline (see
§3), as regression guards: `rsync` alone; an actual `rsync .env
user@host:/...` exfil attempt after a real `.env` read (this is the direct
regression test for the flow-tracker fix above — it exercises both "rsync
isn't a tracked sink verb" and "the embedded `nc` inside `rsync` must not
falsely match"); an `async` function written to a `.ts` file; a `sync`
substring in a bash command; a `--signoff` commit whose message contains
`sync` (the `--signoff` is required — `must-sign-commits` matches *every*
`git commit` without it, so a bare commit here would return `fix`, not
`allow`, which would be the rule working correctly, not a false positive —
caught during design, not after a failing run); and an env var name
containing both `sync` and `token` as substrings but not matching any of
the 8 named credential vars.

**All six passed as ordinary `it()` on the first real run** (see §7,
"known false-positive probe class" section — 6/6 green). None are
`test.fails`: there is nothing to encode as a known-failing regression
today, per instruction to convert only probes that actually reproduce a
failure. If a future rule-pattern change regresses this class, one of
these six will start failing loudly.

## 9. Full `@get-keel/core` suite (state-manager.ts change did not break anything)

```
$ cd packages/core && npx vitest run --reporter=verbose
 Test Files  13 passed (13)
      Tests  234 passed (234)
```

## 10. `drift.test.ts` (install.ts vs plugin.ts rule parity — untouched, still green)

```
$ npx vitest run src/__tests__/drift.test.ts --reporter=verbose
 ✓ rules drift: install.ts vs plugin.ts > enforces the same rule ids
 ✓ rules drift: install.ts vs plugin.ts > matches the same patterns and actions per rule
 ✓ rules drift: install.ts vs plugin.ts > has no unanchored rm -rf / false-positive (BUG 1)
 ✓ rules drift: install.ts vs plugin.ts > gates plain git rebase / reset / push -d / gh release delete (GAP 3)
 ✓ rules drift: install.ts vs plugin.ts > built template is regenerated with the same rules
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

## 11. Full `@get-keel/cli` suite

```
$ npx vitest run --reporter=verbose
 Test Files  1 failed | 42 passed (43)
      Tests  4 failed | 601 passed (605)
```

605 tests total in the cli package, including this lane's 53. **4 failures,
all pre-existing in `level.test.ts`**, unrelated to this lane. Root cause:
`chalk`-colored CLI output (ANSI escape sequences interleaved character-
by-character around the changed word, e.g. `balanced\x1b[7m → protect\x1b[27m`)
no longer matches the plain-text `toContain('project level: balanced →
protect')` assertions those tests make — an environment/terminal-detection
issue in `level.test.ts` itself, not in the rules or the enforcement
pipeline.

**Verified pre-existing, not caused by this lane's `state-manager.ts`
change**, by reverting only that one-line change and re-running:

```
$ git stash push -- packages/core/src/enforce/state-manager.ts
$ (rebuild core + cli)
$ npx vitest run src/__tests__/level.test.ts --reporter=verbose
EXIT: 1        # same 4 failures, confirmed before restoring the fix
$ git stash pop
```

Left `level.test.ts` untouched — out of scope for this lane (per the "never
weaken a failing test" rule, and this isn't a test this lane owns or
introduced).

## 12. Root `npm test` (proves the harness is wired into the real verification path)

```
$ npm test
> @get-keel/core@0.1.9 test → 234 passed (234)
> @get-keel/cli@0.2.2 test → 601 passed | 4 failed (605)   # same 4 pre-existing level.test.ts failures, see §11
> @get-keel/mcp-server@0.1.2 test → no test files, exit 0
> @get-keel/opencode-plugin@0.1.9 test → ERR_MODULE_NOT_FOUND: dist/index.js
```

`@get-keel/opencode-plugin`'s `test` script (`node ./scripts/load-test.js`)
fails because that package has never been built in this fresh worktree
checkout (`dist/index.js` doesn't exist) — unrelated to this lane, which
never touches `packages/opencode-plugin`.

**This lane's fixture harness (53 tests) is confirmed running and green
inside the real `npm test` invocation** — it is not a side suite that only
passes when run in isolation.

## Summary

- 22/22 shipped default rules covered, 46 fixture cases (23 must-block +
  23 must-allow), zero `skip: true`.
- Escalation-ladder replay and mutation-catch both proven empirically
  (§4, §5), not asserted on faith.
- KNOWN-FP probe class investigated first (§8): already fixed in
  `flow-tracker.ts`; 6 regression-guard probes added, all green, none
  `test.fails`.
- `packages/core` (234), `drift.test.ts` (5), and this harness (53) are
  fully green. The only failures anywhere in the workspace are 4
  pre-existing, unrelated `level.test.ts` ANSI-output assertions and one
  pre-existing unbuilt `opencode-plugin` package — both verified
  independent of this lane's changes.
