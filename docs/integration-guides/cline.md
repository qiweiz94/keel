# Cline Integration

Cline has a real `PreToolUse` hook (`HOOK_CONTROL` + `cancel: true`) that
Keel wires for actual blocking, plus two advisory layers: standing
requirements injected every session, and an MCP check server the agent can
call before risky actions on its own initiative. `PostToolUse` and
`TaskComplete` (v1 M2-C1) give `type: verification`/`type: claim`
obligations a real discharge and claim-check channel on this host too —
see below.

## Install

```bash
keel install --cline
```

This creates in your project (and, for the hooks, in `~/.cline/hooks/`):

- `.clinerules` — standing requirements (read by Cline at session start).
- `~/.cline/hooks/PreToolUse` — evaluates every tool call with
  `keel evaluate`; a `HOOK_CONTROL` line with `cancel: true` stops the call.
- `~/.cline/hooks/PostToolUse` (v1 M2-C1) — fires after every completed
  tool call. Scans the tool's own output for secret-shaped content and
  records the attempt, but deliberately does NOT clear a `type:
  verification` obligation on this host yet — see below.
- `~/.cline/hooks/TaskComplete` (v1 M2-C1) — fires once the agent run
  finishes, carrying the agent's own final generated text. This is Cline's
  Stop-equivalent claim-channel: it is what lets `type: claim` actually
  check a "done"/"passing" claim against a pending obligation on this host.
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
Tool completes → PostToolUse hook → scans output for secrets, records the
              attempt outcome (never discharges type: verification — see below)
Run finishes  → TaskComplete hook → checks the agent's final text against
              a pending type: claim obligation (never blocks)
Risky action  → agent can ALSO call keel_check directly (advisory, on its own initiative)
```

**Verification status:** the `PreToolUse` hook is `types`-level confidence
— built against Cline's installed `@cline/core` type definitions, not
exercised inside a real running Cline session in this repo's environment.
The warn path (`systemMessage` on a non-cancelling `HOOK_CONTROL` line) is
`docs`-level, best-effort.

`PostToolUse`/`TaskComplete` (v1 M2-C1) are also `types`-level confidence,
but built from a stronger source than `PreToolUse` was: the installed
`cline` npm CLI's own COMPILED `node_modules/@cline/core/dist/index.js`
bundle, not merely its `.d.ts`. The claim channel (`TaskComplete`) is fully
live end-to-end. `type: verification` discharge specifically stays
deliberately inert — `PostToolUse`'s own `success` field reflects whether
the tool call itself errored, and no installed source confirms whether a
FAILING test (a shell command exiting non-zero) sets that field or leaves
it unset with the failure only visible as text. Rather than guess and risk
discharging an obligation on a run that never passed, `exitCode` stays
`null` on this host until that's confirmed. Full citations:
`docs/integrations.md`'s footnote ⁶.

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
