# Claude Code Integration

Keel enforces rules on Claude Code via [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks).

## Install (Recommended)

```bash
keel install --claude-code
```

This creates in your project:

- `.claude/hooks/PreToolUse/keel-enforce` — evaluates every tool call with
  `keel evaluate`; exit code 2 blocks the action and shows the rule message.
- `.claude/hooks/PostToolUse/keel-reinject` — re-injects standing requirements
  after every tool call so long sessions don't lose them.
- Registers both hooks in `.claude/settings.json` (matcher `*`).

Restart Claude Code after installing.

## How it works

```
Tool call → PreToolUse hook → keel evaluate --tool <name> --args <json>
                             → exit 0 = allow
                             → exit 2 = deny (message shown to the model)
         → PostToolUse hook  → standing requirements re-injected
```

Deny rules warn on the first violation and block on repeat (state persists
across calls via `~/.keel/state/`). Fix rules cannot mutate the tool input in
Claude Code — the call is allowed and the fix is surfaced in the message.

## Requirements

- `keel` on PATH (`npm install -g keel-cli`)
- Rules in `~/.keel/rules.yaml` and/or `.keel/rules.yaml` (project rules
  override global rules for the same id)
- Standing requirements in `~/.keel/requirements.md` / `.keel/requirements.md`

## Limitations

- Hook overhead is one `keel evaluate` subprocess per tool call (~50-200ms).
- Rate-limit and sequence rules are per-process in the core pipeline; the
  subprocess path applies command/content rules and warn-then-deny escalation.
