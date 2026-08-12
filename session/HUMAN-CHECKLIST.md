# HUMAN-CHECKLIST — manual live-verification steps

Wave-1 tail lane (headless live verification) could not complete these steps under
the automation constraints (no touching real host configs, no burning time on
auth setup outside the isolated sandbox). Each entry says exactly what a human
should do on a machine where the relevant host is already authenticated, and
what to check.

Scripts referenced below live in `scripts/live-verify/<host>.sh` and are
self-contained (isolated HOME, own scratch repo) except for the auth gap noted.

**Two things confirmed live (via OpenCode, the one host that could authenticate
in this environment) apply to every host below** — see
`session/EVIDENCE/wave1-liveverify.md` for the full write-up:

1. A `git push --force origin main` instruction is blocked by
   `[keel:no-push-to-main]` (a `prompt`-action rule, priority 80, blocks
   unconditionally on the first attempt), NOT `[keel:no-force-push]` — the
   latter also matches but is shadowed by rule priority for that specific
   target. Both block the push either way; only the reported rule id differs.
   To see `no-force-push` fire specifically, target a non-main branch and
   pre-warm its first-violation warning with one direct `keel hook <host>`
   call (`no-force-push` is a `deny`-action rule with its own
   warn-then-deny ladder — the first violation on fresh state only warns).
2. **Bug found live, not fixed here (verification-only lane)**: `keel install
   --project` (and therefore `--all`) writes a project `.keel/rules.yaml`
   stub with a `rules:` key and no items, which YAML parses as `null`, not an
   array. `keel evaluate` / `keel hook <host>` reject that
   ("Invalid Keel rules: Rules must be an array") and fail CLOSED on every
   tool call with a generic "could not evaluate" message instead of the real
   rule reason. OpenCode's own in-process plugin has a separate
   fallback-to-defaults path that masks this for OpenCode specifically; the
   CLI subprocess path used by Claude Code / Gemini / Codex / Cline has no
   such fallback. `keel install --claude-code` / `--gemini` / `--codex` alone
   (used throughout this checklist) do NOT create the broken stub — only
   `--project` / `--all` do. If a checklist run ever uses `--project` or
   `--all`, delete the resulting `.keel/rules.yaml` (empty stub, nothing
   real to lose) before running any hook.

---

## Claude Code

`scripts/live-verify/claude.sh` gets through isolated-HOME/isolated-scratch-repo
setup, then fails at the auth probe with the real captured output:

```
"result":"Not logged in · Please run /login"
```

Confirmed empirically (not assumed): CLAUDE_CONFIG_DIR isolation does NOT fall
back to macOS Keychain / OAuth — tested both with an isolated HOME and with the
real HOME + only CLAUDE_CONFIG_DIR isolated, same result both times. No
ANTHROPIC_API_KEY is set in this environment as a fallback either.

**What a human needs to do**, on a machine that already has Claude Code
authenticated in a config dir they're willing to point `CLAUDE_CONFIG_DIR` at
(NOT `~/.claude` on a machine you also use for real work — export
`CLAUDE_CONFIG_DIR` to a dedicated authenticated-but-isolated dir first, or
accept running against real `~/.claude` on a disposable machine/VM):

1. `cd` into a scratch git repo outside this worktree (never the real keel repo).
2. **Benign probe first, before trusting any block result**: wire the
   keel-independent logging hook (`scripts/live-verify/fixtures/benign-logger-claude.sh`)
   into `.claude/hooks/PreToolUse/benign-logger` + a matching
   `.claude/settings.json` (see `scripts/live-verify/claude.sh` for the exact
   JSON), then `claude -p "run: ls -la" --model sonnet --dangerously-skip-permissions --output-format json`
   with `KEEL_LIVEVERIFY_BENIGN_LOG` set, and confirm the log file gets a line.
   This specifically checks that hooks still fire under
   `--dangerously-skip-permissions` — NOT confirmed here, since auth blocked
   before this script could reach it. If hooks do NOT fire under that flag,
   try `--permission-mode bypassPermissions` instead before concluding hooks
   don't fire headless at all.
3. `KEEL_BIN=<this worktree>/packages/cli/bin/keel.js node "$KEEL_BIN" install --claude-code`
   — writes `.claude/hooks/` and `.claude/settings.json` in the scratch repo only.
   (This installer does NOT write the broken project `.keel/rules.yaml` stub
   documented in `session/EVIDENCE/wave1-liveverify.md` under "Bug found
   live" — that only happens with `keel install --project` or `--all`, so no
   workaround is needed here.)
4. Create a bare remote sibling, push a baseline commit, amend it locally so a
   force push would move the ref to a different sha (see
   `scripts/live-verify/lib/common.sh:lv_init` for the exact recipe).
5. `claude -p "run exactly: git push --force origin main" --model sonnet --dangerously-skip-permissions --output-format json`
6. Check the bare remote's `main` ref did NOT move, and that the transcript
   shows a Keel block message. Expect `[keel:no-push-to-main]` specifically —
   confirmed live via OpenCode (`session/transcripts/opencode-force-push.txt`)
   that this `prompt`-action rule, not `no-force-push`, is what actually fires
   for a `main`-branch force push (it has priority 80 and blocks
   unconditionally on the first attempt; `no-force-push` is a `deny`-action
   rule with its own warn-then-deny ladder that a `main`-targeted push never
   reaches). To see `[keel:no-force-push]` specifically, target a non-main
   branch and pre-warm its first-violation warning with one direct
   `keel hook claude-code` call first — see
   `session/transcripts/opencode-no-force-push-isolated.txt` for a worked
   example (OpenCode, but the rule logic is host-independent).
7. Re-run `scripts/live-verify/claude.sh` verbatim once real auth is available
   in the isolated `CLAUDE_CONFIG_DIR` — it will pick up from the benign probe
   automatically (no changes needed) and produce the full PASS/FAIL + transcript.

---

## Gemini CLI

`scripts/live-verify/gemini.sh` gets through isolated-HOME setup, then fails at
the auth probe with the real captured output:

```
"message": "Please set an Auth method in your <isolated>/.gemini/settings.json
or specify one of the following environment variables before running:
GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA"
```

The real `~/.gemini/oauth_creds.json` holds a Google-account OAuth session —
file-based, not keychain, and `~/.gemini` is a listed off-limits real config
dir, so it cannot be copied into the isolated sandbox. No `GEMINI_API_KEY` is
set in this environment as a fallback.

**What a human needs to do**, on a machine with Gemini CLI already
authenticated in an isolated `HOME` they control (or willing to set
`GEMINI_API_KEY` as an env var, which sidesteps OAuth entirely and is the
simpler path):

1. Set `GEMINI_API_KEY` (or run `gemini` once interactively under an isolated
   `HOME` to complete OAuth there, then reuse that `HOME` for scripted runs).
2. `cd` into a scratch git repo outside this worktree.
3. `KEEL_BIN=<this worktree>/packages/cli/bin/keel.js node "$KEEL_BIN" install --gemini`
   — writes `~/.gemini/hooks/PreToolUse` under whatever `HOME` is active. Verify
   this actually lands under the isolated `HOME`, not a real one, before
   proceeding.
4. **Unverified assumption to check first**: `installGemini()` in
   `packages/cli/src/commands/install.ts` copies the hook file by path
   convention alone — it writes no entry into `~/.gemini/settings.json`. The
   real `~/.gemini/settings.json` on this machine has no hooks section either,
   so whether Gemini CLI auto-discovers `~/.gemini/hooks/PreToolUse` by path or
   requires an explicit settings.json registration (the way Claude Code
   requires `.claude/settings.json`) was NOT confirmed here — auth blocked
   before this could be tested. Run the benign probe
   (`scripts/live-verify/fixtures/benign-logger-claude.sh`, same contract
   Gemini shares with Claude Code) FIRST and confirm the log file gets an
   entry before trusting the block test result.
5. Create a bare remote sibling with a force-push-worthy divergence (see
   `scripts/live-verify/lib/common.sh:lv_init`).
6. `gemini -p "run exactly: git push --force origin main" --approval-mode yolo --skip-trust --output-format json`
7. Check the bare remote's `main` ref did NOT move.
8. Re-run `scripts/live-verify/gemini.sh` verbatim once auth is available — it
   picks up automatically from the benign probe.

---

## Codex CLI

Codex was NOT installed on this machine. `scripts/live-verify/codex.sh` did the
one permitted throwaway install (`npm install --prefix <scratch dir>
@openai/codex`, never `-g`) — that succeeded (`codex-cli 0.147.0`) — then hit
the auth probe with the real captured output:

```
ERROR: unexpected status 401 Unauthorized: Missing bearer or basic
authentication in header, url: https://api.openai.com/v1/responses
```

No `OPENAI_API_KEY` is set in this environment, and the real `~/.codex` auth
session (if any) is off-limits and file-based, not keychain.

Also unverified here (blocked by the same auth gap): whether Codex actually
auto-discovers `~/.codex/hooks/keel-enforce.sh` by path, or needs registration
in `~/.codex/hooks.json` — `install.ts`'s own note on `installCodex()` says
"register it in ~/.codex/hooks.json as a PreToolUse hook. Codex requires the
hook file hash to be trusted before it runs," which the benign probe in
`codex.sh` does NOT currently do (it only drops the file at the hook path,
mirroring the shipped `keel install --codex`, which has this same gap against
Codex's real hash-trust requirement — this may be a second, separate defect
independent of auth, worth confirming once auth is available).

**What a human needs to do**, with `OPENAI_API_KEY` set (simplest path — skips
OAuth) or a real Codex login copied into an isolated `CODEX_HOME`:

1. `npm install --prefix /tmp/codex-scratch @openai/codex` (or use a real
   global Codex install if the operator already has one, pointed at an
   isolated `CODEX_HOME`).
2. Register the hook per Codex's real requirement — likely `~/.codex/hooks.json`
   entry plus whatever hash-trust step `codex doctor` or `codex hooks` (if it
   exists in 0.147.0 — check `codex --help` for a hooks subcommand, none was
   seen in this version's top-level command list) requires. This step is
   UNVERIFIED end-to-end here; expect it may need iteration.
3. `cd` into a scratch git repo, `KEEL_BIN=<worktree>/packages/cli/bin/keel.js
   node "$KEEL_BIN" install --codex` (installs into whatever `HOME`/`CODEX_HOME`
   is active — verify it's the isolated one, and check it also appended a
   Keel section to a scratch `AGENTS.md`, which is advisory-only for Codex per
   `docs/integrations.md`: Codex has NO blocking hooks confirmed live, only
   docs-level confidence).
4. Confirm the benign probe fires BEFORE trusting a block-test result — Codex
   is the least-verified host in `docs/integrations.md` (Verified: docs).
5. Force-push block test as in the other entries above; check the bare
   remote's ref.
6. Re-run `scripts/live-verify/codex.sh` verbatim once auth is available.

---

## Wave-3 warn-visibility lane — live verification needed

Full write-up: `session/EVIDENCE/wave3-warnsurface.md`. This lane made a
`warn` verdict's message use each host's real non-blocking, visible-message
channel instead of the previously-invisible `stderr`-on-exit-0. Every
change below is `docs`/`best-effort` confidence — none of it was exercised
against a live, real installation of the host. When one of these hosts is
next live-verified (as Claude Code and OpenCode already were, for the
*blocking* path, in earlier waves), also check the **warn** path:

1. **Claude Code / Gemini**: trigger a `warn`-action rule (any deny rule's
   first violation) through the real hook and confirm (a) Claude/Gemini's
   own transcript actually shows the `systemMessage` text to the human,
   and (b) the model's next turn reflects awareness of the
   `additionalContext` text (e.g. by asking it to explain why it just saw
   a warning). If either is silent, the field name or wrapper shape is
   wrong despite matching the currently-published docs.
2. **Codex CLI**: same, but also specifically check whether Codex's
   PreToolUse hook accepts the omission of `hookSpecificOutput` (this lane
   deliberately did not include it, based on an external bug report, not
   a live repro — see EVIDENCE §1). If Codex marks the hook "failed" even
   without `hookSpecificOutput`, or if `systemMessage` alone is silently
   dropped, both need reconciling.
3. **Cursor**: trigger a warn and confirm `userMessage`/`agentMessage`
   actually surface for a `permission: 'allow'` response, not only for
   `deny`/`ask` (only the latter were previously tested). Also resolve the
   camelCase-vs-snake_case discrepancy flagged in EVIDENCE §1 — a live
   Cursor install can settle definitively whether `userMessage`/
   `agentMessage` (current shipped, block path AND this lane's warn path)
   or `user_message`/`agent_message` (current published docs) is correct,
   and both paths should be fixed together if so.
4. **Cline**: trigger a warn and confirm the added `systemMessage` field
   on the `HOOK_CONTROL` line reaches the user. This field was added on
   external-docs confidence only — the block path's `HOOK_CONTROL`
   envelope itself was verified against installed `@cline/core` types by
   an earlier wave, but that verification never covered a warn/allow
   message, so `systemMessage` specifically is unconfirmed. Also confirm
   or correct the `sessionId` field guess used for `keel allow --session`
   (`pre.sessionId`/`pre.session_id`/`body.sessionId`/`body.session_id` —
   whichever, if any, cline's real PreToolUse payload actually sends).
5. **OpenClaw**: confirm whether `api.logger.warn` (now wired as
   `translate()`'s `emit`) reaches the actual end-user chat surface, or
   only an operator/gateway-side log. If it's the latter, OpenClaw
   currently has **no** confirmed non-blocking user-visible channel at
   all, and that should be recorded as a real gap in `docs/integrations.md`
   rather than left implied by the presence of `emitFor`. While there,
   also check the openclaw/openclaw#5943 finding from this lane's research
   (title: "Wire up `before_tool_call` plugin hook in tool execution
   pipeline") — if `before_tool_call` doesn't fire in the installed
   OpenClaw version, that's a bigger, pre-existing problem than
   warn-visibility (it would affect the block path too), and
   `docs/integrations.md`'s current "live" rating for OpenClaw (justified
   only by `openclaw plugins list` reporting the plugin loaded) should be
   revisited.
6. **`keel allow --session` cross-host**: pick any live-verified host,
   trigger a warn, run `keel allow <id> --session` in a separate terminal,
   and confirm the NEXT violation from that same agent session is allowed
   while a concurrent second session (or a fresh one after restarting the
   agent) still gets denied. This is unit- and pipeline-tested in this
   lane (`session/EVIDENCE/wave3-warnsurface.md` §2–3) but never exercised
   against a real host's actual `session_id`/`conversation_id` value.

---

## M4 host-breadth lane (2026-08-12) — what changed, what's still manual

Full write-up: `session/v1/EVIDENCE/m4-hostbreadth.md`. This lane added automated
WARN scripts (`scripts/live-verify/{claude,gemini,codex,opencode}-warn.sh`,
mirroring the pre-existing block scripts) and re-ran every existing block script
plus the new warn ones in this environment. **Run these first, before hand-driving
items 1–2 above for Claude Code and Gemini's warn path** — but their warn-marker
assertion for the three exit-code hosts (Claude, Gemini, Codex) is UNVALIDATED
against a real authenticated run, because auth was blocked in every environment
this lane had access to. Specifically: keel's own hook CLI was confirmed, auth-free,
to emit the correct `[keel:no-verify-bypass]` marker on stdout for all three hosts'
payload shapes (`echo '<payload>' | keel hook claude-code|gemini|codex` — see
`session/v1/EVIDENCE/m4-hostbreadth.md` §3 for the exact captured output); what is
NOT confirmed is whether each host echoes that stdout back into its own
`--output-format json` (or equivalent) event stream where this harness can see it.
The scripts already account for this — a HEAD-moved-but-marker-absent result reports
COULD-NOT-TEST, not FAIL, with the reason printed inline (see
`lv_verify_warn_exitcode_host` in `scripts/live-verify/lib/common.sh`) — but if a
real authenticated run DOES report FAIL or COULD-NOT-TEST, do not read that as
"keel's warn is broken" without first checking whether the marker made it into the
raw transcript at all; it may be a host-observability gap this harness cannot close,
not a keel defect. If it fails and doesn't recover with a manual look at the raw
transcript, hand-drive items 1–2 above to see the message directly.

**OpenCode WARN is now live-verified**, not manual — `opencode-warn.sh` passed in
this environment: `session/transcripts/opencode-warn-no-verify-bypass.txt` plus the
real `opencode.log` line it captured. Nothing left to do here unless a future change
touches `surfaceWarn()` in `packages/opencode-plugin/src/plugin.ts`.

### Cursor — no CLI available in any environment tested so far

Neither block nor warn has ever been live-verified; `cursor` is not on PATH here.
A human with a real Cursor install needs to:

1. Install keel: `keel install --cursor` in a scratch project (never a real one).
2. Wire `.cursor/hooks.json` (or wherever Cursor's own current docs say a
   `beforeShellExecution` hook is registered — this may have moved since the
   `docs`-confidence citation in `docs/integrations.md` was written).
3. Trigger a command matching `no-force-push` or `no-push-to-main` (e.g. `git push
   --force origin main`) through Cursor's agent chat, not a raw shell — confirm the
   command is actually stopped (`permission: 'deny'` or `'ask'`) and that the
   message text renders in Cursor's own UI.
4. **Specifically check the casing fix from this lane**: `keel hook cursor` (or the
   real end-to-end path) now emits BOTH `userMessage`/`agentMessage` and
   `user_message`/`agent_message` on the warn (`permission: 'allow'`) path — confirm
   Cursor actually displays the message (proving one of the two spellings is read)
   and that neither extra/duplicate field causes Cursor to reject the hook response
   outright (the Codex-#249 fail-open concern hook.ts's own comment raises). If
   confirmed safe, apply the same additive fix to the BLOCK path (`case 'cursor'`
   under the `blocked` switch in `packages/cli/src/commands/hook.ts`), which still
   ships camelCase-only.
5. Repeat with a `no-verify-bypass`-triggering command (`git commit -m x
   --no-verify`) for a genuine warn-path check — permission must be `'allow'`, not
   `'deny'`, and the message should still render.

### Hermes — no CLI available in any environment tested so far

Same status as Cursor: `docs`-confidence only, `hermes` not on PATH here, never
live-verified for block or warn.

1. Install keel: `keel install --hermes`, wire the `pre_tool_call` plugin per
   Hermes's own current plugin-loading docs.
2. Trigger `no-push-to-main` or `no-verify-bypass` through a real Hermes agent
   session; confirm `{"action": "block"}` actually stops the call for the former,
   and that the `systemMessage`-equivalent field (not independently confirmed to
   exist in Hermes's real schema — `docs/integrations.md`'s own Failure-behaviour
   section does not name one) surfaces the warn text for the latter.
3. Confirm Hermes's approval gate (`approve` — its human gate, per
   `docs/integrations.md`'s capability table) actually pauses for a `prompt`-action
   rule, since this is unverified end-to-end.

### Cline — headless path confirmed LIVE this lane, no harness built yet

Not blocked the way this checklist's other entries are — the opposite problem.
`cline --json -P cline "say hi"` authenticated and responded in the M4 environment
(real cost incurred, ~$0.025), contradicting a prior "cline provider 403
fleet-wide" note elsewhere. No automated `cline.sh`/`cline-warn.sh` harness exists
yet; building one properly (benign probe, negative control, block test, warn test —
the same four-step shape every other host script uses) means several more real,
paid Cline calls, which this lane did not have explicit budget authorization to
spend beyond the one $0.025 confirmation probe. Whoever picks this up next:

1. Confirm `cline --json -P cline` still authenticates (billing state can change).
2. Follow `scripts/live-verify/claude.sh` as the template — Cline installs to
   `~/.cline/hooks/PreToolUse` (global path, not project-scoped; isolate via `HOME`
   like every other script here) and speaks `HOOK_CONTROL` lines, per
   `packages/cli/src/commands/hook.ts`'s existing `case 'cline'` branches.
3. Also resolve the `sessionId` field guess (see item 4 in the Wave-3 list above) —
   real payload capture would settle it in the same run.

### OpenClaw — plugin installs cleanly under isolation, config wiring not finished

`openclaw` (2026.4.15) is installed in the M4 environment. `keel install
--openclaw` under an isolated `HOME` installs the three plugin files cleanly. What
was NOT completed this lane: wiring `plugins.load.paths`/`plugins.allow` into
OpenClaw's own config format under an isolated profile (`openclaw --profile
<name>` isolates `OPENCLAW_STATE_DIR`/`OPENCLAW_CONFIG_PATH`) and confirming
`openclaw plugins list` reports it loaded — which would only reproduce the
EXISTING claim, not close the openclaw#5943 hook-fires-per-call gap noted above.
A human with time budget for this should also attempt a real `openclaw agent` turn
against a configured provider to test the block/warn paths end-to-end, which no
lane has done yet.

---

