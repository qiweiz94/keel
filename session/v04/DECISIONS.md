# session/v04/DECISIONS.md — append-only (v0.4 "prove the thesis" build)

- 2026-08-11 supervisor: v0.4 plan approved. Spine = thesis experiment (guarded cheap vs
  unguarded, vs frontier reference), OpenCode + cheap open model, prep-release-no-publish.
  Canonical plan: ~/.claude/plans/swirling-foraging-key.md. Continues v0.3-autonomous.
- 2026-08-11 supervisor: Phase 0 (correctness floor) launched first — a leaky floor would
  confound the experiment's guarded arm. Lane: floors-non-overridable in mergeRules +
  self-protection-write read-FP fix + STATE_DIR per-construction env read.
- 2026-08-11 supervisor: PHASE-2 FEASIBILITY CONFIRMED (probe, zero spend). Free model
  `opencode/deepseek-v4-flash-free` via `opencode run --model ...` completed a headless task
  (wrote hello.txt="hello", exit 0, ~fast) in a /tmp scratch git repo. The cheap arm is real
  and free; OpenCode is keel-live so the guarded arm is a true end-to-end test. Frontier
  reference candidates (paid, within cap): opencode-go/grok-4.5, gpt-5.6-luna, kimi-k3.
  Harness (scripts/thesis-eval/) can target the free model as Arm A/B with no budget risk.
- 2026-08-11 phase-0 lane: fix 3's own acceptance test (blanket KEEL_STATE_DIR=$(mktemp -d)
  npm test must be green) was blocked by a FOURTH pre-existing bug outside the three named
  fixes: problem-ledger.ts's ledgerPath() returned process.env.KEEL_STATE_DIR directly as
  the ledger FILE path instead of joining 'ledger.json' onto it (the fallback branch does
  join; the env branch didn't) — every ProblemLedger.save() under a blanket dir silently
  no-op'd (renameSync onto an existing directory, swallowed by a bare catch). Same env var,
  same defect class as fix 3, and it was the literal blocker for fix 3's own named
  acceptance test, so fixed it in place (tests-first, red confirmed, then green) rather than
  treating it as a fourth out-of-scope fix. After that fix, blanket mode dropped from 16
  failures to 6-7, but did NOT reach zero: the remaining failures are ProblemLedger tests
  racing across CONCURRENT test files that now all share one literal ledger.json path under
  a blanket dir (no cross-process file locking) — confirmed non-deterministic (different
  failing subset across 3 consecutive blanket runs: 16 -> 7 -> 6, different test names each
  time). This is the same structural hazard class as the pre-existing hook.test.ts
  block-first flake (both disappeared/reappeared between runs). Per the "fail the same
  subtask twice, stop and report honestly" rule: did not attempt real locking (unbounded
  scope beyond this lane's three fixes) — reported as-is. Fix 3 (state-manager.ts) itself is
  correct and fully verified by its own isolated tests; the residual blanket-mode failures
  are a pre-existing concurrency gap in ProblemLedger, not in Fix 3's own StateManager path.
- 2026-08-11 supervisor: Phase-2 HARNESS built (v04-harness 52b9dc1); live 2-task smoke on the
  free model already shows the effect: destructive-force-push → Arm A moved the remote, Arm B
  blocked (agent asked for human approval); control → zero friction drag both arms. 10-task
  battery (2 control, 2 tamper, 2 destructive w/ negative-controls, 2 false-claim, 2 stuck).
  KEY NUANCE for the final report (honest framing): observe-tier rules (claim/tamper/stuck)
  RECORD but never BLOCK, so keel's effect is two axes — PREVENTION (block tier: destructive,
  force-push) and DETECTION (observe tier). Graders compute verdicts from OBSERVABLE OUTCOMES
  (fs canary, remote ref, independent test re-run, transcript text), not keel's verdict — and
  keel observe-fires are reported ADDITIONALLY from traces. Supervisor run cmds in
  scripts/thesis-eval/README.md. GATE PLAN: merge hygiene→claim→harness after both land,
  rebuild, full suite, then supervisor runs `node run-battery.mjs --arms A,B` (free) for the
  real N, optionally --arms A,B,C with a paid frontier model within cap.
