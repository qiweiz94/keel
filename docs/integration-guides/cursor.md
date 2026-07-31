# Cursor Integration

Cursor has no tool-interception hook, so Keel's Cursor integration is
**advisory**: it installs declarative rules that remind the agent of your
standing requirements on every file.

## Install

```bash
keel install --cursor
```

This creates `.cursor/rules/keel.mdc` (glob `**/*`, `alwaysApply: true`),
which restates:

- Run tests and include output before claiming completion.
- Build success ≠ tests pass.
- Ask the user before choosing formats/configs. Never default.
- Re-check standing requirements in long sessions.

## How it works

```
Every file context → .cursor/rules/keel.mdc (always apply)
```

Cursor cannot block tool calls. For hard enforcement use OpenCode (plugin) or
Claude Code (hooks).

## Requirements

- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
- Full standing requirements in `~/.keel/requirements.md`
