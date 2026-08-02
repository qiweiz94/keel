# Changelog

## Unreleased

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
