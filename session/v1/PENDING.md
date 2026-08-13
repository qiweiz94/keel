# Keel v1.0.0 — PENDING / handoff for a new session

**State at handoff:** branch `v0.4-thesis` @ `79ca29c`, version **1.0.0**, **213 commits ahead of
`main`**, suite green (core 622 / cli 840 / mcp 6 / plugin all-pass), `npm publish --dry-run` clean.
**NOTHING has been pushed, published, or merged.** Full record: `session/v1/SESSION-LOG.md`. Honest
audit: `session/v1/AUDIT.md`. Everything below is what's LEFT.

Every code-closable AUDIT gap is CLOSED. What remains is either human-gated (needs credentials /
budget / an outward action) or a deliberately-accepted limit or optional follow-up.

---

## 0. THE BIG ONE — the entire v1.0.0 is unreleased and local

All 213 commits live only on the local `v0.4-thesis` branch. The release itself has not started.
The ordered sequence is in `session/v1/HUMAN-CHECKLIST.md`; summary below.

## 1. Human-gated release sequence (only a human can do these)

Recommended order:
1. **Real-machine dogfood / burn-in** — *the one gate the test suite + benchmark cannot stand in
   for.* keel has never run on a real dev machine against real agent sessions. Install locally, live
   with it a few days before announcing. HIGHEST-VALUE pre-publish gate. (HUMAN-CHECKLIST §4)
2. **Windows CI green** — push a branch so `windows-latest` runs the full suite; nanoid is fixed so
   the audit step is clean. Windows is logic-complete + unit-covered but **runtime-unverified** on a
   real Windows host. Exact steps: `session/v1/runbooks/windows.md`. (§7)
3. **CHANGELOG fresh-eyes skim** against `session/v1/EVIDENCE/*.md`. (§8)
4. **Merge to `main`** — the integration branch is **`v0.4-thesis` @ `79ca29c`** (NOT the old lane
   branches). (§3)
5. **`npm publish`** — dependency order (core → cli/opencode-plugin), `--dry-run` immediately
   before each. Deliberate human action. (§1)
6. **Flip the GitHub repo public** + confirm the SECURITY.md advisory URL resolves. (§2)
7. **Per-host live-verify** — Gemini/Codex/Cursor/Cline/Hermes/OpenClaw need real credentials; run
   `scripts/live-verify/<host>.sh`, commit transcripts, upgrade the matrix honestly. Steps:
   `session/v1/runbooks/per-host.md`. (§5)
8. **Record the demo GIF** — `scripts/demo/keel-disable-trace.sh` → asciinema → GIF → link from
   README + landing. (§6)

## 2. Deferred / optional code follow-ups (a future session COULD do)

- **Detection-axis benchmark at scale — thesis still UNPROVEN.** The free model is too capable to
  fail the false-claim/tamper/stuck tasks, so the detection base rate is too low to measure a keel
  delta (the N=4 run even had the guarded arm false-claim slightly more, by chance). To actually
  prove/disprove detection: run a **mid-capability model** (between the too-capable free model and
  the too-weak tiny one) and/or the **paid frontier arm** (`opencode-go/*`, `--allow-paid`). Harness
  + attribution guard + cost gate are ready. Steps: `session/v1/runbooks/benchmark.md`.
- **Accepted arms-race residuals (user chose to ACCEPT as documented — harden only if desired):**
  quote-wrapped `rm"${IFS}"-rf"${IFS}"/` and `${IFS:0:1}` modifier forms (`command-normalizer.ts`
  `renderToken` would need to expand inside double-quoted segments); Python interpreter-body aliasing
  (`__import__('shutil').rmtree('/')`); `os.remove('/etc/passwd')` non-root path (floor scoped to
  `/`/`~` by design). All are best-effort regex limits; chasing them invites false-positives.
- **perf-budget CPU-time blindness (accepted).** The rewritten test measures CPU-time, so a
  wall-clock-only regression (sync disk/network added to the hot path) wouldn't be caught. Accepted
  because the hot path is pure in-memory today; `scripts/perf/bench.mjs` still reports wall-clock.
- **Exfil deny-tier stays single-process by design.** The new cross-process correlation is
  **warn-tier** only (a hard block would false-positive on legit read-token-then-network builds).
  A deny-tier cross-process rule would need careful FP work — deliberately not done.
- **Rego/WASM policy engine** is marked EXPERIMENTAL (unwired, not shipped, smoke-tested only).
  Long-term: wire it to the YAML test bar, or remove it.
- **Prompt injection remains unsolved** (stated plainly in `docs/exfil.md` / SECURITY.md) — an
  architectural limit, not a bug.

## 3. Strategy / GTM (discussed this session, not yet acted on)

The user asked about IP protection + go-to-market. Recommendations captured for when launch nears:
- **License:** Apache-2.0 (already set) for the core; keep any future hosted/fleet product
  proprietary (open-core). **Trademark the name "Keel."** Optional DCO/CLA to preserve relicensing.
- **Moat is not the code** — it's the curated rule corpus + the measured evidence + brand +
  distribution. Open source *is* the trust moat for a guardrails tool.
- **GTM wedge:** lead with the measured number (0% vs 14–75% harm, keel-attributed); a 10-second
  `npx keel scan` → protected aha; a demo GIF of an agent trying `keel disable` and being blocked;
  the reproducible benchmark as a credibility artifact; distribute where the agents already are
  (OpenCode/Claude Code/Cursor/Aider communities); position as the cross-agent guardrail layer.

## 4. Housekeeping (harmless; clean up when confident)

- **`v04-liveverify` branch/worktree** — genuinely-unmerged v0.4 D1 live-verify work (kept
  deliberately). Decide: merge its useful bits or drop it. `../keel-v04-liveverify` on disk.
- **37 lane branch refs still exist** (`v1-*`, `v1p2-*`, `worktree-agent-*`). Harmless; deletable
  with `git branch -D <name>` once you're confident nothing in them is wanted. All their merged work
  is in `v0.4-thesis`.
- **Recovery patches** at `session/v1/stale-worktree-patches/` (gitignored) — safety net for the 4
  stale-base worktrees' superseded uncommitted work. Delete anytime: `rm -rf
  session/v1/stale-worktree-patches/`.

## 5. Build gotchas & conventions for whoever resumes (learned the hard way this session)

- **Commit messages must NOT contain the substring `nc`** — a shipped scanner substring-matches it
  and the pre-commit hook blocks. Bit every worker repeatedly; watch words like `nc`, `since`,
  `instance`, `enhance`, `evidence`, `unchanged`, `once`, `announce`, `advisory`→no, `benchmark`(be**nc**h),
  `bench`. `grep -in nc` your message before committing. (Not in the repo's CLAUDE.md; a session fact.)
- **Do NOT use Agent `isolation: worktree` for parallel lanes off `v0.4-thesis`** — its baseRef
  default branches off stale `main`, not current HEAD (and was observed inconsistent). Use MANUAL
  worktrees: `git worktree add -b <lane> ../<dir> v0.4-thesis`, and VERIFY the base commit before
  trusting a lane. See memory `feedback_worktree_isolation_baseref_fresh_branches_off_main`.
- **Generated files, never hand-edit:** `packages/cli/src/core/**` (gitignored copy) and
  `packages/cli/templates/keel-enforce.js` (tracked bundle). Edit source in `packages/core/src`,
  `npm run build`, then test. `DEFAULT_RULES_YAML` is a TWO-file change (`install.ts` +
  `opencode-plugin/src/plugin.ts`, guarded by `drift.test.ts`, paste-safe: no backtick/backslash/`${`).
- **Never touch the real `~/.keel` / `~/.claude` / `~/.opencode`** — tests/experiments use isolated
  `HOME`/`KEEL_STATE_DIR`/`KEEL_OVERRIDES_DIR` + `/tmp` scratch. The A5 `globalSetup` guard now
  fails the suite if real `~/.keel/overrides.json` is touched. (This session cleaned one stale
  expired grant out of it, deliberately + reported.)
- **`round2.mjs` must exit 0** — the red-team regression harness; run it after any floor/normalizer
  change. **perf-budget.test.ts** measures CPU-time now (skips, never fails, under heavy load).
- **The strongest measured number** (v0.4, N=12 harm-eliciting): guarded cheap agent **0% harm vs
  75% unguarded**, attribution re-audited to real keel blocks — `session/v04/EXPERIMENT.md`. The
  Phase-3 full-battery N=4 result (prevention decisive, detection unproven) is `benchmark-scale.md`.

## 5b. Key pointers for the next session

- Record of what was done: `session/v1/SESSION-LOG.md`
- Honest final audit (all gaps + residuals): `session/v1/AUDIT.md`
- Human release steps: `session/v1/HUMAN-CHECKLIST.md` + `session/v1/MERGE-NOTE.md`
- Runbooks: `session/v1/runbooks/{windows,per-host,benchmark}.md`
- Per-lane evidence: `session/v1/EVIDENCE/*.md`
- Red-team regression harness: `scripts/redteam/round2.mjs` (must exit 0)
- Memory (persistent, cross-session): the `project_keel_v1_build_complete_2026-08-12` note.

**One-line status for a cold start:** keel v1.0.0 is built, hardened, and honestly documented on
local `v0.4-thesis`; every code gap is closed; the release itself (dogfood → Windows CI → publish →
go-public → main-merge) and the detection-axis proof are what's left.
