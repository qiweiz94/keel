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
2. Enable the plugin in your OpenClaw config and restart the gateway. `keel install
   --openclaw` prints the exact commands (with your real install path filled in); they
   look like this:
   ```bash
   openclaw config set plugins.load.paths '["~/.openclaw/plugins/keel"]' --strict-json
   openclaw config set plugins.allow '["keel"]' --strict-json   # pins trust; clears OpenClaw's provenance warning
   ```
   These **replace** the array at that path rather than appending — verified against a
   real installed OpenClaw (2026.4.15). If you already have other entries in either array,
   run `openclaw config get plugins` first and include the existing values in the JSON, or
   they will be dropped. `openclaw config set` also validates that each load path actually
   exists on disk before writing, so a typo fails loudly instead of silently no-op'ing.

## How it works

```
Tool call → before_tool_call plugin hook → asks the keel daemon
          → daemon reachable    → block: true / requireApproval per your rules
          → daemon unreachable  → keel's OWN circuit breaker (below), not
                                   an OpenClaw fail-open path — the daemon
                                   call is caught inside the plugin and
                                   never throws up to OpenClaw at all
```

**Two separate fail-open/fail-closed questions, easy to conflate — keep them apart:**

1. **Daemon unreachable.** This never reaches OpenClaw's own error handling —
   `daemon()` in `index.mjs` catches the fetch failure internally and returns `null`.
   What runs next is keel's *own* policy choice, not something OpenClaw forces: a local
   circuit breaker that blocks only catastrophic, irreversible operations (`rm -rf /`,
   force-push to a protected branch, `DROP TABLE`, fork bombs, `mkfs`, raw block-device
   writes), allows the rest, and prints a loud DEGRADED notice. Blocking everything
   during an outage is what gets a plugin uninstalled; blocking nothing is what makes it
   a lie.
2. **OpenClaw's own load/throw handling** — a genuinely different layer, and it splits
   in two, not one blanket "fails open":
   - A plugin that fails to *load* (crashes at import/register time) is skipped
     entirely and every tool call proceeds with zero coverage from it —
     openclaw/openclaw#20914, closed as stale without a fix. This is why `keel install
     --openclaw` copies three already-tested static files rather than generating
     anything, and why confirming `openclaw plugins inspect keel` shows it loaded (not
     just `plugins list`, which reports `hookNames: []` for hook-only plugins even when
     registration succeeded) is worth doing once after install.
   - A plugin that loads and registers `before_tool_call` fine, but whose *handler
     throws during an actual call*, is the opposite: reading the installed 2026.4.15
     runtime (`dist/pi-tools.before-tool-call-*.js`) shows that path wrapped in a
     try/catch that returns `{blocked: true, reason: "Tool call blocked because
     before_tool_call hook failed"}` — fail-**closed**. keel's handler is written
     defensively enough (the daemon call never throws; `translate()` guards on
     unexpected shapes) that this path is not expected to trigger in normal operation.

   This is a materially different failure surface from Claude Code/Codex/Gemini's hook
   contract, where a keel process failure denies by construction rather than by a
   host-side catch block. See [`README.md`](../../README.md#limits) and
   [`SECURITY.md`](../../SECURITY.md).

## Verification status

`live`¹ for the block path — plugin loads and `before_tool_call` registers,
confirmed with `openclaw plugins inspect keel --json` (not just `plugins
list`) under an isolated `HOME`. That is still not an exercised call: no
actual tool call has been run through a real agent turn and observed
reaching keel's daemon (no model-provider credentials in any environment
this project has run in). What has changed: the upstream issue this caveat
is built on (openclaw/openclaw#5943, "Wire up `before_tool_call` plugin
hook in tool execution pipeline") is **closed** (2026-02-03), before the
2026.4.15 build this repo tests against, and reading that build's actual
compiled source confirms the wiring the issue describes is present — the
tool-execution wrappers this lane inspected call `runBeforeToolCallHook(...)`
before `tool.execute()` runs, and `block: true` throws before it. The
load-time config-wiring gap this file used to flag as "not completed" is
closed too — see the Install section above and `installOpenClaw()` in
`packages/cli/src/commands/install.ts`. Full evidence and exact commands
run: [`docs/integrations.md`](../integrations.md) footnote 1. The gap
described above (an exercised call) is narrowed, not closed, by any of
this. The warn path (`api.logger.warn`) is still `docs`-level — whether it
reaches the chat UI or only an operator/gateway log is unconfirmed.

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- `keel daemon` running (or willing to auto-spawn — check your OpenClaw
  plugin-launch permissions)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
