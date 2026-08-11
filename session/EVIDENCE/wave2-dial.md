# Wave 2 Lane 7 — Speed-dial hardening

Worktree: `/Users/nanoclaw/code/keel-w2-dial` (branch `w2-dial`)

## 1. Sprint auto-expiry

**Storage choice: rules.yaml, not KEEL_STATE_DIR.** `sprint_started_at` (ISO
8601) and `sprint_expiry_hours` (default 4, 0 disables) are two new
top-level `KeelConfig` fields, written by the same comment-preserving
surgical line editor that already writes `level:` (`writeRulesLevel` in
`packages/cli/src/commands/level.ts`). Reasons this beats
`KEEL_STATE_DIR`:

- It is scoped identically to `level` itself — global sprint gets a global
  expiry, project sprint gets a project expiry, with no extra keying logic
  to keep in sync with which scope `keel level [--project]` targeted.
- It survives everything `level:` itself survives: copying the file,
  checking it into a dotfiles repo, `keel install` re-runs. State-dir
  timestamps would silently detach from the file the moment it moved.
- It requires no new plumbing to be "read live": `rules.yaml` is already
  re-parsed from disk on every process invocation (that's how `keel level`
  already takes effect "without a restart" per the existing docstring in
  level.ts) — the same reload that already exists is where expiry now
  gets checked too.
- Setting any level other than `sprint` clears a leftover
  `sprint_started_at` (see `writeRulesLevel`'s doc comment), so a
  hand-edited `level: sprint` with no timestamp key correctly never
  auto-expires, instead of picking up a stale clock from some earlier run.

**Where enforcement reads it**: `packages/core/src/enforce/rule-parser.ts`
gained `sprintExpiryStatus()`, `resolvedLevel()`, and
`effectiveHierarchyLevel()` — the single place "which dial is actually in
effect right now" gets computed. `pipeline.ts`'s private `effectiveLevel()`
(the per-call enforcement decision point, used by both the sprint-downgrade
check and the fast/full/deep depth selection) now delegates to
`effectiveHierarchyLevel()` instead of reading `config.level` raw. Six
other call sites (`status.ts`, `dashboard.ts`, `daemon.ts`, `validate.ts`,
`enforce.ts`) had their own copy of the same project-over-global
precedence; only `status.ts` was touched (explicitly required — see §1
below) and `pipeline.ts` (the actual enforcement path). The others are
either UI-only display or a fallback default that pipeline.ts's own
resolution overrides on every real call, so they were left alone rather
than expanding the diff beyond what enforcement correctness requires.

**Timeout-only, as specified** — no session-end detection. A process that
never calls `keel status` or triggers a tool call simply keeps sprint
active past its window in memory; the reversion happens the next time
anything reads the rules file, which for a process-per-call host (no
daemon) is "the very next tool call."

### `keel status` announcement

Live run, temp `HOME`, sprint set 5h ago against the 4h default:

```
$ keel status
  Speed dial: BALANCED (sprint=warn-only · balanced=default · protect=block-first)
    Change: keel level sprint|balanced|protect [--project]
    sprint expired → balanced (set 5 hours ago, 4h limit — 1h past expiry)
    Re-arm with: keel level sprint [--project]
```

Note the dial line itself already reads `BALANCED` — the RESOLVED level,
not the raw `level: sprint` still sitting in the file — with the expiry
line explaining why. `keel level` (no argument) surfaces the same fact:

```
$ keel level
  global: sprint
    sprint expired → balanced (set 5 hours ago)
  project: not configured (...)
```

A fresh sprint (1h old) shows neither the dial flip nor the expiry line,
just a countdown:

```
$ keel status
  Speed dial: SPRINT (sprint=warn-only · balanced=default · protect=block-first)
    Change: keel level sprint|balanced|protect [--project]
    sprint auto-reverts to balanced in ~4.0h
```

### Enforcement (not just display) picks it up — `keel evaluate`, same rules.yaml

Fresh sprint (`sprint_started_at` 1h ago) against a plain `deny` rule
(`no-force-push`) — sprint keeps softening it to `warn` on every call,
never escalates:

```json
{"action":"warn","rule_id":"no-force-push","message":"No force push to shared branches.", ...}
{"action":"warn","rule_id":"no-force-push","message":"No force push to shared branches.", ...}
```

Same rules.yaml, `sprint_started_at` rewritten to 5h ago (expired) — the
very next `keel evaluate` call (a fresh subprocess, proving there is no
daemon involved) now behaves like `balanced`: warn once, then deny:

```json
{"action":"warn","rule_id":"no-force-push","message":"First violation of \"no-force-push\" — warning only. Next time will be blocked.", ...}
{"action":"deny","rule_id":"no-force-push","message":"No force push to shared branches.", ...}
```

## 2. Dial transparency

`keel level <level>` now prints a "Dial diff" section computed from
`computeDialDiff()` (exported from `level.ts`), which loads the real
merged ruleset via `mergeRules()` and evaluates each rule's action with
`dialAction()` (exported from `rule-parser.ts` — the same pure function
`pipeline.ts`'s `enforcedAction()` delegates to for the live enforcement
decision, so the printed diff cannot drift from what the pipeline actually
does). Real output, switching a two-rule project from balanced to sprint
(one plain `deny` rule, one `level: protect` floor):

```
$ keel level sprint
  global level: balanced → sprint
  ...
  Dial diff (balanced → sprint), from the merged ruleset:
    1 rule(s) soften deny/block → warn: no-force-push
    1 `level: protect` floor(s) unchanged: no-secrets-read
```

The diff also reports rules a dial switch activates/deactivates (a
`level:` filter effect, distinct from the deny→warn softening) and, per
the npm `--audit-level` precedent named in the task brief, still prints
when nothing changes rather than going silent — e.g. setting the *global*
level while a *project* level already overrides it:

```
Note: the project level ("protect") overrides the global level — the effective dial is still protect.

Dial diff: effective dial is unchanged (protect) — no rule changes effective action.
```

`LEVEL_EFFECTS` (the existing prose block) is kept as a general summary;
the diff section is the derived, rule-id-accurate part.

## 3. Floor tests

- `packages/core/src/enforce/__tests__/level-reload.test.ts`:
  - `dialAction()` unit tests: sprint softens plain deny/block to warn;
    `level: protect` keeps its declared action at sprint, balanced, AND
    protect.
  - Pipeline-level: "at sprint: a protect-floor violation still reaches
    deny on repeat; a plain deny rule stays stuck at warn" — same rule
    type, same escalation path, contrasted directly.
  - New describe block "sprint auto-expiry reverts enforcement to
    balanced": constructs a real `EnforcementPipeline` with
    `reloadRules`/`ruleFingerprint` wired to a temp rules.yaml (same
    pattern as the existing "dial level changes apply on the next call"
    test), rewrites the file's `sprint_started_at` between calls, and
    proves both directions (fresh stays warn-forever; expired reaches
    deny on repeat) through the pipeline's public `evaluate()`, not by
    calling the private level-resolution methods.
- `packages/core/src/enforce/__tests__/rule-parser.test.ts`: unit tests
  for `sprintExpiryStatus`/`resolvedLevel` covering no-timestamp
  (never expires), `sprint_expiry_hours: 0` (disabled), within-window,
  past-window, and a custom expiry hours value; plus validation tests for
  malformed `sprint_expiry_hours`/`sprint_started_at`.
- `packages/cli/src/__tests__/level-dial-diff.test.ts` (new file): unit
  tests against `computeDialDiff()` directly — asserts a `level: protect`
  floor rule is never in `softened` or `hardened` at any transition, is
  always reported in `floors`, and that a no-op level switch reports zero
  changes.
- `packages/cli/src/__tests__/level.test.ts`: added CLI-level tests —
  `sprint_started_at` gets written/refreshed on `keel level sprint` and
  cleared on switching away; the dial-diff output for a fixture with a
  real floor rule never lists that floor id on the "soften" line; `keel
  status` announces expiry with the resolved (not raw) dial, and stays
  silent when sprint is still fresh.

## 4. Pre-existing ANSI-color test failures — fixed

All 4 were `toContain`/`toMatch` assertions against `execSync`-captured
CLI stdout, which is ANSI-colored in this environment even though the
captured stream isn't a TTY (chalk still detects color support from
`FORCE_COLOR`/similar in the ambient env — confirmed via
`NO_COLOR=1 ... vitest run`, which logged "'NO_COLOR' env is ignored due
to 'FORCE_COLOR' env being set"). Fix: a `stripAnsi()` helper
(`/\x1b\[[0-9;]*m/g`) added to `level.test.ts`'s `run()` helper, applied
to captured stdout before returning it — the CLI's own color behavior is
untouched. Verified both ways:

```
$ npx vitest run src/__tests__/level.test.ts            # default env (colored)
 Test Files  1 passed (1)
      Tests  27 passed (27)

$ NO_COLOR=1 npx vitest run src/__tests__/level.test.ts  # NO_COLOR forced
 Test Files  1 passed (1)
      Tests  27 passed (27)
```

(27, not 13 — includes the new sprint-expiry and dial-diff tests added in
this lane, described in §3.)

## 5. Suite results (full, unfiltered)

```
$ npm run build        # regenerates packages/cli/src/core and templates/keel-enforce.js
  — all 4 workspaces build clean, no errors

$ npm run lint          # tsc --noEmit, core + cli + mcp-server
  — clean, no errors

$ npm run test --workspaces
@get-keel/core:            Test Files  15 passed (15) | Tests  264 passed (264)
@get-keel/cli:              Test Files  46 passed (46) | Tests  649 passed (649)
@get-keel/mcp-server:       No test files (passWithNoTests)
@get-keel/opencode-plugin:  56/56 custom load-test checks PASS, including
                             the existing sprint/balanced/protect dial
                             matrix ("sprint: protect-level rule is a floor
                             (warns then blocks)", "keel level dial-down is
                             blocked", etc.) — the plugin bundle embeds
                             packages/core directly, so this is independent
                             confirmation the dialAction()/
                             effectiveHierarchyLevel() refactor didn't
                             change existing behavior anywhere it wasn't
                             supposed to.
```

`level.test.ts` is green in the default (non-NO_COLOR) environment, as
required.

## Files touched

- `packages/core/src/types.ts` — `sprint_started_at`, `sprint_expiry_hours` on `KeelConfig`
- `packages/core/src/enforce/rule-parser.ts` — `sprintExpiryStatus`, `resolvedLevel`, `winningLevelConfig`, `effectiveHierarchyLevel`, `dialAction`; validation for the two new config fields
- `packages/core/src/enforce/index.ts` — barrel exports for the above
- `packages/core/src/enforce/pipeline.ts` — `effectiveLevel()` and `enforcedAction()` now delegate to the shared helpers instead of re-deriving the precedence/softening logic inline
- `packages/cli/src/commands/level.ts` — `writeRulesLevel()` persists/clears `sprint_started_at`; `levelCommand()` prints the dial diff and an override note; `computeDialDiff()`/`printDialDiff()`/`DialDiff` added; no-arg report surfaces expiry
- `packages/cli/src/commands/status.ts` — dial line uses the resolved level; new expiry/countdown lines
- Tests: `packages/core/src/enforce/__tests__/level-reload.test.ts`, `packages/core/src/enforce/__tests__/rule-parser.test.ts`, `packages/cli/src/__tests__/level.test.ts` (extended), `packages/cli/src/__tests__/level-dial-diff.test.ts` (new)

Not touched (binding constraints honored): `packages/cli/src/core/**`
(generated — build ran before cli tests each time), `templates/keel-enforce.js`
(regenerated by `npm run build`, not hand-edited), `DEFAULT_RULES_YAML` in
install.ts/plugin.ts.
