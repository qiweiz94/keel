# Cursor Integration

Cursor's `beforeShellExecution`/`beforeMCPExecution` hooks let Keel actually
block a tool call, not just remind the agent about one — plus a declarative
rules layer for standing requirements Cursor shows the model on every file.
`postToolUse`/`postToolUseFailure`/`afterAgentResponse` (v1 M2-C1) give
`type: verification`/`type: claim` obligations a real discharge and
claim-check channel on this host too — see below.

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
  The SAME script handles every event below; `keel hook cursor` tells them
  apart from the payload shape (Cursor sends no explicit event-name field).
- `.cursor/hooks.json`, wiring that script into `beforeShellExecution` and
  `beforeMCPExecution` (block-capable, `failClosed: true` — a crash in the
  hook denies, it doesn't silently allow) AND, new this lane, `postToolUse`,
  `postToolUseFailure`, and `afterAgentResponse` (claim-to-evidence — these
  three structurally can never block, see below).

If `.cursor/hooks.json` already exists, keel leaves it alone and prints a
warning — add all five hook entries yourself rather than have the installer
guess at merging your existing config. Without `postToolUse`/
`postToolUseFailure`/`afterAgentResponse` wired, `type: verification`/
`type: claim` obligations will arm on an edit but never discharge or get
checked on this host.

## How it works

```
Shell/MCP call → beforeShellExecution / beforeMCPExecution
              → keel-enforce.sh → keel evaluate --tool <name> --args <json>
              → {permission: allow}            → runs
              → {permission: deny|ask}          → blocked / needs approval
Tool call completes → postToolUse / postToolUseFailure
              → keel-enforce.sh → discharges a pending verification/claim
                obligation on a CONFIRMED pass, scans output for secrets
Agent finishes a generation → afterAgentResponse
              → keel-enforce.sh → checks the generated text against a
                pending claim obligation (never blocks)
Every file context → .cursor/rules/keel.mdc (always apply, advisory)
```

**Verification status:** the block path (`beforeShellExecution`/
`beforeMCPExecution`) is `docs`-level confidence — built from Cursor's
published hook contract, not exercised inside a real Cursor install in this
repo's test environment. The warn path on that same block channel
(`userMessage`/`agentMessage`, sent alongside the snake_case
`user_message`/`agent_message` Cursor's real docs use) is the same
confidence level.

The claim-to-evidence channel (`postToolUse`/`postToolUseFailure`/
`afterAgentResponse`, v1 M2-C1) is `types`-level confidence instead — a
STRONGER basis than the block path above, but still not `live`: these three
events, and the exact `{tool_output, error_message, text, input_tokens,
...}` field names each one carries, were read directly out of the
INSTALLED Cursor.app's own bundled `cursor-agent-exec` extension on this
machine (not published docs, which document none of the three). For a
shell command specifically, the real numeric exit code is recovered from
`postToolUse`'s `tool_output` field (a JSON string of `{output, exitCode}`)
— every other tool type's output shape carries no exit code at all, and
that channel is left `null` (never discharges) rather than guessed. Full
citations and the exact confirmed/unconfirmed boundary:
`docs/integrations.md`'s footnote ⁵.

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
- Full standing requirements in `~/.keel/requirements.md`
