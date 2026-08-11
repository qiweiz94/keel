# v0.4 M1/A3 — fail-closed audit

Enumerates every path where `keel hook <host>` could fail OPEN (a tool call
proceeds) instead of CLOSED (the host sees a block, or at minimum a loud
error — never a silent exit-0 allow), and proves each one, mostly through
the real built CLI (`dist/index.js`). Node v26.0.0, worktree
`keel-v04-failclosed`, branch `v04-failclosed`, base commit `2a45592`.

Scope discipline: only `packages/cli/src/commands/hook.ts` and a new test
file were edited. `packages/cli/src/core/` (build-copied from
`packages/core/src/`) and `packages/core/src/enforce/{pipeline,rule-parser}.ts`
were read for tracing but not edited — findings there are flagged below for
the supervisor, not fixed in this lane.

## The bug, and the fix

**`hook.ts`'s only try/catch started AFTER `await readStdin()` and
`parsePayload()`.** A stream error out of `for await (const chunk of
process.stdin)` — a host closing its write end mid-read, an ECONNRESET, not
a contrived case — escaped as an unhandled promise rejection.
`packages/cli/src/index.ts` calls `program.parse()`, not `parseAsync`, and
the `hook` command's `.action()` callback is not awaited, so nothing catches
that rejection. Node's default behavior on an unhandled rejection is to
terminate the process with exit code 1.

Every exit-code host in `renderVerdict` blocks ONLY on exit 2 — the file's
own comment on Codex is explicit: "any OTHER non-zero means the hook
failed and execution continues." The stdout-signaling hosts (cursor,
cline) never even got a stdout envelope written. A crash before evaluation
began was therefore read by the host the same way a hook that was never
installed reads: **permission to proceed.**

### Empirical before/after (not inferred)

Reproduced against the pre-fix build by `git stash`-ing the hook.ts edit,
rebuilding `packages/cli`, and driving the built `hookCommand` in-process
with a fake `process.stdin` whose async iterator rejects
(`/tmp/repro-stdin-error.mjs`, not committed — throwaway):

```
BEFORE (pre-fix, dist/commands/hook.js):
Error: simulated ECONNRESET on stdin
    at Object.next (repro-stdin-error.mjs:21:40)
    at readStdin (dist/commands/hook.js:308:22)
    at hookCommand (dist/commands/hook.js:325:17)
REPRO_RESULT exitCode=1

AFTER (git stash pop, rebuilt):
Keel could not evaluate this action, so it was blocked. Check `keel validate` and ~/.keel/rules.yaml.
REPRO_RESULT exitCode=2
```

Exit 1 vs exit 2 is the entire bug: for claude-code/codex/gemini, 1 is "hook
failed, proceed"; only 2 blocks.

### The fix

`hook.ts` now exports `hookVerdict(hostArg, options): Promise<HostVerdict>`
— a pure function containing everything the old `hookCommand` did, wrapped
in ONE outer try/catch that spans the stdin read through evaluation. Any
escaping exception renders `renderVerdict(host, null)` (the same
fail-closed verdict an in-evaluation error already produced) instead of
letting the process crash into an unhandled rejection. `hookCommand` is now
a thin shell: call `hookVerdict`, write stdout/stderr (itself wrapped in
its own try/catch, separate from the exit, so an EPIPE on the write cannot
prevent `process.exit` from firing with the already-computed fail-closed
code), then `process.exit(verdict.exitCode)`.

The claim-reach (`Stop` hook) branch's intentional `exit 0 on any error` is
preserved unchanged and stays inside the new outer try — `process.exit`
terminates synchronously, so it never reaches the new catch.

`hookVerdict` being a pure function (no `process.exit`) is also what makes
this fix testable at all without mocking `process.exit`, which is a trap in
both directions: a no-op mock lets execution fall past the claim path's
exit into a second evaluation; a throwing sentinel gets caught by the new
outer catch and produces a spurious second verdict. Tests read
`hookVerdict`'s return value directly, the same way `hook-command.test.ts`
already does for `renderVerdict`/`parsePayload`.

## Per-error-path matrix

All rows below except the stdin-stream-error row were measured by spawning
the real built `dist/index.js hook <host>` as a subprocess against a
private `HOME`/`KEEL_STATE_DIR` (never `~/.keel`). See
`packages/cli/src/__tests__/fail-closed.test.ts`.

| # | Path | Before this lane | After this lane | Test |
|---|------|-------------------|------------------|------|
| stdin-error | stdin stream error (readStdin throws) escaping BEFORE hookCommand's try | **FAIL OPEN** — exit 1, unhandled rejection, no envelope on any host | **FAIL CLOSED** — exit 2 / stdout deny envelope on every host, `COULD_NOT_EVALUATE` message | in-process, `hookVerdict` + fake throwing stdin (deterministic; OS pipe-error timing isn't) |
| (a) | malformed/unparseable JSON on stdin | Degrades to `tool:'unknown'` (documented, pre-existing design — "a hook that crashes is a hook the host skips"). Whether it then blocks depends on the loaded ruleset; typically allows since `unknown` rarely matches a real rule's command pattern. | Unchanged — this lane's invariant is "must not crash into exit 1," not "must block," and that already held. Verified no raw stack trace / uncaught-exception signature. | `fail-closed.test.ts` "(a) malformed/unparseable input JSON" |
| (a2) | **empty** stdin (misconfigured host sends nothing) | Same `unknown`/empty-args path as (a); measured exit **0 (allow)**, with a real `rm -rf /` rule proven to fire correctly given a real payload. No signal distinguishes "stdin was empty" from "nothing to block." | Unchanged — measured, not fixed (policy call, flagged below, not this lane's to decide). | `fail-closed.test.ts` "(a2) empty stdin" |
| (b) | rules file fails to parse (bad YAML) | `initEnforce` throws (`ruleErrors.length` from `parseRulesFile`'s `errors` + `validateRules`); caught by hook.ts's own try/catch → `result = null` → blocked. **Already fail-closed before this lane** — the stdin-error bug (above) was a DIFFERENT gap, not this one. | Unchanged (verified, not touched) — exit 2 claude-code, `permission:'deny'` cursor, exit 2 generic. Every subsequent call ALSO blocks (no last-known-good on this path — see note below). | `fail-closed.test.ts` "(b) a rules file that fails to parse" |
| (c) | exception thrown mid-evaluation | pipeline.ts's per-rule try/catch (evaluateTiers, two loops) re-throws any non-`OBSERVE_CONTINUE` error; `evaluate()`'s own outer catch also re-throws. Nothing in core swallows a real error into a false "allow." Propagates to hook.ts's catch → blocked. **Already fail-closed before this lane**, confirmed by reading pipeline.ts end to end (not assumed). | Unchanged (verified with a REAL trigger, not a mock — see below) — exit 2, `COULD_NOT_EVALUATE`, discriminated from (b) by NOT containing "Invalid Keel rules." | `fail-closed.test.ts` "(c) an exception thrown mid-evaluation" |
| (d) | missing/corrupt state dir | `StateManager`'s file I/O is wrapped in best-effort try/catch (`state-manager.ts`: "corrupt — use defaults" / "state persistence is non-critical"); base rule matching (command/filesystem/content) doesn't read state at all, only escalation counters (rate limit, warn-once-then-deny) do. A `deny`-action command rule still fires. | Unchanged (verified) — `KEEL_STATE_DIR` pointed at a plain file (not a directory); a matching `deny` rule still blocked, exit 2. | `fail-closed.test.ts` "(d) a missing/corrupt state dir" |
| (e) | unknown host name | `hookCommand`/`hookVerdict`: `(HOSTS as readonly string[]).includes(hostArg) ? hostArg as Host : 'generic'` — falls back to generic parsing, does not skip enforcement. | Unchanged (verified) — a made-up host name still blocks a matching command (exit 2) and still allows an ordinary one (exit 0). | `fail-closed.test.ts` "(e) an unknown host name" |
| (f) | timeout | No network I/O anywhere in the evaluation path (`pipeline.ts` has exactly one `await`, wrapping the synchronous tier loop; `checkPackagesCacheOnly` is genuinely cache-only, background package verification is fire-and-forget and does not block the call). The only unbounded wait is `readStdin()`'s `for await` blocking until the host closes stdin — a host that never closes it hangs `keel hook` until the HOST's own hook timeout kills the process. What the host does with a killed hook (SIGKILL/SIGTERM) is outside keel's process and is host-specific; SECURITY.md's own framing ("the agent's own process is the boundary") already scopes this out. | Not fixed in this lane (see Flags below — a bounded stdin-read timeout is a policy call for the supervisor, not implemented here to avoid introducing flake into this lane's own evidence). | Not tested (a real hang cannot be asserted on deterministically without introducing timing flake) |

Also verified: rule-parser.ts's SECURITY.md claim — **"malformed rules fail
closed — last-known-good stays in force"** — is real, but is scoped to a
long-lived pipeline (the daemon / opencode plugin), via
`pipeline.ts`'s `checkRuleVersion()` (lines ~182–211): a mid-session reload
that produces parse/validation errors is discarded, the previous hierarchy
is kept, and the hash is deliberately left unchanged so the reload (and the
error) is retried on the next call. **`keel hook` does not exercise this
path at all** — it is a fresh process per call, so `initEnforce`'s own
`loadRuleHierarchy` + `ruleErrors` check runs cold every time, with no prior
state to fall back to. The practical effect is *stronger* than
"last-known-good" (every single call blocks, not just the one racing a bad
reload) but operationally different: a typo in `.keel/rules.yaml` wedges
every hook call until the file is fixed, not just the one call that
introduced it. `fail-closed.test.ts`'s "(b)" block asserts two consecutive
calls both block, to make this concrete.

## hook.ts fixes made

1. **The stdin-stream-error fail-open** (above) — the one real bug this
   lane found and fixed. `hookVerdict` extracted as a pure function; the
   entire body wrapped in an outer try/catch that renders
   `renderVerdict(host, null)` on ANY escape; stdout/stderr writes in
   `hookCommand` given their own try/catch, separate from `process.exit`,
   so a broken pipe on the write itself cannot suppress the exit code.

No other hook.ts changes. `parsePayload`, `renderVerdict`, and the
claim-reach branch's deliberate `exit 0` are behaviorally unchanged —
verified by the full pre-existing suite (`hook.test.ts`,
`hook-command.test.ts`, `hook-contract.test.ts`, `claude-stop-hook.test.ts`)
passing unmodified.

## Core findings flagged for the supervisor (NOT edited — pipeline.ts / rule-parser.ts are other lanes' files)

1. **`rule-parser.ts` validateRules() has a regex-validation gap.**
   `packages/core/src/enforce/rule-parser.ts`, the pattern-validity loop at
   lines 184–196 checks `rule.match`, `rule.match_regex`,
   `rule.unless_reasoning`, `steps[].pattern`, `trigger.pattern`,
   `satisfy.pattern`, and `boundaries[].pattern` — but NOT `rule.unless[].regex`
   (`KeelRule.unless?: { regex?: string }[]`, types.ts:211-212/478).
   `pipeline.ts:631` constructs `new RegExp(u.regex, 'i')` for that field
   with no try/catch of its own. A rule with an invalid `unless[].regex`
   therefore loads successfully (no load-time error) and only throws once a
   call reaches a command that matches `rule.match` — at which point the
   throw DOES propagate correctly to hook.ts's fail-closed catch (proven in
   this lane's test suite, case (c) above), so **this is not a fail-open
   bug**. It is a validation-completeness gap with a confusing symptom: an
   operator who mistypes `unless[].regex` gets every matching call blocked
   with the generic `COULD_NOT_EVALUATE` message instead of the rule's own
   `message`, and no `keel validate` signal at authoring time. Suggested
   fix: add `...(rule.unless || []).map(u => u.regex)` to the pattern array
   at rule-parser.ts:184-192 (same shape as the existing entries).
   Input that triggers it: any `type: command` rule with a `match` that can
   fire, plus `unless: [{ regex: "(unclosed" }]`.

2. **`type: claim` rules can be authored with a blocking `action` that can
   never actually block.** `hook.ts`'s claim-reach branch (Claude Code
   `Stop` hook only, v0.4 Phase 1) always exits 0 regardless of what
   `evaluateClaimText` returns or whether it throws — by design, since the
   Stop hook fires after the agent's turn is already complete and there is
   no tool call left to deny (documented in hook.ts's own header comment on
   that branch). `rule-parser.ts`'s `validateRules()` does not constrain
   `type: claim` rules to non-blocking actions the way it does for e.g.
   `type: mcp`/`inheritance`/`meta`/`session`/`context` (the
   `notImplemented` set) — a user can author `type: claim, action: deny`
   and `keel validate` will accept it as a normal, enforcing rule. The rule
   fires (it can match, record, even set `observed_matches`), but the
   channel it fires on structurally cannot stop anything, so the authored
   `action: deny` reads as a hard block and is actually pure observation.
   Suggested fix: either have `validateRules` reject/warn on
   `type: claim` combined with a blocking action, or have `keel validate`
   /`keel status` surface this explicitly ("claim rules are observe-only on
   every currently wired host").

3. **`onRulesError` is never wired from the CLI.** `pipeline.ts`'s
   `checkRuleVersion()` calls `this.config.onRulesError?.(errors)` when a
   mid-session reload fails validation (the last-known-good path, see
   above) — but `packages/cli/src/commands/enforce.ts`'s `initEnforce()`
   never passes `onRulesError` when constructing `EnforcementPipeline`. For
   any long-lived pipeline instance that exercises this path (the daemon,
   the opencode plugin — NOT `keel hook`, which is a fresh process per
   call and never reaches this code), a rules-file typo introduced
   mid-session is silently absorbed: enforcement correctly continues on the
   last-known-good ruleset (not a fail-open), but the operator gets no
   signal that their edit was rejected. `enforce.ts` is outside this lane's
   owned files (hook.ts + the new test file only) — flagged, not touched.

4. **Empty stdin is a silent, total, indistinguishable-from-normal allow.**
   Measured directly (see matrix row (a2)): a host that sends nothing on
   stdin (a real integration bug, not a garbled payload) allows every
   single call, forever, with no stderr, no stdout, no exit-code signal
   different from a genuine "nothing to block" verdict. This is a policy
   question — should `keel hook` distinguish "stdin had zero bytes" from
   "stdin had bytes that failed to parse" and treat the former as louder
   evidence of a broken integration? — not something this lane changed
   unilaterally, since sibling lanes may depend on today's behavior for a
   legitimate host that sometimes has nothing to report.

5. **Stdin-read timeout (path (f)) is host-governed, not keel-governed,**
   and this lane deliberately did not add one: a bounded `readStdin()` with
   a fail-closed timeout, or a `SIGTERM` handler that emits the block
   envelope before the process dies (covering slow paths generally, not
   just the stdin read — though `SIGKILL` still defeats it), are both real
   options, but the timeout VALUE and the choice of a self-imposed hang
   ceiling are a supervisor-level policy call, and a test asserting on a
   real hang would introduce exactly the kind of timing flake this lane's
   own evidence should not have. Documented as a recommendation, not
   implemented.

## Verification

```
npm run build                          # all four workspaces, clean
packages/core: 541 passed | 2 skipped  # baseline, unchanged (core untouched)
packages/cli:  724 passed | 14 skipped # baseline 708 + 16 new fail-closed tests, 0 regressions
```

Full CLI run includes the pre-existing `hook.test.ts`, `hook-command.test.ts`,
`hook-contract.test.ts`, and `claude-stop-hook.test.ts` — all pass unmodified
against the new hook.ts, confirming the refactor (`hookCommand` →
`hookVerdict` + thin exit shell) is behavior-preserving for every path this
lane did not intend to change.
