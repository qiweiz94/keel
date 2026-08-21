# Keel vs. the OWASP Agentic AI Top 10

This page maps Keel's 47 shipped default rules (`packages/cli/src/commands/install.ts`,
`DEFAULT_RULES_YAML`) against the OWASP GenAI Security Project's Agentic Security
Initiative (ASI) **"Top Ten for Agentic Applications"** — first public draft, ID
prefix `ASI01`–`ASI10`, as retrieved 2026-08-19. Source:
[GenAI-Security-Project/GenAI-Agent-Security-Initiative, `agentic-top-10/`](https://github.com/GenAI-Security-Project/GenAI-Agent-Security-Initiative/tree/main/agentic-top-10).
This is a first public draft, not a numbered final release — expect category names
and IDs to shift as the initiative matures; re-check against the source before citing
this page as current.

A rule's tier matters to this mapping and is called out inline: **Tier 1**
(`level: protect`) and most **Tier 2** (`level: sprint`, dial-governed) rules actively
`deny`/`warn`/`prompt` in the shipped defaults. **Tier 3** (`mode: observe`) rules are
evaluated and recorded on every call but **never interrupt** by default — they earn
promotion to warn/block only after their real hit rate is measured against live
traffic (see [docs/tiers.md](tiers.md)). Rules cited below as Tier 3 are marked
explicitly; treat their coverage as "detected and logged," not "enforced."

This is not a compliance claim. Keel is a runtime tool-call enforcer: it evaluates
commands, filesystem writes, data flows, env vars, and a handful of behavioral
patterns (loops, unverified success claims, test-oracle tampering) on every tool
call, outside the agent's own context window. It has no visibility into the model's
internal reasoning or goals, no model-weight or agent-identity infrastructure, and no
multi-agent protocol awareness. Several OWASP categories are consequently **out of
Keel's current scope** — that is stated plainly below rather than stretched into a
mapping that isn't real.

## Quick reference

| # | OWASP category | Keel coverage |
|---|---|---|
| ASI01 | Agent Behaviour Hijack | Not addressed directly — mitigated only by downstream consequence rules |
| ASI02 | Tool Misuse and Exploitation | Well covered — this is Keel's core purpose |
| ASI03 | Identity and Privilege Abuse | Partial — OS-level privilege escalation and credential exposure only |
| ASI04 | Agentic Supply Chain Vulnerabilities | Partial — package supply chain and tool-manifest tampering only |
| ASI05 | Unexpected Code Execution (RCE) | Well covered |
| ASI06 | Memory and Context Poisoning | Not addressed |
| ASI07 | Insecure Inter-Agent Communication | Not addressed |
| ASI08 | Cascading Failures | Partial — single-session runaway/loop and false-success propagation only |
| ASI09 | Human-Agent Trust Exploitation | Partial — architectural (approval gates outside context window) + one detector |
| ASI10 | Rogue Agents | Well covered — this is Keel's self-protection tier |

## ASI01 — Agent Behaviour Hijack

> Manipulating an agent's goals/plans to pursue attacker-aligned objectives.

**Not addressed directly.** Keel has no rule that inspects incoming content (tool
output, retrieved documents, user prompts) for injection payloads or goal-manipulation
patterns — that would require reasoning-level visibility Keel doesn't have on most
hosts. What Keel *does* provide is a safety net for the actions a hijacked agent would
try to take next, which several Tier 1/2 rules block regardless of why the agent
decided to take them:

- `no-exfil-flow` / `no-exfil-flow-cross-call` — block sending credential-file
  contents over the network, the most common hijack payoff.
- `no-destructive-commands` / `no-destructive-interpreter-body` — block a hijacked
  agent's destructive fallout.
- `keel-control-gate` / `no-rules-tampering` / `no-self-protection-write` /
  `no-enforcer-removal` — block a hijacked agent from disarming Keel itself as its
  first move.

None of these detect the hijack; they only contain what a hijacked agent can do once
it starts issuing tool calls.

## ASI02 — Tool Misuse and Exploitation

> Tricking agents into using their tools in harmful or unintended ways.

**Well covered.** Gating tool calls against harmful use is Keel's core function,
independent of *why* the agent chose to make the call:

- `no-destructive-commands` — blocks root/home/cwd-wide `rm -rf`, disk-format
  primitives, and fork bombs.
- `no-destructive-interpreter-body` — blocks the same destructive patterns written
  inside a `python -c`/`node -e`/`perl -e` one-liner body instead of as a shell verb.
- `pipe-to-shell` — blocks piping a downloaded script straight into `bash`/`sh`/`eval`.
- `no-remote-exec` — prompts before on-the-fly package execution (`npx`, `bunx`,
  `pnpm dlx`, etc.) that runs unvetted code.
- `unverified-package-install` — prompts when an agent installs a package that
  doesn't resolve against the public registry (package-hallucination/slopsquatting).
- `cicd-and-infra` — prompts before `terraform apply/destroy` or mutating `kubectl`
  commands against a non-local cluster.
- `prod-db-destruction` / `no-db-destructive` — deny/warn on `DROP`/`TRUNCATE`/
  `DELETE` against a production-tagged or untagged database connection.
- `paste-site-exfil` — prompts before posting to pastebin-class hosts.
- `broad-privilege-escalation` — warns on unscoped `sudo`, `chmod -R`, `chown -R`.
- `write-outside-project` — prompts before writes to system paths or shell rc files.

## ASI03 — Identity and Privilege Abuse

> Impersonating agents or escalating access through identity/auth weaknesses.

**Partial.** Keel has no concept of agent identity, authentication, or
impersonation — it cannot detect one agent presenting as another, or an OAuth/service-
account token being misused across trust boundaries. What it does cover is the
narrower OS-level and credential-handling half of this category:

- `broad-privilege-escalation` — warns on unscoped `sudo`, recursive `chmod`/`chown`.
- `no-credential-echo` — denies printing named secret-bearing env vars
  (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, etc.) in a command.
- `no-secrets-in-code` / `no-secret-files` — deny writing literal credential formats
  or credential files to disk.

The identity/impersonation half of this category — cross-agent auth spoofing — is not
addressed.

## ASI04 — Agentic Supply Chain Vulnerabilities

> Introducing insecure models, agents, tools or artefacts compromising integrity.

**Partial.** Keel addresses the package-dependency slice of the supply chain and
tampering with the *local* tool/MCP manifest, but has no coverage of model-weight
provenance, agent-framework supply chain, or third-party MCP server integrity —
those are out of Keel's current scope (it enforces on tool calls, not on what a model
or an already-configured MCP server actually is):

- `unverified-package-install` — prompts on any `npm`/`pnpm`/`yarn`/`bun` install
  whose package doesn't resolve against the public npm registry, the direct
  mitigation for the "19.7% of LLM-recommended packages don't exist"
  package-hallucination finding (USENIX Security 2025). The finding's own headline
  incident, the squatted `huggingface-cli`, was a PyPI package — this rule does not
  check `pip`/PyPI installs at all (verified against `package-verifier.ts`: only the
  npm registry and npm-family package managers are implemented), so that exact
  incident class is covered for the JS ecosystem only, not reproduced for Python.
- `no-rules-tampering` / `no-self-protection-write` — deny edits to `.mcp.json`,
  `.claude/settings*.json`, and `.opencode/plugins/**`, which stops an agent from
  silently swapping in a different (potentially compromised) tool/MCP definition —
  a narrow, tool-manifest-integrity slice of this category, not model or agent
  supply-chain coverage.

## ASI05 — Unexpected Code Execution (RCE)

> Triggering unauthorized or unsafe code execution through agent behaviors.

**Well covered.**

- `pipe-to-shell` — blocks `curl|wget` piped or command-substituted into a shell
  interpreter.
- `no-destructive-interpreter-body` — blocks destructive calls written inside an
  interpreter one-liner body.
- `no-remote-exec` — prompts before on-the-fly package execution.
- `unverified-package-install` — prompts before installing an unverified package,
  which can carry install-time RCE (postinstall scripts).

## ASI06 — Memory and Context Poisoning

> Corrupting agent memory or context to distort reasoning and decision-making.

**Not addressed.** Keel has no rule that models an agent's memory/context store or
inspects content being read back into context for poisoning. This would require
content-provenance tracking on read paths that Keel's current filesystem/command/flow
rule types don't provide (filesystem-type rules in this engine evaluate writes, not
reads — see `secret-file-read-without-egress`'s rationale for the same read/write
asymmetry in a different rule).

## ASI07 — Insecure Inter-Agent Communication

> Poisoning messages or abusing protocols between agents to alter behavior.

**Not addressed.** Keel enforces on one host process's tool calls; it has no
awareness of agent-to-agent messaging protocols (A2A, ACP, or ad hoc
inter-agent channels) and cannot inspect or gate traffic between agents.

## ASI08 — Cascading Failures

> Faults or hallucinations propagate through agents, causing compounded failures.

**Partial**, and scoped to a single agent session rather than a multi-agent
orchestration. Most of the rules that apply here ship in **Tier 3 (`mode: observe`)**
— they record a signal on the trace but do not interrupt by default, so treat this
category's coverage as "detected and logged," not "blocked," until a given rule is
promoted:

- `bash-rate-limit` (Tier 2, `warn`, active by default) — warns past 30 Bash calls in
  60 seconds, the one rate-limit rule in this group that actually enforces out of the
  box.
- `no-repeat-loops` (promoted out of Tier 3, `action: warn` + live `escalation`
  ladder) — actively redirects an agent retrying the identical failing command 3+
  times in 15 minutes, and denies at 5; this one already enforces out of the box (see
  [docs/tiers.md](tiers.md)).
- `runaway-budget-tool-calls` / `runaway-budget-bash-calls` (Tier 3, `mode: observe`)
  — record more than 500 tool/Bash calls in a 4-hour window, a coarse runaway-session
  proxy.
- `session-runaway-trip` (Tier 3, `mode: observe`, `type: session`) — a composite of
  the same signal across five session-scoped dimensions (duration, tool-call count,
  Bash-call count, distinct-file-write churn, consecutive-failure count) instead of
  one flat counter; only the failure-aware dimension can escalate past `prompt`, all
  the way to a `keel halt` lockdown latch (see [docs/tiers.md](tiers.md)).
- `claim-without-evidence` / `test-before-commit` / `source-change-requires-test`
  (all Tier 3, `mode: observe`) — record a "done/fixed/passing" claim or a commit
  that follows a source edit with no passing verification run in between, the
  mechanism by which one agent's unverified (possibly hallucinated) success claim
  would otherwise propagate downstream as fact. `source-change-requires-test`'s own
  rationale in the YAML notes it was deliberately re-tiered off deny-on-push into
  observe to measure its real false-positive rate first.
- `test-oracle-tampering` / `test-oracle-env-introspection` (both Tier 3,
  `mode: observe`, `confidence: low`) — record patterns where a test looks weakened
  or gamed to pass rather than the underlying code fixed, another route by which a
  false "it works" would propagate.

True cross-agent cascading failure (agent A's bad output triggering agent B's
failure in a multi-agent pipeline) is not addressed — Keel has no multi-agent
orchestration visibility (see ASI07).

## ASI09 — Human-Agent Trust Exploitation

> Exploiting over-trust or fatigue in human oversight to enable misuse, including
> deceptive behaviours.

**Partial**, addressed architecturally rather than by detecting manipulation itself.
Keel's `action: prompt` rules force a human checkpoint on risky operations from
*outside* the agent's context window, so the checkpoint can't be talked away by
in-context persuasion the way a purely in-model safeguard could:

- `no-push-to-main`, `cicd-config-edit`, `cicd-and-infra`, `write-outside-project`,
  `paste-site-exfil`, `no-remote-exec`, `git-history-rewrite`, `publish-gate` — all
  require explicit human approval before the action executes.
- `keel-control-gate` — blocks the agent from operating Keel's own controls, so it
  cannot get itself pre-approved by manipulating the enforcer.
- `claim-without-evidence` (Tier 3, `mode: observe`, `confidence: low`) — targets an
  unverified "done"/"passing" claim, one concrete form of the "deceptive behaviours"
  this category names. Weak citation, flagged rather than relied on: the rule's own
  YAML documents that on its one production-reachable channel (commit/PR message
  text), the shipped `source-change-requires-test` rule shares the same trigger and
  wins the evaluator's short-circuit — so `claim-without-evidence` is "never
  evaluated on that call at all" in the current default ruleset, despite being
  wired in.

No rule detects manipulation *language* itself (urgency framing, fabricated
authority, approval-fatigue patterns) — the coverage here is the checkpoint's
placement outside the context window, not content analysis of the persuasion attempt.

## ASI10 — Rogue Agents

> Malicious or compromised agents acting autonomously to deceive, disrupt, or
> exfiltrate.

**Well covered** — this is what Keel's Tier 1 self-protection floor and exfil/
destructive rules exist for, and they apply regardless of whether the agent went
rogue via compromise, misalignment, or a successful hijack upstream:

- `keel-control-gate` / `no-rules-tampering` / `no-self-protection-write` /
  `no-enforcer-removal` — deny a rogue agent disarming its own guardrails, the
  CVE-2025-59536/CVE-2026-21852 host-config-poisoning class.
- `agent-env-hijack` — denies persisting a mutated `ANTHROPIC_BASE_URL`/
  `OPENAI_BASE_URL`/`KEEL_*` into shell config (a man-in-the-middle/reconfiguration
  persistence route).
- `no-exfil-flow` / `no-exfil-flow-cross-call` — deny/warn sending data read from
  credential files over the network ("disrupt or exfiltrate").
- `no-destructive-commands` / `no-destructive-interpreter-body` / `prod-db-destruction`
  — deny destructive filesystem/database operations ("disrupt").
- `claim-without-evidence` (Tier 3, `mode: observe`) — targets fabricated success
  claims ("deceive"), with the same currently-unreachable-in-production caveat noted
  under ASI09.

## Rules with no OWASP category

The mapping above cites 36 of the 47 shipped rules at least once. These 11 don't fit
any ASI01–ASI10 category — most are standing engineering-workflow conventions rather
than agentic-security controls, which is consistent with how their own rationale
text describes them:

- `no-force-push`, `protected-branch-reset`, `protected-branch-delete`,
  `commit-to-main`, `no-verify-bypass` — git shared-history/branch-protection
  hygiene, not specific to an AI agent doing the pushing.
- `no-after-hours-publish` — a timing nudge on releases, general engineering
  practice.
- `no-skip-tests` — flags test-skip flags on a green run; a verification-honesty
  convention, not a threat-model item.
- `must-sign-commits` — a pure convenience auto-fix; its own rationale states
  explicitly "not a security control."
- `verify-format-before-decision` — a context-rot nudge (checking project
  conventions before choosing a format), not a security control.
- `research-before-fix`, `root-cause-before-refactor` — workflow-discipline nudges
  (research before patching, diagnose before refactoring) aimed at code quality, not
  a named ASI risk.

Their absence from the table above isn't a gap in this mapping — it's evidence the
mapping wasn't stretched to cover rules that don't actually address an agentic
security risk.

## What this means in practice

Keel is strongest against categories that reduce to *"an agent, for whatever reason,
is about to make a harmful tool call"* — ASI02, ASI05, ASI10, and large parts of
ASI09. It has essentially no coverage of categories that require visibility Keel's
architecture doesn't have: the agent's own reasoning/goals (ASI01), model or
agent-framework supply-chain provenance (ASI04, partially), persistent memory/context
stores (ASI06), or multi-agent communication protocols (ASI07, ASI08 partially). That
gap is consistent with how Keel is described elsewhere in this repo (see
[docs/comparison.md](comparison.md)): a tool-call enforcement layer, not a full
agentic-security platform.
