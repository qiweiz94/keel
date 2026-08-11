# The three tiers

`keel install` writes 42 default rules into `~/.keel/rules.yaml`, split into three
tiers. This page explains what each tier does, how the "speed dial" (`keel level`)
interacts with them, and how a rule moves from silently watching to actually blocking.

Two different things are both called "level" here, and it's worth pulling apart once:

- **`keel level`** is the global dial you set — `sprint`, `balanced`, or `protect`.
  It's one setting for the whole ruleset.
- **A rule's own `level:` field** is a per-rule floor. Most rules don't set one (or
  carry `level: sprint`, meaning "no floor — obey the dial"). Eleven rules set
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
  exist and get squatted by attackers waiting for an agent to `npm install` the
  hallucinated name (USENIX Security 2025). For actions in that class, a warn-once
  ladder is the wrong shape — the first hit *is* the incident.

Three tiers resolve that tension by giving each rule the posture its own evidence
earns it, instead of applying one policy to all 42.

| Tier | What it does | Can the dial soften it? | Example rules |
|---|---|---|---|
| **1 — protect floor** | Denies on the *first* hit, always | No — active and unsoftened at every dial, sprint included | `no-force-push`, `pipe-to-shell`, `no-exfil-flow`, `keel-control-gate` |
| **2 — balanced** | Warns once, then blocks (dial-dependent) | Yes — `sprint` downgrades its deny/block to warn | `no-push-to-main`, `no-secrets-in-code`, `cicd-and-infra` |
| **3 — observe** | Evaluated and recorded, never interrupts | N/A — records what it *would* have done regardless of dial | `no-repeat-loops`, `research-before-fix`, `claim-without-evidence` |

## Tier 1 — protect floor (11 rules)

Every rule below ships with `level: protect`. That makes two things true regardless of
what dial you're on: the dial can never soften or hide it, and it denies on the very
first match rather than warning once first. Verified live — evaluating `no-force-push`
against a fresh `keel install` on the default `balanced` dial returns `deny` on the
first call, while a Tier-2 deny rule (`no-credential-echo`) returns `warn` ("First
violation... warning only") on its first call under the same dial.

| Rule id | Guards against |
|---|---|
| `keel-control-gate` | An agent running keel's own control commands (`disable`, `allow`, `level`, `install`, `uninstall`, `rules --append`) |
| `no-rules-tampering` | Editing keel's own rules/state/plugin files, or host auto-approve config (`.claude/settings*.json`, `.mcp.json`, `.vscode/settings.json`, git hooks) |
| `no-enforcer-removal` | Deleting keel's enforcement files |
| `agent-env-hijack` | Persisting a mutated `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`/`KEEL_*` into shell or config files |
| `no-destructive-commands` | Destructive commands, including fork bombs |
| `no-force-push` | `git push --force` (suggests `--force-with-lease`) |
| `protected-branch-reset` | `git reset --hard` naming main/master explicitly |
| `protected-branch-delete` | Deleting the main/master branch, local or remote |
| `pipe-to-shell` | `curl/wget \| sh`-style remote code execution |
| `no-exfil-flow` | Data read from a sensitive file, then sent over the network |
| `prod-db-destruction` | A destructive DB operation against a connection tagged prod/production/live |

## Tier 2 — balanced (22 + 1 rules)

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
| `unverified-package-install` * | prompt | A package name that doesn't resolve against the npm registry |

\* `unverified-package-install` ships with no `level:` or `mode:` field at all — it
isn't under either tier's YAML comment header in `install.ts`. It's listed here because
its behavior (no floor, dial-softenable `prompt`) matches Tier 2, but that placement is
this page's inference, not something the source labels explicitly.

## Tier 3 — observe (9 rules)

Every rule below ships with `mode: observe`. The pipeline evaluates them on every
matching call and records what it *would* have done — the `observed_action` field on
the trace entry (`~/.keel/traces/YYYY-MM-DD.jsonl`) — but the actual `action` returned
to the host is always `allow`. Nothing here interrupts anyone yet. Three are the
original "stuck agent" rules; the other six were added since and follow the same
observe-first pattern.

| Rule id | Type | Would-be action | Guards against |
|---|---|---|---|
| `no-repeat-loops` | stuck | warn → deny | An identical failing command retried 3× / 5× in a 15-minute window |
| `research-before-fix` | research | redirect | Patching a failure without looking anything up first |
| `root-cause-before-refactor` | diagnosis | redirect | A destructive/structural change with no recorded hypothesis or investigation |
| `source-change-requires-test` | verification | deny | A commit/push after a source edit with no passing test run since |
| `claim-without-evidence` | claim | warn | Claiming "done/fixed/tested/passing" without a verification run to back it |
| `test-oracle-tampering` | oracle | warn | A test weakened (skip/only added, assertion removed, snapshot rewritten) shortly after it failed |
| `test-before-commit` | verification | warn | `src/` changes committed with no passing test run in the session |
| `runaway-budget-tool-calls` | rate | warn | >500 tool calls in the last 4 hours of a session |
| `runaway-budget-bash-calls` | rate | warn | >500 Bash calls in the last 4 hours of a session |

`test-oracle-tampering` is the one Tier-3 rule that carries a level (`level: balanced`)
— it's also the one exception to "every rule evaluates at every dial": switching to
`sprint` deactivates it. Confirmed live: `keel level sprint` from `protect` printed
`1 rule(s) deactivated (their level floor is above sprint): test-oracle-tampering`, and
`keel status` reported `Active at current dial: 41 of 42`.

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
  4 rule(s) soften deny/block → warn: no-secrets-in-code, no-secret-files,
    no-credential-echo, source-change-requires-test
  1 rule(s) deactivated (their `level` floor is above sprint): test-oracle-tampering
  11 `level: protect` floor(s) unchanged: keel-control-gate, no-rules-tampering,
    no-enforcer-removal, agent-env-hijack, no-destructive-commands,
    protected-branch-reset, protected-branch-delete, pipe-to-shell,
    prod-db-destruction, no-exfil-flow, no-force-push
```

`sprint` isn't meant to be permanent: it auto-reverts to `balanced` after 4 hours
(`DEFAULT_SPRINT_EXPIRY_HOURS` in `rule-parser.ts`), overridable with
`sprint_expiry_hours` in rules.yaml (`0` disables the revert). `keel status` shows the
countdown; `keel level` (no argument) flags an already-expired sprint. Changes take
effect on the next tool call — no restart, no daemon round-trip needed.

## The promotion lifecycle

Today, promoting a Tier-3 rule is a manual step you take yourself, not an automated
threshold. Concretely:

1. An observe-mode rule fires silently on every matching call. The verdict it would
   have returned lands in `observed_action` on that call's trace entry
   (`~/.keel/traces/YYYY-MM-DD.jsonl`, documented in `SPEC.md` §9) — the actual action
   returned to the host stays `allow`.
2. `keel retrospective` surfaces the closest built-in signal: session-level workflow
   metrics computed from the same trace stream — attempts-to-success, stuck-loops per
   session, research-before-solve rate, time-to-first-search, churn cycles, deny-repeat
   rate, verification completion, and pivot recovery. It's not a per-rule
   would-have-blocked tally, but `stuck-loops/session` and `research-before-solve` are
   directly downstream of `no-repeat-loops` and `research-before-fix` firing (or not).
3. When you're satisfied a rule's hits are real signal and not noise, you edit that
   rule's `mode: observe` to `warn` or `block` yourself, in `~/.keel/rules.yaml`.
   That's it — there is no `keel promote` command and no numeric auto-promotion
   threshold shipped today. `keel-control-gate` denies an agent running
   `keel rules ... --append` on your behalf, so this step is always a human's.

The project's own design targets a false-positive rate under 0.1% for a *hard* deny
with no override (`SPEC.md` §8) — that's the bar a rule should clear before you'd want
it blocking outright, but it's a stated target for you to judge against, not a number
keel measures or enforces automatically. An automated promotion workflow with rule
catalog metadata is on the roadmap (`ROADMAP.md`, "Later") — not built yet.
