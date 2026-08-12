# Cline Integration

Cline has a real `PreToolUse` hook (`HOOK_CONTROL` + `cancel: true`) that
Keel wires for actual blocking, plus two advisory layers: standing
requirements injected every session, and an MCP check server the agent can
call before risky actions on its own initiative.

## Install

```bash
keel install --cline
```

This creates in your project:

- `.clinerules` — standing requirements (read by Cline at session start).
- `~/.cline/hooks/PreToolUse` — evaluates every tool call with
  `keel evaluate`; a `HOOK_CONTROL` line with `cancel: true` stops the call.
- `.cline/cline_mcp_settings.json` — registers the `keel` MCP server
  (`keel serve`), which exposes:

| Tool | Purpose |
|------|---------|
| `keel_check` | Check an action against rules before executing it |
| `keel_audit` | View recent enforcement entries |

Restart Cline after installing.

## How it works

```
Session start → .clinerules (standing requirements)
Tool call     → PreToolUse hook → keel evaluate --tool <name> --args <json>
              → HOOK_CONTROL line, cancel: true on deny/block
Risky action  → agent can ALSO call keel_check directly (advisory, on its own initiative)
```

**Verification status:** the `PreToolUse` hook is `types`-level confidence
— built against Cline's installed `@cline/core` type definitions, not
exercised inside a real running Cline session in this repo's environment.
The warn path (`systemMessage` on a non-cancelling `HOOK_CONTROL` line) is
`docs`-level, best-effort. Current matrix, with every caveat:
`docs/integrations.md`.

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
