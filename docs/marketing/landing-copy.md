# Landing page copy

Drop-in copy for a site. Written to be pasted into any static generator — no design
assumed. Voice: plain, specific, no adjectives doing work that evidence should do.

---

## Hero

> # Rules your AI agent can't forget
>
> Coding agents follow your instructions at turn 1 and ignore them by turn 40. Keel
> moves the rules out of the context window and into the tool-call boundary — where
> the model can't read them away.
>
> ```bash
> npx @get-keel/cli scan
> ```
>
> [Get started →](#install) · [GitHub →](https://github.com/qiweiz94/keel)
>
> *Free and open source. Apache-2.0. Runs entirely on your machine.*

**Alternate hero lines** (A/B candidates):

- *Your agent can write code. Keel decides what it's allowed to run.*
- *Guardrails for AI coding agents — enforced outside the context window.*
- *Enforcement, not instructions.*

---

## The problem (three columns)

**Instructions decay.**
`CLAUDE.md` and `.cursorrules` are prompts. The model reads them and tries to comply.
As context fills, early instructions lose attention — the "Lost in the Middle" effect
is measurable from 8K tokens.

**Compaction erases them.**
Long sessions summarize earlier turns. Your rules were in those turns.

**Advisory means optional.**
An agent that wants to proceed can `--no-verify`, rewrite `core.hooksPath`, or write
the file directly. Nothing advisory stops any of it.

---

## How it works

> Keel evaluates every tool call **before** it executes, in a process the agent doesn't
> control.

```
Agent decides to run a command
        ↓
Keel evaluates it against your rules     ← outside the context window
        ↓
allow · warn · block · require approval · rewrite the command
        ↓
Command runs, or doesn't
```

Rules are YAML, and most are three lines:

```yaml
- id: no-force-push
  type: command
  match: "git push --force(?!-with-lease)"
  action: deny
  message: "Use --force-with-lease instead."
```

---

## Feature blocks

**See what's exposed, before you install anything**
`npx @get-keel/cli scan` audits every AI agent on your machine: which ones can run shell
commands with no enforcement, and which MCP servers install unpinned packages or talk
over plaintext HTTP. Findings are ranked by severity, with the exact path or command
that triggered each one.

**Approval gates the agent can't self-grant**
Irreversible operations — history rewrites, publishes, protected-branch pushes, database
destruction — stop and wait for a human to run `keel allow <id> --once`. Agents are
hard-blocked from running keel's control commands, so they cannot approve themselves.
This gate is never softened, at any protection level.

**A speed dial, because friction is the real failure mode**
`sprint` warns without blocking. `balanced` warns once, then blocks. `protect` blocks on
the first violation. Change it any time; it takes effect on the next tool call. A
guardrail that can't be loosened gets uninstalled, and an uninstalled guardrail protects
nothing.

**Works with the agent you already use**
OpenCode, Claude Code, Cline, Cursor, Codex CLI, Gemini CLI, OpenClaw, Hermes — plus an
MCP server and a generic stdin contract for everything else. The docs mark each host
`live`, `types`, or `docs` by how much it has actually been verified, rather than
implying they're all equally proven.

**Catches agents that get stuck**
Retrying the same failing command is invisible from inside the context window and
obvious from outside it. Keel has rule types for it — N identical failures triggers a
redirect; patching without research gets held; destructive changes need a hypothesis
first. They ship in observe mode, recording what they'd have done, until you've seen
they don't misfire on your work.

**Tamper-evident history**
Every gated or blocked action is written as a signed, hash-chained receipt. `keel verify`
proves the log wasn't edited after the fact.

---

## Install

```bash
npm install -g @get-keel/cli
keel install --all      # wire every agent found on this machine
keel scan               # confirm coverage
```

Node.js 22.12+. Nothing leaves your machine.

---

## FAQ

**Does this send my code anywhere?**
No. Evaluation is local pattern matching. There is no account, no telemetry, and no
network call in the enforcement path. The optional dashboard binds 127.0.0.1 with a
token that is never written to disk.

**Will it slow me down?**
Only if it misfires — which is why deny rules warn on first violation and block on
repeat, and why `keel level sprint` downgrades everything to warnings while you're
iterating. Approval gates are reserved for genuinely irreversible operations.

**Can the agent just bypass it?**
Pattern rules are regex gates, not an anti-virus; a determined agent can obfuscate a
command. That's why irreversible operations use human approval instead of pattern
matching. Enforcement also runs in-process, so it assumes the agent process itself isn't
compromised — if that's your threat model, you want kernel-level sandboxing.

**How is this different from Semgrep or Snyk?**
Those analyse code after it's written. Keel gates what the agent *does* — the command,
the file write, the network call — before it happens. They compose well.

**What if my agent isn't supported?**
Use the MCP server (`keel serve`) or the generic contract (`keel hook generic`):
`{tool, args}` on stdin, exit 0 to allow, 2 to block. That's how any wrapper integrates
without keel shipping a bespoke adapter.

**Is it really free?**
The CLI, the engine and every integration are Apache-2.0, and stay that way.

---

## Footer CTA

> **Find out what your agent can currently do.**
>
> ```bash
> npx @get-keel/cli scan
> ```
>
> Installs nothing. Takes ten seconds.

---

## Meta / SEO

```html
<title>Keel — Guardrails for AI Coding Agents | Enforce Rules Outside the Context Window</title>
<meta name="description" content="Keel enforces rules on AI coding agents at the tool-call boundary — so they survive context rot and compaction. Works with Claude Code, Cursor, OpenCode, Cline, Codex and Gemini CLI. Open source.">
```

**Primary keywords:** AI agent guardrails · AI coding agent security · Claude Code hooks
· PreToolUse hook · agent policy engine · MCP security · stop AI agent destructive commands

**Long-tail (higher intent, lower competition):** how to stop Claude Code from force
pushing · AI agent ignores CLAUDE.md · Cursor rules not being followed · block AI agent
from running rm -rf · MCP server security scan · AI agent audit log

**Structural notes**
- One `<h1>`, containing "AI coding agents".
- The `npx` command in the first viewport — the zero-install trial is the conversion event.
- FAQ section marked up with `FAQPage` schema.org for rich results.
- Link to GitHub with `rel="me"`; link the docs deep pages, not just the repo root.
