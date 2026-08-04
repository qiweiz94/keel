# X / Twitter thread

> One concrete number in the first post, one runnable command, and the limits stated
> before anyone else raises them. No thread-bait ("a 🧵 you can't miss").

---

**1/**

```
My coding agent retried the same failing command 39 times in one session.

Not a bug in the model. A missing control surface — nothing outside the context
window was watching.

So I built one.
```

**2/**

```
CLAUDE.md, AGENTS.md, .cursorrules are prompts.

The model reads them and tries to comply. There's no mechanism making it.

By turn 40 they're diluted. After compaction they're gone.

Advisory ≠ enforced.
```

**3/**

```
Keel evaluates every tool call BEFORE it runs, in a process the agent doesn't control.

- id: no-force-push
  type: command
  match: "git push --force(?!-with-lease)"
  action: deny

That's the whole rule.
```

**4/**

```
See what's currently unprotected on your machine. Installs nothing:

  npx @get-keel/cli scan

Mine found 4 agents that could run any shell command with nothing in the way, plus an
MCP server pulling an unpinned package at launch.
```

**5/**

```
The setting I use most is the approval gate.

Agent hits `git rebase` → blocked → I run `keel allow git-history-rewrite --once` in my
own terminal.

Agents are hard-blocked from running keel's control commands. They can't approve
themselves.
```

**6/**

```
The real failure mode of guardrails isn't missing a threat. It's false positives.

Interrupt good work often enough and it gets uninstalled — then it protects nothing.

So: warn once, block on repeat. And a dial:

keel level sprint    # warnings only
keel level protect   # block on first violation
```

**7/**

```
It also catches agents that circle.

`stuck` — N identical failures → redirect
`research` — no patching before looking it up
`diagnosis` — no destructive change without a root cause

Ships in observe mode. Records what it WOULD have done, until you trust it.
```

**8/**

```
Works with OpenCode, Claude Code, Cline, Cursor, Codex, Gemini CLI, OpenClaw, Hermes.
Anything else via MCP or a generic stdin contract.

The docs mark each host live / types / docs by how much it's actually been verified.
I'm not going to pretend they're all equally proven.
```

**9/**

```
Limits, stated up front:

Pattern rules are regex gates, not an anti-virus. A determined agent can obfuscate a
command — that's why irreversible ops use human approval instead.

Enforcement is in-process. If the agent binary itself is hostile, you want kernel
sandboxing, not this.
```

**10/**

```
Free. Apache-2.0. Runs entirely on your machine — no account, no telemetry.

github.com/qiweiz94/keel

If you try it and hit a false positive, send me the rule id and the command. That's the
most useful thing anyone can give me right now.
```

---

## Notes

- Post 1 and post 4 are the ones that travel. Both carry a real number or a runnable command.
- Reply to every response for the first two hours.
- A screenshot or 20-second asciinema of `keel scan` finding something real on post 4
  roughly doubles engagement over plain text.
- Don't quote-tweet competitors. Don't subtweet a specific tool's incident.
