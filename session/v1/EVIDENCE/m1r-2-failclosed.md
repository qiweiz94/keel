# M1r-2 — degenerate-input fail-closed sweep

Branch `v1-m1r-2-failclosed`, worktree `keel-v1-m1r-2-failclosed`, based on
`v0.4-thesis`. Locked product decision: degenerate input (empty string,
unparseable JSON, missing required fields, null/undefined) must fail
CLOSED (block or prompt) at every enforcement entry point — never a silent
allow.

## Baseline (before any change)

`npm install && npm run build && npm test` — green before touching
anything:

```
core: Test Files 33 passed (33) / Tests 557 passed | 2 skipped (559)
cli:  Test Files 41 passed (41) / Tests 751 passed | 15 skipped (766)
opencode-plugin: 57/57 PASS (load-test.js)
```

## What A3 already covered (verified, not rebuilt)

`packages/cli/src/commands/hook.ts`'s `hookVerdict()` already had extensive,
well-tested fail-closed coverage before this lane, proven end-to-end in
`packages/cli/src/__tests__/fail-closed.test.ts` against the real built
CLI:

| Scenario | Verdict (pre-existing) | Test |
|---|---|---|
| `.keel/rules.yaml` fails to parse | exit 2 / deny, all hosts | `fail-closed.test.ts` (b) |
| `unless[].regex` invalid | now caught at load time (folded into (b)) | `fail-closed.test.ts` (c) |
| Corrupt `KEEL_STATE_DIR` (file, not dir) | still blocks matching rule | `fail-closed.test.ts` (d) |
| Unknown host name | falls back to `generic`, still blocks matching rule, still allows non-matching | `fail-closed.test.ts` (e) |
| stdin stream error (ECONNRESET mid-read) | exit 2, not the exit-1 unhandled-rejection crash | `fail-closed.test.ts` "stdin stream error" |
| Malformed/junk JSON on stdin | degrades to a well-formed `unknown`-tool call rather than crashing (a hook that crashes is a hook the host skips) | `fail-closed.test.ts` (a) |

This is real, load-bearing coverage. It was **not** rebuilt.

## What was broken (measured by A3, explicitly deferred as a policy
question) and is now FIXED by this lane's locked decision

The existing suite had **already found and characterized** two gaps,
explicitly flagged in code comments as "measured, not changed — a policy
question for the supervisor." This lane's task is that locked decision:
fix them.

### 1. `hook.ts` — empty stdin / unparseable JSON / missing tool identity

**Before:** `parsePayload()` degraded malformed input to
`{ tool: 'unknown', args: {} }` — a well-formed, non-crashing call. But
`hookVerdict` then evaluated it normally through `pipeline.evaluate()`,
which has no `tool === 'unknown'` special case (confirmed: zero hits for
`'unknown'` in `pipeline.ts`) — its only fallback is
`return this.result('allow', '', 'Allowed (no matching rule)', ...)`
(`pipeline.ts:1050`). A specific dangerous-command rule (real rules do not
deny `.*`) can never match a synthetic `unknown` tool, so the call sailed
through silently. Proven pre-fix by the original test assertions
(`fail-closed.test.ts` git history): `expect(r.status).toBe(0)` for empty
stdin and for a truncated `TOOL_INPUT` env var.

**After:** `ParsedCall` gained a `degenerate` flag. `parsePayload()` sets
it whenever JSON fails to parse, the top-level value isn't a usable object,
or a host's own tool-identity field (`tool_name` / `tool` /
`preToolUse.toolName`) is missing, blank, or non-string — via a shared
`toolField()` helper so every host branch is covered uniformly, not
patched one at a time. `hookVerdict` checks `call.degenerate` **before**
calling `evaluateToolCall`, and renders the identical fail-closed verdict
already used for an internal keel failure (`renderVerdict(host, null)`) —
reusing the per-host envelope that was already tested (cursor's `deny`,
cline's `cancel`, exit 2 for the exit-code hosts).

A deliberate line is drawn and tested both ways: a **missing** value is
legitimate where absence is normal (no `session_id`, no `tool_input` for a
zero-arg tool) — never degenerate. Only a **lost/corrupt** identity or
argument payload is degenerate. The env-var `TOOL_INPUT` path makes this
concrete: `safeJson()` now reports `corrupt: true` only when `TOOL_INPUT`
was PRESENT but failed to parse (data loss); an absent `TOOL_INPUT` stays
`corrupt: false` (legitimate zero-arg call).

### 2. Regression found and closed during the fix, before it shipped

Naively marking every missing-tool-identity payload degenerate would have
broken Claude Code's `Stop` hook: a `Stop`-shaped payload with a
missing/null `last_assistant_message` used to fall through to the ordinary
tool-call branch (no `tool_name` on a Stop payload), landing on `tool:
'unknown'` — harmless pre-fix only because `'unknown'` matched no rule.
Post-fix, that fall-through would have turned a `Stop` event into an
exit-2 **block** — violating the hook's own contract that it can NEVER
block (exit 2 on `Stop` tells Claude Code to keep going, using keel's own
failure as the reason: a self-inflicted loop, see `hookVerdict`'s header
comment). `parsePayload`'s `claude-code` branch now gates on
`hook_event_name === 'Stop'` alone (not also on the message being valid) —
every Stop-shaped payload, message present or not, stays on the
structurally-can't-block claim-reach path (`reasoning: ''` when the
message is missing). Proven end-to-end in
`claude-stop-hook.test.ts` (new test: exit 0 with `last_assistant_message`
omitted entirely).

### 3. `packages/core/src/policy-engine.ts` — `PolicyEngine.evaluate()`

**Before:** every check inside `evaluate()` is gated on
`event.tool_name === 'bash'` / `'write_file'` / etc. — exact string
matches. An empty/missing/non-string `tool_name` matched **none** of them,
so `results` stayed `[]`, and every caller reads an empty array as
"allowed." This is a **live, wired entry point** — not dead code —
confirmed via `packages/mcp-server/src/index.ts` (`new PolicyEngine(...)`)
and `packages/cli/src/commands/check.ts` (`keel check`).

**After:** `evaluate()` gained a fail-closed branch, structurally identical
in shape to its existing `!this.policy` branch: a non-string or empty
`tool_name` returns `action: 'block', rule_name: 'fail-closed-degenerate-input'`
immediately, before any type-specific check runs. A real tool name that
matches no rule is untouched — this is not a default-deny firewall, it
only closes the specific "no identity to evaluate" gap.

### 4. `packages/mcp-server/src/index.ts` — MCP `keel_check` arg contract

**Before:** `keel_check`'s own `inputSchema` declares `action` and `target`
`required`, but nothing enforced that. A missing `action` produced
`tool_name: ''` (silently allowed pre-fix-#3 above). A missing `target`
**alone** was not caught by fix #3 either — `action` was still a real,
non-empty tool name, just paired with `command: '', filePath: ''`, which
matches no real rule pattern. A `keel_check` call that checked nothing at
all read back `"POLICY OK: Action is allowed by project policy."` to the
calling agent — the exact silent allow this lane exists to close.

**After:** an explicit guard ahead of `engine.evaluate()`: either field
missing or empty returns `POLICY BLOCKED` with `isError: true`. The
generic "external tool call" path (missing/empty `toolName`) is covered
for free by fix #3, confirmed live.

**Also found and fixed while writing this lane's first-ever test for the
package:** `packages/mcp-server/tsconfig.json` had no `__tests__` exclude
(unlike `packages/core/tsconfig.json`, which does, with the comment
"package.json ships files:[dist]; keep test sources out of the published
build"). Invisible until now because mcp-server never had a test file
before. Left as-is, `npm publish` would have shipped compiled test files.
Mirrored core's exclude pattern.

### 5. `packages/opencode-plugin/src/plugin.ts` — `tool.execute.before`

**Lowest-confidence item** (in-process SDK hook call from opencode's own
runtime, not a text-parsing boundary — `input: any`, no live evidence
opencode ever calls this hook with a missing `tool`). Included for
consistency with the same class of gap: `toEnforceInput(input?.tool ||
'unknown', ...)` had the identical fallback pattern as `hook.ts`'s
pre-fix `parsePayload`, feeding a synthetic `unknown` tool into
`pipeline.evaluate()`, which — same as #1 above — has no
`tool === 'unknown'` special case and would allow via "Allowed (no
matching rule)." Fixed with an explicit guard: `typeof input?.tool !==
'string' || input.tool === ''` throws `[Keel] fail-closed-degenerate-input`
before `pipeline.evaluate()` ever runs, mirroring the deny path's own
receipt/record/throw shape used elsewhere in `before()`.

Editing `plugin.ts` (source) regenerates
`packages/cli/templates/keel-enforce.js` (generated, never hand-edited) via
`npm run build`; the package's own `dist matches canonical template` check
verified this stayed in sync.

## Path → degenerate input → verdict → test table

| Entry path | Degenerate input | Verdict | Test |
|---|---|---|---|
| `keel hook claude-code` (stdin) | empty stdin | exit 2, `Keel could not evaluate` | `fail-closed.test.ts` (a2) |
| `keel hook claude-code` (env var) | `TOOL_INPUT` truncated/unparseable | exit 2, `Keel could not evaluate` | `fail-closed.test.ts` (a3) |
| `keel hook claude-code` (env var) | `TOOL_INPUT` genuinely absent | **allows** (legitimate zero-arg call, not degenerate) | `fail-closed.test.ts` (a4) |
| `keel hook claude-code` | valid JSON, `tool_name` absent | exit 2 | `fail-closed.test.ts` (a5) |
| `keel hook claude-code` | `tool_name: null` | exit 2 | `fail-closed.test.ts` (a5) |
| `keel hook generic` | `tool` absent | exit 2 | `fail-closed.test.ts` (a5) |
| `keel hook cursor` | neither `command` nor `tool_name` | deny (stdout envelope) | `fail-closed.test.ts` (a5) |
| `keel hook cline` | `preToolUse.toolName` absent | cancel (`HOOK_CONTROL`) | `fail-closed.test.ts` (a5) |
| `keel hook claude-code` (Stop) | `last_assistant_message` missing/null | exit 0 — never blocks (claim path, by contract) | `hook-command.test.ts`, `claude-stop-hook.test.ts` |
| `keel hook` (all hosts) | junk / unparseable JSON on stdin | `degenerate: true` → exit 2 / deny (per host) | `hook-command.test.ts` |
| `keel hook` (all hosts) | stdin stream error mid-read | exit 2 (pre-existing A3 fix, reverified) | `fail-closed.test.ts` "stdin stream error" |
| `PolicyEngine.evaluate()` (`.keel.yaml` engine) | empty `tool_name` | block, `fail-closed-degenerate-input` | `policy-engine.test.ts` |
| `PolicyEngine.evaluate()` | `tool_name: null` | block | `policy-engine.test.ts` |
| `PolicyEngine.evaluate()` | real, unmatched `tool_name` | **allows** (not a default-deny firewall) | `policy-engine.test.ts` |
| MCP `keel_check` | missing `action` and/or `target` | `POLICY BLOCKED`, `isError: true` | `mcp-server/src/__tests__/degenerate-input.test.ts` |
| MCP `tools/call` | missing/empty tool name | `POLICY BLOCKED` (via `PolicyEngine` guard) | `degenerate-input.test.ts` |
| MCP stdio | malformed JSON-RPC line | JSON-RPC `-32700` parse error, not a silent allow | `degenerate-input.test.ts` |
| MCP `keel_check`, complete+dangerous | real rule match | `POLICY BLOCKED` (unaffected) | `degenerate-input.test.ts` |
| MCP `keel_check`, complete+safe | no rule match | `POLICY OK` (unaffected — proves no overreach) | `degenerate-input.test.ts` |
| opencode `tool.execute.before` | `input.tool` missing | throws `[Keel] fail-closed-degenerate-input` | `load-test.js` |
| opencode `tool.execute.before` | `input.tool === ''` | throws `[Keel] fail-closed-degenerate-input` | `load-test.js` |
| opencode `tool.execute.before` | real, unmatched `input.tool` | **allows** (unaffected) | `load-test.js` |

## Hard constraints honored

- `packages/cli/src/core/**` and `packages/cli/templates/keel-enforce.js`
  were never hand-edited — confirmed by `git status --short`: no `src/core`
  entries appear (gitignored, regenerated by `npm run build` from
  `packages/core/src` and `packages/opencode-plugin/dist` respectively).
  `keel-enforce.js`'s diff is a build artifact of editing
  `packages/opencode-plugin/src/plugin.ts` and running `npm run build`.
- `~/.keel`, `~/.claude`, `~/.opencode` were never touched — every test
  uses `mkdtempSync(tmpdir())` for `HOME`/`KEEL_STATE_DIR`/policy files.

## Final verification — full `npm test`, raw output

```
> keel-monorepo@0.4.0 test
> npm run test --workspaces

> @get-keel/core@0.4.0 test
> vitest run

 Test Files  33 passed (33)
      Tests  560 passed | 2 skipped (562)

> @get-keel/cli@0.4.0 test
> vitest run

 Test Files  41 passed (41)
      Tests  760 passed | 15 skipped (775)

> @get-keel/mcp-server@0.4.0 test
> vitest run --passWithNoTests

 Test Files  1 passed (1)
      Tests  6 passed (6)

> @get-keel/opencode-plugin@0.4.0 test
> node ./scripts/load-test.js

PASS  exports default plugin
PASS  id is keel-enforce
PASS  all plugin hooks
PASS  self-bootstrap rules.yaml
PASS  KEEL_STRICT rejects malformed rules
PASS  fallback defaults keep enforcing after malformed rules
PASS  runtime hook failures fail closed
PASS  missing input.tool fails closed rather than evaluating as tool: unknown
PASS  blank input.tool ("") fails closed the same way as missing
PASS  a real (if unmatched) input.tool still allows
PASS  plugin audit redacts sensitive arguments
PASS  warn then deny
PASS  sequence first violation warns
PASS  sequence repeat denies
PASS  sequence ignores unrelated calls
PASS  verification boundary warns then denies
PASS  keel disable is blocked for agents
PASS  keel allow self-approval is blocked
PASS  keel level dial-down is blocked
PASS  rm of the plugin file is blocked
PASS  rules.yaml writes are blocked
PASS  filesystem first warns then denies
PASS  content first warns then denies
PASS  network first warns then denies
PASS  rate first violation warns then denies
PASS  flow first violation warns then denies
PASS  priority metadata selects higher priority rule
PASS  context and unless metadata allow exemptions
PASS  level: protect rule is a floor, not a dial-scoped exemption
PASS  fix rule mutates command args in place
PASS  failed test does not satisfy obligation
PASS  successful test clears obligation
PASS  worktree changes create verification obligation
PASS  system.transform injection
PASS  session.compacting embedding
PASS  balanced: deny warns then blocks
PASS  balanced: sprint-level rule stays active
PASS  balanced: protect-level rule is a floor (denies on first hit)
PASS  balanced: balanced-level rule fires (warns)
PASS  sprint: unleveled deny rule downgraded to warn
PASS  sprint: deny downgraded to warn
PASS  sprint: protect-level rule is a floor (denies on first hit)
PASS  sprint: balanced-level rule is filtered out
PASS  protect: deny blocks FIRST (block-first dial)
PASS  protect: protect-level rule blocks FIRST
PASS  protect: protect-level rule blocks on repeat
PASS  protect: balanced-level rule fires (blocks FIRST)
PASS  turn_number is 1 after the first model call
PASS  turn_number advances on the next model call
PASS  a session with no model call yet stays at turn 0
PASS  per-session counters are independent
PASS  post-edit check flags a broken TypeScript edit
PASS  post-edit check stays silent on a clean edit
PASS  post-edit check ignores files it cannot verify
PASS  every broken file is reported (3/3)
PASS  post-edit check only runs on edits
PASS  claim channel MUST-FIRE: edit then a completed "done" utterance with no test run since
PASS  claim channel MUST-NOT-FIRE: obligation discharged by a real passing run before the claim
PASS  claim channel MUST-NOT-FIRE: hedge/WIP text stays silent
PASS  claim channel MUST-NOT-FIRE: no prior edit means no pending obligation
PASS  claim channel tolerates a malformed/empty payload without throwing
PASS  dist matches canonical template
PASS  OpenCode auto-load probe

All checks passed
```

Net test delta: core 557→560 (+3), cli 751→760 (+9), mcp-server 0→6 (new
package test infra), opencode-plugin 57→60 (+3). No regressions in any
package.

## Files changed

- `packages/cli/src/commands/hook.ts` — `ParsedCall.degenerate`,
  `toolField()`, degenerate checks in `parsePayload`/`hookVerdict`,
  `safeJson()` corrupt-tracking, Stop-event gating fix.
- `packages/cli/src/__tests__/fail-closed.test.ts` — (a2)/(a3) flipped
  from documented-allow to proven-block, new (a4) absent-vs-corrupt line
  test, new (a5) missing-identity sweep across 4 hosts.
- `packages/cli/src/__tests__/hook-command.test.ts` — updated
  `degenerate: true` assertions, rewrote the Stop-without-message
  expectation.
- `packages/cli/src/__tests__/claude-stop-hook.test.ts` — new end-to-end
  regression test for the Stop-loop bug caught before it shipped.
- `packages/core/src/policy-engine.ts` — degenerate-`tool_name` fail-closed
  branch in `evaluate()`.
- `packages/core/src/__tests__/policy-engine.test.ts` — new test group.
- `packages/mcp-server/src/index.ts` — `keel_check` action/target guard.
- `packages/mcp-server/src/__tests__/degenerate-input.test.ts` — new file,
  first test coverage this package has ever had.
- `packages/mcp-server/tsconfig.json` — added the `__tests__` exclude
  `packages/core/tsconfig.json` already had.
- `packages/opencode-plugin/src/plugin.ts` — `input.tool` degenerate guard
  in `before()`.
- `packages/opencode-plugin/scripts/load-test.js` — 3 new checks.
- `packages/cli/templates/keel-enforce.js` — regenerated (build artifact
  of the plugin.ts change above; never hand-edited).
