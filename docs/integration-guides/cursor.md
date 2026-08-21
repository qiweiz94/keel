# Cursor Integration

Cursor's `beforeShellExecution`/`beforeMCPExecution` hooks let Keel actually
block a tool call, not just remind the agent about one — plus a declarative
rules layer for standing requirements Cursor shows the model on every file.

## Install

```bash
keel install --cursor
```

This creates:

- `.cursor/rules/keel.mdc` (glob `**/*`, `alwaysApply: true`) — restates your
  standing requirements (run tests before claiming done, build ≠ tests pass,
  ask before defaulting a format/config, re-check requirements in long
  sessions). If `keel.mdc` already exists with content keel didn't write,
  keel writes `.cursor/rules/keel-enforcement.mdc` instead of appending —
  MDC frontmatter is only recognized at the top of a file, so appending
  would bury `alwaysApply: true` where Cursor would never parse it.
- `.cursor/hooks/keel-enforce.sh` — evaluates the call with `keel evaluate`.
- `.cursor/hooks.json`, wiring that script into both
  `beforeShellExecution` and `beforeMCPExecution` with `failClosed: true` (a
  crash in the hook denies, it doesn't silently allow).

If `.cursor/hooks.json` already exists, keel leaves it alone and prints a
warning — add the hook to `beforeShellExecution` yourself rather than have
the installer guess at merging your existing config.

## How it works

```
Shell/MCP call → beforeShellExecution / beforeMCPExecution
              → keel-enforce.sh → keel evaluate --tool <name> --args <json>
              → {permission: allow}            → runs
              → {permission: deny|ask}          → blocked / needs approval
Every file context → .cursor/rules/keel.mdc (always apply, advisory)
```

**Verification status:** the block path is `docs`-level confidence — built
from Cursor's published hook contract, not exercised inside a real Cursor
install in this repo's test environment. The warn path
(`userMessage`/`agentMessage`, sent alongside the snake_case
`user_message`/`agent_message` Cursor's real docs use) is the same
confidence level. Current matrix, with every caveat: `docs/integrations.md`.

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
- Full standing requirements in `~/.keel/requirements.md`
