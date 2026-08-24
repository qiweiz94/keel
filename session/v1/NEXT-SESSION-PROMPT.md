# Master prompt — paste this to start the next Keel session

Copy everything below the line into a fresh session to resume with full context.

---

I'm resuming work on **keel** (`/Users/nanoclaw/code/keel`, branch `v0.4-thesis`, Apache-2.0
AI-coding-agent guardrail CLI). Read `session/v1/PENDING.md`'s **"UPDATE 2026-08-24"** block at
the top first — it corrects an earlier misdiagnosis, so don't trust anything below this point that
contradicts it. Full detail on both fixes is in the commit messages for `d04295d` and `0261377` on
`v0.4-thesis`. Here's the state and what I need from you:

## Where things stand

- `v0.4-thesis` is pushed to `origin`. **PR #17 is open**: https://github.com/qiweiz94/keel/pull/17
  (`v0.4-thesis` → `main`).
- **Docs remediation is DONE and merged** (commit `60c3744`). Don't redo this.
- **The earlier "load-test.js prints All checks passed yet exits 1" diagnosis was WRONG** — a
  misreading of the CI log (only the tail near the exit code was grepped, missing a real failure
  earlier in the same step). `npm test --workspaces` runs core/cli/opencode-plugin in one step and
  only reports its own aggregate exit code at the end, so an early failure in `core` surfaces only
  after every later workspace's own successful output has already printed.
- **Two real bugs were found and fixed, both pushed:**
  1. `d04295d` — a genuine Windows self-protection gap: `no-enforcer-removal` and
     `no-self-protection-write`'s regexes hardcoded forward slashes, so a Windows-style backslash
     path (`rm C:\...\.opencode\plugins\keel-enforce.js`) bypassed both rules on a real Windows
     machine. Fixed in both `DEFAULT_RULES_YAML` copies, with a new platform-independent
     regression test. Mutation-probed (revert → red → restore → green).
  2. `0261377` — `opencode-db.test.ts` needs `--experimental-sqlite` on Node 22.12.0 (CI's exact
     pinned version); without it `node:sqlite` throws `ERR_UNKNOWN_BUILTIN_MODULE` outright.
     Reproduced by downloading Node 22.12.0 directly and running the test against it locally.
     Fixed via `NODE_OPTIONS` in `packages/core/vitest.config.ts`. Also mutation-probed.
- **CI run for `0261377` was triggered but had not finished as of this being written.** Check it
  first, don't assume either outcome:
  `gh run list --repo qiweiz94/keel --branch v0.4-thesis --limit 1 --json databaseId,status,conclusion`
  then, if needed, `gh run view <id> --repo qiweiz94/keel --log-failed`.

## Task 1 (primary): confirm CI is actually green, or finish the job if not

If the run above shows `conclusion: success` on all 3 platforms: great, move straight to Task 2.

If it's still red: **read the ENTIRE failure log, not just the tail** — that exact shortcut is
what produced the wrong diagnosis before. `grep -c "FAIL" <log>` per platform first to get a real
count, then look at every occurrence, not just the ones near the exit code. Two fixes landed this
session; a third distinct issue is possible but hasn't been seen yet — don't assume it's a
variation on either bug already fixed without checking.

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
