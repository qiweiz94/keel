# Runbook — the thesis benchmark at graded scale (budget decision is yours)

**Status:** the harness, the four detection-eliciting tasks, the per-run `blocked[]` attribution
guard, and the cost-cap are all built and verified at zero/near-zero spend. What's not done is a
**graded battery at real N** and any **frontier (paid) arm** — because paid arms cost money, which
is your call. Everything below is reproducible.

## The measured result already in hand (free, committed)
Guarded cheap agent **0% harm vs 75% unguarded** on N=12 harm-eliciting tasks (0% vs 67% forbidden
actions; 75% vs 8% completion; zero false-positive drag), attribution re-audited (10/10
trace-confirmed keel blocks on the two structurally-blocked tasks). See `session/v04/EXPERIMENT.md`.

## Free-model battery at higher N (no spend — you can run this now)
```
cd scripts/thesis-eval
node run-battery.mjs --arms A,B --reps 8      # 8 reps per (task,arm) on the free model
node aggregate.mjs results                    # aggregate the run dir it prints
```
- Arm A = cheap-unguarded, Arm B = cheap-guarded (keel live). Free `opencode/*-free` model, $0.
- The grader credits "harm prevented" only when keel's own trace shows a same-action block
  (attribution honesty guard). Detection-axis tasks are included but need a mid-capability model to
  actually fail them — see the calibration note in `session/v1/EVIDENCE/m2-b2-bench.md`.

## Frontier arm (Arm C) — PAID, gated, your budget call
```
node run-battery.mjs --arms A,B,C --reps 4 --frontier-model opencode-go/grok-4.5 --allow-paid
```
- Arm C is **refused** unless the model ends in `-free` OR you pass `--allow-paid`
  (or `KEEL_BENCH_ALLOW_PAID=1`) — no silent spend.
- Suggested frontier models: `opencode-go/grok-4.5`, `gpt-5.6-luna`, `kimi-k3` (via OpenCode).
- **Cost estimate:** ~(#tasks × 4 reps) frontier completions of small coding tasks; on a
  mid-priced model that's a few dollars, on a top model more. Record actual spend in
  `session/v1/EVIDENCE/cost.md` (the runner extracts real `cost_usd` from OpenCode step-finish
  events).

## What "benchmark at scale done" means
A committed `run-battery` result dir + `aggregate.mjs` output showing A vs B (and optionally C) at
N≥8, detection-axis events actually elicited, with the attribution guard passing — folded into
`session/v1/EXPERIMENT.md`. If you want, authorize a bounded paid run (set a $ cap) and I'll run it
and record the cost.
