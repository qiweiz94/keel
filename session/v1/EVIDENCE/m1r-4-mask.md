# LANE M1r-4 — `mask` action + `--level` inertness

Worktree: `/Users/nanoclaw/code/keel-v1-m1r-4-mask`, branch `v1-m1r-4-mask`.

## Baseline (before any change)

```
$ npm install   # clean, 169 packages
$ npm run build # clean, all 4 workspaces build
$ npm test
core:            34 files, 597 passed | 2 skipped
cli:              1 FAILED file (perf-budget.test.ts), 41 passed | 794 passed | 14 skipped
mcp-server:       1 file, 6 passed
opencode-plugin:  63/63 PASS (load-test.js)
```

The one baseline failure was `perf-budget.test.ts`'s p99-latency assertion
(45-rule ruleset should evaluate in <50ms; measured 208.876ms best-of-3) —
explicitly a machine-load artifact, not a functional bug: the test's own
failure message reports `load average of 31.2/16 cores`, and its skip-guard
comment target is 1.5/core (the message text describing that load as "under"
the skip threshold is itself inconsistent, but that's a pre-existing
inconsistency in the test, out of scope for this lane). Unrelated to `mask`
or `--level`. Confirmed pre-existing by re-running the full suite after all
changes below — it now PASSES (machine load dropped), and every other file
is unaffected either way.

## PART A — the `mask` action

### Decision: REMOVE, not implement.

### Investigation
- `EnforcementAction` (`packages/core/src/types.ts`) declared `mask` in the
  union.
- `validateRules()` (`packages/core/src/enforce/rule-parser.ts`) had a
  dedicated check that rejected *every* rule using it: `Rule "X" uses action
  "mask", which is not implemented by the enforcement engine`. No rule with
  `action: mask` could ever reach the pipeline.
- `ACTION_STRENGTH` ranked `mask` at strength 2, tied with `fix`/`redirect`
  ("actively intervenes, but the turn continues") — but `pipeline.ts`'s
  `violation()` action dispatch (the function that actually executes
  `fix`/`redirect`/`warn`/`deny`/etc.) had **no branch for `mask` at all** —
  it was structurally unreachable code, doubly so (validation rejects it,
  and even if that check were removed, the pipeline has nothing to do with
  it — it would fall through to a generic "action X is not supported by
  this integration" warn).
- Downstream adapters disagreed with each other about what `mask` even
  means: the Hermes Python client (`packages/cli/templates/hermes/keel_plugin.py`)
  treats it as invisible-allow (not even in its `_ADVISORY` set, so no
  message is ever surfaced); the OpenClaw adapter
  (`packages/cli/templates/openclaw/index.mjs`) groups it with
  `allow`/`warn`/`report` as advisory-no-op, explicitly NOT in the same
  group as `fix` (which it does rewrite arguments for). Three different
  parts of the codebase, three different (non-)behaviors for the same
  action — evidence nobody had actually decided what it does.

### Why not implement
The task's own criterion is "would need a channel keel does not have."
That's exactly the case here:

1. **The only channel that exists for content mutation is pre-execution
   input rewriting** — used today by `fix` (`rule.fix: [{pattern, replace}]`,
   applied in `pipeline.ts`'s `fixAction()`, consumed by
   `opencode-plugin/src/plugin.ts`'s `applyFix()` which mutates
   `args.command` before the tool runs). A `mask` that redacts matched
   content from the *input* before execution is mechanically identical to
   `fix` with a fixed replacement string — not a new capability, just a
   second name for the same one, and OpenClaw's own adapter already
   distinguishes `fix` (rewrites) from `mask` (does not), so redefining
   `mask` this way would contradict the one adapter that already drew a
   line.
2. **The only other plausible meaning — redact matched content from what
   the agent sees in the tool's OUTPUT — has no channel at all.**
   `opencode-plugin/src/plugin.ts`'s own `tool.execute.after` hook comment
   says it directly: *"the hook cannot inject tool results."* Keel's
   enforcement point is `tool.execute.before` (a pre-execution veto/mutate),
   not a proxy over the tool's return value. There is no code path anywhere
   in this codebase that rewrites what the agent reads back from a
   completed tool call.
3. **Masking a secret out of a *live* command breaks the command** (auth
   failure) rather than "actively intervening, but the turn continues" as
   `ACTION_STRENGTH`'s own doc comment promises for it — so even the
   input-rewrite reading doesn't fit the intervention semantics it was
   filed under.
4. **A comprehensive, always-on redaction mechanism already exists and is
   strictly more useful than an opt-in per-rule action**:
   `packages/core/src/enforce/audit-redaction.ts`'s `sanitizeAuditValue`/
   `projectAuditArgs` redacts secrets, tokens, passwords, bearer headers,
   and sensitive paths from *every* audit log entry automatically,
   independent of which rule (if any) matched. A rule author who wants
   "don't leak this in the trail" already gets it for free; a `mask` action
   would be a strictly weaker, opt-in duplicate of behavior that's already
   unconditional.

### What changed
- `packages/core/src/types.ts` — `mask` removed from `EnforcementAction`,
  with a comment pointing at the rationale.
- `packages/core/src/enforce/rule-parser.ts` — `mask` removed from
  `validActions`; the dedicated mask-rejection block deleted (its job is now
  done by the **existing generic check** at `!validActions.has(rule.action)`,
  which was already present and unconditional — confirmed present *before*
  making this change, so removing the dedicated check does not create a
  silent-accept gap: `action: mask` in a rules file still produces
  `Rule "X" has an unsupported action: mask` and still fails the rules file
  closed). `ACTION_STRENGTH` and its doc comment updated to drop `mask` —
  TypeScript's `Record<EnforcementAction, number>` is exhaustive, so the
  compiler itself verifies no stray `mask` key was left behind (a build
  with a leftover key would fail to compile).
- `packages/core/src/enforce/__tests__/agentic-eval.test.ts` — the existing
  test that pinned the *old* mask-specific error message was **rewritten,
  not deleted**, to assert the new (generic) rejection path instead, so
  "an `action: mask` rule fails validation" stays covered.
- `packages/cli/templates/hermes/keel_plugin.py` and
  `packages/cli/templates/openclaw/index.mjs` — **left untouched**. Both are
  thin clients over a value they treat as an opaque string; their tolerant
  fallback for an unrecognized action is itself correct behavior for a
  client that might be talking to an older or newer daemon than its own
  version. Their tests (`hermes-adapter.test.ts`, `openclaw-adapter.test.ts`)
  reference `'mask'` as a literal string, not the `EnforcementAction` type,
  so they were unaffected by the type-level removal and still pass.

## PART B — `--level` inertness

### Finding beyond the task's framing
Investigating `enforce.ts` around the reported message turned up a **more
severe bug than "the flag is a documented no-op"**: the commander CLI option
was declared with a hardcoded default —
`.option('--level <level>', '...', 'balanced')` — which meant
`options.level` was **truthy on every invocation**, including a bare
`keel enforce` that never mentioned `--level` at all. The guard
`if (options.level && !options.persist)` then fired unconditionally without
`--persist`, so **`keel enforce` with no flags whatsoever always printed
"--level=balanced has no effect without --persist" and exited 1** — the
basic status view was unreachable. Verified empirically before touching
anything:

```
$ node packages/cli/dist/index.js enforce   # (in a scratch dir with valid .keel/rules.yaml)
  --level=balanced has no effect without --persist.
  ...
EXIT: 1
```

### Resolution: made `--level` live for the current invocation (not persisted)
`packages/cli/src/index.ts` — dropped the hardcoded `'balanced'` default
from the `--level` option definition, so `options.level` is now `undefined`
unless the caller actually typed `--level=X`. Verified this is exactly what
commander does with no default (`{}` vs `{level:'balanced'}` for a bare
invocation, checked directly against the installed `commander` version).

`packages/cli/src/commands/enforce.ts` (`enforceCommand`):
- Distinguishes `explicitLevel` (only set when the user typed `--level`)
  from the level actually used for this run: `explicitLevel ??
  effectiveHierarchyLevel(hierarchy, 'balanced')` — the same resolution
  `keel status` uses for "what's the real current dial," so a bare
  `keel enforce` in a project persisted at `protect` now correctly reports
  `protect` instead of a hardcoded `balanced` (this was also silently wrong
  before — a second, smaller honesty gap in the same code path).
- The resolved `level` is threaded into `initEnforce()` and into
  `mergeRulesFn(hierarchy, level, 'local')`, so `--level=X` now genuinely
  changes what this invocation reports: rule count, conflict detection, and
  the printed "Level:" line all reflect the named dial — "apply the named
  dial for this invocation," per the task's preferred option.
- Nothing is written to disk unless `--persist` is also given. When
  `--level` is explicit and `--persist` is not, the output says so plainly:
  `(preview for this run only — not persisted; add --persist to make it the
  standing dial)`.
- `--persist` without `--level` is now a clear, explicit error
  (`--persist requires --level=<sprint|balanced|protect>`) rather than
  silently persisting a fallback the caller never asked for — this is new
  behavior; previously the hardcoded default made this combination silently
  persist `'balanced'`.
- The hierarchy is now loaded (for the effective-level fallback and the
  status print) **after** any `--persist` write, so `--level=X --persist`
  in one invocation reports the level it just wrote, not a stale pre-write
  read.
- `index.ts`'s help text for `--level`/`--persist` updated to match.

### Why "live for this invocation" is safe here (not an agent dial-down bypass)
`keel enforce` is a human-run status/setup CLI command — it does not
evaluate any actual tool call (that's `evaluateToolCall`, used by
`keel hook <host>` / the OpenCode plugin's `tool.execute.before`, a
completely separate code path this change does not touch). Confirmed this
command is already covered by the existing `keel-control-gate` rule shipped
in `DEFAULT_RULES_YAML`: `packages/cli/src/__tests__/control-gate.test.ts`
already asserts `keel enforce --level=protect` is a **blocked** Bash command
for an agent (in the same gated list as `keel level sprint`, `keel disable`).
So an agent cannot reach this flag via the guarded Bash tool regardless of
what it does internally — the human-terminal-only assumption is enforced
independently, one layer down, and unaffected by this change.

## Tests added / changed
- `packages/core/src/enforce/__tests__/agentic-eval.test.ts` — rewrote the
  mask-rejection assertion to check the generic unsupported-action message
  instead of the deleted mask-specific one; renamed the test to say so.
- `packages/cli/src/__tests__/level.test.ts`:
  - Rewrote `'enforce --level without --persist refuses...'` →
    `'enforce --level without --persist applies the dial for this
    invocation only, and says so'` — asserts exit 0, `Level: protect`
    printed, the preview note present, and the rules file **unwritten**.
  - Added `'bare keel enforce (no --level at all) shows status instead of
    refusing'` — the regression test for the commander-default bug found
    above.
  - Added `'bare keel enforce reflects the real persisted dial, not a
    hardcoded balanced'`.
  - Added `'enforce --persist without --level refuses — nothing to
    persist'`.

## Full verification run (after all changes, output shown in full)

```
$ npm run build
> @get-keel/core@0.4.0 build       — tsc clean, esbuild 155.1kb
> @get-keel/cli@0.4.0 build        — tsc clean (regenerates src/core/** from core/src)
> @get-keel/mcp-server@0.4.0 build — tsc clean
> @get-keel/opencode-plugin@0.4.0 build — esbuild 414.7kb, regenerates
    packages/cli/templates/keel-enforce.js (generated, matches source diff
    exactly — confirmed via `git diff`, no hand-edits)

$ npm test
> @get-keel/core@0.4.0 test
 Test Files  34 passed (34)
      Tests  597 passed | 2 skipped (599)

> @get-keel/cli@0.4.0 test
 Test Files  42 passed (42)
      Tests  798 passed | 14 skipped (812)
  (perf-budget.test.ts passed on this run; it flaked FAIL on one intermediate
   run in between and passed again on the final rerun shown here — confirms
   it is genuinely load-dependent noise, not a regression from this lane's
   changes: every other one of the 42 files was stable pass/fail across all
   runs, and the flake is the same single p99-latency assertion, same
   pre-existing test, present before any change in this lane was made)

> @get-keel/mcp-server@0.4.0 test
 Test Files  1 passed (1)
      Tests  6 passed (6)

> @get-keel/opencode-plugin@0.4.0 test
 63/63 PASS (node ./scripts/load-test.js), including:
 PASS  dist matches canonical template   (drift.test.ts — confirms the
                                           regenerated keel-enforce.js
                                           template is in sync with source)
```

798 - 794 = +4 net new passing tests in the cli package (3 new `it()` blocks
in level.test.ts; the agentic-eval.test.ts rewrite in core is a like-for-like
replacement, not a net addition, hence the core package's own count is
unchanged: 597 passed both before and after).

## Files touched (source only; dist/generated regenerated by `npm run build`)
- `packages/core/src/types.ts`
- `packages/core/src/enforce/rule-parser.ts`
- `packages/core/src/enforce/__tests__/agentic-eval.test.ts`
- `packages/cli/src/index.ts`
- `packages/cli/src/commands/enforce.ts`
- `packages/cli/src/__tests__/level.test.ts`
- (generated, not hand-edited) `packages/cli/templates/keel-enforce.js`,
  `packages/cli/src/core/**`
