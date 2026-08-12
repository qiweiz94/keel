# Runbook — per-host live verification (needs your credentials)

**Status:** the enforcement + claim-discharge mechanisms are wired and unit/mechanism-tested. What
remains is *live* verification on each real host, which needs **authenticated credentials** for
that host — so it's yours to run. Honesty ratchet: a host only moves to "live" in
`docs/integrations.md` with a committed transcript from a real run.

## What's proven without your creds
- **OpenCode** — block AND warn live-verified (committed transcript). Verification discharge live in-process.
- **Claude Code** — block live-verified (earlier wave); PostToolUse verification-discharge mechanism-tested end-to-end.

## What needs you (per host)
Each host has a driver under `scripts/live-verify/`. Read the script header for the exact command;
the pattern is: install keel for that host into an **isolated** HOME/config, drive the real host
against a scratch repo, and assert the block/warn actually happened.

| Host | Script(s) | What you provide | Pass = |
|---|---|---|---|
| Gemini CLI | `gemini.sh`, `gemini-warn.sh` | a Gemini account/tier that isn't `IneligibleTierError` + auth | block denies + warn surfaces in the host's own log |
| Codex CLI | `codex.sh`, `codex-warn.sh` | Codex CLI installed + authed | same |
| Cursor | (manual) | Cursor app + a project with keel installed | trigger a blocked command in-app; confirm the deny |
| Cline | (manual — headless path exists but costs real money) | Cline provider creds/balance | run the hook against a scratch task; confirm deny |
| Hermes / OpenClaw | (manual) | the host installed | confirm the hook wiring blocks |

## Steps (drivable hosts: Gemini, Codex)
1. Authenticate the host CLI in your shell (its normal login).
2. Run its script from the repo root, e.g. `bash scripts/live-verify/gemini.sh` then
   `bash scripts/live-verify/gemini-warn.sh`. They use an isolated HOME + `/tmp` scratch and never
   touch your real `~/.keel`/`~/.gemini` config beyond what the script sets up.
3. A pass prints the assertion result and writes a transcript. Commit the transcript under
   `session/transcripts/` and flip that host's cell in `docs/integrations.md` from docs/types to
   **live**, citing the transcript.

## Verification-discharge note
The PostToolUse/Stop claim-discharge branch (verification thesis on exit-code hosts) is
mechanism-tested and live only on **Claude Code**. Gemini/Codex discharge is docs-confidence until
a real authed run confirms the host echoes the hook's output on the discharge channel — that check
is part of the same per-host run above.

Do NOT mark any host "live" without a committed transcript. An honest "docs-confidence, not
live-verified" is the correct state until you run it.
