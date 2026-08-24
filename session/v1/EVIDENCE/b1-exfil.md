# b1-exfil: closing AUDIT §5 — exfil cross-call correlation on hook-invoked hosts

Implementer lane, branch `v1p2-b1-exfil`, worktree
`/Users/nanoclaw/code/keel-v1p2-b1-exfil`. Closes AUDIT.md §5 ("Exfil
cross-call correlation is INERT on hook-invoked hosts") — additively, at
**warn/observe tier**, per the lane brief's explicit instruction to prefer
warn over a hard block for this correlation shape.

## Baseline (before any change)

`npm install` → `npm run build` → `npm test`, all green:
- core: 603 passed / 2 skipped (34 files)
- cli: 833 passed / 14 skipped (47 files)
- mcp-server: 6 passed
- opencode-plugin: all checks passed (`load-test.js`)

## The problem, confirmed by reading (not assumed)

`FlowTracker` (`packages/core/src/enforce/flow-tracker.ts`) held
`taggedValues`/`tagOrigins` in plain in-memory `Map`s, constructed once per
`EnforcementPipeline`. `keel hook <host>` (`packages/cli/src/commands/
hook.ts` → `enforce.ts`'s `initEnforce()`) constructs a brand-new pipeline
— and brand-new `FlowTracker` — on every single tool call. `no-exfil-flow`'s
`check()` only ever sees tags recorded by `record()` calls in the SAME
process, so a `Read` of `.env` in one `keel hook claude-code` invocation and
a `Bash curl` in the next never correlate — only a single command that
itself pipes read into sink (`cat .env | curl ...`) is caught. This was
already documented (`docs/exfil.md`, `SECURITY.md`, `AUDIT.md §5`) as a
known, pre-existing gap; this lane closes it, additively, for the warn
tier only.

## Design

### Store: `PersistentFlowStore` (`packages/core/src/enforce/flow-store.ts`, new file)

- **Path / key**: `<stateDir()>/flow-tags.json` — the same `stateDir()` /
  `KEEL_STATE_DIR` / `resolveHome()` resolution `StateManager`
  (`state-manager.ts`) already uses, so tests isolate it via
  `KEEL_STATE_DIR` exactly like every other piece of persisted enforcement
  state, and it lives at the same real `~/.keel/state/` location in
  production. Tags are keyed by the caller's `session_id` — the SAME field
  `overrides.ts`'s `mode: session` override already scopes by, with no
  additional authentication (documented explicitly as an inherited trust
  boundary, not a new one, in both the store's own doc comment and
  `docs/exfil.md`).
- **TTL**: `FLOW_TAG_TTL_MS = 60 * 60 * 1000` (1 hour). Enforced on write
  (`recordTag` prunes before persisting) and on read (`getTags` filters
  again), so an idle session's tags age out even without further writes.
- **Bounds**: `MAX_TAGS_PER_SESSION = 50`, `MAX_SESSIONS = 200`
  (least-recently-active session evicted first) — an on-disk mirror of
  `FlowTracker`'s own in-memory "keep last 1000" cap.
- **Locking**: every `recordTag` call runs its load → merge → persist
  cycle under `withFileLock`/`acquireLock` (`file-lock.ts`) — reused
  unmodified, the exact lock `StateManager` and `overrides.ts` already use,
  including its stale-lock reclaim and bounded-timeout fail-safe (runs
  unlocked rather than skipping the write or hanging the hook).
- **Fail-safety**: a lock timeout, a corrupt `flow-tags.json`, or any other
  read/write failure degrades to "no correlation this call" —
  `recordTag` no-ops, `getTags` returns `[]` — never a thrown exception,
  never a hang. Explicitly documented (both in the store's own doc comment
  and `docs/exfil.md`) as safe ONLY because this store backs a
  warn/observe-tier rule, never a `level: protect` deny floor.

### FlowTracker changes (`packages/core/src/enforce/flow-tracker.ts`)

- Constructor now takes an OPTIONAL `persistentStore?: PersistentFlowStore`
  argument. Every pre-existing `new FlowTracker()` call site (~80 across
  the test suite, plus `daemon.ts` and `opencode-plugin/src/plugin.ts`) is
  unmodified and stays pure in-memory — this is fully additive.
- `record()` — when a persistent store is configured AND the call carries
  a real, specific `KeelRule` object (not the generic per-call sweep at
  `pipeline.ts`'s `record(input, '')`, nor the post-violation bookkeeping
  calls that pass `rule.id`, a plain string) — ALSO persists the matched
  tag via `persistentStore.recordTag(session_id, tag)`, for both the
  path-argument branch and the Bash-native-read-verb branch. This gating
  avoids writing redundant copies of the same real read event from the
  pre-existing call sites that already run on every action for unrelated
  reasons.
- New method `checkPersisted(input, rule)` — the persisted-store analog of
  `check()`: same sink-matching logic (`matchesSink`), but sources tags
  from `persistentStore.getTags(session_id)` instead of the in-memory
  `taggedValues` map. `check()` itself is BYTE-FOR-BYTE unchanged — it
  still only ever sees in-memory state, so `no-exfil-flow`'s existing
  deny/protect behavior is untouched by this lane.

### Pipeline wiring (`packages/core/src/enforce/pipeline.ts`)

The `type: flow` branch now calls `record()` for every flow rule
(unchanged), then branches on a new optional `KeelRule.cross_call` field
(`packages/core/src/types.ts`): `cross_call: true` rules call
`checkPersisted()` instead of `check()`. A `cross_call` rule still calls
its own `record()` (not skipped), so it is self-sufficient even in a
custom `rules.yaml` that ships it without `no-exfil-flow` — this is also
why the per-rule fixture harness (which tests one rule in total isolation)
can exercise it at all.

### New rule: `no-exfil-flow-cross-call`

Added identically to `packages/cli/src/commands/install.ts` and
`packages/opencode-plugin/src/plugin.ts` (the two-file rule requirement
`drift.test.ts` guards): same `sources`/`sinks` as `no-exfil-flow`,
`action: warn`, `level: sprint`, `mode: warn`, `cross_call: true`.
`drift.test.ts`'s rule count updated 45 → 46.

### CLI wiring (`packages/cli/src/commands/enforce.ts`)

`initEnforce()` — the single choke point behind `keel hook <host>`,
`keel test`, and `keel evaluate` (confirmed by grepping every importer of
`initEnforce`) — now constructs `new FlowTracker(new PersistentFlowStore())`,
ON BY DEFAULT for every exit-code host, per the brief. `daemon.ts` and
`opencode-plugin/src/plugin.ts` construct their own `FlowTracker` directly
and were NOT changed — they already correlate in memory for a whole
session and do not need this.

## Why `checkPersisted` is a separate method, not folded into `check()`

`check()` backs `no-exfil-flow`, a `level: protect` deny floor — hard,
undialable, by design (see `docs/exfil.md`'s "Design choice" section).
Consulting the persisted store from `check()` would have silently widened
that floor's false-positive surface from "one live process" to "the
store's TTL, across separate processes" — exactly the shift the lane brief
said NOT to make ("prefer observe/warn over hard-block for the
correlation... a hard block would false-positive"). Keeping them as two
methods, backing two separate rules at two separate tiers, means
`no-exfil-flow`'s behavior is provably unchanged (see test 1 below: the
in-memory `check()` call in the same test still returns `null`) while the
new coverage ships at the tier the brief asked for.

## Tests

### Cross-process / session / TTL / no-FP — `packages/core/src/enforce/__tests__/flow-store.test.ts` (new, 11 tests)

Two SEPARATE `FlowTracker` instances (`tracker1`, `tracker2`), each with
its OWN `PersistentFlowStore` pointed at the same directory — literally
simulating two separate `keel hook` process invocations sharing only a
`session_id` and a `KEEL_STATE_DIR`-equivalent directory:

```
✓ two SEPARATE FlowTracker instances sharing one session_id + directory
  correlate a read recorded by the first with a sink checked by the
  second                                                            28ms
✓ a DIFFERENT session_id does not correlate — no cross-session leak  17ms
✓ a MISSING session_id does not correlate either                     5ms
✓ a TTL-expired tag does not correlate                               14ms
✓ a tag recorded well within the TTL still correlates (not an
  off-by-one)                                                        15ms
✓ no false positive: a READ-ONLY session (no sink call ever made)
  produces no violation                                              14ms
✓ no false positive: an EGRESS-ONLY session (no prior read) produces
  no violation                                                        1ms
✓ checkPersisted returns null with no persistent store configured
  (every pre-existing new FlowTracker() call site is unaffected)      5ms
✓ a corrupt store file degrades to "no correlation", never throws
  (fail-safe: warn/observe tier, not a floor)                        20ms
```

The first test additionally asserts `tracker2.check()` (the in-memory,
`no-exfil-flow`-backing method) returns `null` on the exact same input
that `checkPersisted()` fires on — direct proof the existing deny-tier
rule's behavior is unchanged.

Plus 2 bound tests (`PersistentFlowStore — bounds`):
```
✓ caps tags retained per session at MAX_TAGS_PER_SESSION (bounded, not
  unbounded growth)                                                 679ms
✓ caps the number of distinct sessions retained at MAX_SESSIONS,
  evicting least-recently-active first                             2494ms
```

### Concurrent writers — `packages/core/src/enforce/__tests__/flow-store-concurrency.test.ts` (new, 2 tests) + `fixtures/flow-store-worker.ts` (new)

Mirrors `state-manager-concurrency.test.ts`'s method exactly: spawns REAL
OS child processes (via `vite-node`, not `worker_threads` — the hazard
under test is genuinely cross-process) that import `flow-store.ts`
directly and race on one shared directory:

```
✓ concurrent recordTag calls from N processes, same session, land every
  tag with no loss or corruption                                    811ms
✓ concurrent recordTag calls across DIFFERENT sessions stay isolated
  (no cross-session bleed under the race)                           899ms
```

The first spawns 3 processes × 10 tags each (30 total, under
`MAX_TAGS_PER_SESSION`) against ONE shared `session_id`, then asserts all
30 distinct `(worker, index)` tags are present with no loss — this is the
direct proof `withFileLock` is actually preventing the lost-update race
(without it, per `state-manager-concurrency.test.ts`'s own precedent for
the identical hazard against `StateManager`, concurrent writers clobber
each other's saves).

### Per-rule fixture coverage — `tests/rules/no-exfil-flow-cross-call/{must-block,must-allow}.yaml` (new)

Required by `fixture-harness.test.ts`'s "every shipped default rule has a
fixture dir" guard. `fixture-harness.test.ts`'s `buildPipeline()` was
updated to wire a `PersistentFlowStore()` (isolated via the file's own
`KEEL_STATE_DIR`, set in `beforeAll`) into its `FlowTracker` — additive,
has no effect on the other 45 rules (only a `cross_call: true` rule ever
calls `checkPersisted`). 1 must-block case (read `.env`, then `curl` it,
same case/pipeline — the persisted-store round-trip through real disk,
though still one process; the genuine cross-process proof is the
dedicated suite above) + 2 must-allow cases (no prior read; read with no
egress) — 3 new passing tests.

## Full suite result (after all changes, including the advisor-driven addition, docs included)

```
> keel-monorepo@1.0.0 test
> npm run test --workspaces

@get-keel/core:          Test Files  37 passed (37)   Tests  619 passed | 2 skipped (621)
@get-keel/cli:           Test Files  47 passed (47)   Tests  836 passed | 14 skipped (850)
@get-keel/mcp-server:    Test Files  1 passed (1)     Tests  6 passed (6)
@get-keel/opencode-plugin: All checks passed (load-test.js, incl. "OpenCode auto-load probe")
```

core: +16 tests over the 603 baseline → 619 (3 new files:
`flow-store.test.ts` ×11, `flow-store-concurrency.test.ts` ×2,
`flow-cross-call-pipeline.test.ts` ×3 — the last added in response to
advisor review, see above).
cli: +3 tests (`no-exfil-flow-cross-call`'s 1 must-block + 2 must-allow
fixture cases) over the 833 baseline → 836.

One transient failure was observed and diagnosed as environmental, not a
regression: `opencode-plugin`'s "OpenCode auto-load probe" (which shells
out to the real `opencode` CLI binary and asserts `opencode debug config`
exits 0) hit `ETIMEDOUT` once. Reproduced the exact same `spawnSync`
call standalone outside the test harness and got the identical
`ETIMEDOUT` from the `opencode` binary itself (a real, installed CLI,
`opencode --version` → `1.18.11`) with no code changes in between;
re-running `node ./scripts/load-test.js` immediately after passed cleanly,
including that exact check. Not caused by this lane's diff.

## `npm run build` — clean, no TypeScript errors

```
@get-keel/core:      tsc + esbuild → dist/keel-core.mjs (161.6kb)
@get-keel/cli:       tsc (vendors packages/core/src → src/core, gitignored, never hand-edited)
@get-keel/mcp-server: tsc
@get-keel/opencode-plugin: esbuild → dist/index.js (420.6kb) → copied to
                            packages/cli/templates/keel-enforce.js
```

Confirmed via `git status` that no file under `packages/cli/src/core/**`
appears as changed (it's gitignored, regenerated by the build, never
hand-edited); `templates/keel-enforce.js` DOES appear changed, as
required — it was regenerated by `npm run build` from the edited
`opencode-plugin/src/plugin.ts`, not hand-edited.

## Advisor review

Called before declaring done, per the lane's mandatory instruction. Two
findings, one a real blocker candidate, one a real gap in test rigor.
Both addressed below; neither was dismissed.

### BLOCKER candidate: does the warn-once-then-block ladder gate `action: warn` rules?

The advisor's concern: `violation()` warns on a deny/block rule's first
hit and only blocks on repeat, gated by `isFirstWarning()` /
`StateManager.markFirstTime` / `denyFirstTime.json` — keyed by `rule.id`
ALONE, with a 24h TTL. If that same gate applied to `action: 'warn'`
rules, `no-exfil-flow-cross-call` would warn exactly ONCE per 24h across
an entire shared `KEEL_STATE_DIR` (not per-session) — the first benign
build of the day would burn the warn, and every real cross-call exfil for
the rest of the day would go silent. That would reproduce AUDIT §5's own
failure shape one layer up: a control that looks wired in but is
functionally inert most of the time.

**Investigated, not assumed.** Read `violation()`
(`packages/core/src/enforce/pipeline.ts`) end to end: the
`isFirstWarning`/`markFirstTime`/`denyFirstTime` ladder lives EXCLUSIVELY
inside the `if (action === 'deny' || action === 'block')` branch (lines
~1286-1310). The `action === 'warn'` branch (~1274-1276) calls
`this.warn(input, rule, message, start, tier)` directly and
unconditionally — no `isFirstWarning` check, no `StateManager` read, no
suppression state at all. Also checked `ActionCache` (`this.config.cache`):
its lookup is unconditionally skipped (`cached = ... ? null : ...`)
whenever any stateful rule is active, and `type: 'flow'` rules are always
stateful when `deepChecks` is true — which it always is here, since
`no-exfil-flow` (`level: protect`) forces `protectFloor(rules)` true
regardless of dial. So the cache cannot be suppressing repeat warns
either.

**Then wrote the test the advisor asked for**, not just re-read the code:
`packages/core/src/enforce/__tests__/flow-cross-call-pipeline.test.ts`
(new, 3 tests), against the REAL `EnforcementPipeline` + REAL
`StateManager` (not the FlowTracker-only unit tests, which cannot see
this ladder at all since it lives in `violation()`, one layer up):

```
✓ two SEPARATE sessions, sequentially, sharing one KEEL_STATE_DIR-
  equivalent directory, BOTH warn — the second is not silently
  swallowed                                                          50ms
✓ the SAME session correlating a SECOND time (a later, unrelated sink
  after the same earlier read) also still warns — not a one-shot-per-
  session gate either                                                22ms
✓ meanwhile, a sibling deny-tier no-exfil-flow-SHAPED rule (action:
  deny, NOT cross_call) DOES use the warn-once ladder — confirms the
  ladder is real and scoped to deny/block, not accidentally absent
  from this test setup                                               54ms
```

The third test is the control: it proves the warn-once-then-deny ladder
is genuinely present and reachable in this exact test harness (a
non-`cross_call` deny-type flow rule DOES warn-then-escalate, exactly
like `no-exfil-flow` itself), which rules out "the ladder never fired
here because the harness is missing something," the failure mode that
would make the first two tests a false negative rather than real
evidence.

**Conclusion: not a blocker.** `no-exfil-flow-cross-call` warns every
time it correlates, in every session, indefinitely — no per-rule-id,
per-24h, or per-session suppression of any kind. No code change was
needed; the design was already correct on this axis. What changed is
that this is now proven empirically against the real pipeline, not just
argued from a design review.

### Fixture comment overclaimed what it proves

The advisor correctly noted that `tests/rules/no-exfil-flow-cross-call/
must-block.yaml`'s original comment claimed to prove the "disk round-trip"
mattered, when the fixture (one process, one pipeline, per
`fixture-harness.test.ts`'s isolation model) cannot distinguish that from
an accidental in-memory read — nothing in it would fail if
`checkPersisted()` were refactored to bypass the store. **Fixed**: the
comment now states plainly that this fixture is a smoke test of the
shipped YAML wiring only, and points at `flow-store.test.ts` and
`flow-cross-call-pipeline.test.ts` as the load-bearing proof of the actual
cross-process mechanism. No test behavior changed — only the claim the
comment made about what the test demonstrates.

## Files touched

New:
- `packages/core/src/enforce/flow-store.ts`
- `packages/core/src/enforce/__tests__/flow-store.test.ts`
- `packages/core/src/enforce/__tests__/flow-store-concurrency.test.ts`
- `packages/core/src/enforce/__tests__/flow-cross-call-pipeline.test.ts` (added in response to advisor review)
- `packages/core/src/enforce/__tests__/fixtures/flow-store-worker.ts`
- `tests/rules/no-exfil-flow-cross-call/must-block.yaml`
- `tests/rules/no-exfil-flow-cross-call/must-allow.yaml`
- `session/v1/EVIDENCE/b1-exfil.md` (this file)

Modified (source, not generated):
- `packages/core/src/enforce/flow-tracker.ts` — optional persistent store, `checkPersisted()`
- `packages/core/src/enforce/pipeline.ts` — `cross_call` branch in the flow-rule check
- `packages/core/src/enforce/index.ts`, `packages/core/src/keel-core.ts` — export `PersistentFlowStore`
- `packages/core/src/types.ts` — `KeelRule.cross_call` field
- `packages/cli/src/commands/enforce.ts` — wires `PersistentFlowStore` into `initEnforce()`
- `packages/cli/src/commands/install.ts`, `packages/opencode-plugin/src/plugin.ts` — new `no-exfil-flow-cross-call` rule (identical, two-file requirement)
- `packages/cli/src/__tests__/drift.test.ts` — rule count 45 → 46
- `packages/cli/src/__tests__/fixture-harness.test.ts` — wires `PersistentFlowStore` into the shared test pipeline builder
- `docs/exfil.md`, `SECURITY.md` — honest documentation of the new capability, its tier, TTL/session scoping, and the still-open deny-tier gap

Regenerated by `npm run build` (gitignored / two-file-rule target, never hand-edited):
- `packages/cli/src/core/**` (gitignored, not tracked)
- `packages/cli/templates/keel-enforce.js`
