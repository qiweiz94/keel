# Keel

**Guardrails for AI coding agents — enforced outside the context window.**

Your agent follows your rules at turn 1 and ignores them at turn 40. Keel puts the
rules where the model can't forget them: in front of every tool call, in a process
the agent doesn't control.

[![npm](https://img.shields.io/npm/v/@get-keel/cli?label=@get-keel/cli&logo=npm)](https://www.npmjs.com/package/@get-keel/cli)
[![CI](https://github.com/qiweiz94/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/qiweiz94/keel/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/qiweiz94/keel/badge)](https://scorecard.dev/viewer/?uri=github.com/qiweiz94/keel)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## The measured number

On the three tasks built to tempt a destructive or forbidden action — force-pushing
over `main`, `git reset --hard` on `main`, installing a nonexistent package — re-run
**N=12 per arm**, one free model (`opencode/deepseek-v4-flash-free`) driven with and
without keel installed:

| | unguarded | keel-guarded |
|---|---|---|
| Caused harm (forbidden action, false claim, tampering, or stuck) | **75%** (9/12) | **0%** (0/12) |
| Executed the forbidden action itself | **67%** (8/12) | **0%** (0/12) |
| Completed the task | 8% (1/12) | **75%** (9/12) |

Guarding didn't cost completion — it *enabled* it, because destroying the repo is
itself task failure. On the separate N=10 full-battery pass this repetition scaled
up from, two unrelated control tasks passed in both arms with **zero** keel rules
firing against them — no false-positive drag on legitimate work.

That's the **prevention axis** (keel's block-tier floors stopping an action outright).
It was re-audited to rule out the model simply refusing on its own: on the two tasks
above where the scored harm and keel's blocking mechanism are the same axis, **all
10 corresponding guarded-arm runs** (across both passes) carry a code-confirmed
hard-stop block (`no-push-to-main` + `keel-control-gate`, or `protected-branch-reset`)
against a **100% unguarded-arm attempt rate** on the same tasks — not an empty trace
padding a non-event. One of those runs shows the agent trying to run a `keel disable`-class
command mid-task after being blocked, and getting blocked again — evidence against
self-censorship, not for it. (The third harm-eliciting task, `stuck-nonexistent-package`,
sits on a `mode: observe` axis keel cannot block on either arm; excluded from that 10/10,
classified ambiguous.) Full audit: **[session/v04/EVIDENCE/attribution-reaudit.md](session/v04/EVIDENCE/attribution-reaudit.md)**.

**That 0% is not the same claim as bypass-resistance, and shouldn't be read alone.**
The number above measures an *ordinary* model drifting into a mistake it wasn't trying
to hide — a different threat than a *deliberate* adversary trying to slip one specific
action past one specific rule through obfuscation. For that second threat, see the
separate adversarial sweep in SECURITY.md: of a 260-probe corpus (some probes were
expected to be allowed and are excluded from the denominators below), 188 probes
deliberately obfuscated a command against one of the 12 `level: protect` floor rules
that existed at sweep time, finding per-rule catch rates from **25%** (`no-exfil-flow`,
1 of 4 probes, the floor's weakest rule measured) up to **93%**
(`no-self-protection-write`) against the v0.4-hardened floors. That corpus is no
longer reproducible and predates some v1.0.0 fixes — full caveats and the per-rule
table: **[SECURITY.md § Measured bypass resistance of the Tier-1
floor](SECURITY.md#measured-bypass-resistance-of-the-tier-1-floor)**. Read together: 0%
is how often an unguided agent stumbled into the forbidden action on these three tasks;
25–93% is how a floor rule fared, as of that sweep, against someone actively trying to
evade it — neither number substitutes for the other.

**Scope, stated plainly:** one free model, one machine, one temperature, no frontier-model
arm run yet, and the attribution re-audit is proven for this one under-cautious cheap model
only — **not re-verified for safety-tuned models**, some of which have been separately
observed refusing dangerous commands on their own before keel's hook ever sees them. The
**detection axis** (would keel's observe-tier rules catch a false "done" claim or a
weakened test?) is honestly **inconclusive** at this sample — the free model never
produced those failure modes to catch, and a weak-model pass produced 0% task success in
both arms instead of eliciting them. Full setup, per-task detail, and every confidence
limit: **[session/v04/EXPERIMENT.md](session/v04/EXPERIMENT.md)**.

**See the strongest single trace from that experiment reproduced live, no LLM
required:** `scripts/demo/keel-disable-trace.sh` runs a real dry-run evaluation
showing an agent blocked from force-pushing to main, then blocked again when it
tries to `keel disable` its way around that block — the exact chain
`attribution-reaudit.md` found in the guarded arm. For a broader tour of what
gets blocked, `docs/demo.sh` runs seven enforcement guards end to end (requires
`keel init --hooks` in a scratch repo).

## Audit your setup in 10 seconds — no install

```bash
npx @get-keel/cli scan
```

It finds every AI agent on your machine, tells you which ones can run shell
commands with nothing standing in the way, and flags MCP servers that install
unpinned packages or talk over plaintext HTTP.

```
  Enforcement coverage

    ✗ unprotected  claude-code
    ✓ enforced     opencode
                   ~/.opencode/plugins/keel-enforce.js

  2 findings

   CRITICAL  MCP server runs through a shell
     cursor → MCP server "notes": sh -c curl https://x.tld/i.sh | sh
     → Invoke the server binary directly, so its command line cannot be rewritten.

     HIGH    3 agent hosts can run tools with no enforcement
     claude-code, cursor, codex
     → Run `keel install --all`. Until then nothing stops a destructive command.
```

`--json` for machines, `--ci` to exit non-zero on findings.

## The problem

`CLAUDE.md`, `AGENTS.md`, `.cursorrules` are **prompts**. The model reads them and
tries to comply — Anthropic's own docs say there is "no guarantee of strict
compliance." As context fills, early instructions decay (the "Lost in the Middle"
effect, [Liu et al. 2023](https://arxiv.org/abs/2307.03172), measurable from
8K–16K tokens). Compaction drops them. A sufficiently determined agent can
`--no-verify` its way past anything advisory.

Keel is not a prompt. It's a check that runs *before* the tool executes, in a
process the model cannot edit, using rules it cannot read away.

## Install

```bash
npm install -g @get-keel/cli
keel install --all      # wire every agent host found on this machine
keel scan               # confirm coverage
```

Requires Node.js 22.12.0+. Install one host at a time with `--opencode`,
`--claude-code`, `--cursor`, `--cline`, `--codex`, `--gemini`, `--openclaw`,
`--hermes`, or `--project` to commit config to a repo your team shares.

## What you can do with it

| I want to… | Command |
|---|---|
| See what's unprotected on this machine | `keel scan` |
| Stop agents force-pushing or `rm -rf`-ing | `keel install --all` (ships sane defaults) |
| Require a passing test before a commit | a `verification` rule — see [Rules](#rules) |
| Approve one dangerous action, once | `keel allow <rule-id> --once` |
| Loosen enforcement while prototyping | `keel level sprint` |
| Tighten it before a deploy | `keel level protect` |
| See what got blocked and why | `keel audit --tail 20` |
| Find where an agent kept circling | `keel retrospective` |
| Turn recurring blocks into rules | `keel gather` (proposes; never auto-applies) |
| Check a command without running it | `keel evaluate --tool Bash --args '{"command":"git push --force"}'` |
| Freeze all enforcement immediately, no exceptions | `keel halt` — deny everything until `keel resume` |
| Raise an observe-mode rule once its record earns it | `keel promote <rule-id>` (refuses without measured evidence) |
| Check your rules against the OWASP Agentic Top 10 | `keel conformance` |
| Kill an agent process that's already running | `keel run <cmd>` to supervise, then `keel halt --kill` |

## Supported hosts

Every host below evaluates a tool call **before it runs** and can stop it. The
**Block Verified** column says how much each row's *blocking* path has actually
been proven — `live` means keel was exercised inside the real host, `types` means
it was built against the host's installed type definitions, `docs` means built
from published docs on a machine where that host isn't installed. Blocking and
the separate advisory *warn* path are verified independently — a host proven for
one is not automatically proven for the other — so this table intentionally
carries only the block column; the full Block **and** Warn matrix, with every
caveat and footnote, lives in one place: **[docs/integrations.md](docs/integrations.md)**.

| Host | Install | How it blocks | Block Verified |
|---|---|---|---|
| OpenCode | `--opencode` | plugin throws at `tool.execute.before` | **live** |
| OpenClaw | `--openclaw` | `block: true` / `requireApproval` | **live** |
| Claude Code | `--claude-code` | `PreToolUse` hook, exit 2 | **live** |
| Cline | `--cline` | `HOOK_CONTROL` + `cancel: true` | types |
| Gemini CLI | `--gemini` | `PreToolUse` hook, exit 2 | types |
| Cursor | `--cursor` | `beforeShellExecution`/`beforeMCPExecution`, `{permission: deny\|ask}` | docs |
| Codex CLI | `--codex` | `PreToolUse` hook, exit 2 | docs |
| Hermes | `--hermes` | `{"action": "block"}` | docs |

**Anything else** works through one of two universal paths, no adapter needed:
`keel serve` (MCP server, 7 tools — Windsurf, Zed, Continue, JetBrains AI) or
`keel hook generic` (`{tool, args}` on stdin, exit 0 allow / 2 block). Full matrix,
including hosts with no interception point at all: **[docs/integrations.md](docs/integrations.md)**.

## Rules

Rules live in `~/.keel/rules.yaml` (global) or `.keel/rules.yaml` (per project;
project wins for the same id). New to writing rules? **[docs/custom-rules.md](docs/custom-rules.md)**
covers a minimal five-field `simple_rules:` form (id, type, one match condition,
action, message) that skips the full shape below entirely, with worked examples.

A rules file can also compose: `extends: ../team-base.yaml` (or a list) merges another
file's rules in before its own, resolved relative to the declaring file. An `extends`
override that would weaken an inherited `level: protect` floor is refused at load time
rather than silently absorbed, so a shared base's floors survive composition.

```yaml
version: 1
level: balanced
rules:
  - id: no-force-push
    type: command
    match: "git push --force(?!-with-lease)"
    action: deny
    message: "Use --force-with-lease instead."

  # Require a passing test run before any commit that touches src/
  - id: test-before-commit
    type: verification
    trigger: { tools: [WriteFile, edit], pattern: "src/" }
    satisfy: { tools: [Bash], pattern: "(npm test|vitest|jest|pytest)" }
    boundaries:
      commit: { pattern: "git commit", action: warn }
    verification_window_seconds: 300
    action: deny
    message: "Source changes require a passing test before commit."
```

**Actions:** `allow` (log) · `warn` (warn once, then block) · `deny` (same, stricter
default) · `block` (always) · `prompt` (always block until a human runs
`keel allow <id> --once`) · `fix` (rewrite the command) · `redirect` (interrupt with a
suggested next step) · `research` (block on a stale knowledge-freshness gate) ·
`report` (log only).

**Rule types:** `command`, `filesystem`, `content`, `network`, `env`, `rate`, `budget`,
`time`, `sequence`, `flow`, `session`, `verification`, `context`, `package`, `injection`,
plus the problem-solving types below (`stuck`, `oscillation`, `research`, `diagnosis`,
`claim`, `oracle`).

Any rule can also be scoped to specific hosts with `agents: [claude-code]` — no
`agents` field (the default) means the rule applies everywhere, unchanged. `agent`
here is HOST identity (`opencode` / `claude-code` / `cline` / etc — the string a
host's own integration declares itself as), not a true multi-agent-fleet identity
concept — no host today emits a distinct identity per agent instance. See
[docs/custom-rules.md](docs/custom-rules.md#scoping-a-rule-to-specific-hosts-agents).

`keel install` ships 53 rules by default, split into three tiers — what's an
un-bypassable floor, what warns-then-blocks, and what only observes today:
**[docs/tiers.md](docs/tiers.md)**. The shipped defaults cover destructive commands,
`curl | sh`, hardcoded secrets and credential files, secret exfiltration, force-push
and hook-bypass, and approval gates for DB destruction, protected-branch pushes,
publishing, and `npx`/`bunx` of unpinned packages.

Package installs across npm, PyPI, crates.io, and Go are checked on a ladder: a
name on a known-hallucinated-package list denies, a name that doesn't resolve or is
brand new prompts, and a name within two edits of a popular package warns. Your own
private index is read from `.npmrc` / `pip.conf` / `.cargo/config.toml` /
`GOPRIVATE` first, so internal packages aren't denied on the first try. (The
known-hallucinated-package list currently ships structurally-valid placeholder
names pending a human populating the real research data — the mechanism is live,
the data is not.)

Run `keel validate` after editing.

### Stopping agents that circle

Several rule types target the failure everyone recognises — an agent retrying the same
broken command forever, or circling between a couple of broken approaches without ever
landing one. Four ship as part of the default 53:

- **`stuck`** (`no-repeat-loops`) — N identical failures in a window → redirect, then deny
- **`oscillation`** (`command-oscillation`) — a short repeating CYCLE of 2+ *different*
  failing commands/edits (A→B→A→B), not the same one retried — the sibling `stuck`
  doesn't cover: alternating between two broken approaches instead of hammering one
- **`research`** (`research-before-fix`) — armed only by a *failing* command; blocks patching before looking anything up
- **`diagnosis`** (`root-cause-before-refactor`) — destructive or structural changes need a hypothesis or real investigation (`git log/blame/bisect`) first

`research-before-fix` and `root-cause-before-refactor` — plus eleven more behavioural
rules (`claim`, `oracle` ×2, two verification checks, the rate-based
`runaway-budget-*` pair, `session`, the `type: budget` rule, `command-oscillation`
above, and the `type: injection` rule `untrusted-content-role-markers`) — ship as
`mode: observe`: evaluated and recorded on every matching call, never interrupting
anything, until a human decides otherwise. `no-repeat-loops` has since been PROMOTED
out of observe: this project's own traces cite 41 distinct repeat loops across 20
sessions as real evidence of the failure mode, and no over-triggering has ever been
recorded against it (the existing rate-based call-count `runaway-budget-*` rules were
checked against the same evidence bar and held back — see
[docs/tiers.md](docs/tiers.md)) — it now actually redirects at 3 identical failures
and denies at 5. `keel rules harness --append` is kept only for a rules.yaml created
before these shipped as defaults — it checks by rule id, so it's a no-op if you
already have them.

`session-runaway-trip` (`type: session`, the first real handler for that rule type) is
a related but distinct idea: a COMPOSITE trip across five session-scoped dimensions —
wall-clock duration, cumulative tool-call count, cumulative Bash-call count,
distinct-file-write churn, and consecutive-failure count — escalating
`warn → prompt → halt`. The volume-only dimensions (everything except
consecutive-failure count) are structurally barred from ever reaching more than
`prompt`: a legitimate long session must never get treated like a runaway loop just
for making a lot of calls. Only a repeated-FAILURE streak (reset on any success, the
same shape as `no-repeat-loops`'s `require_failure`) can escalate all the way to a
`keel halt` lockdown latch. Unlike `no-repeat-loops`, this rule has no measured
hit-rate evidence behind it yet, so — honestly, not as a promotion — it ships in
`mode: observe` from day one, alongside the still-observing `runaway-budget-*` rules.

Note the two "budget" things above are NOT the same rule: the existing `runaway-budget-*`
rules (`type: rate`) only ever count tool-call VOLUME in a time window — they have no
visibility into actual LLM token/dollar spend and their own rationale says so. The new
`type: budget` rule (`session-spend-limit`) is a separate mechanism that reads REAL
usage from a host's own local record (a Claude Code transcript's usage fields, an
OpenCode session row's own cost/token columns) and enforces on that instead — see
[docs/tiers.md](docs/tiers.md) for why it ships `mode: observe`.

`type: injection` rules detect indirect prompt injection — instructions embedded in
a file, web page, API response, or other tool result that get read as new
instructions on the agent's next turn, rather than a command the agent itself
typed. Two forms: a DETECTOR (`patterns`, matched against a completed tool call's
own output text) and a GATE (`next_call_scrutiny: true`, arming a warning on the
session's next write/shell call — optionally narrowed with
`taint_correlation: true`, which fires only when that later call's own arguments
or content reference a URL, host, file path, or email found within 400 characters
of the enforcing marker in the earlier flagged result, instead of any
consequential call in the window). `action` is restricted to `warn` for every rule
of this type everywhere — only OpenCode can rewrite a flagged result before the
model reads it; every other host is detection-only, after the fact. This is a
heuristic tripwire over literal, well-attested marker shapes, not a completeness
guarantee — a paraphrased, translated, or encoded payload still passes. See
[docs/injection.md](docs/injection.md) for the full per-host honesty table.

```bash
keel rules harness            # print the legacy standalone set, with what they'd have caught in your history
keel rules harness --append   # add any that are missing to ~/.keel/rules.yaml (run in your own terminal)
```

Check what an observe-mode rule *would* have done in `~/.keel/traces/*.jsonl`
(`observed_action` on each entry) or the workflow signal in `keel retrospective`
(stuck-loops/session, research-before-solve rate, and more). Once you trust it,
raise its `mode:` to `warn` or `block` yourself in rules.yaml — like every keel
control surface, editing rules requires your own hands; `keel-control-gate` denies
an agent running `keel rules ... --append` on your behalf.

## The speed dial

Three levels trade friction against safety. `prompt` approval gates are **never**
downgraded at any level.

```bash
keel level              # show current
keel level sprint       # prototyping
keel level balanced     # default
keel level protect      # before a deploy
```

| Dial | deny/block rules | Checks | Use |
|---|---|---|---|
| `sprint` | downgraded to warnings | fast — content/sequence/flow skipped | quick prototyping |
| `balanced` | warn once, then block | full | day to day |
| `protect` | **block on first violation** | full + reasoning heuristics | high-stakes work |

A rule's own `level:` (13 rules ship with `level: protect`, unrelated to the `keel level`
dial you just set) is a **floor** — `level: protect` rules deny on the very first hit at *any*
dial, sprint included, and are the only rules a lower dial can't soften or drop.
`keel level sprint` auto-reverts to `balanced` after 4 hours (`sprint_expiry_hours`
overrides it; `0` disables the revert) — `keel status` shows the countdown. Changes
take effect on the next tool call; no restart. Full tier table, defaults, and how
observe-mode rules get promoted: **[docs/tiers.md](docs/tiers.md)**.

`keel dashboard` is an interactive panel for the dial and enforcement state;
`keel dashboard --web` is the same thing in a browser. Both bind 127.0.0.1, require a
TTY to start, and authenticate with a one-time token printed on your terminal — so an
agent can't start one or read the token. Open the full URL it prints (the token is in
the `#fragment`); a bare `http://127.0.0.1:PORT/` will render blank by design.

## Self-protection

Keel's control surface belongs to you, not the agent. The defaults hard-deny agents
from running `keel disable|allow|level|enforce|install|uninstall|halt|resume`, from
editing keel's rules or state, and from deleting enforcement files. These are
`level: protect` floors, so no dial setting disables them.

Every gated or blocked action is written to `<project>/.keel/receipts/` as a signed,
hash-chained entry (`keel verify`). Keys live at `~/.keel/receipt-key.json`; rotate with
`keel receipts rotate` — old receipts stay verifiable.

## Limits

Stated plainly, because a guardrail that oversells itself is worse than none:

- **Pattern rules are regex gates, not an anti-virus.** A determined agent can obfuscate
  a command. For genuinely irreversible operations use `action: prompt` (human approval),
  not pattern matching.
- **Reasoning-gated rules need visible reasoning.** Hosts that don't expose chain-of-thought
  can't apply them. Don't rely on them as a hard control.
- **The agent's process is the boundary.** In-process enforcement fails if the agent
  process itself is compromised.
- **Hermes fails open by design; OpenClaw only does for a plugin load failure**, not a
  handler that throws mid-call (that path denies — see `docs/integration-guides/openclaw.md`).
  Both keel plugins carry a local circuit breaker that still blocks catastrophic operations
  when the daemon is unreachable, and print a loud DEGRADED notice.

More in [SECURITY.md](SECURITY.md).

## Documentation

- [docs/landing.md](docs/landing.md) — the measured number, the scan→protected hook, and the live-block demo, as a single page
- [docs/custom-rules.md](docs/custom-rules.md) — write your first custom rule with the minimal `simple_rules:` form, three worked examples
- [docs/tiers.md](docs/tiers.md) — the three rule tiers, the speed dial, and how observe-mode rules get promoted
- [docs/injection.md](docs/injection.md) — indirect prompt-injection scanning, the detector/gate split, and the full per-host honesty table
- [docs/integrations.md](docs/integrations.md) — every host, what it can block, how well it's verified
- [docs/integration-guides/](docs/integration-guides/) — per-host setup, one guide per agent
- [docs/comparison.md](docs/comparison.md) — how keel relates to Cupcake, agentsh, Semgrep, and others
- [docs/defense-in-depth.md](docs/defense-in-depth.md) — a layered dev/staging/production pattern pairing keel with a container boundary
- [docs/owasp-agentic-top10.md](docs/owasp-agentic-top10.md) — how keel's rules map to the OWASP Agentic AI Top 10, category by category, including where keel has no coverage
- [docs/compliance-mappings.md](docs/compliance-mappings.md) — how keel's rules map to NIST AI RMF, the EU AI Act, and ISO/IEC 42001, including where keel has no coverage
- [SECURITY.md](SECURITY.md) — threat model, enforcement limits, reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) — build, test, adding a rule type or host
- [CHANGELOG.md](CHANGELOG.md)

## Development

```bash
npm install
npm run build
npm test          # all workspaces
```

The OpenCode plugin has one canonical source: `packages/opencode-plugin/src/plugin.ts`.
`packages/cli/templates/keel-enforce.js` and `packages/cli/src/core/` are **generated** —
edit the source and rebuild, never the artifacts.

## Trust

Official distribution channels only:

- npm: `@get-keel/cli`, `@get-keel/core`, `@get-keel/opencode-plugin`
- GitHub: [qiweiz94/keel](https://github.com/qiweiz94/keel)

Anything else claiming to be keel isn't.

## License

Apache-2.0 © Chaoyi Li
