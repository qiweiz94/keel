# Hermes Integration

Like OpenClaw, the Hermes plugin is a thin client over the **keel daemon**
— Hermes plugins are Python with a YAML manifest, so there's nothing to
bundle: two files copied in, and the daemon does the actual rule evaluation.

## Install

```bash
keel install --hermes
```

This copies `keel_plugin.py` and `plugin.yaml` into
`~/.hermes/plugins/keel/`, plus an `__init__.py` exposing `register(ctx)`
(Hermes's plugin entry-point contract). Then:

```bash
keel daemon    # idles out after 10 minutes, respawns on demand
```

## How it works

```
Tool call → pre_tool_call plugin hook → asks the keel daemon
          → daemon reachable    → {"action": "block"} per your rules
          → daemon unreachable  → FAILS OPEN by design, but the local
                                   circuit breaker still blocks catastrophic
                                   commands and says so loudly
```

**Fails open, not closed, like OpenClaw** — a throwing plugin is skipped by
Hermes itself. Keel's local circuit breaker only guarantees catastrophic-tier
coverage during a daemon outage, not full rule coverage. See
[`README.md`](../../README.md#limits).

**`fix` rules are advisory-only on Hermes.** Hermes has no mechanism for a
plugin to rewrite a tool call's arguments, so a keel `fix` rule (which
mutates the command in place on hosts that support it) is reported to the
model instead of applied.

## Verification status

`docs`-level — no Hermes CLI is available in this repo's test environment,
so both the block and warn paths are built from Hermes's published plugin
contract, not exercised live. Current matrix, every caveat:
[`docs/integrations.md`](../integrations.md).

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- `keel daemon` running (or willing to auto-spawn)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
