# The three tiers

`keel install` writes 49 default rules into `~/.keel/rules.yaml`, split into three
tiers: 13 rules in Tier 1 carry a hard `level: protect` floor, plus one more Tier-1-
positioned sibling rule that doesn't (see the note under Tier 1 below); 22 rules sit in
Tier 2 (balanced); 12 rules sit in Tier 3 (observe); and one rule (`no-repeat-loops`)
has since been promoted out of Tier 3 into active enforcement (see below). This page
explains what each tier does, how the "speed dial" (`keel level`) interacts with them,
and how a rule moves from silently watching to actually blocking.

Two different things are both called "level" here, and it's worth pulling apart once:

- **`keel level`** is the global dial you set — `sprint`, `balanced`, or `protect`.
  It's one setting for the whole ruleset.
- **A rule's own `level:` field** is a per-rule floor. Most rules don't set one (or
  carry `level: sprint`, meaning "no floor — obey the dial"). Thirteen rules set
  `level: protect`, and those are what this page calls **Tier 1**.

So when a Tier-2 rule's source says `level: sprint`, that is *not* "only active at the
sprint dial" — every rule is evaluated at every dial. It means "this rule has no floor,
so the dial's softening rules apply to it normally."

## Why tiers exist

Two failure modes push in opposite directions, and one ruleset has to survive both:

- **A rule that interrupts on its first hit is how guardrails get switched off.**
  keel's own build history is the evidence: before the anti-circling rules shipped,
  this project's own traces show 41 distinct repeat loops across 20 sessions — one
  command retried 39 times — because the machinery that would have caught it wasn't
  turned on. A brand-new behavioural rule with no track record on *your* traffic earns
  the right to interrupt by first proving it's not a false-positive machine.
- **Some actions are incident-backed, not hypothetical.** `agent-env-hijack` and
  `no-rules-tampering` exist because of real host-config-poisoning CVEs
  (CVE-2025-59536, CVE-2026-21852) and reported Copilot `autoApprove` abuse.
  `unverified-package-install` exists because 19.7% of LLM-recommended packages don't
  exist and get squatted by attackers waiting for an agent to install the
  hallucinated name (USENIX Security 2025). For actions in that class, a warn-once
  ladder is the wrong shape — the first hit *is* the incident.

Three tiers resolve that tension by giving each rule the posture its own evidence
earns it, instead of applying one policy to all 49.

| Tier | What it does | Can the dial soften it? | Example rules |
|---|---|---|---|
| **1 — protect floor** | Denies on the *first* hit, always | No — active and unsoftened at every dial, sprint included | `no-force-push`, `pipe-to-shell`, `no-exfil-flow`, `keel-control-gate` |
| **2 — balanced** | Warns once, then blocks (dial-dependent) | Yes — `sprint` downgrades its deny/block to warn | `no-push-to-main`, `no-secrets-in-code`, `cicd-and-infra` |
| **3 — observe** | Evaluated and recorded, never interrupts | N/A — records what it *would* have done regardless of dial | `research-before-fix`, `claim-without-evidence`, `runaway-budget-tool-calls`, `session-spend-limit` |

## Tier 1 — protect floor (13 rules)

Every rule below ships with `level: protect`. That makes two things true regardless of
what dial you're on: the dial can never soften or hide it, and it denies on the very
first match rather than warning once first. Verified live — evaluating `no-force-push`
against a fresh `keel install` on the default `balanced` dial returns `deny` on the
first call, while a Tier-2 deny rule (`no-credential-echo`) returns `warn` ("First
violation... warning only") on its first call under the same dial.

| Rule id | Guards against |
|---|---|
| `keel-control-gate` | An agent running keel's own control commands (`disable`, `allow`, `level`, `install`, `uninstall`, `rules --append`, `halt`, `resume`) |
| `no-rules-tampering` | Editing keel's own rules/state/plugin files, or host auto-approve config (`.claude/settings*.json`, `.mcp.json`, `.vscode/settings.json`, git hooks) |
| `no-enforcer-removal` | Deleting keel's enforcement files |
| `no-self-protection-write` | Shell writes (`>`, `tee`, `cp`, `mv`, `sed -i`, `python3 -c`, `node -e`, `ln`, `git config core.hooksPath`, …) targeting keel's files, host trust/approval config, or git hooks — closes the gap `no-rules-tampering`/`no-enforcer-removal` leave open, since `filesystem`-type rules only see a tool call's declared path argument, not a shell redirect target |
| `agent-env-hijack` | Persisting a mutated `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`/`KEEL_*` into shell or config files |
| `no-destructive-commands` | Destructive commands, including fork bombs |
| `no-destructive-interpreter-body` | The same destructive-wipe class issued through an interpreter instead of a shell command — `shutil.rmtree('/')`, `os.system('rm -rf ~')`, Node's `rmSync`/`rmdirSync` on `/` or `~`, `subprocess.run([...'rm','-rf','/'])` |
| `no-force-push` | `git push --force` (suggests `--force-with-lease`) |
| `protected-branch-reset` | `git reset --hard` naming main/master explicitly |
| `protected-branch-delete` | Deleting the main/master branch, local or remote |
| `pipe-to-shell` | `curl/wget \| sh`-style remote code execution |
| `no-exfil-flow` | Data read from a sensitive file, then sent over the network |
| `prod-db-destruction` | A destructive DB operation against a connection tagged prod/production/live |

**A 14th rule sits in this same source section but is not a floor:**
`no-exfil-flow-cross-call` is `no-exfil-flow`'s warn-tier sibling — it checks the same
sources/sinks against a persisted, session-scoped store instead of in-memory state, so
it catches a read and a later network sink across two separate hook processes, not just
one. It ships `action: warn`, `level: sprint` (no floor — the dial can soften it like any
Tier-2 rule), yet it's written directly after `no-exfil-flow` in `rules.yaml` rather than
under the Tier-2 comment header. This page counts it toward the 48-rule total but not
toward Tier 1's 13-rule floor count, since behavior (no floor, dial-softenable `warn`) is
what puts a rule in a tier, not its position in the file.

## Tier 2 — balanced (22 rules)

These carry no floor (`level: sprint` in the YAML, meaning "obey the dial normally") or
no `level:` field at all. Most `deny` actions here warn on the first hit and block on
the second under the default `balanced` dial; `sprint` softens deny/block further to a
plain warning. A handful — `no-secrets-in-code`, `no-secret-files`, `no-credential-echo`
— stay `deny` even so, because they match exact, high-confidence signatures (literal
credential formats) rather than a broad pattern. `prompt`-action rules (approval gates)
are never downgraded by any dial.

| Rule id | Action | Guards against |
|---|---|---|
| `no-db-destructive` | warn | Destructive DB op on an *untagged* connection |
| `no-push-to-main` | prompt | Pushing directly to a protected branch |
| `commit-to-main` | warn | Committing directly on main/master |
| `no-verify-bypass` | warn | `--no-verify` / `-n` / `core.hooksPath` hook bypass |
| `write-outside-project` | prompt | Writes to system paths or shell rc files |
| `cicd-config-edit` | prompt | Editing CI/CD pipeline config |
| `cicd-and-infra` | prompt | `terraform apply/destroy`, non-exempted `kubectl` mutations |
| `secret-file-read-without-egress` | warn | Reading a secret file (no egress detected yet) |
| `broad-privilege-escalation` | warn | Unscoped `sudo`, `chmod -R`, `chown -R` |
| `paste-site-exfil` | prompt | Posting to pastebin-class hosts |
| `no-remote-exec` | prompt | `npx`/`bunx`-style on-the-fly remote package execution |
| `no-after-hours-publish` | warn | Publish/push outside 09:00–22:00 |
| `bash-rate-limit` | warn | >30 Bash calls in 60s |
| `no-skip-tests` | warn | Faking a green test run |
| `no-secrets-in-code` | **deny** | Hardcoded credentials written to a file |
| `no-secret-files` | **deny** | Writing/modifying credential files |
| `no-credential-echo` | **deny** | Echoing environment credentials in a command |
| `must-sign-commits` | fix | Auto-adds `--signoff` to commits |
| `git-history-rewrite` | prompt | Git history mutation (rewrites shared history) |
| `publish-gate` | prompt | Publishing or deleting registry artifacts |
| `verify-format-before-decision` | warn | Choosing a format/convention without checking the project's own |
| `unverified-package-install` * | prompt | A package name that doesn't resolve against its package registry (npm, PyPI, crates.io, or the Go module proxy) |

\* `unverified-package-install` ships with no `level:` or `mode:` field at all — it
isn't under either tier's YAML comment header in `install.ts`. It's listed here because
its behavior (no floor, dial-softenable `prompt`) matches Tier 2, but that placement is
this page's inference, not something the source labels explicitly.

## Promoted out of Tier 3: `no-repeat-loops`

`no-repeat-loops` shipped as `mode: observe` alongside the other Tier-3 rules below,
but has since been promoted to real enforcement — its `mode: observe` line was removed
while its `action: warn` + escalation ladder stayed exactly as designed. The evidence
behind the promotion, not an assumption: this project's own traces cite **41 distinct
repeat loops across 20 sessions** (one command retried 39 times) from before this
machinery existed — see "Why tiers exist" above — and no over-triggering or
false-positive has ever been recorded against this rule anywhere in the project's
history (checked against `session/PROMOTION-REPORT.md`, the fixture corpus, and every
retrospective run). The two `runaway-budget-*` rules below were evaluated against the
identical bar and held back: their own rationale states plainly that observe mode
exists to measure a hit rate that has never actually been measured (precedent-only
justification, zero real evaluations recorded to date) — that is the honest "not yet"
case this promotion is not. `session-spend-limit` (the newest Tier-3 rule, `type:
budget`) is a DIFFERENT "not yet" case, one level more cautious than the `runaway-budget-*`
pair: it isn't only unmeasured, its model-string normalization has a safety-critical
failure mode (see its own row below) that needs to survive real traffic before this
rule is even a promotion candidate.

Because it is a `type: stuck` escalation ladder rather than a flat warn-or-deny rule,
it doesn't fit Tier 1 or Tier 2's simple action column cleanly:

| Rule id | Type | Real action | Guards against |
|---|---|---|---|
| `no-repeat-loops` | stuck | warn (base) → **redirect** at 3 identical failures → **deny** at 5, in a 15-minute window; `sprint` downgrades the 5th-attempt deny to warn, the 3rd-attempt redirect never softens | An identical failing command retried 3× / 5× in a 15-minute window |

## Tier 3 — observe (12 rules)

Every rule below ships with `mode: observe`. The pipeline evaluates them on every
matching call and records what it *would* have done — the `observed_action` field on
the trace entry (`~/.keel/traces/YYYY-MM-DD.jsonl`) — but the actual `action` returned
to the host is always `allow`. Nothing here interrupts anyone yet.

| Rule id | Type | Would-be action | Guards against |
|---|---|---|---|
| `research-before-fix` | research | redirect | Patching a failure without looking anything up first |
| `root-cause-before-refactor` | diagnosis | redirect | A destructive/structural change with no recorded hypothesis or investigation |
| `source-change-requires-test` | verification | deny | A commit/push after a source edit with no passing test run since |
| `claim-without-evidence` | claim | warn | Claiming "done/fixed/tested/passing" without a verification run to back it |
| `test-oracle-tampering` | oracle | warn | A test weakened (skip/only added, assertion removed, snapshot rewritten) shortly after it failed |
| `test-oracle-env-introspection` | content | warn | Written code that inspects the call stack/test identifier and branches on it — detecting *which* test is calling the implementation to fake two contradictory tests passing, instead of implementing correct behavior |
| `test-before-commit` | verification | warn | `src/` changes committed with no passing test run in the session |
| `runaway-budget-tool-calls` | rate | warn | >500 tool calls in the last 4 hours of a session — call-VOLUME only, no visibility into actual LLM token/dollar spend |
| `runaway-budget-bash-calls` | rate | warn | >500 Bash calls in the last 4 hours of a session — same call-VOLUME-only caveat |
| `session-runaway-trip` | session | warn → prompt → **deny+halt** (consecutive_failures only) | A composite runaway-loop trip: session duration, cumulative tool/Bash-call counts, distinct-file-write churn, and consecutive-failure count. See below. |
| `session-spend-limit` | **budget** | deny | Measured session spend (real tokens, read from a host's own local transcript/session record — a Claude Code transcript's usage fields or an OpenCode session row's cost/token columns) over `max_tokens`. NOT the same mechanism as the two `runaway-budget-*` rows above: this reads actual usage instead of counting calls. Ships `mode: observe` for a narrower, safety-specific reason than "unmeasured": its Claude Code reader depends on model-string normalization with a real failure mode (a short alias like `claude-sonnet-5` must never be priced as an official dated model ID), and that needs to survive real traffic before this rule denies anything. Two-phase by construction — see `packages/core/src/enforce/budget-tracker.ts` — because Claude Code's Stop hook cannot block. |
| `command-oscillation` | **oscillation** | warn (base) → **redirect** at 2 repeats → **deny** at 3 repeats, in a 15-minute rolling window of the last 8 tracked calls | A short repeating CYCLE of >= 2 DIFFERENT recent command fingerprints (A→B→A→B, or A→B→C→A→B→C) — an agent alternating between two or three failing commands/edits that never converge, not the SAME command repeated (that's `no-repeat-loops`, above). See below. |

`session-runaway-trip` is `type: session`'s first real handler — a composite
runaway-loop trip across five session-scoped dimensions (wall-clock duration,
cumulative tool-call count, cumulative Bash-call count, distinct-file-write churn,
and consecutive-failure count), tracked in one atomically-locked record per session
(`session-store.ts`) and escalated through an author-declared ladder
(`session-tracker.ts`). It doesn't fit this table's flat "would-be action" column
cleanly, for the same reason `no-repeat-loops` didn't fit Tier 1/2's action column:
duration, tool-call count, bash-call count, and file-write churn are pure VOLUME
counters that climb whether a session is thriving or stuck, so they are structurally
barred (`validateRules`) from escalating past `prompt` — a legitimate 500-tool-call
refactor across 60 files must never look like a runaway loop on volume alone. Only
`consecutive_failures` is failure-aware (reset on any success, exactly like
`no-repeat-loops`'s own `require_failure`) and is the one dimension allowed to
escalate all the way to a `keel halt` lockdown latch with no auto-expiry. Unlike
`no-repeat-loops`, this rule ships with no measured hit-rate evidence yet — it starts
in `mode: observe` for the same reason the `runaway-budget-*` rules above still sit
there, not because it was promoted and then held back.

`command-oscillation` (`type: oscillation`) is the sibling ROADMAP.md named alongside
`no-repeat-loops`: a short rolling window of recent command fingerprints per session
(default: last 8, not the whole session history — oscillation is a LOCAL pattern),
checked for a repeating cycle of length >= 2 rather than one fingerprint repeated.
Complementary to `no-repeat-loops` by construction, never redundant with it: a pure
exact-repeat never satisfies this rule's distinct-fingerprint-within-the-unit
requirement, and a genuine A→B→A→B cycle never accumulates a count in
`no-repeat-loops`' own per-fingerprint buckets either. `require_failure` defaults to
`true`, the same discriminator `no-repeat-loops` already relies on: a legitimate TDD
red-green-refactor loop (edit test, edit code, edit test, edit code) is literally
period-2 alternation between two fingerprints, and only the fact that each step
succeeds distinguishes it from a genuine stuck oscillation — requiring failure excludes
it by construction. Known gap, left undone rather than force-fit: an agent oscillating
between edits that each individually SUCCEED (e.g. reverting a file to a prior state
each time) needs a content-state signal no tracker in this codebase feeds into this
detector today. Ships with no measured hit-rate evidence, same posture as
`session-runaway-trip` above.

`test-oracle-tampering` and `test-oracle-env-introspection` are the two Tier-3 rules
that carry an explicit `level: sprint` (every other Tier-3 rule leaves `level` unset) —
both mean "no floor, obey the dial" per this page's own opening distinction, so neither
gets touched by a dial change (both are already `action: warn`, so there is nothing to
soften either). Confirmed live, from a clean isolated install (`keel level sprint` from
`protect`): 5 rules soften from deny/block to warn (`source-change-requires-test`,
`session-spend-limit`, `no-secrets-in-code`, `no-secret-files`, `no-credential-echo`)
but none are DEACTIVATED — every rule stays present and evaluated at every dial, only
the deny-tier ones get weaker. `keel status` reports `Active at current dial: 49 of
49` at sprint, confirming no rule drops out of the active set — "active at every dial"
means present and evaluated, not unaffected by the dial.

## The speed dial

```
keel level sprint     # least friction — prototyping
keel level balanced   # default — day to day
keel level protect    # most friction — before a deploy, high-stakes work
```

| Dial | deny/block rules | Checks run | Tier-1 floors |
|---|---|---|---|
| `sprint` | downgraded to warnings | fast — content/sequence/flow skipped | unchanged, still deny-on-first-hit |
| `balanced` | warn once, then block | full | unchanged |
| `protect` | block on first violation (every deny rule, not just floors) | full + reasoning heuristics | unchanged |

`prompt` approval gates are never downgraded at any dial — an irreversible action still
needs `keel allow <id> --once` from a human no matter how loose the dial is.

Switching the dial doesn't just change a number — it tells you exactly which rules
change behavior, computed from the real merged ruleset, not prose. Live capture,
switching `protect → sprint`:

```
Dial diff (protect → sprint), from the merged ruleset:
  4 rule(s) soften deny/block → warn: source-change-requires-test, no-secrets-in-code,
    no-secret-files, no-credential-echo
  13 `level: protect` floor(s) unchanged: keel-control-gate, no-self-protection-write,
    no-rules-tampering, no-enforcer-removal, agent-env-hijack, no-destructive-commands,
    no-destructive-interpreter-body, protected-branch-reset, protected-branch-delete,
    pipe-to-shell, prod-db-destruction, no-exfil-flow, no-force-push
```

(This capture also predates the budget lane; re-run today and `session-spend-limit`
joins the "soften deny/block → warn" list, since its declared `action: deny` still
participates in the dial-softening check even while `mode: observe` keeps its actual
verdict at `allow`.)

`sprint` isn't meant to be permanent: it auto-reverts to `balanced` after 4 hours
(`DEFAULT_SPRINT_EXPIRY_HOURS` in `rule-parser.ts`), overridable with
`sprint_expiry_hours` in rules.yaml (`0` disables the revert). `keel status` shows the
countdown; `keel level` (no argument) flags an already-expired sprint. Changes take
effect on the next tool call — no restart, no daemon round-trip needed.

## The promotion lifecycle

Promoting a Tier-3 rule is a step you take yourself, never an automated threshold —
but as of `keel promote`'s evidence gate, the observe rung of that step is checked
against real data before it's allowed to happen, not just recommended. Concretely:

1. An observe-mode rule fires silently on every matching call. The verdict it would
   have returned lands in `observed_action` on that call's trace entry
   (`~/.keel/traces/YYYY-MM-DD.jsonl`, documented in `SPEC.md` §9) — the actual action
   returned to the host stays `allow`.
2. `keel retrospective` surfaces two things from the same trace stream: session-level
   workflow metrics (attempts-to-success, stuck-loops per session, research-before-solve
   rate, churn cycles, deny-repeat rate, verification completion, pivot recovery) **and a
   per-rule promotion section** — for each observe-mode rule, its measured would-block
   rate over your own traffic, with a recommendation of `eligible`, `stay_observe`, or
   `insufficient_data` (the last when there aren't enough evaluations yet to trust a low
   rate). "Would-block" counts a deny, block, prompt, *or* redirect the rule would have
   produced. A rule is `eligible` when its rate is below `promotion_fp_threshold`
   (default `0.001`, i.e. 1 per 1,000 evaluations; set it in `~/.keel/rules.yaml`).
3. When a rule is eligible and you agree its hits are real signal, run
   **`keel promote <rule-id>`** — it advances that rule's `mode: observe → warn` (or
   `warn → block`) in your rules file, comment-preserving and idempotent. It only runs
   in an interactive terminal (a human at a TTY); `keel-control-gate` denies an agent
   running it, or `keel rules … --append`, on your behalf, so promotion is always your
   decision. You can also just edit `mode:` by hand.

   Promoting FROM `mode: observe` (whatever the target) now re-runs the exact same
   `computePromotionReport()` recommendation `keel retrospective` just showed you, and
   refuses the edit — no file change, exit 1 — unless it comes back `eligible`. A
   `stay_observe` or `insufficient_data` verdict prints which one it was and why, and
   points back at `keel retrospective` for the detail. `--force` is the escape hatch for
   a human who wants to promote anyway (e.g. you've watched the rule closely by hand and
   trust it despite thin trace coverage); it prints a distinct "may not be ready" warning
   rather than proceeding silently, so a forced promotion is never mistaken for an earned
   one. There is deliberately no equivalent gate for `warn → block`: `mode: warn` is real
   enforcement, not shadow-recording (only `observe` populates `observed_action`/
   `observed_matches`), so there is no measured would-block stream for that rung to check
   — deciding when a `warn` rule has earned `block` is still a judgment call, informed by
   `keel report`.

The default `promotion_fp_threshold` of `0.001` echoes the project's design target of a
false-positive rate under 0.1% for a *hard* deny with no override (`SPEC.md` §8). The
retrospective reports the rate and the recommendation; `keel promote` now enforces that
same recommendation at the observe rung, applying the change only when you run it (or
force it). Nothing promotes automatically.
