# keel integrations — what is supported, and how well

One page for "which platforms does keel work with". The **Verified** columns are the
important ones: they say how much each row has actually been proven, rather than
implying that everything listed is equally solid.

**Block and warn are verified separately** (M4 host-breadth lane) — they are different
code paths per host (a block that stops the call vs. an advisory that must reach a
human/model-visible channel WITHOUT stopping anything), and "block is live" was never
evidence that warn is. Before this lane only OpenCode had ever been exercised for warn
against a real running host at all; everything else's warn confidence was inherited
from the block row, which conflated two different claims into one cell.

Verification levels, strongest first:

| Level | Means |
|---|---|
| **live** | keel was loaded and exercised inside the real host on a machine that has it installed |
| **types** | built against the host's installed type definitions or package source, not its docs |
| **docs** | built from published documentation only — the host is not installed here, so the payload shape is unconfirmed |

That distinction is not pedantry. Three times in this project the published docs were
wrong where the installed types were right: OpenClaw's `before_tool_call` event carries
fewer fields than documented, its `requireApproval.timeoutBehavior` is undocumented, and
Cline's real control channel is a `HOOK_CONTROL` line that appears in no doc page.

---

## Native enforcement

Every one of these evaluates a tool call **before it runs** and can stop it.

| Host | Install | Interception point | How it blocks / warns | Block Verified | Warn Verified |
|---|---|---|---|---|---|
| OpenCode | `keel install --opencode` | `tool.execute.before` plugin | throws / `client.app.log({level:'warn'})` | **live** | **live** — M4: `opencode-warn.sh`, marker captured in OpenCode's own `opencode.log` (not the `--format json` stream — confirmed empirically that channel carries no app-log events headlessly); `session/transcripts/opencode-warn-no-verify-bypass.txt` |
| OpenClaw | `keel install --openclaw` | `before_tool_call` plugin | `block: true` / `requireApproval` / `api.logger.warn` | **live**¹ — `openclaw plugins list` reports it loaded | **docs** — `api.logger.warn` wired wave-3; reaching the chat UI vs. only an operator/gateway log is unconfirmed |
| Claude Code | `keel install --claude-code` | `PreToolUse` hook | exit 2 / `hookSpecificOutput.additionalContext` + `systemMessage` | **live**² — `claude -p` child blocked `git push --force origin main`; see `session/transcripts/claude-code-force-push.txt` | **docs** — M4: `claude-warn.sh` exists and is ready; this environment's isolated `CLAUDE_CONFIG_DIR` is AUTH-BLOCKED (see footnote 2), so it correctly early-exits rather than fabricate a pass |
| Cline | `keel install --cline` | `PreToolUse` hook | `HOOK_CONTROL` + `cancel: true` / `systemMessage` | types — read from installed `@cline/core` | docs, best-effort — see footnote 3 |
| Gemini CLI | `keel install --gemini` | `PreToolUse` hook | exit 2 / same envelope as Claude Code | types — Claude-Code-compatible per `gemini hooks migrate --from-claude` | **docs** — M4: `gemini-warn.sh` exists; this environment is AUTH-BLOCKED (no OAuth session, no `GEMINI_API_KEY`), correctly early-exits |
| Cursor | `keel install --cursor` | `beforeShellExecution` / `beforeMCPExecution` | `{permission: deny\|ask}` / `userMessage`+`agentMessage` | **docs, casing bug fixed** — see footnote 4 | **docs, upgraded schema fidelity (M4)** — now sends both `userMessage`/`agentMessage` AND `user_message`/`agent_message` (cursor.com/docs/hooks, live-refetched this lane); still docs-confidence, no Cursor CLI available to confirm which spelling the real host reads |
| Codex CLI | `keel install --codex` | `PreToolUse` hook | exit 2 / `systemMessage` | docs | **docs** — M4: `codex-warn.sh` exists; throwaway-installs cleanly but is real-auth-blocked (401 from `api.openai.com`), correctly early-exits |
| Hermes | `keel install --hermes` | `pre_tool_call` plugin | `{"action": "block"}` | docs | docs — no Hermes CLI available in this environment |

`keel install --all` installs every one of them.

¹ **Not the same claim as "the hook fires per call."** `openclaw plugins list` reporting
the plugin loaded is a load-time check, not a per-call one; `session/EVIDENCE/wave3-warnsurface.md`
§2 already flagged a GitHub issue (openclaw/openclaw#5943, "Wire up `before_tool_call`
plugin hook in tool execution pipeline") suggesting the hook may not fire in some
versions/builds at all. Not re-verified or downgraded this lane — restated here so the
matrix carries the caveat, not just a linked evidence file. `openclaw` (2026.4.15) is
installed in this M4 environment and keel's plugin installs cleanly under an isolated
`HOME`, but wiring it into OpenClaw's own config (`plugins.load.paths`) to reproduce even
the load-time check was not completed this lane — flagged as a follow-up, not attempted
further, in `session/v1/EVIDENCE/m4-hostbreadth.md`.

² **Two different trust boundaries, not one.** The committed block transcript was
captured via a REAL, non-isolated `~/.claude` login (a privileged supervisor session —
see the transcript's own header). Every isolated-`CLAUDE_CONFIG_DIR` attempt in this M4
environment (and, per claude.sh's own comment, in the environment that wrote that
script) returns `"Not logged in"` — isolation itself breaks Claude Code auth on this
machine. That means the "live" block claim and this lane's own automated `claude.sh`/
`claude-warn.sh` scripts rest on different auth paths; re-running the isolated script
here reproduces AUTH-BLOCKED, not a regression. Also noted, not silently fixed: the
script writes to `session/transcripts/claude-force-push.txt`, but the committed evidence
file this row cites is `claude-code-force-push.txt` — a pre-existing filename mismatch,
left as-is rather than guessing which one is "correct" and renaming blind.

³ Cline's warn path (`systemMessage` on a non-cancelling `HOOK_CONTROL` line) is
docs/best-effort, unchanged this lane. Separately, and NOT a verification of keel's
Cline adapter: this lane found empirically that `cline --json -P cline "say hi"`
authenticates and responds in this environment right now (real cost incurred, ~$0.025),
which contradicts a prior "cline provider 403 fleet-wide" note. No automated keel
block/warn harness for Cline was built this lane — doing so properly (benign probe,
negative control, block test, warn test) means several more real, paid calls with no
budget explicitly authorized for this lane. Flagged in
`session/v1/EVIDENCE/m4-hostbreadth.md` as the most promising next-lane target, not
claimed as verified here.

⁴ Cursor's block-path envelope (`permission: deny|ask` + `userMessage`/`agentMessage`)
still ships camelCase-only, a known bug (cursor.com/docs/hooks specifies snake_case).
The warn path got the additive fix this lane (see Warn Verified cell); the block path
was deliberately left untouched — no Cursor CLI is available in this or any prior lane's
environment to confirm a changed envelope is still accepted, and this codebase has its
own precedent (Codex bug #249, `permissionDecision:'allow'` rejection) for an
unrecognized/wrong field making a host mark a hook FAILED, which fails OPEN. Resolving
both paths together, with real Cursor access, is the recommended follow-up — see the
manual checklist below.

### What each host can and cannot do

Capabilities differ, and keel does not pretend otherwise:

| Host | Blocks | Approval gate | Rewrite tool args (`fix` rules) |
|---|---|---|---|
| OpenCode | ✅ | ✅ | ✅ |
| OpenClaw | ✅ | ✅ (fails **closed** on timeout) | ✅ |
| Claude Code / Gemini / Codex | ✅ | ✅ (as a block with the approval path in the message) | ❌ |
| Cline | ✅ | ✅ (as a cancel) | ❌ |
| Cursor | ✅ | ✅ (routes to Cursor's own `ask` UI) | ❌ |
| Hermes | ✅ | ✅ (`approve` — its human gate) | ❌ — `pre_tool_call` cannot modify args, so `fix` rules are advisory there and the installer says so |

---

## Claim-to-evidence: verification obligations, off OpenCode (v1 M2-B1)

`markVerificationSatisfied` (a `type: verification`/`type: claim` obligation —
armed by an edit, discharged by a real passing test run) and `detectClaim` (an
agent's own "done"/"passing" text, checked against that pending obligation)
used to fire only inside OpenCode's long-lived plugin process: every
exit-code host (`keel hook <host>`) is a FRESH short-lived process per call,
and `hookCommand` calls `process.exit()` right after rendering the verdict —
which used to kill any obligation-arming state before a later PostToolUse
call could ever discharge it, because no exit-code host had a PostToolUse-
shaped event wired to anything at all.

**The fix was smaller than it sounds.** `VerificationTracker` already
persists every armed obligation to `KEEL_STATE_DIR/verification.json` under a
file lock (`state-manager.ts`), and `keel hook`'s PreToolUse path already
armed obligations correctly (it calls `pipeline.evaluate()`, which arms
`type: verification`/`type: claim` triggers on every call) — a fresh process
reading that state on its NEXT invocation already saw what an earlier one
armed. The actual gap was one missing call: nothing on the exit-code path
ever invoked `pipeline.markVerificationSatisfied()` (the discharge) because
there was no post-action event class at all. `hook.ts` now recognizes a
`PostToolUse`-shaped payload, and `enforce.ts`'s new `recordPostAction()`
calls the SAME `markVerificationSatisfied`/`recordAttemptOutcome` pair the
opencode plugin's `tool.execute.after` handler already used — no new
discharge logic, no rebuilt claim grammar, no daemon, no new persistence
layer.

**The exit-code honesty gap.** `markVerificationSatisfied` must only fire on
a CONFIRMED passing run — never on "the command ran" alone, which would
discharge on a FAILING test too (the same "control that lies" class
`VerificationTracker.isFakeSatisfy` already guards against on the trigger
side). Claude Code's own published hook docs describe `PostToolUse`'s
`tool_response` as "JSON of the tool output" without pinning an exact
per-tool schema, and this environment's own sandbox refuses to run a nested
`claude` CLI invocation at all (attempted twice — a hard restriction, not an
auth failure), so the real field carrying a Bash exit code could not be
captured live. `postToolUseExitCode()` (`hook.ts`) tries several plausible
field names and returns `null` (unknown → never discharges) rather than
guessing 0 on anything it doesn't recognize.

| Host | Arms (PreToolUse) | Discharges (PostToolUse-equiv.) | Claim channel (Stop-equiv.) | Keel-side mechanism | Host payload shape |
|---|---|---|---|---|---|
| OpenCode | `tool.execute.before` | `tool.execute.after` (pre-existing, unchanged this lane) | `experimental.text.complete` (pre-existing) | verified — `plugin.test.ts`'s "successful/failed test clears/does not clear obligation" cases | **live** (claim-fires case: `session/transcripts/opencode-claim-rule-live-e2e.txt`; the discharge branch itself predates this lane and was not re-run live here) |
| Claude Code | `PreToolUse` (**live**, pre-existing — `session/transcripts/claude-code-force-push.txt`) | `PostToolUse` — NEW this lane (`claude-posttooluse-verify.sh`, a second hook entry alongside `keel-reinject`) | `Stop` (pre-existing, unchanged) | verified — `claude-posttooluse-verify-hook.test.ts`: real built CLI + real shell script, MUST-discharge (confirmed pass) and MUST-NOT-discharge (confirmed fail / unconfirmed outcome / non-matching command) all pass | **docs** — the `tool_response` exit-code field name is UNCONFIRMED (see above); this environment's sandbox blocks a nested `claude` CLI invocation, so no live PostToolUse payload was captured this lane |
| Codex | `PreToolUse` (**docs**, pre-existing — installer already flags "Codex CLI has no blocking hooks" / hook-trust caveats) | `PostToolUse` — NEW this lane (`codex-posttooluse.sh`) | `Stop` — NEW this lane (`codex-stop.sh`; hook.ts's own prior comment had flagged this as "documented but deliberately unwired" — this is that follow-up) | same test suite covers the parse branch (`hook-command.test.ts`) | **docs** — codex CLI is not installed in this environment; nothing beyond the pre-existing "converged on the same hookSpecificOutput-shaped contract" citation |
| Gemini | `PreToolUse` (**types** — `gemini hooks migrate --from-claude` confirmed to exist on this machine) | `PostToolUse` — NEW this lane (`gemini-posttooluse.sh`) | `Stop` — NEW this lane (`gemini-stop.sh`) | same test suite covers the parse branch | **types** for the general Claude-Code-compatibility claim (same basis as PreToolUse); the SPECIFIC PostToolUse/Stop field shape was not live-confirmable — `gemini -p` on this machine returns `IneligibleTierError` (this account's free tier was deprecated in favor of Antigravity), an auth/tier block, not a code defect |
| Cursor | `beforeShellExecution`/`beforeMCPExecution` (**docs**, pre-existing) | **NO CHANNEL CONFIRMED** | **NO CHANNEL CONFIRMED** | not implemented | cursor CLI is not installed here and this repo carries no prior citation for a post-action/stop-shaped Cursor hook event; not fabricated against an unconfirmed schema |
| Cline | `PreToolUse` (**types**, pre-existing — read from installed `@cline/core`) | **NO CHANNEL CONFIRMED** | **NO CHANNEL CONFIRMED** | not implemented | cline CLI is installed here but its post-action/stop hook shape was not investigated this lane (out of time budget, not ruled out) — left honestly unexplored rather than guessed |
| Hermes / OpenClaw | plugin-based (`pre_tool_call`/`before_tool_call`), not exit-code hosts | out of scope — these are long-lived plugin processes with the same obligation-persistence properties OpenCode already has | out of scope | not touched this lane | unchanged |

**Slopsquatting deny-on-retry (same root cause).** `type: package` rule
cache misses fire `scheduleBackgroundVerification` with `void` — never
awaited on the pipeline's hot path, by design (a live registry round trip
cannot sit on the <50ms budget). In a long-lived host that promise settles
on its own and warms the on-disk `PackageVerifierCache` for the next
attempt; `keel hook`'s `process.exit()` used to kill it before it got a
turn, so a hallucinated package name prompted on every single retry instead
of ever converging to a deterministic deny. `enforce.ts`'s
`flushBackgroundWork()` — fed by the pipeline's existing (pre-built,
test-only) `packageVerifierOnBackgroundStart` hook — now awaits every
promise captured during one `keel hook` call, bounded to 2500ms, before
`hookVerdict` returns. Proven in `hook-package-background-flush.test.ts`
(a MUST-catch-the-regression check: the assertion was confirmed to fail
when the `flushBackgroundWork()` call was deliberately removed and the
fetch mock given a real macrotask delay — see that file's own comment on
why an instant mock silently proved nothing on the first attempt).

**Known gap, not fixed here (documented for the next lane):**
`VerificationTracker.markSatisfied` clears an obligation with no generation
check — an edit landing between a test's PreToolUse and its PostToolUse can
be discharged by a run that started before that edit and never actually
covered it. Narrow, pre-existing (not introduced by this lane), real.

---

## Real token/dollar spend (`type: budget`, v1 budget lane)

Keel's hook architecture has no visibility into LLM API token/dollar usage —
that data lives in the model response, which no PreToolUse/PostToolUse-style
hook ever sees. `type: budget` closes that gap a different way: it reads
usage a host has ALREADY written to its own local transcript/session record,
never a network proxy. This is a narrower, per-host claim than most of this
document's tables — do not read parity into it across hosts that were never
tested.

| Host | Data source | Confidence | Mechanism |
|---|---|---|---|
| Claude Code | Per-session JSONL transcript at `body.transcript_path` (the host's own hook payload field) — each `assistant`-type line's `message.usage`/`message.model` | **live** — confirmed against a REAL transcript on the machine this lane was built on: `sessionId` (camelCase) vs. `session_id` (snake_case) cross-reference behavior, the exact alias model strings (`claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5`), and `<synthetic>` all observed directly, not inferred from docs | `packages/core/src/enforce/budget/claude-transcript.ts` (`measureClaudeCodeSpend`), called from `hookVerdict`'s Stop/PostToolUse branches (`hook.ts`) — never from PreToolUse, see the two-phase note below |
| OpenCode | `~/.local/share/opencode/opencode.db`'s `session` table — `cost` (already computed in dollars by OpenCode itself), `tokens_input`/`tokens_output`/`tokens_reasoning`/`tokens_cache_read`/`tokens_cache_write` | **live** — confirmed against a real installed OpenCode's actual database schema on this machine | `packages/core/src/enforce/budget/opencode-db.ts` (`measureOpenCodeSpend`), called from `plugin.ts`'s `tool.execute.after` hook |
| Codex, Gemini, Cursor, Cline, generic | — | **not supported** | No transcript/session-record source was surveyed or confirmed for any of these hosts this lane. `type: budget` rules simply never fire on them — not a silent partial implementation, an explicit absence. A future lane adding one of these should follow this document's own citation-tier discipline (docs vs. types vs. live) rather than assuming parity with Claude Code or OpenCode. |

**Why this had to be two-phase (SAFETY-CRITICAL, not a style choice).**
Claude Code's `Stop` hook is architecturally observe-only — see this
document's "Claim-to-evidence" section above and
`docs/integration-guides/claude-code.md`: it fires after the turn already
completed, so there is no tool call left to deny. A spend MEASUREMENT
happens at `Stop`/`PostToolUse` (where the transcript write for the
just-completed turn has already landed); it persists an over-budget flag to
`~/.keel/state/budget-tracker.json` (`PersistentBudgetStore`); only the
NEXT `PreToolUse` call ever denies, by reading that flag — never by
re-reading the transcript. This is the same "warn on first violation,
persisted state blocks on repeat" shape every other deny rule in this
ruleset already uses (see this document's own tables above), not a new
pattern invented for this rule type. Proven end-to-end through the real
built CLI and shell hook templates in
`packages/cli/src/__tests__/budget-lane-hook.test.ts`.

**Model-string normalization (SAFETY-CRITICAL).** Real `message.model`
values observed live on this machine include short aliases
(`claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5`) that are NOT
official Anthropic model IDs, alongside `<synthetic>` (always all-zero
usage, skipped) and ordinary dated IDs. `measureClaudeCodeSpend`'s pricing
lookup is exact-string-match only — an alias or any other unrecognized
model string still contributes its tokens to the running total (token-only
enforcement never degrades) but forces the WHOLE session's dollar figure to
`null`, never a partial/undercounted total presented as the true one. The
shipped default rule (`session-spend-limit`) ships with `max_tokens` only,
no `max_dollars`, for exactly this reason — see `docs/tiers.md`.

---

## Universal paths — no adapter needed

**MCP server** (`keel serve`) exposes 7 tools — `keel_check`, `keel_audit`,
`keel_requirements`, `keel_research`, `keel_fetch`, `keel_search_cache`,
`keel_hypothesis`. Any MCP-capable client can use keel with no keel-specific code:
Windsurf, Zed, Continue, JetBrains AI, and others. This is advisory rather than
blocking — the agent chooses to call it — but it needs no integration work.

**Daemon REST** (`keel daemon`) serves `/v1/check`, `/v1/requirements`, `/v1/health`,
`/v1/research`, `/v1/research/cache`, `/v1/hypothesis`, `/v1/outcome` on
`127.0.0.1:31990` with a bearer token from `~/.keel/daemon-token`. Anything that can
make an HTTP request can enforce through it, in any language.

**`keel hook generic`** — the contract for a host with no bespoke adapter:

```
stdin  : {"tool": "bash", "args": {"command": "rm -rf /"}}
stdout : an advisory message, on a non-blocking warn (exit 0)
stderr : the block reason, if blocked
exit   : 0 = allow, 2 = blocked
```

That is how Goose, Roo, Kilo, Amp, n8n or a homegrown wrapper integrate today. Adding a
*named* host on top of it is an entry in `HOSTS` (`packages/cli/src/commands/hook.ts`)
plus a branch in `parsePayload`/`renderVerdict` and a test — not a new script.

---

## No interception point exists

Stated plainly rather than left as a gap for the reader to fill in optimistically:

| Host | Why | Best available |
|---|---|---|
| Aider | no plugin or hook API; only a blanket `--yes` confirm toggle | MCP, or wrap the shell it calls |
| GitHub Copilot cloud agent | governance is a network-egress allowlist, not a per-tool-call gate, and it does not cover MCP servers | MCP allowlisting, egress proxy |
| MCP protocol itself | the spec is explicit that consent is a host responsibility, not a protocol guarantee; the interceptor proposal (SEP-1763) is an unsponsored draft | rely on the host's own hook |

---

## Failure behaviour

Two things every adapter gets right, because getting them wrong is how guardrails end up
uninstalled or silently absent:

**Blocking verdicts all block.** `deny`, `block`, `prompt`, `redirect` and `research`
each stop the call. `prompt` used to exit 0 from `keel evaluate`, which made every
approval gate a no-op in every shell-hook host — destructive SQL, protected-branch
pushes, remote execution, history rewrites and publishing all passed through.

**Advisory verdicts never block, but are never silent either.** keel's ladder is
warn-once-then-block, so the first violation of every deny rule arrives as `warn`.
Swallowing it would mean you see nothing, then a hard block on the repeat, with no
warning in between. This is not just an audit-log entry: `stderr` on `exit 0` is
provably invisible on Claude Code (its own hook docs confirm it goes to a debug log
only), so each host's `warn` uses that host's real non-blocking, human/model-visible
channel instead — Claude Code/Gemini's `hookSpecificOutput.additionalContext` +
`systemMessage`, Codex's `systemMessage`, Cursor's `userMessage`/`agentMessage`,
Cline's `systemMessage`, OpenClaw's `api.logger.warn`. See
`session/EVIDENCE/wave3-warnsurface.md` for the full per-host matrix and confidence
levels (several of these are `docs`-confidence best-effort additions, not yet
live-verified — HUMAN-CHECKLIST.md carries the follow-up).

**`keel allow <id> --session`** scopes an override to the exact agent session that
triggered it (resolved from the most recent session_id in the audit trail), rather
than every session for the next 24h. It never leaks to a different session_id, even
a concurrent one — see the same evidence file for the lifecycle.

**Hermes and OpenClaw fail open by design** — a plugin that throws is skipped and the
call proceeds. Since a thin client cannot bundle the rule engine, both keel plugins
carry a local circuit breaker: if the daemon is unreachable they block only catastrophic
irreversible operations (`rm -rf /`, force-push to a protected branch, `DROP TABLE`,
fork bombs, `mkfs`, raw block-device writes), allow ordinary work, and print a loud
DEGRADED notice. Blocking everything when the daemon is down is what gets a plugin
uninstalled; blocking nothing is what makes it a lie.
