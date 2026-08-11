# Wave 3 Lane 3 — docs: tiers + README refresh

Scope: `docs/tiers.md` (new), `README.md`, `ROADMAP.md`. No source or generated files
touched. Everything below was checked directly against `packages/cli/src/commands/
install.ts`'s `DEFAULT_RULES_YAML`, `packages/core/src/enforce/{pipeline,rule-parser}.ts`,
`packages/core/src/types.ts`, `packages/cli/src/commands/{level,retrospective,audit}.ts`,
`SPEC.md`, `ROADMAP.md`, and live CLI runs in a fresh `HOME` (`npm ci && npm run build`
first, node v26.0.0).

## Claim → verification source

| Claim | Source |
|---|---|
| 42 default rules total | `grep -c '^  - id:' /tmp/.../.keel/rules.yaml` after a fresh `keel install` = 42; `keel validate` prints "42 rules"; `drift.test.ts:72` asserts `install.size === 42` |
| 11 Tier-1 (`level: protect`) rule ids, listed exactly | `awk '/^  - id:/{print}'` over `install.ts` cross-referenced against each block's `level: protect` line; every id individually grepped to confirm presence |
| 22 Tier-2 rules + 1 unlabeled (`unverified-package-install`) | same extraction; `unverified-package-install` confirmed to carry no `level:`/`mode:` field (footnoted in the doc as an inference, not a source label) |
| 9 Tier-3 (`mode: observe`) rule ids | same extraction, all 9 blocks show `mode: observe` |
| Per-rule action/type/message text in the tier tables | python re-extraction of each rule block's `action:`/`type:`/`message:` field directly from `install.ts`'s template literal source, cross-checked against manual reads for the two multi-line (`>-`) messages (`claim-without-evidence`, `test-oracle-tampering`) |
| Tier-1 floors deny on the *first* hit, even under the default `balanced` dial | Live: fresh install, `keel evaluate` against `git push --force origin feature-x` (matches `no-force-push`, Tier 1) returns `"action":"deny"` on the very first call. Contrast: same install, first hit on `no-credential-echo` (Tier 2, `deny` action) returns `"action":"warn"` with message "First violation... warning only. Next time will be blocked." |
| Mechanism: `blockFirst = effectiveLevel==='protect' \|\| rule.level==='protect' \|\| skipFirstWarning` | `packages/core/src/enforce/pipeline.ts:924-932` (read directly) |
| Dial can't soften/hide a `level: protect` rule | `packages/core/src/enforce/rule-parser.ts:322-326` `dialAction()`: `if (rule.level === 'protect') return rule.action` before any dial logic runs |
| Sprint dial downgrades deny/block→warn; deactivates rules whose floor is above sprint; deep/full/fast check depth per dial | `level.ts`'s `LEVEL_EFFECTS`; live `keel level sprint` (from `protect`) output: `4 rule(s) soften deny/block → warn: no-secrets-in-code, no-secret-files, no-credential-echo, source-change-requires-test` / `1 rule(s) deactivated ...: test-oracle-tampering` / `11 level: protect floor(s) unchanged: ...` |
| `test-oracle-tampering` is the one Tier-3 rule with a `level:` (`balanced`), so it deactivates at sprint while the other 8 Tier-3 rules don't | grep of its block in `install.ts`; confirmed by the live dial-diff output above and `keel status` reporting `Active at current dial: 41 of 42` right after the sprint switch |
| Sprint auto-reverts to balanced after 4h; `sprint_expiry_hours` overrides; `0` disables | `packages/core/src/enforce/rule-parser.ts:243` `export const DEFAULT_SPRINT_EXPIRY_HOURS = 4`; live `keel level sprint` output: "sprint auto-reverts to balanced after 4h unless \`sprint_expiry_hours\` overrides it (0 disables)"; `keel status` live output: "sprint auto-reverts to balanced in ~4.0h" |
| `keel level <level>` prints a dial diff (softened/hardened/deactivated/activated/floors) computed from the real merged ruleset | `level.ts:computeDialDiff`/`printDialDiff` read directly; reproduced live (see dial-diff quote above) |
| `keel level`, `keel status`, `keel validate` output shapes quoted in the docs | all run live against a fresh temp-HOME install (see transcript below) |
| Promotion is manual: no `keel promote` command, no `promotion_fp_threshold` config field | `grep -rn "promote\|promotion_fp_threshold" packages/ SPEC.md ROADMAP.md docs/` — no CLI command named `promote` exists in `packages/cli/src/index.ts`'s command list (only `retrospective`, `suggest`, `lessons`, `gather`, `schedule`, `rules`, etc.); no `promotion_fp_threshold` identifier anywhere in the repo |
| Tier-3 rules record `observed_action` on the trace, action returned to host stays `allow` | `packages/core/src/enforce/audit.ts:60-68` (`observed_action: result.observed_action`, comment: "Present only for `mode: observe` rules... this carries what would have been enforced") |
| Trace file location `~/.keel/traces/YYYY-MM-DD.jsonl` | `SPEC.md:868` ("Format: JSONL... Stored at `~/.keel/traces/YYYY-MM-DD.jsonl`"); matches `retrospective.ts:443` (`auditDir = join(homedir(), '.keel', 'traces')`) and `audit.ts` (core)'s `logDir` default |
| `keel audit` (CLI command) does **not** read the trace/observed_action stream — it reads a *different* file (`.keel/audit/audit.log`, `tool_name` field, written by the legacy Rego/WASM `policy-engine.ts` path) | `packages/cli/src/commands/audit.ts:7` vs `packages/core/src/enforce/audit.ts` + `packages/core/src/signing.ts:52`/`policy-engine.ts:661` — two distinct log files/shapes confirmed by reading both sources. Corrected mid-task after advisor flagged this; the doc now points at the trace JSONL directly, not `keel audit` |
| `keel retrospective` prints 8 aggregate metrics (attempts-to-success, stuck-loops/session, research-before-solve, time-to-first-search, churn, deny-repeat rate, verification completion, pivot recovery); no per-rule breakdown option | `retrospective.ts` read in full; live run against an empty trace dir shows exactly those 8 rows; `--help` output shows only `--since/--project/--json/--write`, no `--rule` filter |
| `keel-control-gate` denies an agent running `keel rules ... --append` | `install.ts` rule block: `match: "keel (disable\|allow\|level\|enforce\|install\|uninstall)( \|$)\|keel rules [^\|;&]*--append"` |
| Claude Code host is `live`-verified (not `types`) | `docs/integrations.md:30` already stated `live`; README's own hosts table was stale at `types` — fixed. Transcript: `session/transcripts/claude-code-force-push.txt` (`claude -p` child's own JSON result shows `permission_denials` blocking `git push --force origin main`) |
| `claim`, `oracle`, `package` are real, currently-used rule types (added to README's rule-types line) | `install.ts`: `claim-without-evidence` → `type: claim`; `test-oracle-tampering` → `type: oracle`; `unverified-package-install` → `type: package` |
| `redirect` and `research` are real, reachable EnforcementAction values (added to README's actions line) | `packages/core/src/types.ts:11` declares both; `pipeline.ts:908` returns `'redirect'`; `pipeline.ts:587` returns `this.result('research', ...)` for the knowledge-freshness gate |
| `mask` is a declared-but-unimplemented action — deliberately **not** added to README's actions list | `packages/core/src/enforce/rule-parser.ts:134`: `if (rule.action === 'mask') errors.push(...not implemented by the enforcement engine...)` — validation actively rejects it |
| "Problem-solving rules ship in the default install, not via `keel rules harness`" (README + ROADMAP fix) | `packages/cli/src/commands/harness-rules.ts:4-10`'s own header comment: "AS OF THE wave2-rules TIER RESTRUCTURE, all three of these ship as part of DEFAULT_RULES_YAML itself... `keel rules harness --append` are KEPT for existing users on an older install" — the pre-restructure README/ROADMAP prose ("aren't in the default install", "Promote... into the default install") was stale and has been corrected |
| SPEC.md §8 <0.1% FP-rate figure labeled a design target, not a measured/enforced value | `SPEC.md:849-859` "Acceptable False Positive Rates" table + "Why These Numbers" prose — a design principle, no corresponding code constant found (confirmed by the same grep above) |

## Live command transcript (temp HOME, node v26.0.0, after `npm ci && npm run build`)

```
$ HOME=/tmp/keel-w3docs-home node dist/index.js install
  ✓ Created ~/.keel/rules.yaml
$ grep -c '^  - id:' /tmp/keel-w3docs-home/.keel/rules.yaml
42
$ HOME=/tmp/keel-w3docs-home node dist/index.js validate
  ✓ Global rules: ... (42 rules) ... Total: 42 rules across all scopes
$ HOME=/tmp/keel-w3docs-home node dist/index.js level protect
  global level: balanced → protect
  Dial diff (balanced → protect): No rule changes effective action or activation
  11 level: protect floor(s) unchanged: keel-control-gate, no-rules-tampering,
    no-enforcer-removal, agent-env-hijack, no-destructive-commands,
    protected-branch-reset, protected-branch-delete, pipe-to-shell,
    prod-db-destruction, no-exfil-flow, no-force-push
$ HOME=/tmp/keel-w3docs-home node dist/index.js level sprint
  global level: protect → sprint
  sprint auto-reverts to balanced after 4h ...
  Dial diff (protect → sprint):
    4 rule(s) soften deny/block → warn: no-secrets-in-code, no-secret-files,
      no-credential-echo, source-change-requires-test
    1 rule(s) deactivated (their level floor is above sprint): test-oracle-tampering
    11 level: protect floor(s) unchanged: ...
$ HOME=/tmp/keel-w3docs-home node dist/index.js status
  Speed dial: SPRINT ... sprint auto-reverts to balanced in ~4.0h
  Rules (global): 42 rules
  Active at current dial: 41 of 42
$ (fresh install #2, balanced dial) node dist/index.js evaluate --tool Bash \
    --args '{"command":"git push --force origin feature-x"}'
  {"action":"deny","rule_id":"no-force-push",...}         # Tier-1 floor: deny on FIRST hit
$ node dist/index.js evaluate --tool Bash \
    --args '{"command":"echo aws_secret_access_key: AKIA..."}'
  {"action":"warn","rule_id":"no-credential-echo",
   "message":"First violation of \"no-credential-echo\" — warning only. ..."}
                                                             # Tier-2 deny: warn on FIRST hit
$ node dist/index.js retrospective --help
  Options: --since, --project, --json, --write   (no per-rule filter)
$ node dist/index.js retrospective          # empty trace dir
  attempts-to-success (median), stuck-loops/session, research-before-solve,
  time-to-first-search, churn cycles/session, deny-repeat rate,
  verification completion, pivot recovery      # exactly 8 rows, all "0"/"—"
```

`npx vitest run packages/cli/src/__tests__/drift.test.ts` after the doc changes:
9/9 passed (docs-only change, no source touched — run to confirm the 42-rule
assertion this page depends on is still current, not because doc edits could break it).

## Existing doc claims found that are NOT verifiable — flagged for supervisor, not edited

1. **ROADMAP.md's "Shipped" list**: `12 rule types; 7 actions` (line 14). Actual counts
   from `packages/core/src/types.ts:11-17`: 21 `RuleType` values, 10
   `EnforcementAction` values (`mask` is declared but rejected as unimplemented by
   `rule-parser.ts:134`, so 9 of the 10 are actually usable). Left untouched —
   ROADMAP.md wasn't in this lane's numbered task items and it's ambiguous what subset
   the original "12"/"7" was meant to count (e.g., excluding internal/legacy types).
   Flagging rather than guessing at the intended scope.
2. **`docs/marketing/launch-hn.md` / `launch-reddit.md`**: first-person draft copy
   ("on my own machine the first run found four unprotected hosts", specific host
   counts, etc.) — personal-anecdote numbers in unpublished launch-post drafts, not
   something this lane's scope (docs/tiers.md + README + ROADMAP) covers, and not
   independently checkable against a fixed machine state. Left untouched.
3. Two stale claims that WERE in scope and WERE fixed this lane (listed here so the
   supervisor can see what changed, not as still-open flags): README's Claude Code
   host row (`types` → `live`, matching `docs/integrations.md` which was already
   correct) and README/ROADMAP's "problem-solving rules aren't in the default install"
   language (they are, as of the wave2-rules tier restructure).

## Process note

Mid-task, `advisor()` caught three things my own verification pass had missed before I
wrote prose: (1) README's "Stopping agents that circle" section directly contradicted
`harness-rules.ts`'s own header comment about the wave2 restructure — fixed; (2) I had
been about to cite `keel audit` as where `observed_action` surfaces, but `keel audit`
and the trace-writing `AuditLog` are two different files with two different field
names — fixed to cite the trace JSONL directly, per SPEC.md §9; (3) "every rule is
active at every dial" needed the `test-oracle-tampering` exception stated precisely,
which my own live capture already contained but I hadn't yet reconciled with the
source-code comment. All three are reflected in `docs/tiers.md` and the README/ROADMAP
diffs as shipped.
