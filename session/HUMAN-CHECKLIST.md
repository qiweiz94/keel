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

