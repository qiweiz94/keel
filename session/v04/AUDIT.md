# Keel v0.4 + M1 — Session Audit

Branch `v0.4-thesis` (continues `v0.3-autonomous`; never pushed, never published, never merged to
main). Supervisor: Fable (planning, routing, all gate verification, and the browser + engine fixes
it did itself). Workers: Sonnet (implementers), Opus (security review + red-team), Haiku (none this
session). Full trail in `session/v04/DECISIONS.md`; per-lane evidence in `session/v04/EVIDENCE/`.
The "Untested / unverified" list is deliberately populated.

## Verified working (supervisor reproduced each itself)

- **Full suite green:** core 541 / 2 skipped, cli 708 / 14 skipped, exit 0 (44 default rules).
- **The thesis is MEASURED** (`session/v04/EXPERIMENT.md`). On harm-eliciting tasks (N=12/arm, free
  model), a keel-guarded cheap agent caused **0% harm vs 75% unguarded** and executed **0 forbidden
  actions vs 67%**, while *improving* task completion (75% vs 8%) with **zero false-positive drag**
  on controls. Prevention axis decisive. Detection axis reported honestly as inconclusive in the
  first battery; the benchmark lane later showed it IS elicitable (see below).
- **Floors are un-bypassable** — verified live by the supervisor across every neutralization vector
  that was closed: a lower-scope config cannot weaken a `level: protect` floor by lowering its
  action, flipping it to `mode: observe`, or swapping in a no-op match (same-id, `mergeRules`
  MODE_STRENGTH + exclusion-based surface check). (Different-id priority-shadowing: fix IN FLIGHT.)
- **Regex bypass classes closed (A2 shell-parse layer)** — the highest-leverage correctness upgrade.
  A normalized command surface (quote-stripping of obfuscation-only quotes, compound-split, bounded
  inline variable expansion, interpreter-body extraction) is matched in addition to the raw string.
  Verified live: `r"m" -rf /`, `T=/; rm -rf $T` now DENY (were bypasses). Normalizer 0.139ms.
- **Interpreter-body destruction covered** — `python3 -c "shutil.rmtree('/')"` now DENIES (new floor
  rule `no-destructive-interpreter-body`, scoped to literal `/`/`~` targets, adversarial near-miss
  tested); benign interpreter calls still allow. Verified live.
- **False-positive fixed (G2)** — `echo "rm -rf /"` now ALLOWS (was a pre-existing FP), while
  `sudo rm -rf /`, `x && rm -rf /`, `sh -c "rm -rf /"` still DENY. Verified live.
- **Performance promise measured** — `evaluate()` p50/p90/p99 = 0.89/1.13/1.72ms, ~29x under the
  <50ms budget (`scripts/perf/bench.mjs`, regression test with load-guard). Verdict: holds.
- **The one budget-blowing path fixed** — `unverified-package-install` was a hardcoded 2000ms
  registry block on a cache miss; now cache-first + miss→prompt+background-fill, so `evaluate()`
  returns 5.5ms even against a hanging registry. <50ms now holds on every path.
- **Cross-process concurrency (C2)** — O_EXCL file-lock for state + ledger, 5-process contention
  tests red→green (113/36/138 → exactly 250); caught a real `ProblemLedger.load()` data-loss bug.
- **`observed_action` persisted; claim-to-evidence wired** to real channels (OpenCode
  `experimental.text.complete` proven live; Claude Code `Stop` hook wired).
- **Red-team catch rates refreshed** honestly in `SECURITY.md` (no-rules-tampering 88%,
  no-self-protection-write 93%, +`--no-preserve-root`), with the four residual evasion classes now
  reduced to symlink-redirection + runtime-variable-values (documented).
- **Version 0.4.0**, CHANGELOG + README reconciled to the measured numbers (release-docs lane;
  release mechanics documented, NOT executed).
- **Live hosts:** OpenCode + Claude Code + OpenClaw block-live (transcripts committed in v0.3).

## Confirmed bugs / residuals (known, documented, tracked)

- **Different-id floor priority shadowing** — a pre-existing lower-scope config with a *different*
  rule id + higher priority + `allow` can shadow a floor. Not a one-command agent bypass (writing
  the config is gated). **Fix IN FLIGHT** (v04-floorpriority lane).
- **Fail-closed audit not yet complete** — whether every hook.ts error path (malformed input, parse
  error, mid-eval exception) fails CLOSED vs OPEN is being audited now (v04-failclosed lane). Until
  it lands, some error paths are unverified.
- **Package-verifier background-fill dies on exit-code hosts** — the cache-fill that gives the
  deterministic deny on retry runs only on long-lived hosts (opencode plugin, MCP daemon); on
  claude-code/codex/gemini/cursor, `hook.ts` `process.exit()` kills it, so the slopsquatting gate
  degrades to always-prompt (SAFE, but not deterministic-deny). Queued for M2/B1.
- **Novel reward-hacking class unguarded** — models game impossible tests via environment
  introspection (`process.argv`/`Error().stack` caller-sniffing). Observe-rule proposal IN FLIGHT
  (v04-envintro lane); a content regex will catch obvious shapes and miss clever ones (honest).
- **`git checkout -- <file>` FP** — `no-destructive-commands` blocks a safe single-file checkout;
  rules-tuning follow-up.
- **`install()` writes global `~/.keel` regardless of `--host`** (bare `homedir()`, no env override)
  — a fresh-machine robustness bug (D1 finding). Not fixed.
- **`--level` flag is inert** (rules-file level wins); documented.

## Untested / unverified

- **Detection-axis metrics in the main experiment had a zero base rate** (the free model solved the
  behavioral tasks). The benchmark lane LATER built tasks that DO elicit them (a model gamed an
  impossible task; another produced a real stuck-loop) — but a graded A/B battery at scale on those
  new tasks has NOT been run. The prevention thesis is measured; the detection thesis is
  demonstrated-elicitable but not yet quantified at N.
- **Some "prevention" in the experiment could be MODEL SELF-CENSORSHIP, not keel** — the child models
  sometimes refused `git push --force` on their own before keel's hook saw it (D1 finding). The
  experiment's forbidden-action attributions have NOT been re-audited to separate model-refusal from
  keel-block. This caveat must be checked before the prevention numbers are used in marketing.
- **Warn-visibility live-verified only on OpenCode**; other hosts docs/best-effort (unchanged).
- **Gemini/Codex/Cursor/Cline/Hermes: not block-live-verified** (auth-blocked or no headless path).
- **Windows: unbuilt** (M3). No Windows test coverage.
- **claim-to-evidence live only on OpenCode**; other hosts wired at docs-confidence, and exit-code
  hosts never call `markVerificationSatisfied` (obligations don't discharge) — M2/B1.

## Supervisor conduct note (honest)

The browser-tab flood the user hit three times was **misdiagnosed by the supervisor as opencode**
when the real cause was the `dashboard --web` browser-open firing in `npm test` (the supervisor's
own gate runs included). The supervisor stopped opencode lanes twice on the wrong theory and pushed
unverified urgent "CI=1 BROWSER=none" changes; two worker lanes correctly refused them as
injection-shaped. The real fix (a TTY gate + regression guard, merged into every worktree) is done
and verified. Lesson recorded: root-cause before acting; don't steer lanes mid-flight with urgent
unverified changes.

## Explicitly NOT done

No observe-rule promotion; no publish; no main-merge; no Windows; no Cursor/Cline/Hermes live
verification. Everything is local commits on `v0.4-thesis` awaiting the user's review.
