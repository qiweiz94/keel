# Show HN post

> Draft. HN rewards mechanism and honesty over adjectives, and punishes anything that
> reads like marketing. The version below leads with the concrete failure, states the
> mechanism plainly, and volunteers the limits before a commenter finds them.

---

**Title** (80 char limit — keep under 70 so it doesn't truncate):

```
Show HN: Keel – enforce rules on AI coding agents outside the context window
```

Alternatives, if the above underperforms:

- `Show HN: Guardrails for AI coding agents that survive context rot`
- `Show HN: My agent ran the same broken command 39 times. So I built a rule engine.`

---

**Body:**

```
I kept hitting the same thing with coding agents: they follow instructions at turn 1
and quietly stop by turn 40. CLAUDE.md, AGENTS.md, .cursorrules are all prompts — the
model reads them and tries to comply, but compliance decays as context fills, and
compaction drops them entirely.

Keel moves the rules out of the context window. It hooks the tool-call boundary and
evaluates each call before it runs, in a process the model doesn't control and can't
edit. A rule is YAML:

  - id: no-force-push
    type: command
    match: "git push --force(?!-with-lease)"
    action: deny

Actions are allow / warn / deny / block / prompt / fix / report. `prompt` is the one I
use most — it blocks irreversible operations until I personally run
`keel allow <id> --once` in my own terminal. Agents are hard-blocked from running that
command, so they can't approve themselves.

It works with OpenCode, Claude Code, Cline, Cursor, Codex, Gemini CLI, OpenClaw and
Hermes; anything else goes through an MCP server or a generic stdin/exit-code contract.
The docs mark each host live / types / docs depending on how much it's actually been
verified, because I could only test some of them against the real host.

You can point it at your own machine without installing anything:

  npx @get-keel/cli scan

That lists which agents can currently run shell commands with nothing in the way, and
flags MCP servers launching unpinned packages or talking over plaintext HTTP. On my
machine the first run found four unprotected hosts.

The part I found most interesting to build: rules for *stuck* agents. Checking my own
traces, one command had been retried 39 times in a single session. That pattern is
invisible from inside the context window but trivial to see from outside it, so there
are `stuck`, `research` and `diagnosis` rule types. They ship in observe mode — they
record what they'd have done without interrupting — because a behavioural rule that
blocks on its first hit is how guardrails get uninstalled.

Limits, up front: pattern rules are regex gates, not an anti-virus, so a determined
agent can obfuscate a command — for genuinely irreversible things use the approval gate
rather than pattern matching. Enforcement is in-process, so it assumes the agent
process itself isn't compromised; if that's your threat model you want kernel-level
sandboxing instead. And I'm one person, so several host integrations are built against
published docs rather than a live install.

Apache-2.0. Happy to answer anything.

https://github.com/qiweiz94/keel
```

---

## Timing and follow-through

- Post Tue–Thu, 8–10am ET.
- Be present for the first 3 hours; first-hour response rate drives ranking more than
  the post itself.
- Never ask for upvotes. Never post the link elsewhere in the first hour.

## Comments to prepare for

**"This is just a wrapper around hooks."** — Partly true, and worth conceding. The
hooks are the mechanism; the value is the rule engine on top: state that survives
restarts, warn-then-block escalation, approval gates the agent can't self-grant, and one
policy that applies across eight hosts rather than a bespoke script per host.

**"The agent can just bypass it."** — For pattern rules, yes, and the README says so.
That's exactly why `prompt` gates exist for irreversible operations. Don't oversell here.

**"Why not use OPA/Rego?"** — You can; `keel policy` supports Rego/WASM. YAML is the
default because most rules are ten lines and Rego is a real learning curve.

**"How is this different from <project>?"** — Link `docs/comparison.md`, which says
plainly where other projects are stronger. Do not disparage anyone in the thread.

**"Doesn't this slow the agent down?"** — Evaluation is local pattern matching. The
bigger cost is a false positive interrupting a good workflow, which is why the default
is warn-once-then-block rather than block-first, and why `keel level sprint` exists.
