# Promotion report — `keel retrospective` / `keel promote`

Lane: closeout PROMOTION-REPORT (`w3-report`, merged `v0.3-autonomous` at
`01769bd` — no conflicts). Every number below comes from a command
actually run in this worktree or in an isolated temp directory; each
section shows the command and its captured output. Nothing here was
promoted — see §4.

This report has two parts, deliberately kept apart:

- **§1–2 — METHODOLOGY + DEMONSTRATION.** What the pipeline measures, and
  a captured `keel retrospective` run against a SYNTHETIC dataset built to
  exercise all three recommendation outcomes. Labeled synthetic
  throughout; none of it is evidence about any real rule.
- **§3 — THIS SESSION'S ACTUAL DATA.** A captured `keel retrospective` run
  against the real `~/.keel/traces` on this machine, plus the auditing
  work that was needed to say what that output does and doesn't mean.

## 1. What the pipeline measures

`packages/cli/src/commands/retrospective.ts`'s `computePromotionReport()`
computes, per `mode: observe` rule:

- **`total_evaluations`** — every tracked `tool.execute.before` event is
  one evaluation opportunity for every active rule. "Tracked" means
  `hook === 'tool.execute.before'` AND `agent` is one of
  `opencode-plugin`, `openclaw-plugin`, `hermes-plugin`, `claude-code-hook`
  (`TRACKED_AGENTS` / `isBefore()`, `retrospective.ts:136,146`) — this is
  the SAME filter every other retrospective metric uses, so a rule's
  would-block rate never disagrees with the rest of the report over a
  different denominator.
- **`would_block_count`** — entries where the rule's `observed_action`
  (top-level, or inside `observed_matches[]` when more than one observe
  rule matched the same call) is `deny`, `block`, `prompt`, or `redirect`
  — the four actions the host actually interrupts on. `redirect` is
  included deliberately: three of the shipped observe rules
  (`no-repeat-loops`, `research-before-fix`, `root-cause-before-refactor`)
  use it as their primary or only interrupting action, so excluding it
  would make every one of them read a 0% false-positive rate regardless
  of how often they actually fired.
- **`rate`** = `would_block_count / total_evaluations` (null with zero
  traffic).
- **`threshold`** = `promotion_fp_threshold` from whichever `rules.yaml`
  wins precedence (project over global), default `0.001` (1 per 1000).
- **Recommendation**, one of three — not two:
  - `insufficient_data` when `total_evaluations < ceil(1/threshold)`
    (1000 at the default threshold). A 0% rate over a handful of calls is
    indistinguishable from "not enough traffic yet," so it is never
    reported as proof of safety.
  - `eligible` when `total_evaluations` clears that floor AND
    `rate < threshold`.
  - `stay_observe` otherwise.
- **Scoping.** A rule declared in a project/local `rules.yaml` is
  `scoped: true` — its denominator is filtered to entries whose `cwd`
  falls under that project, so another project's traffic can't dilute its
  rate and push it toward `eligible`. A global/user rule is unscoped: the
  full trace stream is its correct denominator, because it genuinely
  applies everywhere.

The rules this pipeline exists to serve, per the shipped default template
(`packages/cli/src/commands/install.ts`): `source-change-requires-test`,
`no-repeat-loops`, `research-before-fix`, `root-cause-before-refactor`,
`claim-without-evidence`, `test-oracle-tampering`, `test-before-commit`,
`runaway-budget-tool-calls`, `runaway-budget-bash-calls` — all shipped at
`mode: observe` (burn-in), none blocking by default.

## 2. Demonstration (SYNTHETIC data — labeled, not evidence about any real rule)

`scripts/generate-promotion-demo.mjs` (added this lane, no source files
touched) writes an isolated `home/`, `project/`, and `traces/` under a
temp dir — never touches the real `~/.keel/traces` — and generates 5000
synthetic `tool.execute.before` entries across 250 fake sessions, split
across three demo-only rule ids designed to land on each of the three
recommendations:

| rule | scope | evals | would-blocks | rate | designed outcome |
|---|---|---|---|---|---|
| `demo-loop-observer` | global (unscoped) | 5000 (whole stream) | 1 | 0.02% | `eligible` |
| `demo-noisy-observer` | global (unscoped) | 5000 (whole stream) | 40 | 0.8% | `stay_observe` |
| `demo-scoped-observer` | project (scoped) | 500 (this project only) | 0 | — | `insufficient_data` |

Both `TraceEntry` shapes the real pipeline reads are exercised:
`demo-loop-observer`'s would-block uses the legacy single-slot
`rule_id`/`observed_action` fields; `demo-noisy-observer`'s 40 use the
`observed_matches[]` array (the shape introduced by this wave's
observe-continue fix, for when more than one observe rule matches a
single call). `demo-scoped-observer` proves the cwd-scoping: its rule is
declared only in the temp project's own `.keel/rules.yaml`, and 500 of
the dataset's rows share its cwd while another 500 sit under a different
project's cwd on purpose — those 500 must NOT count toward its
denominator, and the captured output below confirms they don't (500, not
1000).

Default threshold (`0.001`) is used throughout — nothing overridden — so
this demonstrates the pipeline's documented default behavior.

Commands run (isolated `HOME`/`KEEL_TRACES_DIR`, no real user data):

```
$ node scripts/generate-promotion-demo.mjs /tmp/keel-promo-demo
Wrote 5000 synthetic trace entries to /tmp/keel-promo-demo/traces/2026-08-11.jsonl
Home:    /tmp/keel-promo-demo/home
Project: /private/tmp/keel-promo-demo/project
Traces:  /tmp/keel-promo-demo/traces

$ cd /tmp/keel-promo-demo/project && env -i HOME=/tmp/keel-promo-demo/home PATH="$PATH" \
    KEEL_TRACES_DIR=/tmp/keel-promo-demo/traces \
    node <repo>/packages/cli/dist/index.js retrospective
```

Captured output:

```
  ⚓ keel retrospective
  earliest → 2026-08-11

  Sessions analyzed: 250   (success 0)

  attempts-to-success (median)      —
  stuck-loops / session             0.00
  research-before-solve             —
  time-to-first-search (median s)   —
  churn cycles / session            0.00
  deny-repeat rate                  0%
  verification completion           —
  pivot recovery (stuck sessions)   —

  Top problem signatures
    general         250 session(s)

  Promotion (mode: observe rules, threshold 0.001 = 0.10% would-block rate)
    demo-loop-observer            eligible for promotion to warn
      1 would-block(s) in 5000 evals, all traces (0.020%) — eligible for promotion to warn
    demo-noisy-observer           stay observe
      40 would-block(s) in 5000 evals, all traces — review before promoting
    demo-scoped-observer          insufficient data
      0 would-block(s) in 500 eval(s), this project — need 1000+ evaluations to trust a rate this small
    Promote with: keel promote <rule-id> (run from your own terminal — never through the agent)
```

All three recommendations are produced correctly against the designed
inputs, the legacy and `observed_matches[]` shapes both count correctly,
and the scoped denominator (500, excluding the other project's 500 rows)
matches the design. `keel promote` was also exercised against this
synthetic project to confirm the TTY gate — see `session/EVIDENCE/wave3-promotion.md`
§7 for the full promote/idempotency evidence from the lane that built the
command; this lane re-confirmed only the refusal path, on the synthetic
project, not against any real config:

```
$ cd /tmp/keel-promo-demo/project && env -i HOME=/tmp/keel-promo-demo/home PATH="$PATH" \
    KEEL_TRACES_DIR=/tmp/keel-promo-demo/traces \
    node <repo>/packages/cli/dist/index.js promote demo-loop-observer < /dev/null
  `keel promote` edits your rules.yaml, so it must be run from your own terminal.
  Run `keel retrospective` to see promotion recommendations instead.
exit=1
```

## 3. This session's actual data (real `~/.keel/traces`, no synthesis)

### 3.1 What's actually in the trace store

Captured 2026-08-11T12:27:05Z. The trace store is append-only and written
concurrently by other lanes/sessions on this machine — a re-run next week
(or next hour) will show a larger total-lines figure than the one below;
that is the store moving, not this report being wrong. The tracked
subset in §3.2 is the number that matters, and it was re-verified stable
across two separate reads during this audit.

```
$ wc -l ~/.keel/traces/*.jsonl | tail -1
   11016 total
```

Before trusting that number, it was audited rather than taken at face
value — a large fraction of it turned out NOT to be dogfood traffic:

```
$ cat ~/.keel/traces/*.jsonl | python3 -c "... agent counts ..."
Counter({'opencode-plugin': 7637, 'unknown': 3349, None: 7, 'claude-code': 7,
          'generic': 6, 'test': 4, 'keel-test': 2, 'verify': 2, 'gemini': 1})

$ cat ~/.keel/traces/*.jsonl | python3 -c "... count agent=='unknown' AND hook is None ..."
agent=unknown: 3349
hook=None: 3426
both (agent=unknown AND hook=None): 3349
```

All 3349 `agent: "unknown"` lines also carry no `hook` field (measured as
the conjunction above, not inferred from the two counts separately) —
these are `keel evaluate` test-harness fixtures (commands like
`protected-command`, `dangerous-command`, `test-tool`, one- or two-event
"sessions" numbering over a thousand on the busiest day) that leaked into
the REAL trace directory instead of an isolated `KEEL_TRACES_DIR`,
apparently from vitest suites elsewhere on this machine that don't
override the trace path. This is not this lane's bug to fix (out of
scope, no source files touched), but it mattered for reading the output
honestly: `isBefore()`'s `TRACKED_AGENTS` filter (§1) already excludes
`agent: "unknown"` for exactly this reason — the design doc that added it
cites the identical failure mode (`retrospective.ts:130-135`). So the
pollution does not reach the promotion denominator; it doesn't need a
separate correction here, but it does mean "11016 lines" is not
"11016 evaluations" and shouldn't be read as such.

### 3.2 The real, tracked subset

```
$ cat ~/.keel/traces/*.jsonl | python3 -c "
    ... filter hook=='tool.execute.before' and agent in TRACKED_AGENTS ..."
total tracked before-hook evals (isBefore): 2971
unique real sessions: 20
earliest: 2026-07-31T01:50:56.745Z
latest:   2026-08-04T03:40:28.825Z
```

Per-file breakdown of that same filter (file names are local dates; the
earliest/latest timestamps just above are UTC, which is why
`2026-07-30`'s 4 entries can carry a UTC timestamp that reads
`2026-07-31` — both numbers are real, just in different clocks):

```
2026-07-29: 0     2026-08-01: 55     2026-08-03: 1530
2026-07-30: 4      2026-08-02: 754    2026-08-04: 579
2026-08-11: 0
```

**Zero tracked evaluations from today (2026-08-11), the day this wave-3
build ran.** All 2971 real tracked evaluations are historical — from
earlier in the v0.3 build effort (local dates 2026-07-30 through
2026-08-04, UTC timestamps 2026-07-31 through 2026-08-04),
dogfooded via the `opencode-plugin` agent while keel's own team was
developing keel (spot-checked commands include `npm run test -w
@get-keel/core`, `keel allow source-change-requires-test --once`, real
`git commit --signoff` calls, and a release-bump commit — genuine
development traffic, not fixtures). This confirms the contract's premise
exactly for today's session (claude-code hooks were never wired into the
real `~/.claude`, so this wave-3 build itself generated no tracked
traces) while also being honest that the trace store is not empty
historically — 2971 real evaluations across 20 real sessions exist, and
`keel retrospective` reads all of them, not just today's.

### 3.3 Real `keel retrospective` output

```
$ cd <this worktree> && node packages/cli/dist/index.js retrospective
```

```
  ⚓ keel retrospective
  earliest → 2026-08-11

  Sessions analyzed: 20   (success 0)

  attempts-to-success (median)      —
  stuck-loops / session             0.80
  research-before-solve             33%
  time-to-first-search (median s)   0.3
  churn cycles / session            0.00
  deny-repeat rate                  10%
  verification completion           0%
  pivot recovery (stuck sessions)   40%

  Top problem signatures
    general         15 session(s)
    stuck-loop      5 session(s)

  Lessons for requirements.md
    • Do not retry an identical blocked command: read the rule message and change approach instead. (5)
    • Research before editing: sessions that searched first resolved in fewer attempts. (2)
    • Switch approach after 2 failed attempts; sessions that never pivoted stayed stuck. (3)

  Promotion (mode: observe rules, threshold 0.001 = 0.10% would-block rate)
    no-repeat-loops                eligible for promotion to warn
      0 would-block(s) in 2971 evals, all traces (0.000%) — eligible for promotion to warn
    research-before-fix            eligible for promotion to warn
      0 would-block(s) in 2971 evals, all traces (0.000%) — eligible for promotion to warn
    root-cause-before-refactor     eligible for promotion to warn
      0 would-block(s) in 2971 evals, all traces (0.000%) — eligible for promotion to warn
    Promote with: keel promote <rule-id> (run from your own terminal — never through the agent)
```

Only 3 of the 9 default observe rules (listed in §1) appear at all. That's because
this command reads whichever `rules.yaml` hierarchy wins for the running
directory (`loadRuleHierarchy(process.cwd())`), and the real, currently
installed `~/.keel/rules.yaml` on this machine (`mtime: 2026-08-04
11:48:10`) only declares `no-repeat-loops`, `research-before-fix`, and
`root-cause-before-refactor` at `mode: observe`. `source-change-requires-test`,
`claim-without-evidence`, `test-oracle-tampering`, `test-before-commit`,
and both `runaway-budget-*` rules — all newer additions from this
build — are not yet in the live installed config, so they report **zero**
real evaluations, not "eligible" or "insufficient_data": the pipeline
never saw them at all in this run.

### 3.4 Why "eligible, 0.000%" here is NOT an eligibility signal

The raw output above says `eligible for promotion to warn` for all three
rules the live config does track. Read literally against the pipeline's
own arithmetic (2971 evaluations ≥ the 1000-evaluation floor at the
default threshold, 0 would-blocks, 0% < 0.1%), that is a correct
computation — but it is not evidence these rules are safe to promote, and
this report deliberately does not present it as such. Checked directly:

```
$ cat ~/.keel/traces/*.jsonl | python3 -c "
    ... count rule_id == one of {no-repeat-loops, research-before-fix,
        root-cause-before-refactor} in rule_id OR observed_matches[],
        across all 2971 tracked evaluations ..."
total hits for the 3 rules across 2971 real tracked evals: 0
```

**Zero.** Not zero would-blocks with some warns/fixes recorded — zero
matches of ANY kind, across every real tracked evaluation in the store.
The 0% rate is not a measured false-positive rate; it's the numerator and
denominator of a rule that never fired once in 20 real dogfood sessions.
`no-repeat-loops` is a stuck-loop detector (needs an actual ≥3x repeated
failing command), `research-before-fix` and `root-cause-before-refactor`
are trigger/stateful rules that only arm on a failing command or a
refactor-shaped edit with a pending obligation — it is entirely plausible
none of those specific conditions arose in this particular 20-session,
2971-call sample of building keel itself. That is real information (it
says these rules are rare-to-trigger in this traffic, which is itself
useful for whoever eventually reviews them), but it is a fundamentally
different claim from "measured at a 0.02% false-positive rate over 1000+
firings," which is what `eligible` is designed to certify and what the
demonstration in §2 actually shows.

Two more reasons this specific real-data run should not be read as a
promotion signal, found while auditing it:

1. **`insufficient_data`'s floor counts total traffic, not the rule's own
   traffic.** `total_evaluations` for an unscoped rule is every tracked
   call in the store, whether or not that rule was even loaded at the
   time or ever matches anything. A rule that was silently inactive for
   the entire window still clears the 1000-evaluation floor on other
   rules' traffic and reads `eligible` — this real run is a live instance
   of exactly that gap. Worth naming as a burn-in prerequisite for a
   human reviewer to check (did the rule actually fire zero times, or was
   it not even active?) before promoting anything off this number; not
   something this lane changed in `retrospective.ts` (no source edits,
   per this lane's contract).
2. **Every one of these 2971 real evaluations predates the
   observe-continue fix** landed earlier in this same wave
   (`session/EVIDENCE/wave3-promotion.md` §1–2: pre-fix, a matched
   `mode: observe` rule's `violation()` call `return`ed straight out of
   `evaluate()`, so a HIGHER-priority observe rule matching first could
   blind evaluation of everything after it on the same call, including a
   lower-priority observe rule that might otherwise have recorded a
   match). This doesn't fabricate the zero — an observe rule's own match
   was still recorded correctly pre-fix when it was hit — but it means
   this real trace window was captured under code with a known blind
   spot, which is one more reason to treat it as "no burn-in signal yet"
   rather than "clean data confirming eligibility."

### 3.5 Conclusion for this session

**No rule is eligible for promotion on this session's real data.**
`no-repeat-loops`, `research-before-fix`, and `root-cause-before-refactor`
show a structural zero-match count (never fired, not "fired safely") over
20 real sessions predating this wave's observe-continue fix — not a
validated false-positive rate. The remaining default observe rules
(`source-change-requires-test`, `claim-without-evidence`,
`test-oracle-tampering`, `test-before-commit`, `runaway-budget-tool-calls`,
`runaway-budget-bash-calls`) have **zero** real evaluations because the
live installed `~/.keel/rules.yaml` on this machine predates their
addition. Today's session (2026-08-11) contributed **zero** tracked
evaluations of any rule — the contract's premise (no continuous dogfood
this session, since wiring keel into the real `~/.claude` was out of
scope) holds exactly as stated.

The mechanism itself is demonstrated working correctly in §2, against
synthetic data built for that purpose, and is ready for real burn-in once
the live config is upgraded to the current default rule set and enough
genuine traffic accumulates.

## 4. Confirmation: nothing was promoted

`keel promote` was not invoked against the real `~/.keel/rules.yaml` at
any point in this lane, with or without `KEEL_ALLOW_NON_TTY`. The only
`keel promote` invocation in this report (§2) targeted a throwaway
synthetic project under `/tmp`, confirmed the TTY refusal, and made no
change to any file this lane doesn't own. `git status` in this worktree
shows only `session/PROMOTION-REPORT.md` and
`scripts/generate-promotion-demo.mjs` added — no rules.yaml anywhere was
touched.

## 5. Commands for a human to run

```
# See your own promotion recommendations (safe from an agent — read-only):
keel retrospective
keel retrospective --json     # machine-readable, includes the `promotion` array

# Promote a rule one rung up the ladder (observe -> warn -> block).
# TTY-gated: refuses outside a real interactive terminal, and is on
# keel-control-gate's deny list, so an agent cannot run this itself.
keel promote <rule-id>
keel promote <rule-id> --to warn   # or --to block, to jump a rung
```
