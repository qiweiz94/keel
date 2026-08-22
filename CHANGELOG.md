# Changelog

## Unreleased

Adds `keel halt` / `keel resume`, a lockdown latch that is the deliberate inverse of
the existing `keel disable` kill switch — where the kill switch ALLOWS every call
while its sentinel exists, a halt DENIES every call while its sentinel exists, and
wins if both sentinels are set at once. This is the escape hatch keel previously
lacked: a per-call rule denial can be rephrased or retried by an agent, but a halt
is not a rule match — it is a strict, pre-rule override.

### Added

- **`keel halt [--reason <text>]` / `keel resume`**, mirroring `keel disable`/`keel
  enable`'s pattern (`packages/cli/src/commands/halt.ts`, modeled directly on
  `disable.ts`). Writes/removes `~/.keel/HALTED` via `resolveHome()` (never
  `process.env.HOME` directly — the same split-brain bug already fixed for
  `disable.ts`'s sentinel writer). The sentinel JSON carries `halted_at`, `reason`,
  and `auto_clear_on_restart: false` — deliberately no `expires_at`/`--until` of any
  kind, unlike `disable`: an industrial e-stop requires a manual reset, and letting
  a halt silently lapse on a timer would defeat the one property that makes it
  different from an ordinary rule. `haltSession(reason)` is exported separately
  from `haltCommand()` so a future rule type can trigger a halt programmatically
  without duplicating the sentinel-write logic; no such rule exists yet, and no
  code outside the CLI calls it in this release.
- **`checkHalt()` in `packages/core/src/enforce/pipeline.ts`**, checked at the very
  top of both `evaluateTiers()` (the tool-call path) and `evaluateClaimTier()` (the
  Stop-hook claim-to-evidence path) — ahead of `checkRuleVersion()` and ahead of the
  existing `DISABLED` kill-switch check, so a halt wins even when an agent has
  already run `keel disable`. Every call returns `deny`/`keel-halted` while halted,
  with no `expires_at` to consult. A corrupt `HALTED` sentinel fails closed toward
  HALTED (still denies) rather than throwing the way a corrupt `DISABLED` sentinel
  does — the opposite polarity, verified explicitly in
  `packages/core/src/enforce/__tests__/pipeline.test.ts`'s new `Halt` describe
  block. Deliberately NOT added to `evaluateOutput()` (the output-redaction path,
  which never blocks — skipping it during a halt would make a secret leak MORE
  likely, not less). New `haltFile?: string` config field mirrors the existing
  `disableFile?: string` for test isolation.
- **The OpenCode plugin (`packages/opencode-plugin/src/plugin.ts`) carries its own
  parallel `isHalted()`/`HALTED_PATH` check**, checked before its own `isDisabled()`
  short-circuit in the `tool.execute.before` gate. This plugin bundles its own copy
  of the enforcement gate separately from `pipeline.ts` (esbuilt into
  `packages/cli/templates/keel-enforce.js`), so the core-level fix alone would not
  have covered this host — confirmed via `packages/opencode-plugin/scripts/
  load-test.js`'s new halt checks, including one that halts with `DISABLED` also
  present and confirms the halt still wins.
- **Self-protection extended to the halt sentinel**: `no-rules-tampering` (paths),
  `no-enforcer-removal` and `no-self-protection-write` (regexes) now guard
  `~/.keel/HALTED` the same way they already guard `~/.keel/DISABLED`, and
  `keel-control-gate`'s verb list now includes `halt|resume` — an agent cannot run
  `keel resume` on a halt it is under, the same way it already cannot run `keel
  disable`. Identical edits landed in both `install.ts`'s and `plugin.ts`'s copies
  of `DEFAULT_RULES_YAML`; `packages/cli/src/__tests__/drift.test.ts` still passes,
  confirming the two stayed field-identical.
- **`keel status`, `keel dashboard` (terminal, `--json`, and `--web`), and `keel
  enable` now surface halt state**, rendered more severely than the kill switch
  (`chalk.bgRed.white.bold`) and resolved as one line rather than two — a user must
  never see "enforcement active" while every call is actually being denied. `keel
  enable` no longer reports a false "already enabled" while a halt is active.

Verified: full test suite green across all four workspaces (`npm test`), the
red-team harness (`node scripts/redteam/round2.mjs`) reports no floor regression
against a captured pre-change baseline, and the drift test confirms `install.ts`
and `plugin.ts` stayed in lockstep. Not yet live-verified against a real OpenCode
session — verified via the built plugin bundle and its own load-test script, the
same verification tier the existing `isDisabled()` kill-switch check in that file
carries.

Widens `unverified-package-install` — the slopsquatting gate that shipped in 0.4.0
as an npm-only resolve-check — to PyPI, crates.io, and Go modules, and teaches the
package verifier to read the same ambient registry configuration a real package
manager would before it denies anything. Both halves exist for the same reason: an
npm-only check is a check most agents route around by using a different ecosystem,
and a check that ignores a team's own private index denies that team's real packages
on the first try, with no warn-first grace period.

### Added

- **Package provenance beyond npm** (`packages/core/src/enforce/package-verifier.ts`).
  `unverified-package-install` now resolves install targets against PyPI, crates.io,
  and the Go module proxy in addition to the npm registry. Six real gaps a design
  audit found in the naive port were fixed before this shipped rather than after:
  flag-value tokens being read as package names (`pip -r`, `--index-url`, and
  friends produced false denies), PyPI private-index false denies, cross-ecosystem
  cache collisions on a shared name, pip extras and version-operator parsing
  (`pkg[extra]>=1.2`), a Go proxy 404 being treated as deterministic nonexistence
  when it is not, and — the one that would have silently defeated the entire defense —
  the PyPI age gate reading the **latest release date** instead of the package's
  **first-ever publish date**. A squatted name published yesterday and republished
  today reads as old under the former and new under the latter; only the latter is
  the signal the age gate exists to test. `cargo install` (a binary-install
  subcommand, not a dependency add) is explicitly out of scope.
- **Ambient package-resolution config awareness**
  (`packages/core/src/enforce/ambient-registry-config.ts`, new). A separate,
  offline, local-only pass that reads the same files and environment variables a
  real package manager would — `.npmrc`, `pip.conf`, `.cargo/config.toml`,
  `GOPRIVATE` — and downgrades a would-be deny onto the existing `privateIndex`
  path when a team's internal registry is configured ambiently with no command-line
  flag at all. This closes a real false-deny class: the rule denies on the first
  unscoped 404 with no warn-first grace, so a team whose internal index lives only
  in `.npmrc` had its own real packages denied on the very first attempt. Zero
  network access; config files only.
- **Dependency-confusion detection.** A new warn for the inverse shape: ambient
  config marks a name as belonging to a private index, but the command explicitly
  forces the public registry. `decidePackageAction` places this warn strictly BELOW
  `not_found`/`unverified`/`age_gate` in the decision ladder, so a forced-public
  flag can never be used to escape a real deny by shifting the verdict onto a
  softer reason.

### Fixed

- **An `npm --registry=` deny-escape in the ambient-config downgrade, caught in
  review and closed before merge.** The first cut of `applySpecAmbient`'s npm path
  treated ANY explicit `--registry=<value>` that wasn't the public registry as proof
  of a private index, with no on-disk config required at all — meaning an agent
  could append `--registry=https://evil.example` to its own hallucinated install and
  permanently turn a real deny into a mere prompt. Ambient config is what a team sets
  up ahead of time; it is not a flag the policed agent writes for itself. The explicit-
  override path now downgrades on exactly one case: ambient config ALREADY marks the
  name private AND the flag forces the public registry. Any other `--registry=` value
  with no matching on-disk config falls through untouched. Cargo's `--registry <name>`
  form was left as-is — it requires the name to already exist in a
  `[registries.<name>]` table read from disk, so a flag alone cannot fabricate it the
  way npm's could.

Verified: new `package-verifier.test.ts` coverage for all four ecosystems and each
of the six ported-gap classes; a dedicated security regression test proving the
`--registry=` escape stays closed; cache-only coverage for the ambient downgrade
(the code path `pipeline.ts` actually calls, as distinct from the direct-call path);
and a pipeline test showing the ambient case resolves on the first attempt against a
no-config control that still needs a retry to deny. Registry reachability itself is
network-dependent by construction — a network failure resolves to `unverified`
(prompt), never to a silent allow and never to a deny.

Adds `type: session`'s first real handler — a composite runaway-loop trip
(`session-runaway-trip`) across five session-scoped dimensions. `rule-parser.ts`
previously rejected every `type: session` rule outright (`notImplemented` Set) and
`pipeline.ts` carried a `continue`-only stub claiming duration was "handled by
context manager" — false; `context-manager.ts` is unrelated token-count-triggered
re-injection. Both are now real.

### Added

- **`session_escalation` on `KeelRule` (`packages/core/src/types.ts`)**, replacing
  the old, never-consumed `max_duration_minutes` field entirely. An array of
  `{ dimension, at, action, message?, halt? }` steps across five dimensions:
  `duration_minutes`, `tool_calls`, `bash_calls`, `file_write_churn` (all pure
  VOLUME counters), and `consecutive_failures` (failure-aware, reset on any
  success — the same shape `no-repeat-loops`'s `require_failure` already uses).
  **Safety-critical, enforced structurally, not by convention**:
  `validateRules()` (`rule-parser.ts`) now rejects `action: deny|block` or
  `halt: true` on any step whose dimension isn't `consecutive_failures` — a
  legitimate long session must never be able to reach `keel halt` on call volume
  alone. Also rejects a `type: session` rule with no `session_escalation` entries
  at all (no detection surface — the same class of error `oracle` rules missing a
  `trigger` already get), closing off the exact "declared but inert" shape this
  rule type used to have.
- **`session-tracker.ts` / `session-store.ts` (new, `packages/core/src/enforce/`)**.
  `PersistentSessionStore` keeps ALL FIVE dimensions for one `(ruleId, session_id)`
  in a SINGLE record under ONE file lock (`session-tracker.json` in
  `KEEL_STATE_DIR`) — deliberately not five separately-locked counters, which
  could produce a torn composite read across two racing `keel hook` processes.
  Keyed WITHOUT `cwd` (unlike `PersistentStuckStore`): a session's duration and
  call counts belong to the session, not to whichever directory the agent
  happened to be in when a given call fired. `SessionTracker.check()` resolves
  the WORST met step across all five dimensions on any given call, deterministic
  tie-break by severity then threshold then declaration order.
- **`pipeline.ts`'s session-trip branch** (`rule.type === 'session'`) replaces the
  old dead stub: bumps activity every call a `type: session` rule is active for,
  checks the composite ladder, and — ONLY when the returned verdict actually
  resolved to `deny`/`block` (accounting for the `sprint` dial's downgrade and a
  consumed `keel allow --once` override — never from the escalation step's
  declared action alone) AND the step carried `halt: true` — writes the `keel
  halt` sentinel via the new `halt-writer.ts`. Passes `skipFirstWarning: true`
  into `violation()`, the same flag `no-repeat-loops` (`type: stuck`) already
  passes and for the identical reason: without it, the terminal deny+halt step's
  FIRST hit downgraded to pipeline.ts's separate warn-once-then-block grace
  ("First violation... warning only") — verified live before the fix, since the
  ladder's own lower steps already ARE the escalation, and stacking a second
  warn-once grace on top silently defeated the terminal step every time.
  `file_write_churn` is gated on `WRITE_TOOL_NAMES` (now exported from
  `verification.ts`, reused rather than re-invented) instead of a
  `!/^read/i.test(tool)` heuristic — the looser form was tried first and
  rejected: `Grep`/`Glob`/`LS` all take a resolvable `path` argument and aren't
  "read"-prefixed, so an agent searching 80 directories would have counted as 80
  distinct file writes. `session-tracker.ts`'s "worst met step wins" tie-break
  prefers the failure-aware dimension over a volume dimension on an equal
  severity tie (previously "higher `at` wins" alone), so a call that crosses
  both `tool_calls@500` and `consecutive_failures@3` at once reports the
  actionable failure signal, not the coincidental call-count threshold.
- **`halt-writer.ts` (new, `packages/core/src/enforce/`)**: `writeHaltSentinel()`,
  the core-side counterpart to `halt.ts`'s `haltSession()` that `packages/core`
  needed but couldn't import (see `halt.ts`'s own header comment on the cli→core
  build direction). Writes the identical sentinel shape (`halted_at`, `reason`,
  `auto_clear_on_restart: false`) at the identical path
  (`config.haltFile || join(resolveHome(), '.keel', 'HALTED')`, matching
  `checkHalt()`'s own resolution exactly) so `keel status`/`keel resume` read a
  rule-triggered halt identically to a manual one.
- **`session-runaway-trip`, a new default rule** (`install.ts` and
  `plugin.ts`'s `DEFAULT_RULES_YAML`, byte-identical — `drift.test.ts`'s rule
  count bumped 46 → 47): duration 240m/480m, tool-calls 500/1000, Bash-calls
  300/600, file-write-churn 40/80 (all warn/prompt only), consecutive-failures
  3/5/8 (warn/prompt/deny+halt). Ships `mode: observe` — unlike `no-repeat-loops`,
  this rule has no measured hit-rate evidence yet, so it starts exactly where
  `no-repeat-loops` and the still-observing `runaway-budget-*` rules did, not as
  a promotion. `category: resource` (matching `bash-rate-limit`'s precedent),
  `priority: 0` (same tier as the two `runaway-budget-*` rules — all three are
  `mode: observe` today so evaluation order has no effect yet).
- **`keel validate`/`keel status` now surface a session-id-scoping caveat** when a
  `type: session` rule is active: `hook.ts`'s `parsePayload` confirms a real
  session id only for claude-code/codex/gemini/cursor; cline is best-effort (4
  spellings tried); `generic` may send none at all, in which case `keel hook`'s
  per-process fallback id makes every "session" look like exactly one call and
  the composite trip silently never advances. Core cannot detect this (it only
  ever sees an opaque string) — surfaced explicitly at the CLI layer instead of
  degrading silently.
- **`fixture-harness.test.ts`'s `expectedActionFor()`** gained a
  `rule.type === 'session' && rule.session_escalation` branch mirroring the
  existing `type: stuck` escalation-ladder special-case, plus
  `tests/rules/session-runaway-trip/{must-block,must-allow}.yaml` fixtures.
- **`pipeline.test.ts`'s new `Session composite trip` describe block** covers the
  full ladder, the halt-sentinel write (and, critically, the three cases where it
  must NOT write: `mode: observe`, the `sprint` dial downgrading the terminal
  deny to warn, and a consumed override), a long successful session capping at
  `prompt` and never reaching `deny`/halt, `exitCode === null` being a true no-op,
  a missing `session_id` being a safe no-op, `file_write_churn` excluding
  read-only search tools and not double-counting a repeated path,
  `duration_minutes` advancing live across calls with fake timers (idle-overnight
  shape), and — because `cli/enforce.ts` wires a REAL `PersistentSessionStore`
  in production while every other case here uses `SessionTracker`'s in-memory
  fallback — a nested `with a real PersistentSessionStore (cross-process)` group
  that re-runs the ladder/reset/null-exit-code cases through the disk-backed
  store and proves a second, freshly-constructed `SessionTracker` sharing the
  same store directory sees the first instance's accumulated failures (the exact
  gap this store exists to close for `keel hook <host>`'s fresh-process-per-call
  shape).

Verified: full test suite green across all four workspaces (`npm test`), the
red-team harness (`node scripts/redteam/round2.mjs`) reports no new regressions,
and the drift test confirms `install.ts` and `plugin.ts` stayed field-identical
at 48 rules. An in-process micro-benchmark (500 sequential `evaluate()` calls)
measured the `PersistentSessionStore`-backed hot-path cost at ~0.34ms/call over
the no-tracker baseline — comfortably inside the pipeline's own <50ms tier
budget. Shipped in `mode: observe` — see `docs/tiers.md` for why, and for
the same promotion bar `no-repeat-loops` itself had to clear first.

Adds `type: budget` — real LLM API token/dollar spend limits, read from a host's own
local transcript/session record. Keel's hook architecture had no visibility into
token/dollar usage before this: that data lives in the model response, which no
PreToolUse/PostToolUse-style hook ever sees. This is distinct from the pre-existing
`runaway-budget-tool-calls`/`runaway-budget-bash-calls` (`type: rate`) rules, which
only ever count tool-call VOLUME in a time window and say so in their own rationale.

### Added

- **`type: budget` rule type** (`RuleType` in `packages/core/src/types.ts`, `validTypes`
  in `packages/core/src/enforce/rule-parser.ts`) — new `max_tokens`/`max_dollars`/
  `hard_stop_multiplier` fields on `KeelRule`. `validateRules()` rejects a `type: budget`
  rule with neither `max_tokens` nor `max_dollars` set.
- **`packages/core/src/enforce/budget/claude-transcript.ts`**
  (`measureClaudeCodeSpend`) — sums a Claude Code session's real token/dollar usage
  directly from its own JSONL transcript, given the LITERAL `transcript_path` from the
  host's own hook payload (never a `cwd` slug — Claude Code's own slug convention
  replaces `/`, `.`, and literal `-` all with `-`, which is provably lossy:
  `/Users/foo/my-project`, `/Users/foo/my.project`, and `/Users/foo/my/project` all
  slugify identically). **Live-verified this lane** against a real transcript on the
  build machine: (1) 63% of assistant lines in a real parent transcript carried a
  snake_case `session_id` that did NOT match the file's own identity (Task/subagent
  cross-references to separate child `.jsonl` files) — this reader deliberately sums
  every line in the file with no per-line session filter, since `transcript_path`
  already settles file identity; (2) real `message.model` values on ordinary sessions,
  including keel's own live-verify fixtures, include short aliases
  (`claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5`) that are NOT official
  Anthropic model IDs, plus `<synthetic>` (always all-zero usage, skipped). Model
  pricing lookup (`DEFAULT_PRICE_TABLE`) is exact-string-match only — an alias or any
  unrecognized model still contributes tokens to the running total but forces the
  WHOLE session's dollar figure to `null`, never a partial/undercounted total presented
  as the true one.
- **`packages/core/src/enforce/budget/opencode-db.ts`** (`measureOpenCodeSpend`) — a
  COMPLETELY SEPARATE implementation for OpenCode, not a variant of the transcript
  reader: OpenCode has no per-session transcript files at all. **Live-verified this
  lane** against a real installed OpenCode's actual `~/.local/share/opencode/
  opencode.db` schema: its `session` table already carries `cost` computed in dollars
  by OpenCode itself (spanning heterogeneous providers — `opencode-go`, `ollama-local`,
  `hy3`, `deepseek-v4-flash`, `glm-5.1` — that a keel-side pricing table would be
  hopeless for and unnecessary), plus `tokens_input`/`tokens_output`/`tokens_reasoning`/
  `tokens_cache_read`/`tokens_cache_write` rollup columns. No model-normalization logic
  exists in this reader at all — there is no per-model lookup to get wrong. Uses
  `node:sqlite`, imported dynamically so a runtime without it degrades to
  `unavailable: true` rather than crashing the plugin hook.
- **Two-phase, race-free enforcement** (`packages/core/src/enforce/budget-tracker.ts`,
  `BudgetTracker`/`PersistentBudgetStore`) — SAFETY-CRITICAL architectural constraint:
  Claude Code's `Stop` hook is observe-only (`docs/integration-guides/claude-code.md`)
  and cannot block, because the turn has already completed by the time it fires. A
  spend measurement is recorded from a Stop/PostToolUse-equivalent hook OUTSIDE
  `EnforcementPipeline.evaluate()`'s PreToolUse path
  (`EnforcementPipeline.recordBudgetSnapshot()`, called from `hook.ts`'s
  `recordClaudeCodeBudgetSnapshot` on Claude Code, and from `plugin.ts`'s
  `tool.execute.after` on OpenCode); it persists an over-budget flag to
  `~/.keel/state/budget-tracker.json`; only the NEXT `PreToolUse` call denies, by
  reading that persisted flag — the pipeline's `type: budget` branch never re-reads a
  transcript or database on the blocking path. This is the same "warn on first
  violation, persisted state blocks on repeat" ladder every other deny rule in this
  ruleset already uses (`EnforcementPipeline.violation()`'s existing
  `denyFirstTime`/`StateManager` mechanism — no new warn-ladder was built). Proven
  end-to-end through the real built CLI and shell hook templates in
  `packages/cli/src/__tests__/budget-lane-hook.test.ts`: a Stop call measuring a
  grossly-over-budget synthetic transcript still exits 0, the next PreToolUse call
  warns (first hit), and the one after that denies (exit 2) — with a companion case
  proving a missing `transcript_path` never fabricates a deny from zero data.
- **`packages/core/src/enforce/halt-writer.ts`** (`writeHaltSentinel`) — the core-side
  counterpart of `cli/halt.ts`'s `haltSession()` that lane's own header comment
  anticipated needing (`packages/core` cannot import from `packages/cli`; the build
  direction is cli → core). Writes the identical sentinel shape. `BudgetTracker`'s
  `hard_stop_multiplier` escalation is its first caller, gated so a `mode: observe`
  rule (what the shipped default ships as) can NEVER trigger it — only a rule that is
  actually enforcing can.
- **`session-spend-limit`**, the 48th default rule (`type: budget`, `max_tokens:
  2000000`), shipped `mode: observe` pending real-traffic burn-in of the Claude Code
  model-normalization logic above — see `docs/tiers.md`. Identical text landed in both
  `install.ts`'s and `plugin.ts`'s copies of `DEFAULT_RULES_YAML`;
  `packages/cli/src/__tests__/drift.test.ts` confirms the two stayed field-identical.

Verified: full test suite green across all four workspaces (`npm test`: core 760
passed, cli 954 passed, mcp-server 10 passed, opencode-plugin's load-test all PASS),
the red-team harness (`node scripts/redteam/round2.mjs`) reports no new floor
regression, and the per-rule fixture harness
(`packages/cli/src/__tests__/fixture-harness.test.ts`) covers `session-spend-limit`'s
must-block/must-allow cases including an unavailable-measurement case that must never
be silently read as under budget. Honesty note: Claude Code's transcript shape and
OpenCode's SQLite shape are both live-verified against real installs on the machine
this lane was built on; every other host (`docs/integrations.md`'s new "Real
token/dollar spend" table) is explicitly unsupported, not silently assumed to work.

Fixes a false-positive class in `no-secrets-in-code` that made the rule actively
hostile to ordinary documentation work: AWS's OWN documented example key,
`AKIAIOSFODNN7EXAMPLE`, is secret-shaped by construction and denied every real
write of a doc, test fixture, or README that quoted it. The fix is deliberately
narrow — an allowlist of deterministic shapes only, with entropy demoted to a
diagnostic that can never soften a verdict.

### Fixed

- **A local, offline placeholder-shape allowlist for `no-secrets-in-code`**
  (`packages/core/src/enforce/secret-confidence.ts`, new; wired in
  `packages/core/src/enforce/pipeline.ts`). Exactly three things clear a match: an
  exact known literal from a small shipped list, AWS's documented `EXAMPLE`-suffix
  convention, and a redaction-shaped run of one repeated character
  (`xxxxxxxx`, `********`). Everything else that is genuinely secret-shaped still
  blocks exactly as it did before. No network call, no model call, no heuristic
  scoring on the deciding path.
- **Entropy is computed and logged, but is diagnostic-only and never softens a
  deny.** This is the deliberate design choice, not an unfinished one: an
  entropy threshold that can downgrade a verdict is a threshold an attacker tunes
  a payload under. Entropy appears in the recorded diagnostic so a human reviewing
  a trace can see what the scorer thought; it has no path to the verdict.
- **The write path stays gated on `redact_span`**, so the label-only patterns
  (both PEM `BEGIN` headers, `aws_secret_access_key[\t ]*[:=]`) are untouched by
  this allowlist — a placeholder-shaped VALUE never clears a match on the LABEL.

Verified: `packages/core/src/enforce/__tests__/secret-confidence.test.ts` (new)
covers each allowlist shape, the entropy-never-softens property, and a corpus of
real-shaped credentials that must all still deny. `install.ts` and `plugin.ts`'s
copies of `DEFAULT_RULES_YAML` took the matching one-line edit and
`packages/cli/src/__tests__/drift.test.ts` confirms they stayed field-identical.

Adds `type: oscillation`, the A→B→A cycle detector ROADMAP.md named as a planned
sibling of `type: stuck`. `no-repeat-loops` catches an agent hammering ONE failing
command; this catches an agent alternating between two or three failing
commands/edits — a real stuck pattern that looks like activity and goes nowhere.
The other half of that roadmap item, semantic livelock, was assessed and
deliberately NOT pursued; see below.

### Added

- **`type: oscillation` rule type** (`RuleType` in `packages/core/src/types.ts`,
  `validTypes` in `rule-parser.ts`) with `min_cycle_length` (default 2),
  `max_cycle_length` (default 4), `min_cycle_repeats` (default 2), and the same
  `require_failure`/`escalation` fields `type: stuck` already uses. Detects a
  repeating CYCLE of >= 2 DIFFERENT command fingerprints
  (A→B→A→B, or A→B→C→A→B→C) inside a session's small rolling window (default: the
  last 8 calls).
- **`oscillation-tracker.ts` / `oscillation-store.ts` (new,
  `packages/core/src/enforce/`)**, mirroring `stuck-tracker.ts`/`stuck-store.ts`'s
  file-locked, TTL-bounded shape rather than inventing a second persistence
  pattern. One documented deviation: `check()`'s persisted-vs-local comparison uses
  `>=` where `stuck-tracker.ts` uses a strict `>`. This is safe and is commented in
  place — entry-array length can tie without the two disagreeing, because
  `recordOutcome` writes through and then mirrors the exact result.
- **Complementary to `no-repeat-loops`, never redundant with it — by
  construction.** An exact single-command repeat can never satisfy oscillation's
  distinct-fingerprint requirement, and a distinct-fingerprint cycle can never
  satisfy the exact-repeat detector. The two structurally cannot double-count the
  same evidence.
- **`command-oscillation`, a new default rule** (`install.ts` and `plugin.ts`'s
  `DEFAULT_RULES_YAML`, byte-identical). Ships `require_failure: true`, mirroring
  `no-repeat-loops`' own discriminator: a legitimate TDD red-green-refactor loop
  (edit test, edit code, edit test, edit code — literally period-2 alternation) is
  excluded by construction because each step succeeds. Ships `mode: observe` with
  zero measured hit-rate evidence — see `docs/tiers.md` for the same promotion bar
  `no-repeat-loops` had to clear.
- **Known gap, left undone rather than force-fit:** an agent oscillating between
  edits that each individually SUCCEED (reverting a file to a prior state and back)
  needs a content-state signal no tracker in this codebase feeds today.
- **Semantic livelock — the other half of the roadmap item — was assessed and not
  pursued.** Keel's actual signal set is command fingerprints plus exit codes, with
  no visibility into what a command DOES; it has no notion of semantic convergence.
  A real "no net progress" detector needs content-state hashing nothing here feeds.
  Forcing a weak proxy (treating any non-exact, non-cyclical activity as
  "not converging") would be indistinguishable from normal work, and was rejected
  rather than shipped.

Verified: `packages/core/src/enforce/__tests__/oscillation.test.ts` (new) covers the
escalation ladder, the `require_failure` discriminator, non-double-counting against
`no-repeat-loops`, and window aging; plus
`tests/rules/command-oscillation/{must-block,must-allow}.yaml` fixtures through the
per-rule fixture harness. Wired into `pipeline.ts`, `enforce.ts`, `daemon.ts`, and
the OpenCode plugin's own bundled copy.

Adds `keel run`, a supervisor that spawns an agent command detached so
`keel halt --kill` can reach a call that is ALREADY EXECUTING — the gap the halt
latch left open, since a hook can only stop a call it sees before it starts. Tier B
in the halt design: Tier A denies the next call, Tier B terminates the current one.

### Added

- **`keel run <command...>`** (`packages/cli/src/commands/run.ts`,
  `run-state.ts`). Spawns detached on POSIX and records pid, pgid, and a process
  identity triple (start time + argv + boot id, all treated as OPAQUE strings, never
  parsed) into a keyed state file, so more than one supervised run can be tracked
  concurrently.
- **`keel halt --kill`** (`packages/cli/src/commands/run-kill.ts`). Re-verifies
  liveness AND identity before sending any signal; refuses on pgid 0 or 1; refuses
  on keel's own pgid; refuses when identity cannot be confirmed; and escalates
  SIGTERM → SIGKILL only after a grace window. **Every ambiguous case resolves to
  refusal — the opposite fail-safe direction from the rest of this codebase's binary
  flags**, deliberately, because a wrong-target kill signal has no safe default the
  way a wrong-direction deny does.
- **`keel status` surfaces supervised runs**, so a human can see what `--kill`
  would target before running it.

### Fixed

- **A bypass in the command-text normalizer that `keel run` would otherwise have
  opened.** Every `type: command` rule — `no-destructive-commands`, `no-force-push`,
  the secret patterns, `keel-control-gate` itself — matched only the raw command
  string, so `keel run "rm -rf /"` would have hidden the real payload from the
  entire ruleset behind a benign-looking wrapper. `command-normalizer.ts` now
  unwraps the wrapped agent command the same way it already unwraps a `shell -c`
  body, before any rule sees it.

Deliberately not done, with reasons:

- **`keel run` is NOT on `keel-control-gate`'s blocked-verb list.** Every other
  gated verb turns enforcement off or clears a lockdown; `run` starts something new.
  An agent already has an ungated path to the same background-process risk through
  plain shell detach syntax, so gating `run` would remove the one channel a human
  can later kill without closing the real gap.
- **Windows gets a plain, unsupervised `run` rather than a refusal to work at
  all.** Job-object supervision needs native bindings this repo does not ship, and
  the Windows CI lane only runs a type check.

Verified: `run.test.ts` and `run-kill.test.ts` (new) cover the identity-verification
refusals (dead pid, reused pid with a different identity, pgid 0/1, keel's own
pgid), the SIGTERM→SIGKILL grace escalation, and multi-run state keying;
`control-gate.test.ts` covers the deliberate `run` non-gating decision;
`no-side-effects.test.ts` covers the new command paths; and
`command-normalizer.test.ts` covers the wrapper-unwrapping bypass fix.

A batch of six correctness and security-hardening lanes closed via targeted
follow-up investigation across the enforcement pipeline, package-provenance
checks, and host integrations: a stale-discharge race in verification-obligation
tracking, two real command-floor bypasses, a label-only secret match that was
detected but never actually redacted, real post-action hook wiring for two more
hosts, a fail-open claim that turned out more pessimistic than the installed
runtime's actual behavior, and two package-manager detection gaps.

### Fixed

- **Verification obligations no longer discharge stale test runs (a generation
  race).** `VerificationTracker.markSatisfied()`
  (`packages/core/src/enforce/verification.ts`) had no version check: a test run
  whose `PreToolUse` fired before a *later* edit re-armed the same obligation
  could still clear that later edit's obligation on `PostToolUse`, discharging a
  result that never actually covered it. Fixed with a generation stamp recorded
  at the moment a satisfying command is observed to *start*
  (`observeSatisfyStart()`, called from `pipeline.ts` alongside the existing
  `observeTrigger()`); `markSatisfied()` now compares that start-time generation
  against the obligation's current generation and refuses to clear it if a later
  edit bumped the generation while the run was still executing. The ordinary
  edit-then-test-then-discharge order is unaffected. New tests in
  `verification.test.ts` cover both the race (stays armed) and the correct-order
  case (still discharges).
- **`no-destructive-interpreter-body` is no longer evadable via Python module
  aliasing.** `python3 -c "__import__('shutil').rmtree('/')"` and both
  `getattr(shutil, 'rmtree')(...)`/`getattr(__import__('shutil'),
  'rmtree')(...)` forms previously allowed — the floor regex required the
  literal token `shutil.rmtree`. Widened to also accept the module obtained via
  `__import__('shutil')` in place of a plain `shutil` name, and
  `getattr(<module>, 'rmtree')(...)` in place of dot notation, keeping the same
  root/home-only target scoping (`install.ts`/`plugin.ts`'s `DEFAULT_RULES_YAML`,
  kept field-identical). Verified via `scripts/redteam/round2.mjs`: both probe
  strings moved from allow to deny, no previously-caught probe regressed.
  SECURITY.md's disclosed residual is updated from "known gap" to "found then
  fixed."
- **The quote-wrapped `${IFS}` word-splitting bypass is closed.**
  `rm"${IFS}"-rf"${IFS}"/` and `rm'${IFS}'-rf'${IFS}'/` previously allowed:
  `command-normalizer.ts`'s `renderToken()` stripped quotes on a
  whitespace-free quoted span but never called `expandVars()` on it, unlike the
  unquoted branch. Both forms now expand and correctly deny via
  `no-destructive-commands`. Deliberately does not distinguish single- from
  double-quote shell semantics (real shells do; this bounded, floor-only
  matching surface treats both as obfuscation vectors, not real variable data).
  One narrower form remains open, disclosed rather than silently absent:
  `rm${IFS:0:1}-rf${IFS:0:1}/` (a parameter-expansion modifier `VAR_RE` doesn't
  recognize) — tracked as a `bypass-attempt` probe in
  `scripts/redteam/round2.mjs`.
- **Output redaction now widens a label-only secret match to cover the secret
  bytes that follow it, instead of leaving them exposed.** `evaluateOutput()`
  detected but never redacted the three label/header-only patterns
  (`aws_secret_access_key[\t ]*[:=]`, both PEM `BEGIN` headers) — a real key
  value or private-key body flowed through fully intact with only a detection
  flag noting something was found. New opt-in, output-path-only
  `KeelRule.patterns[].redact_widen` (`'line' | 'pem'`) extends a matched label
  forward, bounded (4KB for `line`, 8KB for `pem`), to the next newline or a
  matching `-----END ... PRIVATE KEY-----` footer, and redacts the whole
  widened span. A widen that hits its bound without finding a boundary is still
  redacted up to the cap and flagged in the new
  `EnforceResult.redaction_incomplete_rule_ids`, rather than silently claimed
  complete. The write-side deny-on-write check (Tier 5) is completely untouched
  by this field, same scoping as the existing `redact_span`. Shipped on the
  three patterns above in the default ruleset (`install.ts`/`plugin.ts`).
- **OpenClaw's fail-open claim was more pessimistic than the installed
  runtime's actual behavior — corrected.** README.md, `docs/integration-
  guides/hermes.md`, and the OpenClaw plugin's own circuit-breaker comment
  (`packages/cli/templates/openclaw/index.mjs`) previously stated "OpenClaw
  fails open by design" without qualification. Reading the installed 2026.4.15
  runtime's compiled source shows that's only true for a plugin-*load* failure
  (issue #20914, closed as stale without a fix) — a `before_tool_call` *handler*
  that throws mid-call is caught by OpenClaw's own hook runner and turned into a
  block instead. Also confirmed the openclaw/openclaw#5943 concern
  ("`before_tool_call` might not fire at all") is a closed, stale issue, and
  that the hook is wired into the tool-execution call graph in the installed
  build — `docs/integrations.md` footnote 1 carries the full trace.
  `installOpenClaw()` (`packages/cli/src/commands/install.ts`) now prints the
  real, verified `openclaw config set plugins.load.paths/allow ...
  --strict-json` commands instead of a hand-edit config sketch, and warns that
  `config set` *replaces*, not appends, the array at that path. Still open, and
  said so plainly: no live `openclaw agent` turn against a configured provider
  has been run to observe an actual tool call reach keel's daemon.
- **`.npmrc` `${VAR}` references now resolve, and can no longer manufacture a
  fake private-registry host.** `parseNpmrc()`
  (`packages/core/src/enforce/ambient-registry-config.ts`) now interpolates
  `${VAR_NAME}` against the environment via the new `interpolateEnvVars()`; an
  *unset* variable is left as the literal `${VAR_NAME}` text (never substituted
  with an empty string, which could silently corrupt a registry URL a
  different, worse way). `hostOf()` separately refuses to read a value that
  still contains an unresolved `${...}` as a real hostname, closing the path
  where a crafted project `.npmrc` (e.g. `registry=https://${UNDEFINED_VAR}/`)
  could otherwise manufacture a host that merely fails to equal
  `registry.npmjs.org` — exactly the shape that would downgrade a would-be deny
  into an ambient-private allow.
- **`python -m pip install <pkg>` / `python3 -m pip install <pkg>` are now
  recognized as pip installs.** `extractPackageInstalls()`
  (`packages/core/src/enforce/package-verifier.ts`) only matched a bare
  `pip`/`pip3` token as the package manager, so this very common invocation
  style silently fell through unrecognized and skipped ambient-registry/
  hallucination checks entirely. Routed through the exact same pip-handling
  logic as a bare `pip install` (consumes the `python`/`python3` + `-m` prefix,
  then continues unmodified into the shared manager-detection code) rather than
  duplicating any pip-specific parsing. `cargo install` (a different, binary
  install subcommand) remains explicitly out of scope, unchanged.

### Added

- **Real post-action hooks wired for Cursor and Cline's claim/verification
  discharge.** Cursor's `postToolUse`/`postToolUseFailure` (the discharge path)
  and `afterAgentResponse` (the claim-text path) are now real, typed events
  read from the installed Cursor.app's own bundled `cursor-agent-exec`
  extension — not documented at cursor.com/docs/hooks. For a shell command, a
  real exit code is read out of `postToolUse`'s `tool_output` JSON; every other
  tool type is left `null` rather than guessed at. Cline's `PostToolUse`
  (`tool_result`) and `TaskComplete` (`agent_end`) are now real
  `HookConfigFileName` entries read from the installed `cline` CLI's compiled
  `@cline/core` bundle. `TaskComplete`'s `turn.outputText` fully wires the
  claim path; `PostToolUse`'s discharge stays deliberately `null`-only —
  whether a failing shell command trips Cline's own success flag could not be
  pinned down from any source available in this setup. Both close
  `docs/integrations.md`'s prior "NO CHANNEL CONFIRMED" cells with a
  types-tier citation apiece, still short of a live-host guarantee. New
  templates `cline-posttooluse.sh`/`cline-taskcomplete.sh`, wired into `keel
  install` (`install.ts`); new `cline-claim-hook.test.ts`/`cursor-claim-
  hook.test.ts`, plus new coverage added to the existing `hook-command.test.ts`.

Verified per-lane, not as one combined pass: the Python-aliasing bypass fix
against `scripts/redteam/round2.mjs` (both probe strings moved from allow to
deny, no previously-caught probe regressed); the quoted-IFS bypass fix via new
`command-normalizer.test.ts` cases plus its own `bypass-attempt` probe added to
`scripts/redteam/round2.mjs`; targeted new/updated unit tests for the
verification-race, output-redaction-widening, `.npmrc` interpolation, and
`python -m pip install` items (see each commit under this range for its own
test additions); and the Cursor/Cline hook wiring against the installed
runtimes' own compiled source and type definitions, still short of a live
exercised call on either host.

Moves `keel check` off the legacy `PolicyEngine` and onto the same
`EnforcementPipeline` every other host already uses. This supersedes the earlier
disclosure of `keel check`'s weaker command-matching path: that gap is closed
rather than merely documented, and SECURITY.md's corresponding section has been
rewritten to match. Several real behavior changes came with the move, listed
plainly below — including two capabilities that were dropped outright with no
replacement anywhere in the platform.

### Changed

- **`keel check`/`keel check --ci` now evaluate through `initEnforce` /
  `evaluateToolCall` against the `.keel/rules.yaml` four-tier hierarchy**
  (`packages/cli/src/commands/check.ts`), exactly as `keel hook <host>`,
  `keel evaluate`, and `keel daemon` do. It previously built its own `PolicyEngine`
  against `.keel.yaml` — **a file only the old `keel init` ever wrote, which the
  real install flow never creates** — so in practice this command was quietly
  grading every project against a hardcoded default policy rather than against the
  user's actual rules. All of `command-normalizer.ts`'s hardening (quote-strip,
  compound-command splitting, inline variable expansion, `${IFS}` defeat
  protection, interpreter-body extraction, `keel run` wrapper-unwrapping) now
  applies to `keel check` identically. Only CLI-specific ergonomics — the `--ci`
  staged-file loop and `--analyze-reasoning` — remain distinct from the other hosts.
- **`no-verify-bypass` and `broad-privilege-escalation` now warn through
  `keel check` rather than hard-blocking.** This is a severity DROP via
  `keel check` specifically, and it is a correction, not a regression: the old code
  re-raised both to a block regardless of what the rule itself declared, making
  `keel check` stricter than every other enforcement surface on the same two rules.
  Both rules ship `action: warn`; `keel check` now honors that, matching every
  other host.
- **A plain `keel check --file <path>` read (no `--write`) no longer scans file
  content for secrets.** `type: content` rules are write-side only — this is the
  read/write split every other host already has, now applied here too.
  `--write` and `--ci` still scan content.
- **Two pieces of coverage were dropped outright, with no replacement anywhere in
  the platform yet:** the MCP-github-specific bypass message
  (`mcp__github__*` writes bypassing local git hooks), and the
  `HUSKY=0` / `LEFTHOOK=0` / `SKIP=`-prefixed environment-variable hook-bypass
  detection. Neither has a default-rule equivalent. `--no-verify` and
  `core.hooksPath` bypass detection itself is still covered, via the
  `no-verify-bypass` rule.
- **`keel check` no longer emits the legacy signed, hash-chained receipts and audit
  log** (`.keel/audit/audit.log`, `.keel/receipts/`). Nothing is lost that ever
  worked through another host: that log was a `PolicyEngine`-only artifact, and no
  enforcement host ever fed it. `keel check` still produces the same unsigned
  per-call audit trail every other host does (`~/.keel/traces/`, rendered by
  `keel enforce --audit`); it simply no longer keeps a second, signed copy that
  nothing else in the platform wrote to either. `audit.ts` and `verify.ts` had their
  messaging corrected accordingly — `keel verify`'s receipt/chain-verification half
  only ever had legacy-path coverage to begin with.

### Added

- **`packages/cli/src/commands/check-helpers.ts` (new)** — faithful, standalone
  ports of `PolicyEngine`'s `checkPKillPython` method and `checkSecret`'s pattern
  list, landed one lane ahead of the migration precisely so these two checks would
  not be lost in it. Both fill a real gap in the modern default ruleset:
  `no-destructive-commands` has zero `pkill` coverage, and `no-secrets-in-code`
  only ever scans write-tool CONTENT, never a Bash tool's `command` argument. The
  migration imports both directly.
- **New fail-loud behavior when no rules file exists at any of the four tiers**
  (global, user, project, local): `keel check` prints a loud warning and exits 0
  instead of quietly treating every action as allowed. Helper checks, syntax
  verification, behavioral-anomaly detection, and reasoning analysis all keep
  running in that state — only the rule-driven evaluation is skipped — so a bare
  project still gets partial coverage instead of going fully silent, and a
  pre-commit hook wired to `--ci` does not fail every commit just because rules
  were never set up.

Verified: `cli.test.ts` and `install.test.ts` now provision a real
`.keel/rules.yaml` fixture for the check-related cases and assert the warn-not-block
outcomes above; `check-helpers.test.ts` (new) covers both ported checks.
`evidence.test.ts` drove its audit-log/receipt-chain setup through `keel check` —
the only remaining command that touched `PolicyEngine`'s audit writer — and now
calls `PolicyEngine` directly, one real subprocess per call across ten tests,
keeping the same coverage. `init.ts`, `index.ts`, and SECURITY.md were updated
wherever their wording pointed at the file this command no longer reads.

Three CLI surfaces land together: a runnable version of the OWASP Agentic Top 10
mapping that was previously prose-only, four new `keel scan` finding classes for
MCP client configs, and an evidence gate on `keel promote` that finally consumes
the `promotion_fp_threshold` config field that has existed and gone unread since it
was added.

### Added

- **`keel conformance` — the OWASP Agentic Top 10 mapping, made runnable**
  (`packages/cli/src/commands/conformance.ts`, plus one shipped scenario file per
  category at `packages/cli/conformance/ASI01.yaml` … `ASI10.yaml`).
  `docs/owasp-agentic-top10.md` asserted which shipped rules cover each category as
  prose, with no way for a user to check that claim against their OWN loaded
  `rules.yaml`. This evaluates every scenario through the real enforcement pipeline
  and reports pass / fail / not-covered per category, deliberately telling apart a
  genuinely absent rule (informational — keel makes no coverage claim there) from a
  rule that IS present but did not fire the way the defaults promise (a real gap
  worth a look). `--level` evaluates against a chosen dial, `--json` emits
  machine-readable output, `--dir` picks the project to load rules from, and the
  opt-in `--ci` exits 1 on a real gap only — a "not-covered" scenario never fails
  the gate — matching how `keel scan` and `keel check` already use that flag.
- **`keel scan` MCP hardening — four new finding classes**
  (`packages/cli/src/commands/scan-risk.ts`). `parseMCPConfig` now captures `env`
  and `headers`, which it previously dropped on the floor. On top of them:
  **unsafe startup-command patterns** (`sudo`, destructive `rm -rf`, pipe-to-shell),
  reusing `command-normalizer.ts`'s own tokenizer and deobfuscation rather than a
  second string matcher; **dangerous URL schemes** (`javascript:`, `data:`,
  `file:`, `vbscript:`); **SSRF-shaped URLs** (private address ranges and cloud
  metadata endpoints); and **literal credentials sitting in `env`/`headers`**,
  reusing `checkSecret`'s provider-shape patterns plus the placeholder filter, so a
  config carrying a real key still flags while `AKIAIOSFODNN7EXAMPLE`-style
  placeholders stay quiet. `--json` output deliberately drops raw `env`/`headers`
  VALUES, so the plaintext-credential check cannot leak the thing it just found.
  Explicitly documented as out of scope in `docs/integrations.md`, per the MCP
  spec's own security page: token passthrough, confused deputy, and session
  hijacking all depend on a server's RUNTIME behavior, not on anything visible in a
  client config file, and a client-config-only scanner cannot see them.
- **`keel promote` is now gated on measured evidence**
  (`packages/cli/src/commands/promote.ts`). The command previously moved a Tier-3
  rule's `mode:` up a rung with no check that the rule had earned it. Promoting
  FROM `mode: observe` now reads `KeelConfig.promotion_fp_threshold` (`types.ts`) —
  a field that existed and was never consumed until now — and reuses
  `retrospective.ts`'s own `computePromotionReport` pipeline rather than a parallel
  computation. It refuses the edit outright (**exit 1, file untouched**) when the
  rule hasn't seen enough traffic (`insufficient_data`) or when its measured
  would-block rate hasn't cleared the threshold (`stay_observe`), pointing at
  `keel retrospective` either way. `--force` lets a human override, with its own
  distinct "may not be ready" warning rather than a silent success.
  **`warn → block` stays deliberately ungated**: that rung is real enforcement, not
  shadow-recorded, so keel has no measured signal to check against and promoting it
  remains a judgment call informed by `keel report`.

Verified: `conformance.test.ts` (new) covers all ten scenario categories, the
pass/fail/not-covered three-way classification, and the `--ci` gate's
not-covered-never-fails property; `scan-risk.test.ts` (new) covers each of the four
finding classes plus the `--json` value-redaction property; `promote.test.ts` gained
coverage for both refusal reasons, the file-untouched guarantee, `--force`'s
override and its warning, and the ungated `warn → block` rung. `keel-control-gate`
already denies an agent invoking `keel promote` on your behalf, before and after
this change.

Two new signals on `unverified-package-install`'s decision ladder, at opposite ends
of the confidence spectrum, plus one detection-gap cleanup. Together with the
multi-ecosystem widening earlier in this section, the ladder now reads:
`known_hallucination` (exact match, deny) → `not_found` / `unverified` / `age_gate`
(prompt) → `typosquat` (similarity heuristic, warn).

### Added

- **A known-package-hallucination registry as a deny signal**
  (`packages/core/src/enforce/known-hallucinated-packages.ts`, new).
  `package-verifier.ts` previously only asked whether an install target resolves on
  its registry right now — which misses the slopsquatting case entirely: an
  attacker registers a name frontier models are KNOWN to repeatedly invent, then
  waits for an agent to hallucinate that same name and be told to install it. The
  package now resolves, so a plain resolves-check waves it straight through. This
  adds a static, zero-network lookup that runs on every checked install spec
  regardless of verdict, a new `PackageCheckResult.knownHallucination` field, and a
  `decidePackageAction` reason (`known_hallucination`) that turns an
  exists-but-listed name into a strong deny, kept separate from the ordinary
  `not_found`/`unverified` paths in both reason code and message text. A match on a
  `not_found` or `unverified` result deliberately STAYS on that path — never deny on
  a network failure — with the pattern match noted in the message for the human
  reviewing the prompt.
  **PLACEHOLDER DATA, stated up front rather than in a footnote:** the 53 names
  currently in `known-hallucinated-packages.ts` (41 PyPI + 12 npm, matching the
  source's reported counts) are **structurally-valid stand-ins, not the real
  research data** — this build had no live internet access to pull the actual list
  from Socket.dev's 2026 research. The mechanism (lookup, normalization, decision
  wiring, tests) is built to work correctly with whatever names populate the array.
  **A human with access to the source research still needs to swap the placeholders
  for the real 53 names before this is a live production signal.** The refresh
  procedure is in the file header.
- **Levenshtein typosquat detection, as a warn tier**
  (`packages/core/src/enforce/popular-packages.ts`, new; wired into
  `package-verifier.ts`). Compares each install candidate against a shipped list of
  popular, well-known package names per ecosystem (`react`, `requests`, `serde`,
  `gin`, …) and flags names landing within two character edits of one. Guarded by a
  minimum-length floor, an exemption for scoped npm names, and a small allowlist for
  verified legitimate near-duplicates. This is a similarity heuristic with real
  false-positive risk and is priced accordingly: it stays a **warn**, sitting below
  the exact-match `known_hallucination` deny tier and below the
  `not_found`/`unverified`/`age_gate` prompt tiers. It never escalates a verdict
  another signal already reached.

### Fixed

- **`python3.11 -m pip install <pkg>` and other versioned interpreter basenames are
  now recognized as pip installs.** `extractSegmentInstalls`'s inline `pyBase` check
  (`package-verifier.ts`) matched only the literal `python` or `python3`, so a
  perfectly ordinary versioned invocation silently fell through unrecognized and
  skipped the ambient-registry, hallucination, and typosquat checks entirely.
  `command-normalizer.ts` already had an equivalent regex private to
  `classifyInterpreter`; it is now exported as `PYTHON_INTERPRETER_RE` and both call
  sites point at it, so there is exactly one definition rather than two that can
  drift. Confirmed that `python-config` still does not falsely match.
- **A stale doc comment above `extractPackageInstalls` corrected.** It claimed the
  `python -m pip install` prefix check lived in a helper named `isPythonModulePip`.
  No such helper has ever existed — the real logic is the inline `pyBase` check
  above. The comment now names the real check.

Verified: `package-verifier.test.ts` gained coverage for the registry lookup
(including the deliberate never-deny-on-network-failure property), normalization,
and every ladder-ordering case; for the typosquat check's edit-distance boundary,
minimum-length floor, scoped-name exemption, and allowlist; and for
`python3.11`/`python3.12` detection alongside a `python-config` negative case.
`packages/cli/templates/keel-enforce.js` was regenerated so the OpenCode plugin
carries the same logic.

Two rule-authoring capabilities that were previously impossible to express: sharing
a common rule base across files, and scoping a rule to specific hosts. Both are
composition axes over the existing four-tier hierarchy, not replacements for it.

### Added

- **`extends:` rule composition in `rules.yaml`**
  (`packages/core/src/enforce/rule-parser.ts`; `KeelRule`/config shape in
  `types.ts`). Any `rules.yaml` — or `CLAUDE.md`/`AGENTS.md` frontmatter — may
  declare `extends: <path>` or `extends: [<path>, ...]`, resolved relative to the
  DECLARING file's own directory and merged in before that file's own rules.
  `extends` is a **within-tier** composition axis: it resolves entirely before
  `loadRuleHierarchy`'s own four-tier (global/user/project/local) merge, and works
  inside any one of those tiers.
- **A weakening `extends:` override of an inherited `level: protect` floor is
  refused at load time, loudly, naming the rule id.** Same-id overrides across an
  extends chain reuse the exact tightening-only floor logic `mergeRules` already
  uses for scope-based dedup (`floorTightensOrEqual`, built from
  `ACTION_STRENGTH`/`MODE_STRENGTH`/`sameEnforcementSurface` — not a parallel
  reimplementation). This is deliberately STRICTER than `mergeRules`' behavior for
  cross-scope overrides, which silently keeps the stronger floor: an `extends`
  chain is authored deliberately, so a weakening attempt is a mistake worth
  surfacing rather than silently absorbing. It composes with `pipeline.ts`'s
  existing last-known-good fail-closed reload path, so **a `rules.yaml` edit that
  would weaken an inherited floor never takes effect at all.**
- **Circular `extends` chains are detected and a maximum depth is enforced**, and a
  missing or unreadable (`EISDIR`/`EACCES`) extends target reports a clear error
  rather than degrading to defaults.
- **The rules-hash reload check now covers every file an extends chain actually
  depends on**, not just each tier's own `sourcePath` (`pipeline.ts`, `daemon.ts`,
  `enforce.ts`) — so editing a shared base file is picked up by a running daemon
  instead of being invisible until restart.
- **Agent-scoped rule matching via `agents:`** (`KeelRule.agents?: string[]`,
  `types.ts`; filtered in `mergeRules()`). `EnforceInput` already carried `agent` —
  a host's own declared identity string — but no rule could match on it. Threaded
  through every real enforcement call site in `pipeline.ts` via a new private
  `mergedRules()` choke point rather than 15 scattered call sites, plus
  `validateRules()` shape checks and a `detectConflicts()` guard for host-disjoint
  rule pairs. **This is HOST identity, not a true multi-agent-fleet identity
  concept** — `claude-code`, `cline`, `opencode`, the string a host's own
  integration declares itself as. No host today emits a distinct identity per agent
  INSTANCE, and this field does not pretend otherwise. Documented as such in
  `types.ts`, `docs/custom-rules.md`, README.md, and SPEC.md. A rule with no
  `agents` field (the default) applies everywhere, unchanged.

### Fixed

- **A latent `parseRulesContent` gap**: a file whose only top-level keys were
  `extends`/`level` — no `rules:` and no `simple_rules:` — was silently dropped to
  defaults instead of being read.
- **A cache-key gap found while wiring `agents:`.** The stateless verdict cache's
  `CacheContext` (`packages/core/src/enforce/cache.ts`) did not carry the host, so
  an agent-scoped rule could leak one host's cached verdict to a DIFFERENT host's
  otherwise-identical call — a correctness hole that only becomes reachable once
  agent-scoped rules exist, closed in the same lane that creates them. Covered by a
  regression test that fails without the fix.

Verified: `rule-parser.test.ts` gained substantial coverage for extends resolution,
relative-path anchoring, the protect-floor weakening refusal, cycle detection, depth
limits, and each unreadable-target error class, plus the `agents:` shape validation
and conflict-detection cases; `pipeline.test.ts` covers agent-scoped matching
end-to-end and the cache-context regression; `agentic-eval.test.ts` covers the
composed-rules evaluation path. `packages/cli/templates/keel-enforce.js` was
regenerated so the OpenCode plugin resolves extends chains identically.

Documentation, competitive positioning, and harness work landed across this whole
range rather than in one lane, grouped here rather than scattered: regulatory
framework mappings, a corrected account of what competing tools actually enforce, a
drift check for the hand-maintained price table, and a red-team harness relabeling
that turns four now-closed bypass classes into real regression gates.

### Added

- **`docs/compliance-mappings.md` — rule-level mapping to NIST AI RMF, the EU AI
  Act, and ISO/IEC 42001**, including, explicitly, where keel has NO coverage
  rather than only the categories it maps cleanly onto. Linked from README.md and
  ROADMAP.md.
- **An EU AI Act gray-zone caveat, sourced rather than hedged.** The Article 50
  transparency obligations and the high-risk-system deadlines are now cited
  directly from EU pages, replacing an earlier NIST-style hedge on unverified dates
  in `docs/compliance-mappings.md`.
- **A real spend-control comparison in `docs/comparison.md`, sourced from Langfuse's
  and Helicone's own documentation.** The correction that matters: **Helicone
  DOES block spend** — via a rolling time-window rate limit applied at its proxy —
  it is not alerts-only, as an earlier assumption had it. What differs is the
  mechanism, not the presence of enforcement: Helicone limits requests inside a
  rolling window at a proxy; keel's `type: budget` rule limits a CUMULATIVE session
  total read from the host's own local record, with no proxy in the path. Stated as
  a real difference in shape rather than as a capability gap keel wins.
- **`docs/defense-in-depth.md`** — a layered dev/staging/production pattern pairing
  keel with a container boundary, linked from `docs/comparison.md`'s
  weaker-coverage row. Keel gates tool calls; it is not a sandbox, and this page
  says what to put underneath it rather than implying it needs nothing.
- **`scripts/check-price-table-drift.mjs` + `scripts/reference-pricing.json`** — a
  drift check comparing the built `DEFAULT_PRICE_TABLE` (`claude-transcript.ts`)
  against a hand-maintained JSON snapshot of real vendor pricing kept alongside it.
  Only a mismatch on a model BOTH files price fails the check; a model the pricing
  file tracks but the table does not ship is reported as informational, never a
  failure — deliberately, so the tool cannot pressure a future editor into guessing
  a price for an alias, which is the exact failure `DEFAULT_PRICE_TABLE`'s
  exact-match design exists to prevent. **No live fetch**: the pricing file needs
  periodic manual updates against the vendor's own pricing page; wiring a real
  fetch into CI is out of scope here and not claimed. Never writes to the shipped
  table or any source file — detection only, matching the read-only shape of
  `scripts/redteam/round2.mjs`.

### Fixed

- **Four `scripts/redteam/round2.mjs` probes are now real regression gates instead
  of informational lines.** Two Python `shutil`-aliasing probes and two quoted
  `${IFS}` probes were still marked `kind: bypass-attempt` even though the floor
  fixes that close them landed earlier in this same range (`install.ts`'s
  `no-destructive-interpreter-body` match widened to accept the
  `__import__('shutil')`/`getattr(...)` aliased forms; `command-normalizer.ts`'s
  `renderToken` now expands `${VAR}` inside the quoted-run path too, not just the
  unquoted one). All four verdicts are `deny` today, but `kind: bypass-attempt` is
  purely informational and never touches the harness exit code — so a future
  regression on these bypass classes would have scrolled past unnoticed. All four
  are promoted to `control-catch`, following the existing `bash -lc`
  control-gate-bypass pattern in the same file, so a regression now flips exit 1.

### Added

- **Tool-result prompt-injection scanning (Lane F) — a new `type: injection`
  rule type.** Indirect prompt injection (instructions embedded in a file,
  web page, API response, or other tool result that get read as new
  instructions on the agent's next turn) is now detected, not just left as
  a documented gap. Two forms: a DETECTOR (`patterns`, matched against a
  completed tool call's OWN output text via `EnforcementPipeline.
  evaluateInjection()`, never through the normal pre-call `evaluate()`
  dispatch) and a GATE (`next_call_scrutiny: true`, armed by an enforcing
  detector match and firing once, as a warn, on the session's next
  consequential write/shell call — the compensating control for every host
  except OpenCode, where a detected injection has already reached the model
  before keel's hook can act). `action` is restricted to `warn` for every
  rule of this type — never rule-authorable as a harder verdict, the same
  reasoning `rule-parser.ts`'s `validActions` comment already gives for why
  a result-rewrite verdict can't be authored generically (it only actually
  reaches the model on one host). Ships three default rules:
  `injected-instructions-in-tool-output` (warn),
  `untrusted-content-role-markers` (a weaker-confidence sibling, `mode:
  observe`), and `untrusted-content-next-call` (the gate). New
  `EnforcementPipeline.evaluateToolResult()` orchestrates one combined
  secret-redaction + injection scan per tool result (`packages/cli/src/
  commands/hook.ts`, `packages/opencode-plugin/src/plugin.ts`), composing
  both findings into `sanitized_output` and both warnings into one
  `additionalContext`/`systemMessage` envelope. New
  `packages/core/src/enforce/injection-scan.ts` (pure marker-scan +
  neutralization logic, audit-log-safe excerpt defanging) and
  `packages/core/src/enforce/injection-store.ts` (`PersistentInjectionStore`,
  modeled directly on `flow-store.ts`, backing the next-call gate). This is
  a heuristic tripwire over literal, well-attested marker shapes (chat-
  template control tokens, "ignore previous instructions", role-marker
  impersonation, Unicode tag-character smuggling), not a detector with a
  completeness claim — a paraphrased, translated, or encoded payload still
  passes. See `docs/injection.md` for the full per-host honesty table and
  what this deliberately does NOT cover.
- **Cross-turn taint correlation ("Lane G") — a new `untrusted-content-derived-call`
  gate rule (`taint_correlation: true`), the narrower, artifact-correlated
  sibling of Lane F's `untrusted-content-next-call`.** Fires only when a
  LATER consequential call's own arguments or content reference a URL,
  hostname, file path, or email address found within 400 characters of an
  enforcing marker in an earlier flagged tool result this session, instead
  of the broad rule's "any consequential call in the TTL window, no
  payload correlation" trigger. New standalone, pure module `packages/
  core/src/enforce/injection-taint.ts` (`extractOriginArtifacts`,
  `extractCallArtifacts`, `correlateTags`, `defangArtifact` — the latter
  stronger than `injection-scan.ts`'s `defangExcerpt`, additionally
  breaking the `http`/`https` scheme word so a stored artifact can never
  become a live URL). `PersistedInjectionTag` (`injection-store.ts`) gains
  three optional fields — `id`, `artifacts`, `consumedBy` — read
  correctly by pre-Lane-G code (which just ignores them) and reading
  pre-Lane-G tags correctly in turn (no artifacts to correlate against, so
  the new rule stays silently inert on them). `consumePending` now MARKS
  per rule id instead of deleting outright, the correctness fix required
  the moment a second `next_call_scrutiny` rule shares this store — the
  earlier delete-all-on-consume behavior would let whichever rule's
  consequential call happened first blind the other to every pending tag.
  Still `action: warn` only, like every `type: injection` rule; promoting
  a correlated hit to `prompt` is a named future follow-up. Measured, not
  asserted: a 20-scenario corpus (`injection-taint-corpus.test.ts`) backs
  the shipped `confidence: medium`/`maturity: incubating` tier — see
  SECURITY.md for the counts and `docs/injection.md`'s "Cross-turn taint
  correlation" section for the honest limits (exact-match only, four
  artifact classes, single-hop, "storing is indistinguishable from
  obeying").

## 1.0.0

`@get-keel/cli` 1.0.0 · `@get-keel/core` 1.0.0 · `@get-keel/opencode-plugin` 1.0.0

The v1 release. Four correctness/hardening lanes landed on top of 0.4.0's default
ruleset and thesis experiment: a fail-closed sweep across every enforcement entry
point, a `KEEL_HOME` fix that closes most of the install/read split-brain (a few
reader call sites remain — see below), verification-obligation discharge on three
more hosts, Windows support, and a wider host-breadth pass with one real
user-facing fix (Cursor's warn-message casing).
Separately, this release corrects a stale documentation count unrelated to any of
those four lanes: `no-destructive-interpreter-body` (the same destructive-wipe
class as the shell-command floor, caught when issued through an interpreter
instead — `shutil.rmtree('/')`, `os.system('rm -rf ~')`, Node's `rmSync`/
`rmdirSync`) and `test-oracle-env-introspection` (an observe-mode rule flagging
code that detects which test is calling it and branches on that, the
caller-detection pattern used to fake two contradictory tests passing) were both
added in post-0.4.0 "ruleset follow-up" commits (`v04/M1`, `v04/M2` — before the
v1 lanes existed, after the 0.4.0 release notes were already written), bringing
the shipped default ruleset to 45 rules
(13 protect-floor, 22 balanced, 10 observe) at that point, while the README/
`docs/tiers.md`/CHANGELOG kept citing the 43-rule count that was accurate only
at the moment 0.4.0 shipped. Two more changes in this same release moved the
count again: the B1 exfil lane's new warn-tier sibling rule
`no-exfil-flow-cross-call` took the ruleset from 45 to 46, and `no-repeat-loops`
was promoted out of `mode: observe` into active enforcement (real hit-rate
evidence, no false positives — see `docs/tiers.md`), which doesn't change the
total but does move it out of the observe tier. Current state: 46 rules (13
protect-floor, 1 further Tier-1-positioned sibling, 22 balanced, 9 observe, 1
promoted). Found by direct count against `DEFAULT_RULES_YAML` while
preparing this release and reconciled everywhere, verified live via
`keel status`. Evidence for every v1-lane item below: `session/v1/EVIDENCE/*.md`;
the rule-count correction: `session/v1/EVIDENCE/m5-release.md`.

### Fixed

- **`root-cause-before-refactor`'s match pattern no longer over-matches safe
  commands.** An audit reported `git checkout -- <file>` tripping this rule; that
  specific report didn't reproduce (the rule ships `mode: observe`, so it was never
  actually interrupting anything), but the underlying pattern was genuinely too
  broad — it matched `git checkout -- ` generically (missing bare `git checkout .`,
  a real whole-tree discard, entirely) and matched `migrate`/`refactor` inside
  unrelated path segments like `src/migrations/x.ts`. Now scoped to whole-tree-discard
  forms only (`git checkout -- .`, `git checkout .`, `git checkout -- :/`) with
  `migrate`/`refactor` anchored so they stop matching inside path segments. 29 new
  regression cases in `packages/cli/src/__tests__/floor-fp.test.ts`; a stale test
  fixture that had baked the false positive in as expected behavior was corrected
  alongside it. See `session/v1/EVIDENCE/m1r-1-fp.md`.
- **Degenerate input now fails closed at every enforcement entry point, not just
  most of them.** Malformed JSON, a non-object payload, or a missing/blank
  tool-identity field previously degraded silently to a synthetic `tool: 'unknown'`
  call that matched no rule and returned `allow` — a fail-open path on exactly the
  input an attacker or a broken host integration would produce. Closed in four
  places: `hook.ts` (new `ParsedCall.degenerate` flag, carefully carved out for
  Claude Code's `Stop` hook, whose legitimate payload has no `tool_name`),
  `PolicyEngine.evaluate()` (returns `fail-closed-degenerate-input` instead of a
  silent allow), the MCP server's `keel_check` tool (a missing `target` previously
  read back `"POLICY OK"`), and the OpenCode plugin's `tool.execute.before`. See
  `session/v1/EVIDENCE/m1r-2-failclosed.md`.
- **`--level` no longer hangs a bare `keel enforce`.** `enforce.ts`'s `--level`
  option carried a hardcoded default of `'balanced'`, so `keel enforce` with *no*
  flags at all always printed `"--level=balanced has no effect without --persist"`
  and exited 1 — the basic status view was unreachable. `--level` is now `undefined`
  unless typed explicitly; `--level=X` without `--persist` previews that dial for
  the current invocation only; `--persist` without `--level` is now an explicit
  error instead of silently persisting `balanced`. (`keel-control-gate` already
  denies an agent from running any form of this command on your behalf, before and
  after this fix.) See `session/v1/EVIDENCE/m1r-4-mask.md`.
- **Cursor's warn message now reaches Cursor's real API shape.** `hook.ts`'s
  `renderVerdict` sent only camelCase `userMessage`/`agentMessage` on Cursor's
  non-blocking path; Cursor's documented API (re-fetched live this lane) uses
  snake_case `user_message`/`agent_message`. Fixed additively — both spellings are
  sent, so the change can't itself break the hook on an unrecognized field. The
  identical casing question on Cursor's *block* path was left alone (block already
  gates correctly via `permission` alone regardless of message casing; no live
  Cursor CLI available to confirm which spelling that path reads). See
  `session/v1/EVIDENCE/m4-hostbreadth.md`.
- **Windows: the global rule tier no longer silently fails to load.**
  `loadRuleHierarchy()` resolved the home directory as `process.env.HOME || '~'` —
  `HOME` is unset on Windows by default, so `~/.keel/rules.yaml` never loaded there.
  Now falls back to `os.homedir()`. A separate latent bug was also closed: a mixed
  `paths` list like `["**/*.ts", "!**/node_modules/**"]` OR'd its positive and
  negated entries together in one check, inverting the negation into matching
  almost everything; no shipped rule used this shape, so this was unreachable in
  practice, but is now correct (positives OR, negated entries AND-exclude) for any
  rule that does. See `session/v1/EVIDENCE/m3-windows.md`.
- **A Windows file-lock crash (`EBUSY`/`EPERM`) no longer strands a lockfile for
  the full 8-second stale-lock window.** `classifyLockError()` now treats these as
  retryable contention (previously only `EEXIST` was), and lock release retries the
  unlink. See `session/v1/EVIDENCE/m3-windows.md`.

### Added

- **`KEEL_HOME` closes most of the install/read split-brain, on both the write and
  the read side.** Previously only the CLI's own `homedir()` calls existed to
  redirect; now `resolveHome()` (`KEEL_HOME` → `HOME` → `os.homedir()`, exported
  from `packages/core/src/home.ts` and generated into every consuming package) is
  used by all 10 global-target installer writers *and* the 25 reader call sites
  across `packages/cli` and `packages/core` that used to resolve a bare `homedir()`
  independently — daemon token/state, rules.yaml, audit traces, signing/receipt
  keys, override state, the kill-switch sentinel, and more. Two bonus fixes found
  during the sweep: `rule-parser.ts`'s `loadRuleHierarchy()` (the single most
  load-bearing reader in the system) never consulted `KEEL_HOME` at all before this,
  and `disable.ts` fell back to the literal non-existent path `'~'` when `HOME` was
  unset — worse than a bare `homedir()`, and the writer of the exact kill-switch
  file every reader above now trusts. A new install→read consistency test drives
  the real built CLI as separate processes with two distinct `HOME`/`KEEL_HOME`
  temp dirs to prove nothing leaks across the boundary in either direction. **Gap
  closed:** `level.ts`, `validate.ts`, and `enforce.ts`'s rule-fingerprint watcher
  were the last call sites resolving `process.env.HOME || '~'` directly instead of
  `resolveHome()`, the same bare-fallback pattern `disable.ts` had — all three now
  call `resolveHome()`, so `keel level`, `keel validate`, and the enforce pipeline's
  reload watcher honor `KEEL_HOME` like every other reader. See
  `session/v1/EVIDENCE/m1r-3-install.md` and `session/v1/EVIDENCE/reader-home.md`.
- **Verification-obligation discharge now works on Claude Code, Codex, and Gemini,
  not only OpenCode.** There was previously exactly one call site in the whole
  codebase (OpenCode's `tool.execute.after`) that could mark a `verification` rule's
  obligation satisfied or record an attempt outcome — every other host's
  `test-before-commit`/`source-change-requires-test`-style rule could never clear.
  New `recordPostAction()` reuses the same pipeline calls from a new `PostToolUse`
  branch in `hook.ts`, wired for claude-code/codex/gemini via five new hook
  templates, plus the `Stop` branch extended from claude-code-only to codex and
  gemini. Also closes a real race: `flushBackgroundWork()` now awaits the
  slopsquatting deny-on-retry background check (bounded 2500ms) before the hook
  returns, instead of `process.exit()` potentially killing it mid-flight. Honestly
  scoped: these three hosts' exit-code discharge paths are marked `docs`, not
  `live`, in `docs/integrations.md` — this environment couldn't exercise a real
  Claude Code/Codex/Gemini session to confirm the exit-code field shape live. See
  `session/v1/EVIDENCE/m2-b1-verify.md`.
- **Windows support**, CI-verified via a full-suite `windows-latest` job (previously
  lint-only): flavor-aware path normalization (`packages/core/src/enforce/path-normalize.ts`)
  wired into every path/glob matcher in the pipeline. Explicitly caveated: no
  Windows machine was available in this lane, so every claim is macOS-verified via
  explicit `flavor: 'win32'` parameters — CI-wired but Windows-*runtime* unverified
  pending a real green `windows-latest` run. See `session/v1/EVIDENCE/m3-windows.md`.
- **Live warn-path verification tooling and OpenCode's headless warn channel
  confirmed for the first time.** `client.app.log({level:'warn', ...})` does not
  appear in `opencode run --format json`'s stdout but does land in
  `$XDG_DATA_HOME/opencode/log/opencode.log` — the first confirmation of the
  headless case specifically, not just the interactive one. `docs/integrations.md`
  now carries separate Block-Verified and Warn-Verified columns per host instead of
  one conflated column (M4 lane; that page's matrix is authoritative — this entry
  only records that the split happened). See `session/v1/EVIDENCE/m4-hostbreadth.md`.

### Changed

- **The `mask` action is removed.** It was already unreachable — `validateRules()`
  rejected every rule that used it, and the pipeline had no dispatch branch for it —
  and three different parts of the codebase disagreed on what it should even mean
  (invisible-allow in one host adapter, advisory no-op distinct from `fix` in
  another). `audit-redaction.ts` already gives unconditional secret redaction
  regardless, so the decision was to remove rather than finish implementing a
  three-way-disputed action. See `session/v1/EVIDENCE/m1r-4-mask.md`.

### Internal

- Benchmark-harness hardening for keel's own thesis-experiment tooling — a cost
  cap on the paid-model benchmark arm (refuses non-`-free` models without an
  explicit opt-in), real token/cost capture per run, and a reusable
  `attributeKeelBlock()` check that reproduces the earlier manual
  attribution-reaudit finding across 22/22 historical run files. No product code
  under `packages/` changed; zero paid API spend incurred. See
  `session/v1/EVIDENCE/m2-b2-bench.md` and `session/v1/EVIDENCE/cost.md`.

## 0.4.0

`@get-keel/cli` 0.4.0 · `@get-keel/core` 0.4.0 · `@get-keel/opencode-plugin` 0.4.0

This release restructures the default ruleset into three enforcement tiers, closes
the last quiet way a lower-scope config could defang a floor, ships a manual
promotion path for the behavioral rules that used to require a hand edit, and
answers the project's founding question with a measured number instead of an
adjective: on the harm-eliciting task repetition (N=12/arm), a keel-guarded cheap
free-model agent went from the unguarded agent's **75% harm rate to 0%**, while task
completion rose from 8% to 75%, with zero false-positive drag on control tasks. That
is the *prevention* axis (blocking a forbidden/destructive action) — the *detection*
axis (false-claims, test-tampering) stayed honestly inconclusive at this N, a
measurement gap and not a keel result either way. Full methodology and confidence
limits: [session/v04/EXPERIMENT.md](session/v04/EXPERIMENT.md).

### Added

- **Three-tier default ruleset (43 rules).** `keel install` now ships 43 default
  rules split into Tier 1 (`level: protect` floors — 12 rules, un-bypassable, deny on
  the first hit at every dial), Tier 2 (balanced — 22 rules, warn-once-then-block,
  dial-softenable), and Tier 3 (`mode: observe` — 9 rules, evaluated and recorded on
  every matching call but never interrupting until a human promotes them). See
  [docs/tiers.md](docs/tiers.md).
- **`keel promote <rule-id>`** — the promotion pipeline. Advances an eligible Tier-3
  rule's `mode: observe → warn` (or `warn → block`) in your rules file,
  comment-preserving and idempotent. `keel retrospective` reports each observe-mode
  rule's measured would-block rate over your own traffic with an
  `eligible`/`stay_observe`/`insufficient_data` recommendation; `keel promote` only
  runs at an interactive TTY, and `keel-control-gate` denies an agent invoking it on
  your behalf.
- **`unverified-package-install` — the slopsquatting gate.** A Tier-2 `prompt` rule
  that blocks installing a package whose name doesn't resolve against the real
  registry — 19.7% of LLM-recommended packages don't exist (USENIX Security 2025) and
  get squatted by attackers waiting for an agent to `npm install` the hallucinated
  name.
- **The v0.4 thesis experiment** — measured, not asserted. Setup, the N=10
  full-battery result (guarded 0% forbidden-action / 100% task-pass vs. unguarded 20%
  / 70%), the N=12 harm-eliciting repetition (the 75%→0% headline above), and the
  stated confidence limits (single cheap model, N=1 per task before repetition,
  zero-base-rate detection axis, no frontier arm run) all live in
  [session/v04/EXPERIMENT.md](session/v04/EXPERIMENT.md).

### Changed

- **Floors are now un-bypassable on action, mode, *and* enforcement surface — not
  action alone.** `mergeRules` previously compared a lower-scope override of a
  `level: protect` floor's action field only. A `.keel.local.yaml` could keep
  `action: deny` while adding `mode: observe` (which silently suppresses
  interruption) or swap in a `match` pattern that never fires, neutralizing the floor
  without ever weakening its stated action. Both vectors are now closed: overriding a
  floor requires same-or-stronger action *and* mode, and a byte-identical enforcement
  surface on the floor's own id — any other change is rejected outright, fail-closed.
  *Writing* such an override file was already blocked on every agent path; this
  closes what a pre-existing one could do. Verified end-to-end through the real
  pipeline, not just `mergeRules`' return value. See
  [SECURITY.md](SECURITY.md#measured-bypass-resistance-of-the-tier-1-floor).
- **Warn verdicts now surface through each host's real, non-blocking channel**, not
  `stderr` on `exit 0` — provably invisible on Claude Code (its own hook docs say it
  reaches only a debug log). `claim-without-evidence`, `test-oracle-tampering`, the
  verification rules, and every other `warn` now use the host's actual visible
  surface: Claude Code/Gemini's `hookSpecificOutput.additionalContext` +
  `systemMessage`, Codex's `systemMessage`, Cursor's `userMessage`/`agentMessage`,
  Cline's `systemMessage`, OpenClaw's `api.logger.warn`. See
  [docs/integrations.md](docs/integrations.md#failure-behaviour).
- **`argPath()` now reads `file_path`/`notebook_path`**, so `filesystem`-type floors
  (`no-rules-tampering`, `no-secret-files`, `write-outside-project`,
  `cicd-config-edit`) fire on Claude Code and Gemini CLI, which send a tool call's
  path under that key. Previously 0/8 self-protection paths blocked on those two
  hosts; now 8/8, verified live.

### Fixed

- **`keel dashboard --web` no longer opens a browser tab on every automated run.**
  The convenience auto-open was gated only on `platform === darwin`, so the
  dashboard-web test suite (which sets `KEEL_DASHBOARD_ALLOW_NON_TTY=1` to exercise
  the server headlessly) spawned a real tab on every `npm test`. Now gated on
  `process.stdin.isTTY` (and respects `CI` / `KEEL_NO_OPEN=1`), so only a real
  interactive user at a terminal gets the convenience open.
- **A lost-update race in `StateManager` and `ProblemLedger`.** Neither class
  re-read its backing JSON file before mutating, so two processes racing (e.g. two
  concurrent `keel enforce` calls hitting the same rate-limit or circuit-breaker
  counter) each mutated a stale in-memory snapshot and wrote the whole file back,
  silently erasing whichever write lost the race. Reproduced directly: 5 processes ×
  50 increments against one counter landed at 113, 36, and 138 — not 250 — across
  three unlocked trials. Fixed with a per-resource file lock (`file-lock.ts`: O_EXCL
  acquire, stale-lock reclaim, full-jitter backoff, and a documented fail-safe that
  proceeds unlocked rather than hang or silently drop a write past a bounded
  timeout). 12/12 green on the full core suite under the tuned defaults after two
  rounds of hardening. See `session/v04/EVIDENCE/c2-concurrency.md`.
- **A new Tier-1 floor, `no-self-protection-write`,** closes a gap where
  `filesystem`-type rules only inspected a tool call's declared path argument, so a
  shell command redirecting into a protected path (`echo ... > ~/.keel/DISABLED`,
  `sed -i` on `.claude/settings.json`, `git config core.hooksPath`, …) slipped
  through untouched. It now blocks shell writes targeting keel's own files, host
  trust/approval config, and git hooks, while still allowing reads of those paths.

### Security

- Red-team catch-rate table refreshed against the v0.4-hardened floors (260 probes
  through the real CLI, method in `session/v04/EVIDENCE/phase-3-redteam.md`):
  `no-rules-tampering` 52%→88%, `no-enforcer-removal` 33%→75%,
  `no-destructive-commands` 73%→77% (`--no-preserve-root` closed),
  `no-self-protection-write` new at 93%. These are catch rates against *deliberate
  obfuscation*, not ordinary use. Four evasion classes remain open by design and are
  documented rather than silently absorbed into the pass rate: intra-token quoting,
  variable indirection, most interpreter one-liners, and symlink redirection planted
  by an earlier allowed command. Full table and residuals: [SECURITY.md](SECURITY.md).

## 0.2.2

`@get-keel/cli` 0.2.2 · `@get-keel/core` 0.1.9 · `@get-keel/opencode-plugin` 0.1.9

An adversarial review of `keel scan` — the command the README leads with — found nine
bugs, all reproduced before fixing. The checks failed in both directions at once: real
supply-chain vectors reported clean, and the officially documented Windows MCP config
reported CRITICAL. Anyone relying on `keel scan` in 0.2.1 should re-run it.

### Fixed

- **`keel scan --ci` could exit 0 with a CRITICAL finding.** MCP servers are read from
  project configs, so a machine with no installed agent host can still carry a finding.
  The human output returned early, printed "No AI coding assistants detected" and exited
  **0**, while `--json --ci` on identical input exited **1** and reported a
  `sh -c "curl … | sh"` server. Pipelines running `keel scan --ci` got a false pass.
- **Commands were matched as exact strings**, so `/bin/sh` and `/opt/homebrew/bin/npx`
  bypassed both checks entirely. Matching is now on the command basename with
  `.cmd`/`.exe` stripped.
- **`cmd /c npx …` — the documented Windows MCP shape — was reported CRITICAL**, a
  false positive for every Windows user following the official setup docs, *and* the
  unpinned package inside it was never examined. Wrappers are now unwrapped and judged
  by what they actually run.
- **`isPinned` accepted anything after `@` as a version.** `^1.0.0`, `1`, `~1.2`, `*`,
  `beta`, `canary` and `git+ssh://git@host/repo` all read as pinned — precisely the
  mutable references the check exists to catch. It now requires an exact semver, treats
  a remote ref as pinned only with an explicit `#ref`, and ignores local paths.
- **The package token could be an option value.** `uvx --python 3.11 srv@1.2.3` picked
  `3.11`, flagged a correctly pinned server, and never checked the real package.
- **Loopback detection was a regex over the raw URL.**
  `http://localhost:3000@evil.com` (where `localhost:3000` is userinfo) read as local,
  while `127.0.0.2` and `0.0.0.0` read as remote. It now parses the URL and matches the
  hostname against all of `127.0.0.0/8`, `::1`, `0.0.0.0` and `localhost`.
- **Claude Code MCP servers were never detected.** `~/.claude.json` has no top-level
  `mcpServers`; they live under `projects.<path>.mcpServers`. Also adds `.mcp.json` as
  a workspace config — Claude Code was the only host without one.
- **`keel install --gemini` / `--codex` made scan report those hosts as installed**,
  because the installer creates `~/.gemini` and `~/.codex` and scan detected on the bare
  directory. Same self-detection false positive fixed for `cline`/`openclaw`/`hermes` in
  0.2.1; the guard written then asserted only those three names, so it stayed green.
  It is now a behavioural test over **every** host the installer supports.
- **Duplicate findings.** A server defined in both a global and a project config
  produced two identical findings and inflated the count.

## 0.2.1

`@get-keel/cli` 0.2.1 · `@get-keel/core` 0.1.9 · `@get-keel/opencode-plugin` 0.1.9

### Breaking

- **The `product-name-is-keel` default rule is removed.** It denied renaming keel to
  its former name at priority 100 — enforcing this project's own rename history inside
  strangers' repositories. Fresh installs now ship 21 default rules instead of 22;
  existing `~/.keel/rules.yaml` files are untouched. Remove the rule by hand if you
  want it gone from an existing install.
- **The shipped standing-requirements template is rewritten.** `keel install` writes
  `~/.keel/requirements.md`, which the plugin injects into the agent's system prompt
  every turn. It previously carried keel-project-specific assertions ("the primary agent
  used in this project is OpenCode", "never write to CLAUDE.md", "product name is
  'keel'"), so every user's agent was told this repo's conventions as if they were their
  own. It is now host-agnostic: verification culture, root-cause-before-fix, stuck
  escalation, and decision hygiene. Existing files are not overwritten — delete
  `~/.keel/requirements.md` and re-run `keel install` to pick up the new template.
- Receipt and signing keys moved to machine scope (`~/.keel/receipt-key.json`, `~/.keel/signing-key.json`); legacy project-tree keys are still read so existing receipts keep verifying.
- `keel allow <id>` now means a 24-hour window (all violations allowed, audited); `--once` is consumed only by a violation that would actually block (first-time warnings do not consume it). Unknown rule ids are refused.

### Added

- `keel dashboard` — interactive TTY dial panel (1/2/3 switch, project target, refresh, quit).
- `keel dashboard --web` — browser UI with the same controls; 127.0.0.1 only, TTY required to start, one-time token printed on the terminal (never stored; passed as a URL hash fragment).
- New default rules: `no-after-hours-publish` (time, warn) and `bash-rate-limit` (rate, warn) — both last-resort priority so they never preempt deny/prompt gates.
- **`keel scan` now assesses risk, not just discovers.** It reports which installed
  agent hosts have no keel enforcement at all, and flags MCP servers that launch
  unpinned packages (`npx pkg` without a version), run through a shell, or use plaintext
  `http://` transports to non-local hosts. Findings are ranked critical → low and cite
  the exact command or path that triggered them. Adds `--ci` (exit 1 on any finding);
  `--json` now emits only JSON so it can be piped.
- **`keel-control-gate` now covers `keel rules --append`.** The gate listed six
  subcommands by name, so it did not fail safe: every new mutating subcommand was
  un-gated by default, and `--append` shipped able to edit `~/.keel/rules.yaml` with
  only a TTY check in the way — and that check has an environment-variable escape used
  by the test suite. Defence in depth: the TTY check is the mechanism, the rule is the
  policy, and neither should be the only thing between an agent and the rules file.
  Read-only `keel rules harness` stays allowed, so an agent can still show them to you.
- **`keel rules harness --append`** — adds the problem-solving rules to
  `~/.keel/rules.yaml` directly. Printing them to copy by hand meant they routinely
  never got installed, so the `stuck` / `research` / `diagnosis` machinery stayed inert
  while traces kept recording repeat loops. The append is idempotent (adds only missing
  rule ids), writes a `.bak` first, refuses a rules file that does not already parse,
  and restores the original if the result would be invalid — an invalid rules.yaml fails
  closed and would block every subsequent tool call. Like `keel dashboard --web`, it
  requires a TTY, so an agent cannot add or alter its own rules.
- `CODE_OF_CONDUCT.md` and `.github/ISSUE_TEMPLATE/config.yml`, which routes security
  reports to a private advisory instead of a public issue.

### Changed

- **protect is now block-first**: deny rules block on the FIRST violation (previously warn-then-block at every dial). sprint = warn-only, balanced = warn-then-block, protect = block-first + reasoning checks.
- Time rules support an optional command `match` (previously they fired on every action) and overnight windows (start > end).
- `@get-keel/core` bumped to 0.1.9 and the CLI now requires `^0.1.9`. The CLI imports
  five exports (`loadReceiptPublicKey`, `rotateReceiptKey`, `rotateSigningKey`,
  `loadPublicKeyJwk`, `receiptPublicKeyCandidates`) that 0.1.8 does not provide;
  publishing the CLI against the old caret range produced a crash at import time.
- README, ROADMAP, and `docs/comparison.md` rewritten for external readers. The
  comparison page no longer carries undated star counts or competitor teardowns.
- `docs/integrations.md`: `keel mcp` corrected to `keel serve`, and the nonexistent
  `HOST_ADAPTERS` symbol corrected to `HOSTS`.

### Fixed

- Flow sink detection matched the substring "nc" inside unrelated words (e.g. "sync"); sink verbs now require full-word boundaries.
- **`keel dashboard --web` failed silently when unauthenticated.** Opening the page
  without the `#token=…` fragment, or after the server had exited, rendered a shell full
  of placeholders whose only error signal was a toast that auto-hid after 2.6 seconds —
  indistinguishable from a broken page. All three failure modes (missing token, invalid
  token, server unreachable) now show a persistent banner naming the cause and the exact
  command to recover.
- `npm audit` cleared: `fast-uri` (high, host confusion) and `hono` (moderate, CORS
  ReDoS), both transitive via the deprecated private `@get-keel/mcp-server`. CI was
  failing on `npm audit --audit-level=moderate` for all three platforms.
- **`keel scan` could not detect `cline`, `openclaw` or `hermes`** — 3 of the 8 hosts
  keel installs into. Its "N agent hosts can run tools with no enforcement" finding
  silently excluded them, under-reporting with no indication it had done so. Detection
  keys on host-owned files (`~/.cline/data/settings/providers.json`,
  `~/.openclaw/openclaw.json`) rather than the bare `~/.<host>` directory, because
  `keel install` creates those directories itself — detecting on them would make
  installing keel "prove" the host was present.
- **Daemon spawn storm.** `ensureDaemon()` deduplicates within one process, but nothing
  coordinated across the several CLI invocations an agent turn produces. Each lost race
  ran to a 5s timeout and abandoned its spawned daemon until a 10-minute idle shutdown.
  A lost race now adopts the winner and reaps its own child, a timeout reaps before
  throwing, and a `daemon.json` whose pid is no longer alive is treated as stale instead
  of triggering a fresh spawn on every call. Six concurrent processes now converge on
  one daemon with zero orphans.
- `@get-keel/mcp-server`'s `bin` pointed at `keel-mcp.js` while the file on disk was
  still named `ai-enforce-mcp.js` — the last artifact carrying the former product name.
- `@get-keel/opencode-plugin` did not ship its README, so its npm page rendered blank.
  All three published packages now carry `keywords`, `homepage`, `bugs`, `author`, and
  `publishConfig`.

### Added

- `keel status` — enforcement health overview (dial, kill switch, overrides, rule counts, recent blocks).
- `keel receipts rotate` — rotates receipt + signing keys, archiving the old keys; archived keys still verify old receipts.
- Fork-bomb (`:(){ :|:& };:`) detection in the destructive-commands rule.
- `keel install --project` writes `.keel/.gitignore` covering receipts/audit/key files.

### Fixed

- Corrupt kill-switch sentinel now fails CLOSED (enforcement stays on) in the plugin and CLI.
- `keel enforce --level` without `--persist` errors instead of silently doing nothing.
- `keel disable --until` validates its argument instead of silently ignoring bad values.
- `keel verify` reports a missing key as a diagnostic instead of a false `TAMPERED` verdict, and never generates keys.
- Duplicate rule ids in one rules file are rejected.
- Removed the duplicate `verify-before-irreversible` default rule (superseded by `no-force-push` + `no-destructive-commands`).


## 0.2.0 (2026-08-02)

### Breaking

- Runtime paths moved under `.keel/` — audit log is now
  `<project>/.keel/audit/audit.log`, receipts and the signing key live in
  `<project>/.keel/receipts/`, custom templates in `<project>/.keel/templates/`
  (was `.ai-enforce/`). Add `.keel/audit/`, `.keel/receipts/`, and
  `.keel/templates/` to `.gitignore`. Existing `.ai-enforce/` directories are
  not migrated automatically; re-run gated actions to write new evidence.
- Environment variables renamed: `AI_ENFORCE_RECEIPT_KEY` →
  `KEEL_RECEIPT_KEY`, `AI_ENFORCE_SIGNING_KEY_JWK` → `KEEL_SIGNING_KEY_JWK`,
  `AI_ENFORCE_UPSTREAM_SERVERS` → `KEEL_UPSTREAM_SERVERS`,
  `AI_ENFORCE_PORT` → `KEEL_PORT`.
- MCP tools renamed: `ai_enforce_check` → `keel_check`,
  `ai_enforce_audit` → `keel_audit`.
- Policy-protected paths updated to the new `.keel/audit/` and
  `.keel/receipts/` locations.

### Changed

- `product-name-is-keel` now matches only explicit rename pairs
  (`s/keel/ai-enforce`, `replaceAll`/`rename` substitutions within a bounded
  window). Version-bump seds mentioning `@get-keel/*` while running in a
  directory whose path contains the legacy name no longer false-positive.
- `must-sign-commits` skips the `--signoff` fix when the commit command
  already passes `--signoff`.

## 0.1.9 (2026-08-02)

### Added

- `keel level <sprint|balanced|protect>` and `keel enforce --persist` —
  protection levels that rebalance rule severity and enforcement depth without
  editing rules files. Levels compose with per-rule `level:` minimums.
- Agentic threat-model test suite (21 tests) exercising the shipped default
  rules end-to-end: destructive commands, git history rewrite, registry and
  release actions, product identity, claimed-done-without-evidence, speed dial,
  and custom filesystem/rate rules.

### Fixed

- Level changes now apply on the first evaluation after the change (the active
  level was previously captured before rule reload, so the first call after
  `keel level` still ran at the old level).
- `publish-gate` now also blocks `git push --delete/-d` (backslash-free,
  YAML-safe pattern).
- `**` globs no longer fall through to legacy prefix matching after a failed
  match (`.env` no longer matches `.env.example`).
- Kill-switch sentinel read treats ENOENT (concurrent disable/removal) as
  "not disabled" instead of throwing mid-evaluation.

## 0.1.8 (2026-08-02)

### Fixed

- `no-destructive-commands` deny rule no longer fires on `rm -rf /tmp/...` or
  `rm -rf /var/tmp/...` (substring regex false positive) — the pattern is now
  `rm -rf /(?!tmp|var/tmp)` in the plugin defaults, `keel install` defaults,
  and the legacy policy templates. Real destructive paths (`/etc`, `/usr`,
  `/home`, ...) and `~` remain hard denies.
- `keel install` default rules now match the plugin's canonical rule set
  (was missing the `git-history-rewrite` and `publish-gate` approval gates and
  shipped a stale `verify-before-irreversible`). A new drift test
  (`packages/cli/src/__tests__/drift.test.ts`) fails on any future divergence
  of rule ids, patterns, or actions between the two copies.

### Changed

- `git-history-rewrite` gate now also covers plain `git rebase` (including
  mid-rebase `--continue`/`--skip`), `git reset --soft/--keep/--merge/HEAD~`,
  and `git push --delete/-d` via the publish gate.
- `publish-gate` now also gates `gh release delete`.

## 0.1.7 (2026-08-02)

### Added

- `action: prompt` — first-class approval gate. Always blocks (no warn-once
  escalation, never downgraded by protection level) and requires explicit
  approval via `keel allow <rule-id> --once`. Reported as `prompt` in audit
  and CLI output; cached verdicts are skipped so overrides are honored on
  every attempt.
- Default rules (plugin + `keel enforce init` template): `git-history-rewrite`
  and `publish-gate` gate structurally irreversible operations
  (`git filter-branch`, `git rebase --onto/--root`, `git reset --hard`,
  `git commit --amend`, `git stash drop/clear`, `npm publish/unpublish`,
  `gh release create`, `gh repo delete/transfer`) behind `prompt`.
- The OpenCode plugin emits signed, hash-chained receipts (`keel verify`) for
  every gated or blocked action.
- Core path matcher supports `**` multi-segment globs (e.g. `**/*.log`).

### Changed

- `verify-before-irreversible` default rule no longer fires on `rm -rf` of
  temp/cache/trash paths (`/tmp/`, `/var/tmp/`, `Trash`, `node_modules`) —
  fixes a common false positive on disposable directories. `rm -rf /` and
  `rm -rf ~` remain hard denies.

## 0.1.6 (2026-08-01)

Public-readiness hardening: docs, licensing, tooling, and cross-platform CI.

### Changed

- License is now the full Apache-2.0 text (was a 13-line stub).
- `SECURITY.md` email placeholder removed.
- Root monorepo metadata rewritten for public release: Apache-2.0,
  repository/bugs/homepage links, minimal devDependencies (dropped ~100 stale
  hoisted deps from root `package.json`).
- Build/clean scripts are cross-platform (Windows-safe `fs` calls instead of
  `rm -rf`/`cp -r`); `tsc --noEmit` lint added for core, cli, mcp-server.
- CI runs on ubuntu, macOS, and Windows with upgraded actions
  (`checkout@v7.0.1`, `setup-node@v7.0.0`, `action-gh-release@v3.0.2`) and
  Dependabot (npm + GitHub Actions).
- Lockfile regenerated with npm 10 so platform packages (fsevents, esbuild
  binaries, lightningcss) carry explicit `optional` flags — fixes
  `npm ci` `EBADPLATFORM` on Linux/Windows.
- Added `scripts/check-published.test.mjs` — deterministic retry/backoff
  tests for the propagation check.

### Removed

- `packages/github-action/` — it installed the squatted `keel` npm package
  (teamkeel) and never ran in CI.
- Legacy installer/config artifacts (.ai-enforce.yaml, install.sh,
  policy.rego, .pre-commit-hooks.yaml) — nothing loads them.
- Test suites now run on POSIX only; Windows verifies install/build/lint.
  The core path matcher needs separator normalization for full Windows test
  parity (tracked in ROADMAP).

## 0.1.5 (2026-08-01)
