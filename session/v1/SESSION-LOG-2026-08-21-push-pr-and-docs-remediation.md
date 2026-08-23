# Session log — push to public, PR #17, competitive research, docs remediation

**Dates covered:** 2026-08-21 → 2026-08-22. **Branch:** `v0.4-thesis` throughout, now pushed to
`origin`. **Companion doc:** `session/v1/PENDING.md` (updated with a new 2026-08-22 block at the
top — this log is the narrative; PENDING.md is the actionable state). **Master handoff prompt for
the next session:** `session/v1/NEXT-SESSION-PROMPT.md`.

---

## 1. Goal for this window

Prior sessions left keel v1.0.0 fully built, hardened, and honestly documented but **entirely
local** — nothing pushed, nothing published (see `session/v1/PENDING.md` "THE BIG ONE"). This
window's explicit user request was: *"can you help me commit and push and make it ready for
public release and public use?"* — i.e. actually cross the local→public boundary that every prior
session had deliberately stopped short of.

## 2. Decisions made, in order, with the reasoning

### 2.1 Push scope — asked, user chose "Push branch + open a PR"

Offered two options: merge into `main` and push directly, vs. push the branch and open a PR for
review first. **User chose the PR path.** Reasoning for offering it: `main` is the public-facing
branch; a PR gives a review checkpoint and a visible diff before 372 commits of hardening work
lands on it irreversibly.

### 2.2 Release scope — asked, user chose "Also cut the real release"

Offered GitHub-only vs. also publishing to npm. **User chose to also cut the real release.** This
created a real tension against 2.1 (a review checkpoint is only meaningful if the release doesn't
happen regardless of the checkpoint's outcome) — resolved by pushing + opening the PR immediately,
but **deliberately withholding the npm publish/tag step** until the user actually reviews/merges
the PR. This was a self-directed judgment call, not asked again, on the reasoning that publishing
before merge would make the "review" checkpoint the user explicitly chose meaningless.

**Result:** `v0.4-thesis` pushed to `origin`. PR opened:
**https://github.com/qiweiz94/keel/pull/17** ("v0.4-thesis: major feature/hardening round — 372
commits"), base `main` ← head `v0.4-thesis`. Full PR body documents the feature/hardening/supply-
chain/docs scope; explicitly states in its own text that it does not cut or publish a release.

### 2.3 Competitive research — `keel-harness/keel` (github.com/keel-harness/keel)

User asked whether this similarly-named project copied our idea, based on believing they started
after us, and asked for a comparison and anything worth learning/copying.

**Timeline claim checked against evidence, not accepted at face value:** pulled actual
repo-creation and first-commit timestamps on both sides. Finding: **the evidence does not support
"they copied us."** Their GitHub repo was created ~73 minutes before ours; our first commit
predates their first commit by ~2.5 days. Net: inconclusive-to-slightly-against the premise, not
supporting it. Reported this plainly rather than confirming the assumption.

**Architectural comparison:** `keel-harness/keel` is a different category of product from ours —
a full standalone agent harness/CLI with an out-of-process "Warden" doing real OS-level sandboxing
(macOS Seatbelt, Linux bubblewrap, vendored `@anthropic-ai/sandbox-runtime`), hash-pinned policy,
"trust before parse" / "intent before effect" (audit-write-before-action, fail-closed on write
failure), an Ed25519-checkpointed tamper-evident audit hash chain, connect-time egress address
pinning, a published evidence-number ledger, and numbered ADR docs. Our keel is an in-process
tool-call interception layer that hooks into *existing* agents (Claude Code, Cursor, OpenCode,
Cline, Codex, Gemini CLI) rather than replacing/wrapping them in a new harness process.

**Categorization used:** our own existing `docs/comparison.md` / `docs/defense-in-depth.md`
already class kernel-level sandboxing tools (e.g. `agentsh`) as "a layer underneath us," not a
direct competitor. Applied the same categorization to `keel-harness` here, despite the name
collision — it is architecturally a sandboxing-harness product, not an interception-layer
competitor. **Nothing was written to any doc file this session** — this was a conversational
answer only. If the user wants this captured, `docs/comparison.md` is the natural home; not done
because it wasn't asked for as a doc change, only as an answer to the question. Flagged here as a
possible follow-up, not an open task.

### 2.4 Strategy question — "which is a better product, easier to sell/adopt?"

Also surfaced a terminology mismatch: the user used "harness" loosely (governance framework) while
`keel-harness` uses it in the strict sense (full agent runtime). Clarified the distinction.
**Recommendation given** (not acted on, purely advisory): stay an overlay/interception layer —
lower adoption friction (works with agents people already use, no migration), the moat is the
rule corpus + measured evidence + distribution, not the sandboxing tech; the counter-consideration
named explicitly was that pairing with a sandboxing layer later (rather than building one) is a
reasonable future move, not a reason to pivot now.

### 2.5 "What is the proposed next step?" — re-entered Plan Mode, user chose

Presented 4 options; **user explicitly chose: "Review/merge PR #17, then cut the release."** This
is the instruction the rest of this window's read-only investigation (§3) and the eventual pivot
to docs remediation (§4) both trace back to.

## 3. CI investigation on PR #17 — found, diagnosed partially, **not yet resolved**

`gh pr view 17` showed `mergeStateStatus: UNSTABLE` — all 3 CI platforms (`ubuntu-latest`,
`macos-latest`, `windows-latest`, Node `22.12.0`) failing. Pulled the failure log
(`gh run view 32565266549 --log-failed`).

**What the log actually shows, confirmed by direct grep on all 3 platforms identically:** every
individual test in every workspace passes (core/cli/mcp-server all fully green), and
`packages/opencode-plugin/scripts/load-test.js` (run via plain `node`, not vitest, as that
workspace's own `npm test`) prints **every** `PASS` line through `PASS  dist matches canonical
template`, then `All checks passed` — its own internal `failures` counter is provably zero — and
then, immediately after, `##[error]Process completed with exit code 1.` On Windows the npm-level
wrapper error is explicit (`npm error command failed`). This rules out a real regression in the
372 commits' logic (every check passed) and rules out this being a known Windows-only gap (all 3
platforms fail identically).

Read `load-test.js` in full (1081 lines) to understand its structure. Confirmed the success path
has **no explicit `process.exit(0)`** — the script just falls off the end of `main()` after the
final `console.log('\nAll checks passed')`. This is consistent with Node's default exit code being
whatever the event loop naturally resolves to, which opens the door to an async leak (unhandled
rejection, dangling child-process handle, etc.) firing *after* the synchronous script body
completes but *before* the process actually exits — a mechanism that would not show up as a
`FAIL` line (since it happens after every check already ran) but would still flip the exit code.

**Attempted local reproduction, post-context-compaction:** ran `node ./scripts/load-test.js`
directly in `packages/opencode-plugin`. Result: **exit code 0**, "All checks passed" printed
cleanly, no discrepancy — matching every prior local run this whole session. Local Node version:
**v26.0.0**. CI's pinned version: **22.12.0**. This version gap is the leading unconfirmed
hypothesis (Node's handling of unhandled promise rejections became stricter/fatal across recent
majors; a v22-vs-v26 behavioral difference here is plausible but **not yet proven** — no specific
line in `load-test.js` has been identified as the actual source of an unhandled rejection or open
handle).

**Status at handoff: UNRESOLVED.** This is the single blocker on PR #17 merging and, transitively,
on cutting the release at all (`.github/workflows/release.yml` runs the identical `test` job
*before* the `npm publish` step, so this bug would also abort a real publish attempt, not just the
PR merge). See `session/v1/NEXT-SESSION-PROMPT.md` §1 for the concrete next diagnostic step
(install/use Node 22.12.0 locally via nvm and try to reproduce — this session never actually tried
matching CI's exact Node version locally, which is the obvious next move that wasn't reached).

## 4. Docs remediation — planned, and (separately) already fully executed

While investigating the CI bug, discovered that a **fully-drafted Plan Mode plan** already existed
at `/Users/nanoclaw/.claude/plans/swirling-foraging-key.md` for a different, later task: **"Keel —
release-prep documentation remediation."** This reflects that between this window's CI
investigation stalling and this point, a separate thread of work happened (visible via a second
working directory in this environment, `.claude/worktrees/agent-a09a40e1604b5ed29`) that is not
fully captured in this log's narrative continuity but IS fully captured in its result, verified
directly against the repo (see below) rather than trusted blindly.

**The plan's own finding (already verified true by the time this session picked it back up):**
`package.json` everywhere claims `1.0.0`, but `git tag --list` tops out at `v0.2.2` and the real
npm registry confirms neither `@get-keel/cli` nor `@get-keel/core` has ever published past
`0.2.2`/`0.1.9`. Asked how to handle this (in the thread that produced the plan), the user chose:
**docs-only, no publish/tag/push**, and **keep `CHANGELOG.md`'s existing `## 1.0.0`/`## 0.4.0`
section headers as the intended eventual boundaries** rather than flattening everything into
`## Unreleased`. A design pass then verified, via `git log -S` pinpointing when each existing
CHANGELOG section was authored and `git merge-base --is-ancestor` against every candidate item,
that **all 18 backfill items postdate both existing sections** — so everything goes into
`## Unreleased`, nothing into `## 1.0.0`/`## 0.4.0`. It also caught one extra, previously-missed
18th item (`4fcd5a1`, regulatory-mapping docs — NIST AI RMF / EU AI Act / ISO 42001 — confirmed via
a zero-hit grep across the whole CHANGELOG before the fix). Full narrative and per-file reasoning
is in the plan file itself, `/Users/nanoclaw/.claude/plans/swirling-foraging-key.md`.

**On resuming this session, found the plan's own git-log evidence already stale in one respect —
its implementation was already done:** `git log` on `v0.4-thesis` showed merge commit **`60c3744`
— "docs: release-prep remediation — backfill CHANGELOG, fix ROADMAP/README/SPEC staleness"** —
already on the branch, already pushed to `origin`, touching exactly the 5 files the plan scoped
(`CHANGELOG.md` +538/-…, `README.md` +54, `ROADMAP.md` +84, `SPEC.md` +15,
`packages/cli/src/__tests__/do-not-ship.test.ts` +32/-…, 673 insertions / 50 deletions total).

**Did not trust the merge commit's existence as proof of correctness — verified the actual
content against the plan's specific claims, live, this session:**

- `grep` for "NIST"/"ISO 42001"/"regulatory" in `CHANGELOG.md` — present (the 18th item landed).
- `README.md`'s rule-count claim — now reads "53 rules," matching `drift.test.ts`'s own "has
  exactly 53 rules" assertion (which passed in the same run — an independent cross-check, not
  just trusting the doc's own number).
- `ROADMAP.md` header — now bare `## Shipped` (the plan's specified fix; not a different,
  still-wrong specific unpublished version number).
- `do-not-ship.test.ts` — zero remaining "EXPECTED FAILURE"/"pending" language (grepped directly).

**Then ran the plan's full verification section fresh, not reused from any prior run:**

- `npm test` in `packages/cli` alone: exit 0, 62 files / 1136 tests passed, 14 skipped.
- `npm test --workspaces` (all 3 workspaces): exit 0. `core` 56 files/1098 tests (2 skipped),
  `cli` 62 files/1136 tests (14 skipped), `opencode-plugin` 2 files/10 tests — **and the
  `opencode-plugin` `load-test.js` run inside this same command completed cleanly with "All
  checks passed" and exit 0**, i.e. §3's CI-only bug did not reproduce here either, consistent
  with every prior local run this session.
- `scripts/redteam/round2.mjs`: exit 0, output explicitly states "All documented control catches
  still deny (no floor regression)" — the only non-caught bypass attempts are the 3 pre-existing,
  already-disclosed residuals (`env sh -c` obfuscated inner rm, `os.remove` non-root scoped-out
  case, `${IFS:0:1}` parameter-expansion-modifier form), none new.
- Real `~/.keel/rules.yaml` sanity check — file present, loaded, non-empty, structurally sane
  (this machine's personal global config, unaffected by a docs-only change — checked anyway per
  the plan's own verification step, not skipped).

**Important cross-check that ties §3 and §4 together:** `gh run list --branch v0.4-thesis` was
used to confirm CI run `32565266549` (the failing run analyzed in §3) ran against `headSha
60c3744` — i.e. **the CI failure is present on the exact commit that includes the docs
remediation**, and the docs changes touch zero files under `packages/opencode-plugin/`. This
confirms the two issues are unrelated: the CI bug is a pre-existing, still-open blocker
independent of the (now complete and verified) docs work.

**Docs remediation status: DONE.** Merged (`60c3744`), pushed to `origin/v0.4-thesis`, content
verified against every specific claim in the plan, full local test/redteam suite green. Nothing
further needed here. `git status` clean, nothing left uncommitted.

## 5. What is genuinely still open at the end of this window

1. **CI bug on PR #17 (§3) — the sole active blocker.** Not resolved. Concrete next diagnostic
   step identified (match CI's exact Node 22.12.0 locally) but not yet tried.
2. **PR #17 itself** — open, mergeable, blocked only by #1. Not merged (correctly — merging with
   red CI would contradict the review checkpoint the user explicitly chose in §2.1).
3. **The release** — not cut. No tag, no `npm publish`. Correctly withheld per §2.2's reasoning,
   compounded by #1 (the release workflow's own `test` job would hit the identical failure).
4. Everything already listed as open in `session/v1/PENDING.md` §1–§4 from the 2026-08-20 handoff
   (human-gated release sequence beyond CI: dogfood burn-in, Windows CI green, CHANGELOG skim,
   merge to `main`, `npm publish`, flip repo public, per-host live-verify, demo GIF; the
   detection-axis benchmark; the accepted arms-race residuals) is **still open, unchanged, and not
   re-litigated here** — see that file directly rather than duplicating it.
5. Optional, not currently tasked: writing the keel-harness comparison (§2.3) into
   `docs/comparison.md` if the user wants it captured as a durable artifact rather than a
   conversational answer.

## 6. Artifacts touched or produced this window

- **Pushed:** `v0.4-thesis` branch (373 commits including `60c3744`) → `origin`.
- **Opened:** PR #17 — https://github.com/qiweiz94/keel/pull/17 (open, unmerged).
- **Merged separately (not by this session's direct edits, but verified by this session):**
  commit `60c3744` on `v0.4-thesis` — `CHANGELOG.md`, `README.md`, `ROADMAP.md`, `SPEC.md`,
  `packages/cli/src/__tests__/do-not-ship.test.ts`.
- **Read, not modified:** `packages/opencode-plugin/scripts/load-test.js` (1081 lines, full read,
  for the CI investigation).
- **Plan file (Plan Mode):** `/Users/nanoclaw/.claude/plans/swirling-foraging-key.md` — approved,
  and its implementation confirmed already merged.
- **This session log:** `session/v1/SESSION-LOG-2026-08-21-push-pr-and-docs-remediation.md`.
- **Updated:** `session/v1/PENDING.md` (new block prepended, nothing removed).
- **New:** `session/v1/NEXT-SESSION-PROMPT.md` — master handoff prompt for the next session.
