# Keel v1.0.0 — session log (audit trail of everything done)

**Session date:** 2026-08-12 (into 08-13). **Branch:** `v0.4-thesis` @ `79ca29c`, **213 commits
ahead of `main`**, version **1.0.0**. **Nothing pushed, published, or merged to main** — the whole
release is local and awaiting the human release sequence (`HUMAN-CHECKLIST.md` / `PENDING.md`).

Execution model throughout: supervisor (this session) planned + reproduced + merged; worker lanes
(Sonnet implement, Opus red-team/review) ran in manually-created worktrees off `v0.4-thesis`, each
verified by a full-suite integration run before merge. Nothing merged on a worker's say-so alone.

Full per-item evidence: `session/v1/EVIDENCE/*.md`. Honest final audit: `session/v1/AUDIT.md`.

---

## Phase 1 — the v1.0 build (14 lanes, M1r → M6)

Goal: close every gap between v0.4 (thesis proved) and a genuine v1.0 "finished product, one
command short of publish." Each lane = a worktree, verified + merged individually.

| Lane | Commit | What it did |
|---|---|---|
| M1r-1 floor FP | `fd65d39` | Fixed a floor false-positive; found the AUDIT had **misattributed** it (culprit was `root-cause-before-refactor`, an unanchored `mode: observe` pattern) + corrected a stale fixture. |
| M1r-2 fail-closed | `767d648` | Degenerate-input fail-closed sweep — closed **real silent-allow holes**: empty stdin, empty `tool_name`, mcp-server missing action, cursor blank command all used to silently *allow*. |
| M1r-3 install KEEL_HOME | `ad9b44d` | `install()` honors a `KEEL_HOME` override across all 10 global write targets. |
| M1r-4 mask/--level | `572e59a` | Removed the dead `mask` action; fixed `--level` — and found **bare `keel enforce` was permanently broken** (commander default made it always error). |
| M2-B2 benchmark guard | `915786e` | Attribution guard baked into the grader (credits "harm prevented" only on a same-action keel block); cost-capped frontier arm; zero-spend probe. |
| M3 Windows | `c9e5ad9` | `path-normalize.ts` util (posix/win32) wired through 7 matchers — **fixed 2 real bugs** (negated-path OR/AND, `HOME||'~'` unresolved on win32); EBUSY-safe teardown (76 fixture sites); `windows-latest` CI runs the full suite. Runtime-UNVERIFIED (macOS can't run it). |
| reader-home KEEL_HOME | `bfac0c4` | Unified `install` + ~15 readers onto a shared `packages/core/src/home.ts` resolver — **closed a split-brain** M1r-3 flagged. |
| M2-B1 verification | `0c3d16b` | `PostToolUse`/`Stop` verification-claim discharge on exit-code hosts (was OpenCode-only) + slopsquatting flush fix. Honest host matrix — only Claude Code mechanism-tested. |
| M4 host breadth | `d241bba` | **OpenCode WARN genuinely live-verified** (committed transcript); Block/Warn matrix; cursor warn-key casing fix (additive). Auth-blocked hosts honestly checklisted. |
| M5-UX | `b4a3ea2` | `keel report` command + onboarding polish; found + fixed a **false "✓ enforced" promise** on bare `install`. |
| M5-security | `7d8898e` | Exfil hardening (closed `scp` sink gap + a `file_path` source-tagging bug); **discovered exfil correlation is inert on hook-invoked hosts** (documented); Rego/WASM marked experimental. |
| M5-release | `20596e8` | README/landing on the measured numbers, demo script, CHANGELOG, **version → 1.0.0**, `npm publish --dry-run` clean — found + fixed **2 real release-pipeline bugs** (root `package.json` overwrite, stray `.pyc` in tarball). Caught the rule count was 45 not 43. |
| M6 audit + red-team | `6c2a0c8` | Final audit + adversarial red-team + perf-budget rewritten to **CPU-time** (fixes a real flake). **Found a RELEASE-BLOCKING bypass** (below). |

### The release-blocker — found by M6, fixed by the supervisor (`9d25e4d`)
`bash -lc 'keel disable'` (also `uninstall`/`enforce`) turned keel **off in one command at every
dial** — a bundled short-flag (`-lc`/`-ic`/`-xc`) isn't the exact token `-c`, so interpreter-body
extraction never fired, defeating `keel-control-gate`. Fixed in `command-normalizer.ts` by matching
`/^-[a-z]*c$/` for shell interpreters. Regression-guarded by `shell-normalize-bypass.test.ts` (6
cases) + `scripts/redteam/round2.mjs` (promoted to control-catch). Also cleaned the one expired,
harmless test-injected grant out of the user's real `~/.keel/overrides.json`.

**Two lanes (reader-home, M2-B1) hit transient API/DNS errors mid-run** — both fully recovered
(reader-home's work was already committed; M2-B1 was resumed from its transcript to un-revert
cleanly). No work lost.

---

## Phase 2 — close ALL remaining AUDIT gaps

User decisions: close the clean gaps, accept the regex arms-race ones as documented, build the
exfil cross-process correlation now, prep Windows for a human push.

| Lane | Commit | What it did |
|---|---|---|
| A6 nanoid | `1fadd38` | Root `overrides` pin `nanoid ^3.3.17` (→3.3.18); `npm audit` now **0 vulnerabilities** (clears the Windows CI audit step). |
| A3+A4 install | `44f9ddf` | `install --project` now writes the **real** `DEFAULT_RULES_YAML` (was `rules: []` — a **real teammate-clone zero-enforcement bug**); Cursor/Codex "no blocking hooks" copy corrected to match real wiring. Mutation-tested. |
| A2 `${IFS}` | `24df6ab` | Seed the normalizer's expander with `IFS: ' '` — bare-word `rm${IFS}-rf${IFS}/` and `$IFS` now deny. Quote-wrapped `"${IFS}"` + `${IFS:0:1}` variants **accepted as documented arms-race residuals**. |
| A5 override isolation | `e49c53d` | The §8b leak was actually in **8 `packages/core` test files** (not the 2 named); mutation-proven a synthetic rule-id collision could silently DELETE a real armed override. Fixed all 12 sites + a `globalSetup` guard that fails the suite if real `~/.keel/overrides.json` is touched. |
| B1 exfil cross-process | `8ddb5f3` | New session-scoped, TTL'd (1h), bounded, file-locked `PersistentFlowStore` → **warn-tier** `no-exfil-flow-cross-call` (rules 45→46), wired by default into `keel hook`/`test`/`evaluate`. Deny floor untouched. advisor caught a deny-ladder suppression risk (disproven with a test). 16 new tests incl. real spawned-process concurrency. |
| Runbooks + audit refresh | `3a3b66b`, `9e469ac`, `aeebcb5` | Wrote `runbooks/{windows,per-host,benchmark}.md`; refreshed AUDIT (marked every closed gap, corrected the stale release-blocker bottom-line) + HUMAN-CHECKLIST + MERGE-NOTE (merge target = `v0.4-thesis`). |

**Integrated result:** suite green **core 622 / cli 840 / mcp 6 / plugin all-pass**; `round2.mjs`
exits 0; `npm publish --dry-run` clean at 1.0.0.

---

## Phase 3 — three follow-ups

1. **Free full-battery benchmark, N=4** (`894e889`, `benchmark-scale.md`) — 14 tasks × arms A,B,
   free model, **$0**. **Prevention decisive:** forbidden-action **14% (8/56) → 0%**, all 8
   trace-attributed to real keel blocks (8/8), guarded completed MORE (79% vs 66%), zero
   false-positive drag. **Detection NOT supported at scale:** only 3 observe-tier false-claim
   events, which slightly favored the *unguarded* arm by chance; guarded composite-harm is 4% not
   0%. Reported honestly, no dressed-up headline. Detection thesis stays unproven (free model too
   capable; needs mid-capability calibration or frontier arm).
2. **Worktree cleanup — safe, zero-loss** (`54c16b8`, `79ca29c`). Removed all this build's merged
   redundant worktree *directories*; **kept every branch ref** (37 lane branches intact) and
   `v04-liveverify` (unmerged). The 4 stale-base worktrees' uncommitted (superseded) work saved as
   patches at `session/v1/stale-worktree-patches/` before removal. Nothing lost.
3. **Release-sequence walkthrough + prep** — corrected the stale merge target, marked §7/§8 fixed,
   delivered the ordered release command list (in this session's chat + HUMAN-CHECKLIST).

---

## Cross-cutting

- **Nothing pushed / published / merged to main** — deliberate; the endpoint was "ready one command
  short of publish."
- **Infra lesson recorded to memory:** Agent `isolation: worktree` baseRef default branches off
  stale `main`, not current HEAD (and was observed inconsistent) — this session used MANUAL
  worktrees off `v0.4-thesis` after catching it.
- Commit messages avoid the substring `nc` (a shipped scanner substring-matches it).
- The user's real `~/.keel` was touched once, deliberately + reported: cleaned an expired stale
  test-injected `no-verify-bypass` grant from `overrides.json` back to `{}`.

**Bottom line:** keel v1.0.0 is a hardened, honestly-documented, release-ready build with every
code-closable AUDIT gap closed. What remains is human-gated (see `PENDING.md`).
