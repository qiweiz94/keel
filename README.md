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
gets blocked, `docs/demo.sh` runs eight enforcement guards end to end (requires
`keel install --hooks` in a scratch repo).

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
project wins for the same id).

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

**Rule types:** `command`, `filesystem`, `content`, `network`, `env`, `rate`, `time`,
`sequence`, `flow`, `session`, `verification`, `context`, `package`, plus the
problem-solving types below (`stuck`, `research`, `diagnosis`, `claim`, `oracle`).

`keel install` ships 45 rules by default, split into three tiers — what's an
un-bypassable floor, what warns-then-blocks, and what only observes today:
**[docs/tiers.md](docs/tiers.md)**. The shipped defaults cover destructive commands,
`curl | sh`, hardcoded secrets and credential files, secret exfiltration, force-push
and hook-bypass, and approval gates for DB destruction, protected-branch pushes,
publishing, and `npx`/`bunx` of unpinned packages. Run `keel validate` after editing.

### Stopping agents that circle

Several rule types target the failure everyone recognises — an agent retrying the same
broken command forever. Three ship as part of the default 43:

- **`stuck`** (`no-repeat-loops`) — N identical failures in a window → redirect, then deny
- **`research`** (`research-before-fix`) — armed only by a *failing* command; blocks patching before looking anything up
- **`diagnosis`** (`root-cause-before-refactor`) — destructive or structural changes need a hypothesis or real investigation (`git log/blame/bisect`) first

They — plus seven more behavioural rules (`claim`, `oracle` ×2, budget, and verification
checks) — ship as `mode: observe`: evaluated and recorded on every matching call, never
interrupting anything, until a human decides otherwise. `keel rules harness --append` is
kept only for a rules.yaml created before this shipped as a default — it checks by rule
id, so it's a no-op if you already have them.

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

A rule's own `level:` (12 rules ship with it, unrelated to the `keel level` dial you
just set) is a **floor** — `level: protect` rules deny on the very first hit at *any*
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
from running `keel disable|allow|level|enforce|install|uninstall`, from editing keel's
rules or state, and from deleting enforcement files. These are `level: protect` floors,
so no dial setting disables them.

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
- **Hermes and OpenClaw fail open by design** — a throwing plugin is skipped. Both keel
  plugins carry a local circuit breaker that still blocks catastrophic operations when the
  daemon is unreachable, and print a loud DEGRADED notice.

More in [SECURITY.md](SECURITY.md).

## Documentation

- [docs/landing.md](docs/landing.md) — the measured number, the scan→protected hook, and the live-block demo, as a single page
- [docs/tiers.md](docs/tiers.md) — the three rule tiers, the speed dial, and how observe-mode rules get promoted
- [docs/integrations.md](docs/integrations.md) — every host, what it can block, how well it's verified
- [docs/integration-guides/](docs/integration-guides/) — per-host setup, one guide per agent
- [docs/comparison.md](docs/comparison.md) — how keel relates to Cupcake, agentsh, Semgrep, and others
- [docs/owasp-agentic-top10.md](docs/owasp-agentic-top10.md) — how keel's rules map to the OWASP Agentic AI Top 10, category by category, including where keel has no coverage
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
