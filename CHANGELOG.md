# Changelog

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
