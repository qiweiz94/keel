# Wave 2 Lane 1 — default ruleset restructuring (3 tiers)

Scope: `packages/cli/src/commands/install.ts` and `packages/opencode-plugin/src/plugin.ts`
(`DEFAULT_RULES_YAML`, kept byte-equivalent per `drift.test.ts`), plus fixtures under
`tests/rules/<id>/`, `packages/cli/src/commands/harness-rules.ts`,
`packages/cli/src/index.ts` (`createEnforceInit`), and
`packages/cli/src/__tests__/{drift,fixture-harness}.test.ts`.

## Baseline (before any change)

```
$ npm run build && NO_COLOR=1 npm test
packages/core:  Test Files  15 passed (15)  |  Tests  249 passed (249)
packages/cli:   Test Files  1 failed | 44 passed (45)  |  Tests  4 failed | 616 passed (620)
  (the 4 failures are all in level.test.ts — ANSI-color assertions, env-dependent,
   pre-existing per the task brief, NOT touched this wave)
opencode-plugin load-test.js: All checks passed
```

## Rename/reference audit (done before any rename — advisor-mandated)

```
$ grep -rl -E "no-destructive-commands|no-force-push|no-curl-pipe-shell|no-exfil-flow|
  no-rules-tampering|no-verify-bypass|no-db-destructive|no-skip-tests|no-push-to-main" .
```
Hit counts: no-destructive-commands 14 files, no-force-push 16, no-curl-pipe-shell 4,
no-exfil-flow 5, no-rules-tampering 8, no-verify-bypass 5, no-db-destructive 6,
no-skip-tests 4, no-push-to-main 7.

Follow-up: for the 7 heavily-referenced ids, checked whether references were HARD
assertions (`.rule_id`/`.toBe(...)`) or just comments/docs:
- `packages/core/src/enforce/__tests__/{threat-model,agentic-eval,match-surface}.test.ts`
  hard-assert `no-force-push`, `no-rules-tampering`, `no-verify-bypass`,
  `no-destructive-commands`, `no-exfil-flow` by literal id string.
- `no-curl-pipe-shell` and `no-db-destructive` had ONLY comment/generated-file references
  (no hard test assertions) — safe to rename/split.

**Decision: kept all 7 heavily-referenced ids unchanged** (extended in place instead of
renamed), per the task's own instruction ("keep old id as the base if renaming would
break references"). Renamed only `no-curl-pipe-shell` → `pipe-to-shell` (verified safe).
Split `no-db-destructive` into itself (repurposed: untagged/Tier-2/warn) +
`prod-db-destruction` (new id, Tier-1/protect/deny).

## Escaping bug (the actual multi-hour blocker) — read before touching DEFAULT_RULES_YAML again

`DEFAULT_RULES_YAML` is a JS template literal containing YAML text. It has **two
different consumers with two different escaping requirements for the exact same source
bytes**:
- **Runtime (regime B)**: `daemon.ts` etc. `import { DEFAULT_RULES_YAML } from './install.js'`
  — Node evaluates the template literal (one layer of JS backslash-escape processing),
  THEN the resulting runtime string is parsed as YAML (a second layer of escaping).
- **Test-time (regime A)**: `drift.test.ts`, `fixture-harness.test.ts`, and (in
  packages/core) `agentic-eval.test.ts`/`threat-model.test.ts` all `readFileSync` the
  `.ts` SOURCE FILE as plain text and regex-extract the content between the backticks —
  **no JS evaluation happens at all** — then hand that raw text directly to the YAML
  parser (one layer of escaping only).

Any `\b`, `\s`, `\S`, `\"` etc. written with the "obvious" doubled-backslash YAML
convention parses correctly under regime A and is SILENTLY MANGLED under regime B (JS's
template-literal processing drops the backslash before any letter it doesn't recognize
as its own escape, e.g. `\s` → `s`), which then fails YAML parsing at runtime — this
broke `keel install`, the daemon, and every real integration, while every test that reads
the `.ts` source as text stayed green. Quadrupling the backslashes fixes regime B but
then over-escapes regime A (parses to a literal `\\b` in the pattern — a dead regex that
matches nothing).

**Resolution: eliminated `\b`/`\s`/`\S`/`\"`/`\n` from every new pattern entirely**,
matching the convention the original 22 rules already used (bracket classes: `[.]` for a
literal dot, `[^ ]+` instead of `\S+`, `( |$)` instead of `\b`, zero-width
`(?<![A-Za-z])`/`(?![A-Za-z])` lookaround instead of `\b`). The one pre-existing `\t`
(single backslash, in `no-secrets-in-code`'s `aws_secret_access_key[\t ]*[:=]`) is safe
unmodified in BOTH regimes (JS's own `\t` escape and YAML's own `\t` escape converge on
the same tab byte) — left untouched, and confirmed by grep that it is the only
backslash left in the whole 36-rule file. Verified empirically both ways after the fix:

```
$ node -e "... import('./dist/commands/install.js') ... parseRulesContent(DEFAULT_RULES_YAML) ..."
REGIME B (runtime import) errors: undefined   rule count: 36   validate: []

$ node --input-type=module -e "... readFileSync('src/commands/install.ts') ... regex-extract ..."
REGIME A (raw source text) errors: undefined   rule count: 36
```

A `(?<![A-Za-z])sudo(?![A-Za-z])`-style zero-width lookaround was required, not
`(^|[^A-Za-z]) ... ([^A-Za-z]|$)` — the consuming char-class form eats the boundary
character, which then breaks any subsequent same-position lookahead (discovered via the
`sudo apt-get` exemption test: the consumed space made `(?!.*apt-get)` search from a
position that could never re-match the boundary before `apt-get`).

## Tier table

| id | tier | action | level | severity | confidence | what changed |
|---|---|---|---|---|---|---|
| keel-control-gate | 1 | deny | protect | critical | high | metadata only |
| no-rules-tampering | 1 | deny | protect | critical | high | +5 paths: `.claude/settings*.json`, `.mcp.json`, `.vscode/settings.json`, `.git/hooks/**` |
| no-enforcer-removal | 1 | deny | protect | critical | high | metadata only |
| agent-env-hijack | 1 (NEW) | deny | protect | critical | high | new: persisted ANTHROPIC_BASE_URL/OPENAI_BASE_URL/KEEL_* mutation into rc/config files |
| no-destructive-commands | 1 | deny | protect (was sprint) | critical | high | level bump only; match unchanged |
| no-force-push | 1 | deny | protect (was sprint) | high | high | level bump only; **priority NOT raised** (would have beaten no-push-to-main's more specific force+main prompt — reverted after breaking `threat-model.test.ts`) |
| protected-branch-reset | 1 (NEW) | deny | protect | critical | high | new: `git reset --hard` naming main/master explicitly |
| protected-branch-delete | 1 (NEW) | deny | protect | critical | high | new: deleting main/master specifically (generic branch delete stays Tier-2 prompt via publish-gate) |
| pipe-to-shell | 1 (renamed from no-curl-pipe-shell) | deny | protect (was sprint) | critical | high | +`bash -c $(curl ...)`, `eval $(curl ...)` variants |
| no-exfil-flow | 1 | deny | protect (was unset) | critical | high | +sources: `.aws/credentials`, `.config/gcloud/**`, `Keychains/**`, `.npmrc`, `.netrc`; priority 85 (must record before secret-file-read-without-egress can preempt — see below) |
| prod-db-destruction | 1 (NEW, split from no-db-destructive) | deny | protect | critical | high | new: DROP/TRUNCATE with prod\|production\|live tag in the same command |
| no-db-destructive | 2 (repurposed) | warn (was prompt) | sprint | high | medium | untagged DROP/TRUNCATE/DELETE — softened per Replit AIID 1152 (DB there was untagged) |
| no-push-to-main | 2 | prompt | sprint | high | high | metadata only |
| commit-to-main | 2 (NEW) | warn | sprint | medium | medium | new: `git checkout main && git commit` chain (KNOWN GAP: bare `git commit` while already on main is invisible — no ambient branch state) |
| no-verify-bypass | 2 | warn (was deny) | sprint | high | high | softened per do-not-ship guard (no deny on --no-verify) |
| write-outside-project | 2 (NEW) | prompt | sprint | high | medium | new: `/etc/**` `/usr/**` `/bin/**` `/sbin/**` `/System/**` `/Library/**` + shell rc files (NOT a `!`-negated project-relative denylist — rejected as an allowlist inversion) |
| cicd-config-edit | 2 (NEW) | prompt | sprint | medium | high | new: `.github/workflows/**`, `.gitlab-ci.yml`, `Jenkinsfile`, `azure-pipelines.yml`, `.circleci/**` |
| cicd-and-infra | 2 (NEW) | prompt | sprint | high | medium | new: `terraform apply/destroy`, `kubectl apply/delete/exec/drain/cordon/rollout restart`, exempted for known local contexts |
| secret-file-read-without-egress | 2 (NEW) | warn | sprint | medium | medium | new: bare `cat/less/more/head/tail/strings/xxd/base64` of a secret path with no egress yet (KNOWN GAP: command-type only — misses the native Read tool; priority -5, deliberately below no-exfil-flow's 85) |
| broad-privilege-escalation | 2 (NEW) | warn | sprint | medium | low | new: unscoped `sudo` (exempts apt-get/apt/yum/dnf/brew), `chmod -R NNN`, `chown -R` |
| paste-site-exfil | 2 (NEW) | prompt | sprint | high | medium | new: curl/wget to pastebin.com/hastebin/dpaste/transfer.sh/file.io/0x0.st |
| no-remote-exec | 2 | prompt | sprint | medium | high | metadata only |
| no-after-hours-publish | 2 | warn | sprint | low | medium | metadata only |
| bash-rate-limit | 2 | warn | sprint | low | medium | metadata only |
| no-skip-tests | 2 | warn (was deny) | sprint | high | high | softened per do-not-ship guard |
| no-secrets-in-code | 2 | deny | sprint | critical | high | metadata only (exact-signature exception to Tier-2 warn/prompt default, per severity×confidence) |
| no-secret-files | 2 | deny | sprint | high | high | metadata only |
| no-credential-echo | 2 | deny | sprint | high | high | metadata only |
| must-sign-commits | 2 | fix | sprint | low | high | metadata only — **caught a real bug**: first metadata pass dropped the `fix:` transform block entirely; restored and verified via `fixture-harness.test.ts`'s own `must-sign-commits` case |
| git-history-rewrite | 2 | prompt | sprint | medium | high | metadata only |
| publish-gate | 2 | prompt | sprint | high | high | metadata only |
| verify-format-before-decision | 2 | warn | sprint | low | low | metadata only |
| source-change-requires-test | 3 | deny (mode: observe) | — | medium | medium | re-tiered to `mode: observe`; tracker/boundary mechanism unchanged, only the outer verdict (allow + observed_action) |
| no-repeat-loops | 3 (moved from harness-rules.ts) | warn (mode: observe) | — | medium | high | moved verbatim; priority -10 |
| research-before-fix | 3 (moved from harness-rules.ts) | redirect (mode: observe) | — | medium | medium | moved verbatim; priority -10; **documented gap**: `research`-type-with-trigger rules are checked in pipeline.ts's pre-cache stateful loop BEFORE Tier-1 command rules for the same call, so even in mode:observe this can short-circuit a Tier-1 rule's evaluation on the same write/edit if a research obligation happens to be pending — pipeline.ts change, out of this lane's scope, not fixed here |
| root-cause-before-refactor | 3 (moved from harness-rules.ts) | redirect (mode: observe) | — | medium | medium | moved verbatim; priority -10 |

22 original + 14 new (agent-env-hijack, protected-branch-reset, protected-branch-delete,
prod-db-destruction, commit-to-main, write-outside-project, cicd-config-edit,
cicd-and-infra, secret-file-read-without-egress, broad-privilege-escalation,
paste-site-exfil, no-repeat-loops, research-before-fix, root-cause-before-refactor) = 36
rules (pipe-to-shell is a rename, not a net addition).

## `unless`/priority interactions verified empirically (not just by inspection)

- `no-exfil-flow` promoted to `level: protect` has a global side effect via
  `protectFloor()`: it forces `deepChecks` on at EVERY dial (including sprint) whenever
  any protect-level content/sequence/flow rule is present — closing a real
  "sprint dial silently skips exfiltration/sequence checks" gap that existed before this
  wave. Confirmed this changes behavior for a CUSTOM project sequence rule too (not just
  the shipped default), and updated the 2 core tests that asserted the old
  sprint-skips-deep-checks behavior, with inline comments explaining why.
- `secret-file-read-without-egress` (priority -5) does not break `no-exfil-flow`'s
  read-then-network detection: verified with a direct pipeline call that the flow
  tracker's `record()` still fires (via the higher-priority flow rule reaching the input
  first) before the low-priority warn rule gets a look.

## Supervisor-flagged fixes (live-verify lane, addressed in this wave)

1. **REAL BUG — `keel install --project` stub was unparseable.** The generated
   `.keel/rules.yaml` wrote `rules:` followed only by comment lines — YAML-parses
   to `rules: null`, which `parseRulesContent` rejects ("Rules must be an array"),
   and `initEnforce` (`enforce.ts:64`) throws on ANY rule-source error — breaking
   `keel evaluate` and `keel hook <host>` on every tool call after a fresh
   `install --project` (confirmed live; only OpenCode's own fallback masked it).
   Fixed to `rules: []` (valid empty list). Added a regression test in
   `install-all.test.ts`: the project `.keel/rules.yaml` from a real
   `install --all` run parses with no errors, and `keel evaluate` against it
   exits 0 with a non-`error` action.

2. **Priority shadowing — `no-force-push` was invisible for main-targeted force
   pushes.** `no-push-to-main` (Tier 2, priority 80) matched `git push --force
   origin main` and returned `prompt` before `no-force-push` (Tier 1 protect,
   no priority override) was ever evaluated — proven live. A force-push to a
   protected branch is strictly more dangerous than either alone and must hit
   the Tier-1 floor's deny, not the softer prompt. Fixed by giving
   `no-force-push` `priority: 82` (just above no-push-to-main's 80, still below
   the ~85-100 range other Tier-1 rules use — no other collision found).
   Verified empirically (not just by inspection) that the ladder state is
   per-rule-id, so this also changes the expected verdict on a THIRD call to
   the same session that already consumed the ladder on a feature-branch push
   — updated `agentic-eval.test.ts`/`threat-model.test.ts` accordingly, and
   added a full-ruleset ordering probe in `fixture-harness.test.ts` (the
   per-rule isolation model that the rest of the harness deliberately uses
   cannot see a shadowing bug between two DIFFERENT rules by construction).

3. **drift.test.ts field-completeness.** The original comparison used a
   hand-picked field list (match/action/level/mode/priority/severity/
   confidence/category) — `paths:`/`exclude:`/`patterns:`/`vars:`/`sources:`/
   `sinks:`/`unless:`/`boundaries:` etc. were NOT compared and happened to be
   identical only by luck. Rewrote to deep-equal the FULL parsed rule object
   per id across install.ts and plugin.ts, so any future field addition is
   covered automatically rather than requiring the list to be remembered.

4. **Glob semantics note (no action needed this wave).** A parallel lane is
   fixing `pathMatches` so bare `*` correctly means any-chars-in-segment and
   `.env.local`/`id_rsa.pub` correctly match `**/.env*`/`**/id_rsa*`. Audited
   this wave's new `paths:` glob lists (`no-rules-tampering` extension,
   `write-outside-project`, `cicd-config-edit`) for any pattern relying on the
   OLD buggy semantics to "work" — found none (no bare single `*` in any new
   path pattern; `cicd-config-edit` deliberately uses the literal
   `**/.gitlab-ci.yml`, not a wildcard variant, since GitLab CI configs don't
   need one — not a workaround, just no wildcard where none was needed).

## Verification

Two runs, same command family, different ambient shell state:

```
$ npm run build && NO_COLOR=1 npm test                    # task-specified command
```
- packages/cli: 4 failed, 718 passed (722) — all 4 failures in level.test.ts's
  ANSI-color assertions, matching the pre-existing baseline above 1:1 (not a
  regression from this wave's changes; confirmed by diffing failing test names
  against the baseline run)

```
$ npm run build && env -u FORCE_COLOR NO_COLOR=1 npm test  # FORCE_COLOR cleared
```
- packages/core: 251/251 passed (0 regressions after test updates — see below)
- packages/cli: 722/722 passed (the same 4 level.test.ts assertions pass once
  FORCE_COLOR is unset — they read the ambient shell's color capability, and
  FORCE_COLOR overrides NO_COLOR=1 when both are set; env-dependent, not code)
- opencode-plugin load-test.js: 55/55 passed
- fixture harness: 147/147 (145 per-rule must-block/must-allow cases across all 36
  rules + 2 new priority-ordering probes), covering every new/changed/moved rule with
  its own `tests/rules/<id>/{must-block,must-allow}.yaml`
- drift.test.ts: 9/9 (full-object field comparison across install.ts/plugin.ts, the
  36-rule count assertion, the third-source structural checks for index.ts)

Final tier-table correction: `no-force-push` carries `priority: 82` (see supervisor
fix #2 above), not unset as originally landed.

### packages/core test updates (necessary consequence of the re-tier, not scope creep)

`threat-model.test.ts` and `agentic-eval.test.ts` both read `DEFAULT_RULES_YAML` directly
from `plugin.ts`'s source and assert exact verdicts against the shipped ruleset — they
are load-bearing regression tests for MY changes by construction. Updated, with inline
comments citing the specific re-tier that motivated each:
- `no-verify-bypass`/`no-skip-tests` softened deny→warn: updated ladder assertions
  (warn/warn instead of warn/deny).
- `no-destructive-commands` promoted to protect: swapped the "sprint downgrades deny to
  warn" demo to a rule that's STILL plain `level: sprint` (`no-secrets-in-code`), and
  added a new test proving no-destructive-commands specifically no longer downgrades.
- `no-db-destructive` softened to warn / `prod-db-destruction` added: updated expected
  actions, added a tagged-vs-untagged case.
- `source-change-requires-test` moved to `mode: observe`: rewrote the
  claimed-done-without-evidence and verification-honesty blocks to assert
  `action === 'allow'` + `observed_action === <what it would have done>` instead of the
  old blocking verdict, with a comment explaining observe mode does not replay the
  warn-then-deny ladder (reports the raw boundary action every call).
- `no-exfil-flow`/protectFloor sprint interaction: see above.
