# Gemini CLI Integration

Keel reuses the Claude Code hook contract for Gemini CLI, rather than
guessing at a separate one — Gemini ships `gemini hooks migrate
--from-claude`, which exists specifically to convert Claude Code hooks into
Gemini's own format, so the two are equivalent by the vendor's own account.

## Install

```bash
keel install --gemini
```

This creates in `~/.gemini/hooks/`:

- `PreToolUse` — evaluates every tool call with `keel evaluate`; exit code 2
  blocks the action, same envelope as Claude Code.
- `PostToolUse` — discharges `verification`/`claim` rule obligations (v1,
  M2-B1).
- `Stop` — checks the agent's own completed turn text for an unverified
  completion claim (observe-only, never blocks).

Gemini also has its own Policy Engine (`--policy`/`--admin-policy`),
independent of keel — the hook above enforces your `~/.keel/rules.yaml`
regardless of whether Gemini's own policy engine is also configured.

## How it works

```
Tool call → PreToolUse hook  → keel evaluate --tool <name> --args <json>
                              → exit 0 = allow, exit 2 = deny (message shown to the model)
         → PostToolUse hook  → verification obligations discharged
Turn ends → Stop hook        → unverified completion-claim check (observe-only)
```

## Verification status

`types`-level confidence for the block path — built against the
Claude-Code-compatible contract Gemini documents, not exercised inside a
live Gemini CLI session. The `PostToolUse`/`Stop` discharge paths and the
warn path are `docs`-level — this repo's environment has no `GEMINI_API_KEY`
or OAuth session to drive a real Gemini CLI run against
(`session/v1/EVIDENCE/m4-hostbreadth.md`'s `gemini-warn.sh` correctly
early-exits AUTH-BLOCKED rather than fabricate a pass). Current matrix,
every caveat: [`docs/integrations.md`](../integrations.md).

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
- Full standing requirements in `~/.keel/requirements.md`
