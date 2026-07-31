# Aider Integration

Aider has no tool-interception hook, so Keel's Aider integration is
**advisory**: its instructions file reminds the agent of your standing
requirements at every session.

## Install

```bash
keel install --codex   # writes the requirements section to AGENTS.md
```

Aider reads `AGENTS.md` at session start. The Keel section restates:

- Run tests and include output before claiming completion.
- Build success ≠ tests pass.
- Ask the user before choosing formats/configs. Never default.
- Re-check standing requirements in long sessions.

## How it works

```
Session start → AGENTS.md → Keel standing requirements section
```

Aider cannot block tool calls. For hard enforcement use OpenCode (plugin) or
Claude Code (hooks).

## Requirements

- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
- Full standing requirements in `~/.keel/requirements.md`
