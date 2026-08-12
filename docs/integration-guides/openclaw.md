# OpenClaw Integration

The OpenClaw plugin is a thin client over the **keel daemon** — unlike
OpenCode's self-contained bundled plugin, OpenClaw's plugin sends every tool
call to a locally running `keel daemon` process for the actual rule
evaluation.

## Install

```bash
keel install --openclaw
```

This copies three files into `~/.openclaw/plugins/keel/` (`index.mjs`,
`openclaw.plugin.json`, `package.json` — imports only Node builtins, nothing
to bundle). You then need to:

1. Start the daemon: `keel daemon` (idles out after 10 minutes of
   inactivity and respawns on demand).
2. Enable the plugin in your OpenClaw config and restart OpenClaw:
   ```
   plugins.load.paths += "~/.openclaw/plugins/keel"
   plugins.allow       += "keel"   # pins trust; clears OpenClaw's provenance warning
   ```

## How it works

```
Tool call → before_tool_call plugin hook → asks the keel daemon
          → daemon reachable    → block: true / requireApproval per your rules
          → daemon unreachable  → FAILS OPEN by design (see below), but the
                                   local circuit breaker still blocks
                                   catastrophic operations and prints a loud
                                   DEGRADED notice
```

**OpenClaw fails open, not closed, when the daemon can't be reached** — a
throwing plugin is skipped by OpenClaw itself. Keel's plugin carries a local
circuit breaker for catastrophic-only coverage during an outage rather than
relying on OpenClaw's own behavior, but this is a materially different
failure mode from Claude Code/Codex/Gemini's hook contract, where a keel
process failure denies. See [`README.md`](../../README.md#limits) and
[`SECURITY.md`](../../SECURITY.md).

## Verification status

`live`¹ for the block path — `openclaw plugins list` confirms the plugin
loads under an isolated `HOME`. That is a **load-time** check, not a
per-call one: a separate, still-open upstream issue
(openclaw/openclaw#5943) suggests `before_tool_call` may not fire in some
OpenClaw versions/builds at all, and wiring the plugin into a running
OpenClaw session to reproduce even the load-time check live was not
completed as of this release (`session/v1/EVIDENCE/m4-hostbreadth.md`). The
warn path (`api.logger.warn`) is `docs`-level — whether it reaches the chat
UI or only an operator/gateway log is unconfirmed. Current matrix, every
footnote: [`docs/integrations.md`](../integrations.md).

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- `keel daemon` running (or willing to auto-spawn — check your OpenClaw
  plugin-launch permissions)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
