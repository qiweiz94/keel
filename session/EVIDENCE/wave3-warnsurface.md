# Wave-3 Lane 2 — in-session warn rendering + session allowlist

Scope: (1) make a `warn` verdict actually visible to a human/model on every
host, not just written to the audit log; (2) `keel allow <id> --session` —
scope an override to the current agent session, without leaking to another.

Worktree: `keel-w3-warnsurface`, branch `w3-warnsurface`.

---

## 1. Warn-visibility audit — before/after matrix

The premise (confirmed empirically, not assumed): `docs/integrations.md`
already claimed "Advisory verdicts never block, but are never silent
either." That was true for the *audit log* and for hosts with a real
stdout-JSON message channel (Cursor's `userMessage`, Cline's
`HOOK_CONTROL`), but for every **exit-code host** (Claude Code, Gemini,
Codex) the pre-existing code wrote the advisory text to **stderr on exit
0** — and Claude Code's own current hook docs
(`code.claude.com/docs/en/hooks`, fetched 2026-08-11) are explicit that
stderr on exit 0 "goes to the debug log only, never shown to Claude or in
transcript." An allow-with-warning nobody sees is functionally identical
to no warning at all — this is exactly the invisible-warn class the lane
brief described.

| Host | Before this lane | Confirmed real channel | After this lane | Confidence |
|---|---|---|---|---|
| Claude Code | `stderr`, exit 0 (confirmed invisible) | `hookSpecificOutput.additionalContext` (model) + `systemMessage` (user, transcript-only) — `permissionDecision` deliberately NOT set to `'allow'` (see correction below) | Both message fields set on stdout JSON, no `permissionDecision` | **types→docs-confirmed** (schema fetched live from current published docs; block path stays "live"-verified, warn path unchanged confidence: not re-verified live) |
| Gemini CLI | `stderr`, exit 0 | Same envelope, inherited from the pre-existing "Claude-Code-shaped" equivalence claim (`gemini hooks migrate --from-claude`) | Same JSON envelope as Claude Code | **types** (unchanged — this lane did not independently verify Gemini) |
| Codex CLI | `stderr`, exit 0 | `systemMessage` (docs: "PreToolUse and PermissionRequest support systemMessage"). Deliberately **omits** `hookSpecificOutput.permissionDecision:'allow'` — an external bug report (github.com/safishamsi/graphify issue #249, "codex-cli 0.120.0 hook failed: unsupported permissionDecision:allow") suggests some Codex CLI versions reject that field outright. Exit 0 with no decision already means "proceed," so nothing is lost by omitting it. | `{systemMessage}` only, no `hookSpecificOutput` | **docs** (unchanged) — human should live-verify per HUMAN-CHECKLIST |
| Cursor | `stderr`, exit 0 (the `stdout` allow JSON carried no message at all) | `beforeShellExecution` response: `permission` + `userMessage` (user) + `agentMessage` (agent) for ANY permission value, not just deny/ask (`cursor.com/docs/hooks`) | `userMessage`/`agentMessage` added to the existing `{permission:'allow'}` stdout JSON | **docs** — see casing note below |
| Cline | `stderr`, exit 0 | External docs describe a `systemMessage` field on Cline's hook response as user-visible, separate from `cancel`/`errorMessage` | Added `systemMessage` to a `HOOK_CONTROL` line with `cancel:false` | **docs, best-effort** — NOT re-verified against installed `@cline/core` types (that verification, done for the block path, predates this lane and did not cover a warn message) |
| Generic | `stderr`, exit 0 | None documented (`docs/integrations.md`'s own contract: "stdout: the block reason, IF BLOCKED") | Advisory text printed to stdout as plain text | Explicitly **unconfirmed / best-effort** — a wrapper that ignores stdout on allow is no worse off |
| OpenCode plugin | `client.app.log({level:'warn', ...})` in the before-hook | Same — already user-visible in the OpenCode UI stream, not just a trace file | **No change** — already correct | live (pre-existing) |
| OpenClaw plugin | `console.warn(label)` — a plugin's own stdout/stderr, not confirmed to reach the end user's chat surface | `api.logger.warn` (OpenClaw plugin SDK docs list `api.logger.{debug,info,warn,error}`) | `translate()`'s `emit` callback now wired to `api.logger.warn` via a new `emitFor(api)` helper, falling back to `console.warn` when absent | **docs, upgrade over previous** — whether `logger.warn` itself reaches the chat UI vs. only an operator/gateway log is **not confirmed here**; flagged to HUMAN-CHECKLIST |

### Honest gaps carried forward, not silently fixed

1. **Cursor field-casing discrepancy.** The file's pre-existing, already-
   tested block-path envelope (`renderVerdict`'s `case 'cursor'` for
   blocked verdicts) uses camelCase `userMessage`/`agentMessage`, and this
   lane matched that convention for the new warn-path addition for
   internal consistency. A live fetch of `cursor.com/docs/hooks` during
   this lane's research returned **snake_case** (`user_message`,
   `agent_message`) for the same fields. This lane did **not** change the
   already-shipped, already-tested block path — that risks breaking
   Wave-2-verified behavior on a documentation reading this lane cannot
   itself live-verify. Both paths should be resolved together by whoever
   next gets live Cursor access. Recorded in HUMAN-CHECKLIST.
2. **`before_tool_call` wiring in OpenClaw itself.** Research surfaced a
   GitHub issue (openclaw/openclaw#5943, title: "Wire up `before_tool_call`
   plugin hook in tool execution pipeline") suggesting the hook may not
   fire in some OpenClaw versions/builds at all. This is orthogonal to
   warn-visibility specifically (it would affect blocking too) and is
   **not** something this lane could verify or fix — flagged for whoever
   owns OpenClaw's "live" verification claim in `docs/integrations.md`
   (currently justified only by `openclaw plugins list` reporting the
   plugin loaded, which is not the same as the hook firing per call).
3. **Codex's `permissionDecision:'allow'` rejection report is a single,
   version-specific external issue**, not something reproduced here (no
   Codex install available in this environment, matching the pre-existing
   "docs"-only confidence in `docs/integrations.md`). The `systemMessage`-
   only design is the conservative reading of that evidence, not proof the
   fuller envelope is actually broken.
4. **Cline's session field for `keel allow --session`** (see §2) is an
   unverified best-effort guess at the field name, not derived from
   installed types the way the block-path shape was.

None of these are claimed as fixed; all are `docs`/`best-effort`
confidence, distinguishable in the table above from the pieces this lane
could actually confirm against a live-fetched, currently-published schema.

### A regression caught and fixed before commit: `permissionDecision:'allow'`

The first draft of the Claude Code/Gemini branch set
`hookSpecificOutput.permissionDecision: 'allow'` explicitly, reasoning that
it would avoid Claude Code's own permission system deciding to `ask` in
the absence of any decision. On review this was identified as a real
safety regression, not a neutral choice: `permissionDecision: 'allow'`
does not mean "keel is not blocking this" — it means "skip Claude Code's
own permission flow entirely." A `warn` verdict is the *first violation of
a deny rule*, not a decision that the call is fine. Before this lane, a
first `git commit --no-verify` exited 0 with (invisible) stderr, and
Claude Code's own permission system still asked the human before running
it. Sending `permissionDecision: 'allow'` would have turned "invisible
warning, human still asked" into "visible warning, auto-approved" —
strengthening visibility while weakening the actual guard, on exactly the
path this lane exists to strengthen.

Fixed by omitting `permissionDecision` entirely (Claude Code's docs list
`'defer'` as a distinct value meaning "defer to normal permission flow",
which only makes sense if `'allow'` bypasses that flow — omitting the
field is the more conservative reading and keeps it optional). The
`hookSpecificOutput` wrapper itself stays present so `additionalContext`/
`systemMessage` are not silently dropped (per
`anthropics/claude-code#40380`, "systemMessage silently dropped without
hookSpecificOutput" — a report this lane's own research surfaced but had
not cross-checked against its first draft). Pinned with a test asserting
`hookSpecificOutput.permissionDecision` is `undefined` for a warn verdict
on both claude-code and gemini.

---

## 2. `keel allow <id> --session`

### Design

- `RuleOverride` gains `mode: 'session'` and `session_id`
  (`packages/core/src/enforce/overrides.ts`). `FileRuleOverrideStore.consume(ruleId, sessionId?)`
  now takes an optional caller `sessionId`:
  - `once` — unchanged: single use, deleted on first match.
  - `window` — unchanged: allowed until `expires_at`, every use audited.
  - `session` — allowed until `expires_at`, **only** when `sessionId === override.session_id`.
    A mismatched or absent `sessionId` returns `false` and does **not**
    delete or otherwise disturb the entry — the owning session can still
    use it on a later call. `peek()`/`list()` unchanged (non-destructive).
- `pipeline.ts`'s three `overrideStore.consume(...)` call sites now pass
  `input.session_id` (all three already had `input: EnforceInput` in
  scope). A new `overrideMessage(ruleId)` helper reports "Session
  override consumed" / "Standing override consumed" / "One-time override
  consumed" correctly instead of the old, now-inaccurate hardcoded
  "One-time override consumed" for every mode — wrapped in try/catch since
  several existing hand-rolled test doubles for `overrideStore` in
  `pipeline.test.ts` implement only `consume`, not the full
  `RuleOverrideStore` interface (vitest does not type-check, so this only
  surfaces at runtime — confirmed by running the suite before adding the
  try/catch, which failed 3 tests with `peek is not a function`).
- **Session identity**: `EnforceInput.session_id` is the vehicle. For the
  CLI-subprocess hosts (`keel hook <host>`), each invocation is a **fresh
  process** — `initEnforce()` in `enforce.ts` generates a new random
  `session_id` every single call, discarding any host-supplied one. This
  lane wires the host's REAL session id through instead:
  - `evaluateToolCall()` (`packages/cli/src/commands/enforce.ts`) gained
    an `extra.sessionId` override, used in place of the per-process
    generated id when present (for both the pipeline input and the audit
    record — previously the audit record used the generated id
    unconditionally, which would have made `resolveCurrentSessionId()`
    below unable to see a host's real session at all).
  - `hook.ts`'s `parsePayload()` now extracts a `sessionId` per host,
    confidence varies:
    - `claude-code`/`codex`/`gemini`: `body.session_id` — confirmed on
      Claude Code's current published stdin schema and, per the "Codex
      converged on the same hookSpecificOutput contract" research finding,
      Codex's too.
    - `cursor`: `body.conversation_id` — confirmed on Cursor's current
      published base hook schema ("all hooks receive `conversation_id`").
    - `cline`: best-effort (`pre.sessionId`/`pre.session_id`/
      `body.sessionId`/`body.session_id`), **not** verified against
      installed `@cline/core` types — genuinely unknown field name.
      Documented, not guessed further.
    - `generic`: `body.session_id`, optional additive extension to the
      documented contract — a generic wrapper that supplies one benefits;
      one that doesn't loses nothing.
    - Absence is the honest failure mode everywhere: a call with no
      resolvable session id simply cannot participate in `--session` — it
      falls back to the per-process random id (matching prior behavior
      exactly), which can never collide with a real grant.
- `keel allow <id> --session` (`allow.ts`) resolves "the current session"
  as **the most recent `session_id` in the audit trail**
  (`AuditLog().loadAll()`, sorted by ISO timestamp). This CLI command runs
  in the user's own terminal, never inside the agent's process, so there
  is no live call to read a session id off directly — the most recent
  session that actually triggered enforcement activity is the practical
  proxy for "the session I'm looking at right now." No activity yet →
  refuses with an explicit error (does not fabricate a session to scope
  to). `--once`/`--session` are mutually exclusive (explicit error, not a
  silent pick). TTL: 24h ceiling (same as the default "window" form),
  since a session that never revisits keel would otherwise sit in
  `overrides.json` forever — but the REAL boundary is the exact
  `session_id` match: once that agent session ends, no future call will
  ever carry that id again (each host session mints a fresh one), so in
  practice the grant becomes unreachable long before the 24h ceiling in
  the overwhelming majority of cases.
- **Reader/writer split closed**: `allow.ts` previously wrote
  `~/.keel/overrides.json` from a **module-level constant** computed once
  at import time from `homedir()` — never honoring `KEEL_OVERRIDES_DIR`,
  which `FileRuleOverrideStore` (the pipeline's default reader) already
  did. This is the exact "module-level env const misses runtime overrides"
  class this repo already hit and fixed for `KEEL_TRACES_DIR`/
  `KEEL_OVERRIDES_DIR`'s *other* construction site (see `overrides.ts`'s
  own pre-existing comment, now updated). It was flagged as a known,
  deliberate gap by an earlier wave ("`keel allow` ... always writes
  ~/.keel/overrides.json unchanged this wave"). Fixed here as a
  prerequisite for testing this lane's own feature in isolation — `allow.ts`
  now reads `KEEL_OVERRIDES_DIR` **per call**, matching
  `FileRuleOverrideStore` exactly, so an isolated/test environment's
  `keel allow` and its enforcement pipeline now agree on which file they
  mean.
- `keel-control-gate`'s existing pattern
  (`keel (disable|allow|level|enforce|install|uninstall)( |$)`) matches on
  the subcommand, not its flags, so `keel allow <id> --session` is already
  blocked for agents with no rule change needed — verified with a
  regression test against the actual shipped pattern
  (`allow.test.ts`, last case).

### Lifecycle, defined and tested

- **Grant**: `keel allow <id> --session` → resolves current session_id →
  writes `{mode:'session', session_id, expires_at: now+24h}`.
- **Use**: every `pipeline.evaluate()` call carrying that exact
  `session_id` for that rule is allowed — repeatedly, not spent (tested:
  3 consecutive matching calls all return `allow`).
- **Non-leak**: a call carrying a *different* (or absent) `session_id`
  gets the rule's normal enforcement — tested at both the store level
  (`overrides.test.ts`) and the full pipeline level with a real
  `FileRuleOverrideStore` (`pipeline.test.ts`, "threads the caller
  session_id through to a real overrideStore"), and specifically tested
  that a mismatch does **not** damage the entry (owner can still use it
  right after).
- **Expiry**: past `expires_at`, `consume()` returns `false` for anyone
  (owner included) and the on-disk entry is deleted on the next lookup by
  *any* caller — tested explicitly, including the "cleared by an unrelated
  session's lookup" case, matching the pre-existing lazy-cleanup pattern
  `once`/`window` already used.
- **`--once` unchanged**: still a single 5-minute-window single-use grant,
  regression-tested.

### Two follow-ups from review, also fixed before commit

1. **Auto-resolution picks the wrong session when two are running in
   parallel.** `resolveCurrentSessionId()` takes the globally most-recent
   audit entry — with two live agent sessions, `keel allow X --session`
   can silently scope to whichever one happened to act last, not the one
   the human is actually looking at. The resolved id is printed, which is
   a partial mitigation, but `--session` is now an optional-value flag
   (`--session [session-id]`, commander's optional-argument form): a human
   who can see the real session_id (e.g. printed by a warn's
   `additionalContext`, or in a transcript) can pin it explicitly —
   `keel allow <id> --session <exact-id>` — which skips
   `resolveCurrentSessionId()` entirely. Bare `--session` keeps the
   auto-resolve behavior unchanged.
2. **A grant that can never match still reports success.** For a host that
   supplies no session_id (cline today, best-effort per §1; the env-var
   fallback path), `enforce.ts`'s `initEnforce()` mints a fresh per-process
   random id shaped `ses_<base36-timestamp>_<6 base36 chars>` every single
   subprocess call — so the audit trail's "most recent session_id" is
   already dead on arrival by the time a human runs `keel allow --session`
   in a separate terminal; the next call from that same host mints a
   different one. `allowCommand` now recognizes that exact shape
   (`PER_PROCESS_FALLBACK_SESSION_ID` in `allow.ts`) and prints an explicit
   warning alongside the success message rather than silently reporting a
   grant that will never actually be used. It does not fail the command —
   the write itself succeeded and is harmless — it just stops pretending
   the grant will do anything. Not shown for an explicitly pinned
   `--session <id>` (the human supplied it on purpose).

---

## 3. Test results

Full monorepo, `npm run build` then `npm test` (all workspaces), run from
this worktree, nothing piped through grep/head/tail:

- `@get-keel/core`: **443 passed, 2 skipped** (445 total). New coverage:
  `overrides.test.ts`'s `session-scoped overrides` describe block, plus a
  full-pipeline session-override test in `pipeline.test.ts`.
- `@get-keel/cli`: **1030 passed, 16 skipped** (1046 total). New coverage:
  `allow.test.ts` (new file — `--session`, `--session <id>` explicit pin,
  the fallback-shape warning, mutual exclusivity, `--once`/window
  regression checks), `hook-command.test.ts` additions (session_id
  extraction per host, warn-visibility per host, and the
  `permissionDecision` guard described in §1 above), and
  `openclaw-adapter.test.ts` additions for `emitFor`.
  This is the FINAL count, taken after the `permissionDecision` fix in §1
  and the two follow-ups in §2 — earlier numbers seen mid-lane are stale.
- `@get-keel/mcp-server`: no test files (unchanged, `--passWithNoTests`).
- `@get-keel/opencode-plugin`: **57/57** checks pass via its own
  `scripts/load-test.js` harness, including `dist matches canonical
  template` (confirms `templates/keel-enforce.js` was regenerated by the
  build, not hand-edited — this lane never touched that file directly,
  per the binding constraint).

No pre-existing test was weakened or deleted to make this pass. The 16 CLI
skips and 2 core skips are the same pre-existing skip counts as the
Wave-2-gate baseline (`session/DECISIONS.md`: "core 436/2skip, cli
997/16skip").

**One transient flake observed and root-caused, not code-caused**: a
single full-suite run mid-lane showed two failures unrelated to any file
this lane touched (`public-v1.test.ts` "inherits the configured
protection level," `level-reload.test.ts` "sprint auto-expiry" — both
"expected deny, got warn" on a second call, i.e. timing/escalation-
sensitive assertions). Both passed cleanly in isolation immediately after,
and a `ps aux` check found the actual cause: an early-lane research
command (a full-filesystem `find`/`bfs` scan for `@cline/core`, launched
while investigating Cline's real hook schema, see §1) had been left
running in the background this entire session, competing for CPU/disk
during that one parallel full-suite run. Killed, then three consecutive
full `npm test` runs all passed clean (`1030 passed | 16 skipped`,
`58/58` files, matching every other run in this evidence file). Recorded
per this repo's own "profile before blaming a subprocess" / "verify
through the scheduled path" discipline rather than silently re-running
until green.

---

## 4. Files touched

- `packages/core/src/enforce/overrides.ts` — `session` mode, `consume(ruleId, sessionId?)`.
- `packages/core/src/enforce/pipeline.ts` — thread `input.session_id`, `overrideMessage()`.
- `packages/cli/src/commands/enforce.ts` — `extra.sessionId` override for `evaluateToolCall`.
- `packages/cli/src/commands/hook.ts` — `ParsedCall.sessionId`, per-host `parsePayload` extraction, per-host warn-visibility rendering.
- `packages/cli/src/commands/allow.ts` — `--session` flag, `resolveCurrentSessionId()`, `KEEL_OVERRIDES_DIR`-honoring per-call paths.
- `packages/cli/src/index.ts` — `--session` CLI flag registration.
- `packages/cli/templates/openclaw/index.mjs` — `emitFor(api)`, wired into `register()`.
- `packages/cli/templates/keel-enforce.js` — regenerated by `npm run build` (opencode-plugin bundle), not hand-edited.
- New/extended tests: `packages/core/src/enforce/__tests__/overrides.test.ts`,
  `packages/core/src/enforce/__tests__/pipeline.test.ts`,
  `packages/cli/src/__tests__/hook-command.test.ts`,
  `packages/cli/src/__tests__/openclaw-adapter.test.ts`,
  `packages/cli/src/__tests__/allow.test.ts` (new file).

`packages/cli/src/core/` and `packages/cli/templates/keel-enforce.js` were
never hand-edited — only regenerated by `npm run build`, per the binding
constraint.
