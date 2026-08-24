# Codex CLI Integration

Codex CLI gets both a real blocking hook and an advisory instructions layer
from `keel install --codex` — not advisory-only, despite the installer's own
current log line (see the note in Verification status below).

## Install

```bash
keel install --codex
```

This creates:

- `~/.codex/hooks/keel-enforce.sh` — evaluates every tool call with
  `keel evaluate`; register it in `~/.codex/hooks.json` as a `PreToolUse`
  hook. Codex requires the hook file's hash to be trusted before it runs
  (Codex's own trust-on-first-use mechanism, not a keel step).
- `~/.codex/hooks/keel-verify.sh` — a `PostToolUse` hook that discharges
  `verification`/`claim` rule obligations (added in v1, M2-B1).
- `~/.codex/hooks/keel-claim.sh` — a `Stop` hook, the same completion-claim
  check Claude Code's `Stop` hook runs.
- An `AGENTS.md` section (created or appended) restating your standing
  requirements — the advisory layer, read at session start.

## How it works

```
Tool call → PreToolUse hook  → keel evaluate --tool <name> --args <json>
                              → exit 0 = allow, exit 2 = deny
         → PostToolUse hook  → verification obligations discharged
Turn ends → Stop hook        → checks the agent's own completed text for an
                                unverified completion claim (observe-only)
Session start → AGENTS.md    → standing requirements (advisory)
```

## Verification status

All three hooks are `docs`-level confidence — built from Codex's published
hook contract, not exercised inside a live Codex CLI session in this repo's
environment (no Codex install / no `api.openai.com` auth available here; see
`session/v1/EVIDENCE/m4-hostbreadth.md`'s AUTH-BLOCKED note for the same
constraint on the warn-verification pass). The installer's own console
output still prints "Codex CLI has no blocking hooks — these are advisory
instructions" from before the hooks were added — that line is stale
(`packages/cli/src/commands/install.ts`); the hooks it installs alongside
that message do register real `PreToolUse`/`PostToolUse`/`Stop` contracts,
consistent with the `docs`-verified "PreToolUse hook, exit 2" row in
[`docs/integrations.md`](../integrations.md).

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml`
- Full standing requirements in `~/.keel/requirements.md`
