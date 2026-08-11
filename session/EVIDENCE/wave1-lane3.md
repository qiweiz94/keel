# Wave 1 · Lane 3 — Shadow-mode audit persistence

Worktree: `/Users/nanoclaw/code/keel-w1-observed`, branch `w1-observed`.

## 1. The gap, confirmed at the source

```
$ grep -n "observed_action" -r packages/core/src packages/cli packages/opencode-plugin
packages/core/src/types.ts:235:  observed_action?: EnforcementAction     # EnforceResult — already existed
packages/core/src/enforce/pipeline.ts:715:      observed.observed_action = would
```

`AuditEntry` (types.ts, the interface actually written to `~/.keel/traces/*.jsonl`) had **no**
`observed_action` field, and `AuditLog.record()` (packages/core/src/enforce/audit.ts) built its
entry by naming every field explicitly — `observed_action` was never one of them:

```ts
const entry: AuditEntry = {
  timestamp: result.timestamp, session_id: extra.session_id, ... ,
  fix_applied: result.action === 'fix',
}
```

So a `mode: observe` verdict computes `observed_action` in the pipeline, survives as far as the
in-memory `EnforceResult`, and is dropped the moment it is persisted. Confirmed empirically before
any edit — `pipeline.test.ts` already asserts `result.observed_action` on the in-memory result
(lines 979, 990, 1000, 1040), but nothing asserted it on the *written* JSONL line.

## 2. Two independent audit trails — scope correction

The task brief named `packages/core/src/enforce/receipts.ts` and `.../enforce/signing.ts` as
readers to check for backward compatibility. Those files don't exist at that path — the real
files are `packages/core/src/receipts.ts` and `packages/core/src/signing.ts` (top-level, not
under `enforce/`). More importantly, reading them showed **two structurally separate audit
systems** in this codebase:

| | Type | Written by | Read by | Format |
|---|---|---|---|---|
| A | `AuditEntry` | `AuditLog.record()` (packages/core/src/enforce/audit.ts) + opencode-plugin's own `record()` | `AuditLog.loadDate/loadAll`, `Suggester`, `lessons`, `gather`, `keel enforce --audit` | plain JSONL, unsigned, no hash chain |
| B | `SignedEntry` / `ActionReceipt` | `PolicyEngine.audit()` (packages/core/src/policy-engine.ts) via `createSignedEntry`/`createReceipt` | `keel verify` (packages/cli/src/commands/verify.ts → `verifyChain()`) | Ed25519-signed, hash-chained, `.keel/audit/audit.log` + `.keel/receipts/receipts.log` |

`mode: observe` only exists on system A's path (`rule.mode` is checked in `pipeline.ts`, which
`PolicyEngine` never touches — confirmed: `grep -n "mode.*observe" packages/core/src/policy-engine.ts`
returns nothing). `keel verify` verifies system B, which never carried `observed_action` before
this change and still doesn't after it — there is no old-vs-new shape to reconcile there, because
that trail is untouched.

Given that, item 4 ("`keel verify` ... must handle old entries without the field") is satisfied by:
- proving system A's readers (the ones that actually gain the field) tolerate old-shaped lines
  (section 4 below), and
- a plain regression proving system B — the one `keel verify` actually reads — still verifies
  end-to-end, unaffected by this change (section 5).

## 3. Changes made

### `packages/core/src/types.ts` — `AuditEntry` gains the field

```diff
   reasoning?: string
   fix_applied?: boolean
+
+  /**
+   * Mirrors EnforceResult.observed_action: set only for rules in
+   * `mode: observe`, carrying the action that WOULD have been enforced while
+   * `action` itself stays "allow". Optional so entries written before this
+   * field existed still parse — every reader here does a plain `JSON.parse`
+   * with no schema check, so an absent key is just `undefined`, not an error.
+   */
+  observed_action?: EnforcementAction
 }
```

### `packages/core/src/enforce/audit.ts` — `AuditLog.record()` copies it

```diff
       context_tokens: extra.context_tokens,
       reasoning: sanitizeReasoning(extra.reasoning),
       fix_applied: result.action === 'fix',
+      // Present only for `mode: observe` rules (action stays "allow" while
+      // this carries what would have been enforced). Written unconditionally
+      // — JSON.stringify drops an undefined property, so a non-observe entry
+      // serializes byte-identical to before this field existed.
+      observed_action: result.observed_action,
     }
```

`AuditLog.record()` is the single call site in the whole repo that constructs an `AuditEntry` from
an `EnforceResult` inside the core/CLI path (confirmed by grep below) — it is called from exactly
one place, `evaluateToolCall()` in packages/cli/src/commands/enforce.ts:160, which in turn is the
shared entry point used by `hook.ts`, `evaluate.ts`, and (indirectly) any command built on top of
`initEnforce`/`evaluateToolCall`. Fixing `record()` fixes every one of those callers.

```
$ grep -rn "\.record(\|AuditLog\b" packages/opencode-plugin/src packages/cli/src | grep -v __tests__
packages/cli/src/commands/enforce.ts:160:  auditLog.record(result, {
packages/cli/src/commands/hook.ts:1:import { initEnforce, evaluateToolCall } from './enforce.js'
packages/cli/src/commands/evaluate.ts:1:import { initEnforce, evaluateToolCall } from './enforce.js'
```

### `packages/opencode-plugin/src/plugin.ts` — its own separate `record()` writer

The plugin does not use `AuditLog` at all; it has its own local `record()` (line 284) that appends
a freeform object to `~/.keel/traces/*.jsonl`. Its one call site building an entry from a pipeline
`EnforceResult` (the `before` hook, line 524) named fields explicitly and had the same gap:

```diff
-      record({ session_id: input?.sessionID, turn_number: enforceInput.turn_number, tool: input?.tool, args: projectAuditArgs(args), rule_id: result.rule_id, action: result.action, message: result.message, hook: 'tool.execute.before' })
+      record({ session_id: input?.sessionID, turn_number: enforceInput.turn_number, tool: input?.tool, args: projectAuditArgs(args), rule_id: result.rule_id, action: result.action, observed_action: result.observed_action, message: result.message, hook: 'tool.execute.before' })
```

Checked every other `record(...)` call in the file (line 271 kill-switch event, 376 rules-error
event, 499 post-edit-syntax finding, 570 after-hook completion) — none of them build from a
pipeline `EnforceResult`, so none needed the field.

### Not changed, and why

- **`audit-redaction.ts`** — `projectAuditArgs`/`sanitizeAuditValue` only walk the `args` object
  and `sanitizeReasoning` only touches `reasoning`; neither is invoked on the entry's top-level
  fields, so `observed_action` (an `EnforcementAction` string, never free text) passes through
  untouched. Confirmed by reading the file — no path from `record()` sends `observed_action`
  through either sanitizer.
- **`packages/core/src/policy-engine.ts` / `signing.ts` / `receipts.ts`** — `mode: observe` does
  not exist on this path (verified by grep, section 2). Adding the field there would be
  speculative, not fixing an observed gap.
- **`rule.mode` on the entry (task item 1, "if trivially available")** — skipped. `AuditLog.record()`
  receives an `EnforceResult` (no `mode` field) and an `extra` bag (no `mode` field either); the
  `KeelRule` object itself is not in scope at the call site. Adding it would require plumbing
  `mode` onto `EnforceResult` first, which is exactly the ripple the task said to avoid. Recording
  this explicitly rather than silently doing nothing.
- **`packages/cli/src/commands/daemon.ts`** (`/v1/check`) — calls `pipeline.evaluate()` directly
  and returns the `EnforceResult` (already carrying `observed_action`) over HTTP; it never builds
  an `AuditEntry` or writes to any trace file at all — confirmed: `grep -n "AuditLog" packages/cli/src/commands/daemon.ts`
  returns nothing. This is a pre-existing gap (the daemon-served MCP path is not audited at all,
  independent of `observed_action`), out of scope for "thread through every existing audit writer."

## 4. Backward compatibility — system A (AuditEntry / traces)

Real trace files interleave two writers with different shapes (`packages/core/src/enforce/audit.ts`'s
`AuditLog` and the opencode-plugin's local `record()`) — `gather.ts:80` already casts
`AuditEntry & { t?: number }` because of exactly this. The compat test therefore hand-builds one
line of each old shape, then appends a new entry via the *real* writer, and reads the file back
through the real reader:

```
$ npx vitest run --reporter=verbose src/enforce/__tests__/audit.test.ts src/__tests__/signing-chain-regression.test.ts
 RUN  v4.1.10 /Users/nanoclaw/code/keel-w1-observed/packages/core

 ✓ src/__tests__/signing-chain-regression.test.ts > signing chain — untouched by the observed_action change > still verifies an old-shape hash-chained audit.log end to end 7ms
 ✓ src/enforce/__tests__/audit.test.ts > audit privacy > redacts sensitive arguments and reasoning before writing JSONL 3ms
 ✓ src/enforce/__tests__/audit.test.ts > observed_action persistence (shadow-mode audit) > records the would-be action for a mode:observe rule, with action staying allow 7ms
 ✓ src/enforce/__tests__/audit.test.ts > observed_action persistence (shadow-mode audit) > leaves a non-observe entry byte-identical: no observed_action key on the wire 1ms
 ✓ src/enforce/__tests__/audit.test.ts > observed_action persistence (shadow-mode audit) > parses a mixed-schema trace file — pre-existing core and opencode-plugin shaped lines with no observed_action, plus a new entry written after them 2ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  02:34:48
   Duration  270ms (transform 106ms, setup 0ms, import 155ms, tests 22ms, environment 0ms)
```

The `'parses a mixed-schema trace file...'` test (packages/core/src/enforce/__tests__/audit.test.ts)
writes an old core-shaped line (no `observed_action`, no `t`/`hook`) and an old opencode-plugin
shaped line (`t`, `hook`, no `level`/`context`/`observed_action`) directly to the day's `.jsonl`
file, then calls the real `AuditLog(directory).record(...)` to append a third, new-shaped entry,
then reads all three back through `AuditLog.loadDate()` and asserts:
- both old lines parse with `observed_action === undefined`
- the new line has `observed_action === 'deny'` while `action === 'allow'`
- the full mixed array survives `Suggester.analyze()` (the downstream consumer keyed on `.action`)
  without throwing, returning `total_tool_calls === 3`.

The `'leaves a non-observe entry byte-identical'` test asserts the serialized JSONL line for a
normal (non-observe) `record()` call does **not** contain the string `"observed_action"` at all —
proving `JSON.stringify` dropping the `undefined` property means every pre-existing non-observe
call site is unchanged on the wire, not just "still parses."

## 5. Backward compatibility — system B (signed chain, what `keel verify` reads)

`packages/core/src/__tests__/signing-chain-regression.test.ts` builds an isolated Ed25519 key via
`KEEL_SIGNING_KEY_JWK` (the same env override `initSigning()` checks first, so this never touches
`~/.keel`), writes two `SignedEntry` lines through the real `createSignedEntry()`, and runs
`verifyChain()` against them:

```
 ✓ signing chain — untouched by the observed_action change > still verifies an old-shape hash-chained audit.log end to end 7ms
```

The test also asserts `JSON.stringify(e1)` does not contain `"observed_action"` — confirming this
trail's shape is genuinely unchanged by the task, not coincidentally compatible.

## 6. Positive test — observe verdict reaches the JSONL

From `packages/core/src/enforce/__tests__/audit.test.ts`, `'records the would-be action for a
mode:observe rule, with action staying allow'`: builds a fresh `EnforcementPipeline` with a
`mode: observe, action: deny` rule matching `rm -rf /`, evaluates it (isolated — no shared state,
temp dir passed explicitly to `new AuditLog(directory)`; `KEEL_STATE_DIR` also set/restored around
the test defensively, though `AuditLog`'s constructor does not itself consult it —
`this.logDir = logDir || join(homedir(), '.keel', 'traces')`, confirmed by reading audit.ts:14),
records the result, reads the JSONL line back off disk, and asserts:
- `result.action === 'allow'` and `written.action === 'allow'` (nothing was interrupted)
- `result.observed_action === 'deny'` and `written.observed_action === 'deny'` (survives to disk)
- `written.rule_id === 'obs-danger'`

Test passed — see the verbose run in section 4.

Note also documented in the plugin.ts diff comment context: an observe verdict never reaches
`createReceipt()` — `plugin.ts:534` gates receipt creation on `action === 'deny' || 'block' ||
'prompt'`, and observe always yields `action === 'allow'`. So the promotion pipeline downstream of
this lane will have only the trace JSONL to work from for observe verdicts, never a receipt — that
is expected, not a gap this lane needs to close.

## 7. Build

```
$ npm run build
> @get-keel/core@0.1.9 build ... tsc ... esbuild ... dist/keel-core.mjs  98.5kb
> @get-keel/cli@0.2.2 build ... (wipes + re-copies packages/cli/src/core from packages/core/src, then tsc)
> @get-keel/mcp-server@0.1.2 build ... tsc
> @get-keel/opencode-plugin@0.1.9 build ... esbuild ... dist/index.js  296.5kb (copied to packages/cli/templates/keel-enforce.js)
```

All four workspaces built clean, no TypeScript errors. Confirmed the generated copies picked up
the change:

```
$ grep -n "observed_action" packages/cli/src/core/types.ts packages/cli/src/core/enforce/audit.ts packages/cli/templates/keel-enforce.js
packages/cli/src/core/types.ts:235:  observed_action?: EnforcementAction
packages/cli/src/core/types.ts:290:  observed_action?: EnforcementAction
packages/cli/src/core/enforce/audit.ts:59:      observed_action: result.observed_action,
packages/cli/templates/keel-enforce.js:8766:      record({ ..., observed_action: result.observed_action, ... })
```

## 8. Full suites

Core (packages/core), full run, all tests:

```
$ npx vitest run
 RUN  v4.1.10 /Users/nanoclaw/code/keel-w1-observed/packages/core

 Test Files  14 passed (14)
      Tests  238 passed (238)
   Start at  02:34:05
   Duration  656ms (transform 1.45s, setup 0ms, import 2.44s, tests 1.19s, environment 1ms)
```

CLI (packages/cli), full run, all tests:

```
$ npx vitest run
 Test Files  1 failed | 42 passed (43)
      Tests  4 failed | 552 passed (556)
   Start at  02:34:10
   Duration  13.24s (transform 2.38s, setup 0ms, import 5.77s, tests 65.10s, environment 13ms)
```

The 4 failures are all in `src/__tests__/level.test.ts` (`keel level` / `keel status` output
assertions expecting plain-text like `'project level: balanced → protect'` but receiving raw ANSI
color codes — a chalk/TTY-detection environment mismatch, unrelated to `observed_action`). Verified
pre-existing by stashing every change in this lane and re-running against the unmodified base
commit (`f00522a`):

```
$ git stash && npx vitest run src/__tests__/level.test.ts
 Test Files  1 failed (1)
      Tests  4 failed | 9 passed (13)
   Start at  02:34:53
   Duration  2.61s ...
$ git stash pop   # changes restored, then rebuilt
```

Same 4 tests fail identically with zero changes applied — confirmed not caused by this lane's work.

## 9. Files changed

- `packages/core/src/types.ts` — `AuditEntry.observed_action?: EnforcementAction`
- `packages/core/src/enforce/audit.ts` — `AuditLog.record()` copies `result.observed_action`
- `packages/opencode-plugin/src/plugin.ts` — `before` hook's `record()` call carries `observed_action`
- `packages/core/src/enforce/__tests__/audit.test.ts` — 4 new tests (positive, byte-identical
  non-observe, mixed-schema compat + Suggester consumption)
- `packages/core/src/__tests__/signing-chain-regression.test.ts` — new file, regression proving the
  separate signed/hash-chained trail (`keel verify`'s actual target) is unaffected
- Generated (via `npm run build`, not hand-edited): `packages/cli/src/core/*`,
  `packages/cli/templates/keel-enforce.js`

## 9b. Cross-lane coordination fix: `KEEL_STATE_DIR` on `StateManager`

Mid-lane, the supervisor reported another lane had verified `StateManager`
(packages/core/src/enforce/state-manager.ts) did not honor `KEEL_STATE_DIR` at all, and asked
every lane to apply an identical one-liner so parallel branches merge cleanly. Verified
empirically before touching it:

```
$ grep -n "STATE_DIR" packages/core/src/enforce/state-manager.ts
21:const STATE_DIR = join(homedir(), '.keel', 'state')
```

Confirmed true — no env-var fallback existed. This does not affect *this* lane's own tests: the
positive observe-mode test builds `EnforcementPipeline` without passing a `stateManager` (every
use of `config.stateManager` in pipeline.ts is optional-chained, so omitting it is safe and never
touches `STATE_DIR`), and `AuditLog` isolation is via an explicit `logDir` constructor argument,
not any env var. Applied anyway, as directed, since it's a correct, narrowly-scoped, backward
compatible fix (falls back to identical prior behavior when `KEEL_STATE_DIR` is unset) within
`packages/core/src` and other lanes depend on the exact same line landing:

```diff
-const STATE_DIR = join(homedir(), '.keel', 'state')
+const STATE_DIR = process.env.KEEL_STATE_DIR || join(homedir(), '.keel', 'state')
```

Rebuilt and re-ran both full suites after this change — identical results to section 8 (core
238/238, cli 552/556 with the same 4 pre-existing `level.test.ts` failures):

```
$ npx vitest run   # packages/core
 Test Files  14 passed (14)
      Tests  238 passed (238)

$ npx vitest run   # packages/cli
 Test Files  1 failed | 42 passed (43)
      Tests  4 failed | 552 passed (556)
```

Also checked, per the supervisor's second instruction ("audit/trace paths may have their own dir
resolution — isolate BOTH"): confirmed the trace dir is indeed separately resolved and, unlike
`STATE_DIR` now, still has **no** env-var override —
`AuditLog`'s constructor is `this.logDir = logDir || join(homedir(), '.keel', 'traces')`
(packages/core/src/enforce/audit.ts:14) and the opencode-plugin's `TRACES_DIR` is a hardcoded
module-level constant off `os.homedir()` (packages/opencode-plugin/src/plugin.ts:27-32) with no
env check at all. Neither was changed — out of this lane's assigned scope, and every test in this
lane already isolates the trace dir correctly via an explicit `logDir` argument rather than
depending on an env var, so no test here was at risk of touching real `~/.keel/traces`. Flagging
for whichever lane owns that surface: `TRACES_DIR` in the opencode-plugin has no override at all,
so any test that imports and exercises the plugin's `record()`/`before` hook directly (rather than
unit-testing the pipeline result and the isolated `AuditLog` writer, as this lane did) would write
into the real home directory.

## 10. Untested / left for later waves

- The MCP-server/daemon path (`packages/cli/src/mcp/{server,gateway,daemon-client}.ts` and
  `packages/cli/src/commands/daemon.ts`'s `/v1/check`) never writes any `AuditEntry` at all —
  `observed_action` reaches the caller fine (it's on the raw `EnforceResult` returned over HTTP),
  but nothing about that path was tested here since it's a pre-existing, orthogonal audit-coverage
  gap, not a regression risk from this change.
- `keel enforce --audit` and `keel enforce --json`-style CLI rendering of a fresh observe entry
  were not exercised end-to-end through the actual `keel` binary (no shell-out to the built CLI in
  this evidence) — coverage here is at the `AuditLog`/pipeline unit level, which is what the task's
  binding constraints (isolated temp dirs, no real `~/.keel`) point to anyway.
