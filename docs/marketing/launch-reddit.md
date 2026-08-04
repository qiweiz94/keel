# Reddit launch posts

> Reddit is community-specific and allergic to cross-posted marketing copy. These are
> three genuinely different posts, not one post retitled. Read each subreddit's
> self-promotion rules before posting — several require a participation history.

---

## r/programming

Strict on self-promotion. Lead with the technical problem, not the product.

**Title:** `Why AI coding agents stop following your rules around turn 40 — and what actually enforces them`

**Body:**

```
Instruction files for coding agents (CLAUDE.md, AGENTS.md, .cursorrules) are prompts.
The model reads them and tries to comply, but there's no mechanism making it. Two things
degrade that further as a session runs:

1. Attention dilution — the "Lost in the Middle" effect (Liu et al. 2023,
   https://arxiv.org/abs/2307.03172) shows retrieval accuracy dropping for content in
   the middle of long contexts.
2. Compaction — summarizing earlier turns drops the instructions outright.

So enforcement has to live outside the context window. The interception points that
actually exist today:

- Tool-call hooks: Claude Code PreToolUse, OpenCode tool.execute.before, Cline, Cursor,
  Gemini CLI. The call is evaluated before it runs; a non-zero exit or thrown error
  stops it.
- Git hooks: agent-agnostic, commit-time. Coarser, but works with tools that expose no
  hook API at all.
- MCP: advisory — the agent chooses to call it — but needs no host-specific integration.

The interesting design problem isn't blocking; it's false positives. A guardrail that
interrupts good work gets uninstalled within a week, which means it protects nothing.
What seems to work is warn-once-then-block (first violation is informational, repeat is
enforced) plus a hard approval gate reserved for irreversible operations only.

I built an implementation of this: https://github.com/qiweiz94/keel — Apache-2.0. But
I'm more interested in whether others have found interception points I've missed,
especially for agents with no plugin API.
```

---

## r/LocalLLaMA

Values self-hosting, no telemetry, and no cloud dependency. Say so explicitly.

**Title:** `Local-only guardrails for coding agents — no cloud, no telemetry, YAML rules`

**Body:**

```
Built this for a problem that gets worse with longer contexts: agents follow rules early
in a session and stop later. Prompt-based instruction files can't fix it because they
ARE the thing being forgotten.

Keel evaluates every tool call before it executes and blocks on rule violations. Fully
local — pattern matching in-process, no API calls, no telemetry, no account. The daemon,
if you use it, binds 127.0.0.1 with a token that never touches disk.

  npx @get-keel/cli scan     # audit your setup, installs nothing

Works with OpenCode, Claude Code, Cline, Cursor, Codex, Gemini CLI, OpenClaw, Hermes,
plus an MCP server and a generic stdin contract for anything else. Rules are YAML:

  - id: no-force-push
    type: command
    match: "git push --force(?!-with-lease)"
    action: deny

Also has rule types for agents that get stuck — N identical failures in a window
triggers a redirect. I found one command in my own logs retried 39 times in a single
session; that's easy to detect from outside the context window and impossible from
inside it.

Apache-2.0, Node 22+. https://github.com/qiweiz94/keel
```

---

## r/ClaudeAI · r/ChatGPTCoding

Practical and workflow-focused. Show the thing, skip the theory.

**Title:** `I got tired of my agent force-pushing, so I built a rule engine it can't ignore`

**Body:**

```
Setup that finally worked for me: rules enforced at the tool-call boundary instead of in
an instructions file the model forgets.

Check what's currently unprotected on your machine (installs nothing):

  npx @get-keel/cli scan

Mine reported 4 agents that could run any shell command with nothing in the way.

Then:

  npm install -g @get-keel/cli
  keel install --all

Ships sane defaults out of the box — destructive commands, curl | sh, secrets in code,
force-push, protected-branch pushes. The one I'd actually recommend to anyone:

  keel level protect     # block on first violation, before a deploy
  keel level sprint      # warnings only, while prototyping

And approval gates for irreversible things — the agent hits `git rebase`, it stops, and
I run `keel allow git-history-rewrite --once` myself. Agents are blocked from running
that command, so they can't approve themselves.

Free, Apache-2.0: https://github.com/qiweiz94/keel
```

---

## Rules of engagement

- Post to one subreddit at a time, days apart. Simultaneous cross-posting reads as spam.
- Answer every comment in the first two hours.
- If someone reports a false positive, ask for the rule id and the command. That's the
  highest-value feedback this project can get.
- Never argue with criticism of the premise. Concede the accurate parts.
