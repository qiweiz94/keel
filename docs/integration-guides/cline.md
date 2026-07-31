# Cline Integration

Cline has no tool-interception hook, so Keel's Cline integration is
**advisory**: it injects standing requirements into every session and exposes
an MCP check server the agent can call before risky actions.

## Install

```bash
keel install --cline
```

This creates in your project:

- `.clinerules` — standing requirements (read by Cline at session start).
- `.cline/cline_mcp_settings.json` — registers the `keel` MCP server
  (`keel serve`), which exposes:

| Tool | Purpose |
|------|---------|
| `ai_enforce_check` | Check an action against rules before executing it |
| `ai_enforce_audit` | View recent enforcement entries |

Restart Cline after installing.

## How it works

```
Session start → .clinerules (standing requirements)
Risky action  → agent calls ai_enforce_check → allow/warn/deny decision
```

The agent is *expected* to check before dangerous operations — Cline cannot
force it. For hard enforcement use OpenCode (plugin) or Claude Code (hooks).

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
