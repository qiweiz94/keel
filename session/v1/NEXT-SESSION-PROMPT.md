# Master prompt — paste this to start the next Keel session

Copy everything below the line into a fresh session to resume with full context.

---

I'm resuming work on **keel** (`/Users/nanoclaw/code/keel`, branch `v0.4-thesis`, Apache-2.0
AI-coding-agent guardrail CLI). Read `session/v1/PENDING.md`'s new **"UPDATE 2026-08-22"** block
at the top first, then `session/v1/SESSION-LOG-2026-08-21-push-pr-and-docs-remediation.md` for
full narrative if you need it. Here's the state and what I need from you:

## Where things stand

- `v0.4-thesis` is pushed to `origin`. **PR #17 is open**: https://github.com/qiweiz94/keel/pull/17
  (`v0.4-thesis` → `main`). It is `MERGEABLE` but `UNSTABLE` — blocked by CI.
- **Docs remediation is DONE and merged** (commit `60c3744` — CHANGELOG/README/ROADMAP/SPEC/
  do-not-ship.test.ts). Verified fresh, full suite green. Don't redo this.
- **The one open blocker is a CI-only bug**, unrelated to any of the 372 commits' real logic:
  `packages/opencode-plugin`'s `npm test` (which runs `node ./scripts/load-test.js` directly, not
  vitest) prints every single `PASS` line, then `All checks passed` (confirming its internal
  `failures` counter is genuinely 0), and then **the process still exits with code 1** — on all 3
  CI platforms (ubuntu/macos/windows-latest, Node 22.12.0) identically. This does NOT reproduce
  locally — every local run this whole prior session, on Node v26.0.0, exits 0 cleanly with
  identical output. The CI run to look at: `gh run view 32565266549 --repo qiweiz94/keel
  --log-failed` (ran against head `60c3744`, still the current HEAD).

## Task 1 (primary): diagnose and fix the CI-only exit-1 bug

This is the only thing standing between here and merging PR #17 (and, transitively, cutting the
actual release — `.github/workflows/release.yml`'s `test` job runs this exact same check before
`npm publish`, so it would abort a real publish too).

**The one concrete lead not yet tried:** local Node is v26.0.0; CI is pinned to 22.12.0. Install
22.12.0 via `nvm install 22.12.0 && nvm use 22.12.0`, then run `cd packages/opencode-plugin && node
./scripts/load-test.js; echo "EXIT: $?"` directly. If it reproduces the failure there, you have
your root cause — bisect from there (Node's unhandled-rejection/exit-code defaults changed across
majors; look for anything in `load-test.js` — the multiple `spawnSync('git', ...)` calls
(~line 537-541), the trailing `spawnSync('opencode', ...)` probe (~line 1060-1072, only fires
`if (opencodeProbe.status === 0)`), or any unawaited async operation — that could leave a
dangling handle or fire an unhandled rejection *after* the synchronous script body finishes
printing "All checks passed" but *before* the process naturally exits). If it does NOT reproduce
even at 22.12.0, the CI environment itself (sandboxed shell, non-TTY, resource limits) is the next
thing to interrogate — compare against the raw CI log line-by-line for anything after "All checks
passed" that a local terminal wouldn't show.

**Once fixed:** re-push, confirm `gh pr view 17 --json mergeStateStatus` reports something other
than `UNSTABLE`, and confirm all 3 `test (*, 22.12.0)` checks show `conclusion: SUCCESS` via
`gh run list --branch v0.4-thesis --limit 3`.

## Task 2: once CI is green, merge PR #17

I explicitly asked for "review/merge PR #17, then cut the release" — the review checkpoint was a
deliberate choice (see the session log §2.1-2.2 for why), so don't merge while CI is still red
even if you think the docs/logic changes themselves are fine. Once CI is actually green, merging
is the expected next action — confirm with me first if anything about the PR's content looks off
on a fresh look, otherwise proceed.

## Task 3: after merge, cut the real release

Tag `v1.0.0` against `main`'s new HEAD, push the tag, let `.github/workflows/release.yml` run.
Verify the publish actually completed: check the release workflow run, confirm
`@get-keel/cli`/`@get-keel/core`/`@get-keel/opencode-plugin` show up on the real npm registry
(`npm view @get-keel/cli versions` etc.), confirm the GitHub Release was created. This is a
public, hard-to-reverse action — confirm with me before pushing the tag even though I already
said to cut the release, since actually publishing to the real npm registry is exactly the kind
of action worth a last checkpoint.

## Task 4: after that, the rest of the original release checklist still applies

`session/v1/PENDING.md` §1 (human-gated release sequence: real-machine dogfood burn-in, Windows CI
green — now moot since Task 1 makes Windows CI green as a byproduct, CHANGELOG fresh-eyes skim,
merge to main — same as Task 2, npm publish — same as Task 3, flip the repo public, per-host
live-verify with real credentials, record the demo GIF) and §2 (deferred/optional: detection-axis
benchmark at scale, accepted arms-race residuals — don't chase these unless asked) are unchanged
from the 2026-08-20 handoff and still apply once the release is actually live. Read that file's
full text rather than assuming this summary is complete — it has exact commands and file paths
per item.

## Optional, not currently tasked, only if I ask

Writing up the `keel-harness/keel` competitive comparison (a different, unrelated full-harness/
sandboxing product, not a copy of us — timeline evidence doesn't support that claim either) into
`docs/comparison.md` next to the existing `agentsh` "layer underneath us" categorization. This was
discussed and answered conversationally last session but never written to a file. Don't do this
unless I bring it up — it's not blocking anything.

## Ground rules (from this repo's CLAUDE.md, still binding)

- `npm test` (not just `npm run build`) is the only acceptable verification before claiming
  something works.
- Sign commits with `--signoff`, never `--force` push (use `--force-with-lease`), never bypass
  git hooks.
- Product name is `keel`, never anything else.
- Before any destructive/irreversible git operation, check `git status` first.
- Don't default silently on format/convention questions — ask.
