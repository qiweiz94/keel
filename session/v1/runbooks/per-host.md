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
| Cursor | (manual) | Cursor app + a project with keel installed | trigger a blocked command in-app; confirm the deny — see "Cursor block-path field-casing" note below before you do |
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

## Offline coverage strengthened, 2026-08-19 (lane-n2)
No live credentials were available this session for any of the six non-live hosts (Gemini CLI,
Codex CLI, Cursor, Cline, Hermes, OpenClaw), so this pass could not move any host from
docs/types to live — see the honesty ratchet above. What it did do: broadened the EXISTING
offline test coverage (synthetic JSON/env stdin through the real built hook scripts and adapters,
no host process involved) so the gap between "types-level" and "live-verified" is smaller without
being live:
- `packages/cli/src/__tests__/hook-contract.test.ts` — added a Gemini case to the end-to-end
  host-hook-script block (previously only cline/cursor/codex/claude-code were driven through the
  real templates there). Added, per host (cline/cursor/codex/gemini): a destructive `rm -rf`
  (`no-destructive-commands`), a pipe-to-shell remote exec (`pipe-to-shell`), a SECOND prompt-class
  rule distinct from push-to-main (proves the prompt path isn't tied to one pattern), and a
  secret-file-read WARN case (`secret-file-read-without-egress`) — the first warn-path coverage
  for these host scripts; every prior case here was deny/prompt only. Each new deny/prompt case was
  verified against a real `keel evaluate` run to confirm the intended synthetic rule fired (not a
  built-in floor rule shadowing it) before being wired into the host-script assertions. NOT
  covered: `no-exfil-flow` (flow-type — reads a secret file, then denies only if a network sink
  follows in the same session; this harness drives one `--tool bash --args {command}` call at a
  time, so flow-type and content-type rules aren't reachable through it at all).
- `packages/cli/src/__tests__/hermes-adapter.test.ts` and `openclaw-adapter.test.ts` — the
  offline-circuit-breaker test only exercised 3 of the 7 `OFFLINE_DENY` categories each adapter
  ships (rm -rf, force-push, DROP TABLE). Now exercises all 7 (adds TRUNCATE TABLE, fork bomb,
  mkfs, raw `dd` to a block device) plus near-miss non-catastrophic cases. Both adapters also gained
  an identical, separately-labeled test documenting a known false positive of the regex backstop
  (`DROP TABLE` inside an unrelated `echo` string still blocks — no command-vs-string-literal
  distinction) — added to BOTH adapters for parity, since they ship a byte-identical `OFFLINE_DENY`
  list.
This is still synthetic-input testing, not a live host run. It raises confidence that the
command-mapping code is *correct as written*; it does not prove any of the six hosts actually
invoke that code the way the docs say they do.

## Cursor block-path field-casing — status as verified in THIS worktree
`packages/cli/src/commands/hook.ts`'s `renderVerdict` function, non-blocking/advisory branch for
Cursor (the `!blocked` switch, `case 'cursor'`) sends BOTH `userMessage`/`agentMessage` (camelCase)
and `user_message`/`agent_message` (snake_case) — a prior wave's fix, per the code comment there,
after a live `cursor.com/docs/hooks` fetch showed the docs use snake_case.
The BLOCK path in the same function (the `blocked` switch, `case 'cursor'`) still sends ONLY
camelCase (`userMessage`/`agentMessage`) — a comment on the advisory branch above calls this out
explicitly as the same bug, left unfixed there deliberately pending live Cursor access. Verified
directly in this worktree (2026-08-19, lane-n2, no edits made to `hook.ts` here): that block-path
gap is still present as of this commit. A sibling lane in this sprint is reportedly fixing it —
don't trust this note's "still present" claim once that lane lands; re-read `hook.ts`'s block-path
`case 'cursor'` directly (search for `renderVerdict`, not a line number, since any edit shifts
them).
