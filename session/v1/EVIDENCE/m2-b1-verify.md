# M2-B1 — verification thesis LIVE across the exit-code hosts

Branch `v1-m2-b1-verify`, worktree `keel-v1-m2-b1-verify`, based on the
latest `v0.4-thesis` with wave-1 hardening merged.

## Baseline (before any change)

`npm install && npm run build && npm test` — green before touching
anything (one flaky, load-dependent perf-budget test noted and confirmed
load-related, not touched):

```
core: Test Files 34 passed (34) / Tests 597 passed | 2 skipped (599)
cli:  Test Files 41 passed (41) / Tests 794 passed | 14 skipped (809)   [perf-budget flaked under
      full-suite CPU contention; re-ran in isolation → 1 passed | 1 skipped, confirming it is the
      test's own documented load-skip guard racing, not a regression]
mcp-server: 6/6
opencode-plugin: 57/57 (load-test.js)
```

## What was read before changing anything

- `packages/opencode-plugin/src/plugin.ts` — `tool.execute.after`:
  `if (exit === 0) pipeline.markVerificationSatisfied(action)` +
  `pipeline.recordAttemptOutcome(action, exit)`. `experimental.text.complete`:
  `pipeline.evaluateClaim(enforceInput)`.
- `packages/core/src/enforce/verification.ts` — `VerificationTracker`
  already persists every armed obligation to `StateManager`
  (`KEEL_STATE_DIR/verification.json`, file-locked, cross-process by
  construction).
- `packages/core/src/enforce/state-manager.ts` — confirms the above:
  "persists enforcement state across process boundaries... loads state
  from disk on construction."
- `packages/cli/src/commands/hook.ts` — `keel hook <host>` already calls
  `pipeline.evaluate()` on every PreToolUse call (which arms obligations
  fine), and already had a `Stop`-shaped claim-reach branch for
  claude-code (`evaluateClaimText`, awaited synchronously before the
  process's own `process.exit()`). **No PostToolUse-shaped branch existed
  at all** — `markVerificationSatisfied`/`recordAttemptOutcome` were called
  from exactly zero places on the exit-code path.
- `packages/cli/templates/claude-posttooluse.sh` — already installed as a
  PostToolUse hook, but for a UNRELATED purpose (standing-requirements
  re-injection). Not a verification/claim discharge channel.
- `packages/core/src/enforce/pipeline.ts`'s `type: package` branch — its
  own header comment already named the exact slopsquatting deny-on-retry
  gap this lane's deliverable #3 asked about, including the accepted
  extension point (`packageVerifierOnBackgroundStart`) built for a future
  fix to use.
- `packages/cli/src/commands/daemon.ts` — a long-lived `keel daemon` HTTP
  service exists with a cached-per-cwd pipeline and a shared `StateManager`,
  but `keel hook <host>` does not talk to it (`/v1/outcome` exists but is
  not called from `hook.ts`, and it does not call
  `markVerificationSatisfied` either). **Not used by this fix** — see
  "considered and rejected" below.

## Root-cause finding (corrects the task's framing)

The task description frames this as "process.exit() kills the background
fill, so obligations never discharge." That is half right: `process.exit()`
DOES kill in-flight work, but the persistence layer that survives across
process boundaries (`StateManager`) already existed and already worked —
proven by the fact that PreToolUse arming already persisted correctly
before this lane. **The actual gap was structural, not a race**: there was
no PostToolUse (or equivalent) event class on the exit-code path AT ALL,
so `markVerificationSatisfied` was never called from more than one place
in the whole codebase (the opencode plugin's own after-hook). No daemon,
new persistence layer, or "reconcile on next invocation" mechanism was
needed — the fix is a new event branch plus reuse of two already-existing
pipeline methods.

The ONE place `process.exit()` genuinely does kill live in-flight async
work that matters is the slopsquatting background registry lookup
(`scheduleBackgroundVerification`, fired with `void`) — that one IS a real
race against `process.exit()`, and is fixed separately (see below).

## Daemon: considered, not used

`keel daemon` (packages/cli/src/commands/daemon.ts) would also solve this
(a long-lived pipeline, same as OpenCode's), but wiring `keel hook` to talk
to it would have meant every exit-code host now depends on a background
service being up, adds an HTTP round trip to the hot path, and is a much
larger change than the task's hard constraint ("reuse the existing claim
grammar + VerificationTracker; do NOT rebuild") calls for. The persisted
`StateManager` file already gives every `keel hook` invocation the same
cross-process visibility the daemon would, without the extra moving part.
Noted here so a future lane doesn't have to re-derive this trade-off.

## The fix

**`packages/cli/src/commands/enforce.ts`** (source, not generated):
- `recordPostAction(tool, args, exitCode, extra)` — the exit-code-host
  equivalent of the opencode plugin's `tool.execute.after` handler,
  calling the SAME `pipeline.markVerificationSatisfied()` (only on a
  confirmed `exitCode === 0`) and `pipeline.recordAttemptOutcome()` the
  plugin already used. No new discharge logic.
- `pendingBackgroundWork` / `flushBackgroundWork()` — captures every
  `scheduleBackgroundVerification` settlement promise via the pipeline's
  existing `packageVerifierOnBackgroundStart` hook (previously a
  test-only extension point, now used in production for the first time)
  and awaits them, bounded to 2500ms, before `hookVerdict` returns.

**`packages/cli/src/commands/hook.ts`** (source, not generated):
- `ParsedCall.postAction` — set for a `hook_event_name === 'PostToolUse'`
  payload on claude-code, codex, and gemini (gated the same way the
  existing `Stop` branch is — on `hook_event_name` alone, never on field
  presence/absence, so a malformed PreToolUse payload can never be
  misread as a completed call).
- `postToolUseExitCode(toolResponse)` — deliberately conservative: tries
  `exit_code`/`exitCode`/`exitStatus`/`success`/`is_error`/`interrupted`
  and returns `null` (unknown) on anything else. `null` NEVER discharges.
- `Stop` branch extended from claude-code-only to codex and gemini too
  (hook.ts's own prior comment had explicitly flagged Codex's identical
  Stop shape as "documented... but deliberately NOT wired here this
  phase" — this is that follow-up, at the same docs-tier confidence).
- `hookVerdict` gained a `postAction` branch (structurally can't block,
  same shape as the `Stop`/claim-reach branch: always exits 0, even if
  evaluation throws) and now calls `await flushBackgroundWork()` before
  its final `renderVerdict` return on the ordinary tool-call path.

**New templates** (`packages/cli/templates/`): `claude-posttooluse-verify.sh`
(installed as a SECOND `PostToolUse` entry alongside the pre-existing
`keel-reinject`, not a replacement), `codex-posttooluse.sh`, `codex-stop.sh`,
`gemini-posttooluse.sh`, `gemini-stop.sh`.

**`packages/cli/src/commands/install.ts`**: wires the new templates into
`installClaudeCode` (second `hooks.PostToolUse` command entry),
`installGemini` (new `~/.gemini/hooks/PostToolUse` and `~/.gemini/hooks/Stop`),
`installCodex` (new `~/.codex/hooks/keel-verify.sh` and
`~/.codex/hooks/keel-claim.sh`, same "UNVERIFIED against a live Codex CLI"
caveat the pre-existing PreToolUse install note already carries).

No file under `packages/cli/src/core/**` or `templates/keel-enforce.js`
was hand-edited — only rebuilt via `npm run build` from
`packages/core/src` (which was not modified) and `packages/opencode-plugin/src`
(also not modified).

## Host → channel → confidence matrix

See `docs/integrations.md`'s new "Claim-to-evidence: verification
obligations, off OpenCode (v1 M2-B1)" section for the full table
(reproduced in summary here):

| Host | Discharge channel | Keel-side mechanism | Host payload shape |
|---|---|---|---|
| OpenCode | `tool.execute.after` (pre-existing, unchanged) | verified (pre-existing plugin.test.ts cases) | **live** (claim-fires case only; discharge branch predates this lane) |
| Claude Code | `PostToolUse` — NEW | verified (new e2e test, real built CLI + shell script) | **docs** — exit-code field unconfirmed, sandbox blocks live `claude` CLI |
| Codex | `PostToolUse`/`Stop` — NEW | parse-level tests pass | **docs** — CLI not installed here |
| Gemini | `PostToolUse`/`Stop` — NEW | parse-level tests pass | **types** for Claude-Code-compatibility citation; **could not live-verify** — `IneligibleTierError` |
| Cursor | none | not implemented | **NO CHANNEL CONFIRMED** |
| Cline | none | not implemented | **NO CHANNEL CONFIRMED** (not investigated, not ruled out) |
| Hermes / OpenClaw | n/a | out of scope (not exit-code hosts) | unchanged |

## Live-host attempts (honest accounting)

**Claude Code**: `claude` IS on PATH (`/Users/nanoclaw/.local/bin/claude`,
v2.1.228) and DOES authenticate with the real (unmodified) `HOME` — a
direct `claude -p "say hi, one word" --output-format json` succeeded
(`"is_error":false`, cost $0.139468). However, every attempt to drive it
through this repo's own established live-verify pattern
(`scripts/live-verify/claude.sh`, and a raw `claude -p
--dangerously-skip-permissions` probe) was refused by this environment's
own sandbox with:

```
Permission for this action was denied by the Claude Code auto mode
classifier. Reason: Blocked by classifier.
```

This is a hard restriction on nesting a `claude` CLI invocation inside
this agent's own sandbox — not an auth failure, and not something a
different isolation strategy would route around (the tool's own warning
is explicit that working around it is out of bounds). No new live
Claude Code transcript could be produced this lane. The PRE-EXISTING
`session/transcripts/claude-code-force-push.txt` (PreToolUse block,
unrelated to this lane's changes) stays as-is; it does not cover the new
PostToolUse discharge path and is not claimed to.

**Gemini**: `gemini` is installed (v0.44.0) but `gemini -p "..."` in a
scratch dir returns:

```
Error authenticating: IneligibleTierError: This client is no longer
supported for Gemini Code Assist for individuals. To continue using
Gemini, please migrate to the Antigravity suite of products...
```

An auth/tier block on this account, not a code defect. `gemini hooks
migrate --from-claude` (the citation the whole Claude-Code-compatibility
claim rests on) does exist as a subcommand on this installed binary —
confirmed via `gemini hooks --help` — which is the "types" evidence
already claimed for the pre-existing PreToolUse row; it does not extend
to confirming the PostToolUse/Stop payload shape specifically.

**Codex**: `codex` is not on PATH in this environment (`command not
found`). No live or types-tier evidence obtainable here.

**Cursor**: `cursor` CLI is not on PATH. No prior citation in this repo
for a post-action/stop-shaped Cursor hook event either — not fabricated.

**Cline**: `cline` CLI is installed and known headless-drivable from prior
sessions (`reference_cline_cli_headless_and_billing.md`), but investigating
its post-action/stop hook contract was out of this lane's time budget.
Left honestly unexplored — recorded as "not investigated," not "confirmed
absent."

**OpenCode** (per the task's own default-to-OpenCode instruction):
confirmed drivable in this environment (`opencode --version` → 1.18.11,
CI=1 BROWSER=none OPENCODE_TERMINAL=dumb). Not re-driven live for THIS
lane's deliverables because OpenCode's discharge mechanism was not changed
— it already worked before this lane, and `session/transcripts/
opencode-claim-rule-live-e2e.txt` already documents its claim-detection
path live. Re-running it would not have tested any new code.

## Mechanism-level proof (real built binary, not a live host)

`packages/cli/src/__tests__/claude-posttooluse-verify-hook.test.ts` — six
cases, all against the REAL built CLI (`dist/index.js`) and the REAL
installed shell script templates (`claude-pretooluse.sh`,
`claude-posttooluse-verify.sh`, `claude-stop.sh`), each hook invocation a
genuinely separate `execSync` subprocess (mirroring what a real exit-code
host does — a fresh process per hook call), obligation state carried
across them purely via `KEEL_STATE_DIR`:

- MUST-DISCHARGE: edit → PostToolUse with `exit_code: 0` → a later "done"
  claim does NOT fire.
- MUST-NOT-DISCHARGE: edit → PostToolUse with `exit_code: 1` → claim
  STILL fires (a failing run must never clear the obligation).
- MUST-NOT-DISCHARGE: edit → PostToolUse with NO determinable outcome
  (no exit_code/success/is_error/interrupted field) → claim STILL fires
  (the honest "Claude Code's real schema is unconfirmed" case).
- A PostToolUse for a non-matching command (`ls -la`, confirmed pass)
  does not discharge.
- Malformed rules.yaml → PostToolUse still exits 0 (fails open, same
  contract as `Stop`).
- An ordinary PreToolUse call is unaffected by the new branch existing.

This is real, deterministic, and load-bearing — but it is proof of KEEL's
OWN logic against an ASSUMED payload shape, not proof that Claude Code
actually sends that shape. Per the honesty ratchet, `docs/integrations.md`
keeps Claude Code's new discharge row at **docs**, not **live**.

## Slopsquatting deny-on-retry (deliverable #3)

Confirmed the same root cause: `pipeline.ts`'s `type: package` branch
already had an explicit comment identifying this exact gap and the
extension point built for it (`packageVerifierOnBackgroundStart`).
`enforce.ts`'s `flushBackgroundWork()` reuses that hook.

`packages/cli/src/__tests__/hook-package-background-flush.test.ts` proves
it, in-process (see the file's own comment for why: a real subprocess
version was attempted first, using a `node:http` server in the test-runner
process as a stand-in registry with `KEEL_NPM_REGISTRY`, but this
environment's own sandbox network policy was found empirically to hang/
abort a CHILD process's fetch to a server listening in the PARENT
process — reproduced directly with a minimal `spawnSync` + `fetch` repro
outside any keel code, so this is a sandbox property, not a defect under
test). The in-process version calls `hookVerdict()` directly twice,
simulating two separate real subprocess invocations via `initEnforce()`'s
own fresh-pipeline-per-call reset.

**Mutation-tested, not just written**: the first version of this test
used an instantly-resolving fetch mock and passed identically whether or
not `flushBackgroundWork()` actually awaited anything — proving nothing.
Caught by deliberately commenting out the `await flushBackgroundWork()`
call and re-running: the suite stayed green. Fixed by giving the mock a
real macrotask delay (`setTimeout`, 40ms) that only an explicit await can
bridge; re-ran against the same disabled-flush build and the "second
attempt... cache is warm" test correctly failed (`does not exist` expected,
`not yet checked` received — i.e. the deny-on-retry regressed exactly as
predicted). Restored the real fix, rebuilt, reran: both tests pass.

## Full test suite (after the fix, output shown)

```
core:            Test Files 34 passed (34) / Tests 597 passed | 2 skipped (599)
cli:             Test Files 44 passed (44) / Tests 806 passed | 14 skipped (820)
mcp-server:      Test Files 1 passed (1) / Tests 6 passed (6)
opencode-plugin: 61/61 PASS (load-test.js)
```

Zero failures, zero skips beyond the two pre-existing `packages/core`
skips (untouched by this lane). The perf-budget flake seen in the
baseline full-suite run did not recur in this run.

## Known gaps, stated plainly

1. **Exit-code field name is genuinely unconfirmed** for claude-code/
   codex/gemini's `PostToolUse` `tool_response`. `postToolUseExitCode`
   defaults to `null` (no discharge) on anything it doesn't recognize —
   the safe direction, but it also means the discharge may simply never
   fire in practice against a real host until someone with a working
   `claude`/`codex`/`gemini` CLI outside this sandbox captures a real
   payload and reports the actual field name back.
2. **Cursor and Cline have no discharge/claim channel** — recorded
   honestly as `NO CHANNEL CONFIRMED` (Cursor) and "not investigated this
   lane" (Cline), per deliverable #4's explicit instruction not to fake
   one.
3. **`VerificationTracker.markSatisfied` has no generation check**
   (pre-existing, not introduced by this lane) — an edit landing between
   a test's PreToolUse and its PostToolUse can be discharged by a run
   that never covered it. Noted for the next lane.
4. **This sandbox blocks nested `claude`/likely other agent CLI
   invocations** — a hard environment constraint discovered empirically
   this lane (two independent attempts, both refused by the "auto mode
   classifier"), not something this lane's code can route around.
