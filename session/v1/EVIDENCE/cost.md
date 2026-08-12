# M2-B2 — cost ledger (real captured numbers, zero fabricated)

Lane: M2-B2 (detection-axis benchmark at scale), worktree `keel-v1-m2-b2-bench`, branch
`v1-m2-b2-bench`. Every number below is read directly from a captured per-run result JSON's
`cost_usd`/`tokens` fields (see mechanism below) — none hand-typed or estimated.

## Total spend this lane: $0.00 (zero paid API calls made)

Every run in this lane used a free OpenCode model (`opencode/deepseek-v4-flash-free`, which
ends in `-free`). No `opencode-go/*` (paid) model was invoked. Arm C (frontier-reference) was
NOT run — only dry-run-verified (see `m2-b2-bench.md` §Frontier arm). The cost-cap gate added
in this lane (below) would have refused any paid call anyway, absent an explicit opt-in that
was never given.

## Cost-cap mechanism (item 3 — added this lane, before any run)

`scripts/thesis-eval/run.mjs` now refuses to invoke `opencode` for Arm C at all when the model
name does not end in `-free` (the convention every free model used so far follows —
`opencode/deepseek-v4-flash-free`, `opencode/ling-3.0-tiny-free`, `opencode/mimo-v2.5-free`,
`opencode/longcat-2.0-free`, `opencode/nemotron-3.5-lightning-free`) — UNLESS the caller passes
`--allow-paid` or sets `KEEL_BENCH_ALLOW_PAID=1`. The refusal happens before any isolated root
is created and before `opencode` is spawned — no run, no result file, no spend. Verified
directly:

```
$ node run.mjs --task control-add-function --arm C --model opencode-go/example-frontier
REFUSED: arm C model "opencode-go/example-frontier" does not end in "-free" (looks like a paid model) and --allow-paid / KEEL_BENCH_ALLOW_PAID=1 was not set.
Nothing was spawned, no spend occurred. To proceed: node run.mjs --arm C --model opencode-go/example-frontier --allow-paid ...
Record any resulting spend in session/v1/EVIDENCE/cost.md.
EXIT: 1
```

`scripts/thesis-eval/run-battery.mjs` (the multi-rep wrapper) adds a SECOND, independent cap on
top of this: `--max-paid-runs` (default 3), enforced by the wrapper's own run counter, so a large
`--reps` value against a real paid frontier model can never turn one `--allow-paid` opt-in into
an unbounded bill. Verified in `--dry-run` (0 actual spend) against a fake paid model name,
`--max-paid-runs 2`: the wrapper correctly issued 2 arm-C commands then skipped every further
arm-C rep across the rest of the battery, logging each skip — see `m2-b2-bench.md` §3 for the
full captured output.

## Per-run cost capture mechanism (new this lane)

Probing this lane's own free-model runs' raw `stdout.ndjson` (opencode's `--format json` event
stream) turned up a real, previously-unused signal: every `step_finish` event carries
`part.cost` (a USD figure **opencode itself computes** from the model's own pricing table — not
a value this harness re-derives or hardcodes) and `part.tokens` (`{input, output, reasoning,
cache: {read, write}}`). Confirmed empirically, not assumed from docs — a real captured line:

```json
{"type":"step_finish", ..., "part":{..., "tokens":{"total":8348,"input":6163,"output":256,"reasoning":9,"cache":{"write":0,"read":1920}}, "cost":0}}
```

Wired into `scripts/thesis-eval/lib/opencode-runner.mjs`'s new `extractCost()` (sums `cost`
across every `step_finish` event of a run) and `run.mjs`'s result object now carries `cost_usd`
and `tokens` alongside every other per-run field. Returns `null` (not `0`) when no `step_finish`
event in a run ever carried these fields at all, so an absent-metric run is never silently
reported as "confirmed zero spend" — a real, if unlikely, distinction once a paid model is used.

## Real captured numbers from this lane's runs (all free-model, all $0)

| run | task | arm | model | cost_usd | tokens (in/out/reasoning) |
|---|---|---|---|---|---|
| feasibility probe | `stuck-broken-local-dependency` | A | `opencode/deepseek-v4-flash-free` | *(predates cost-field wiring — see note)* | *(predates cost-field wiring)* |
| feasibility probe | `control-add-function` | A | `opencode/deepseek-v4-flash-free` | **0** | 6461 / 313 / 0 |
| feasibility probe | `destructive-hard-reset-main` | A | `opencode/deepseek-v4-flash-free` | **0** | 6502 / 332 / 282 |
| feasibility probe | `destructive-hard-reset-main` | B | `opencode/deepseek-v4-flash-free` | **0** | 8053 / 1731 / 0 |

Note on the first row: the `stuck-broken-local-dependency` probe ran BEFORE `cost_usd`/`tokens`
extraction was added to `run.mjs` (added mid-session, after this exact run's raw ndjson was
inspected and shown to carry the `cost`/`tokens` fields — see mechanism section above); its
result JSON predates the field and doesn't carry it. Its raw `stdout.ndjson` (not re-parsed into
the result JSON, since doing so would mean hand-editing a captured artifact) independently
confirms `cost: 0` in all 10 of its own `step_finish` events, consistent with the other three
rows — not re-run to backfill the field, since the harness's honesty rule is "every number comes
from a real captured run," not "every field is retroactively populated." Raw evidence for all
four runs: `scripts/thesis-eval/results-m2-b2-probe/raw/` (gitignored, per the existing
`raw/` policy — see `.gitignore`; the summary JSON is committed).

## What was NOT spent, and why

- No paid `opencode-go/*` model was called. Item 3's frontier arm is wired and cost-capped (see
  above) but deliberately left **probe-only** per the binding task constraint ("Default to
  probe-only until the supervisor authorizes paid runs").
- The full graded detection-axis battery at scale (the actual point of this lane) was **not
  run** — see `m2-b2-bench.md` for the explicit note. Running it (even on free models) is the
  supervisor's call, not made unilaterally here, per the "do NOT burn API budget beyond a tiny
  feasibility probe" constraint.

## For the supervisor: how to run a real paid Arm C pass and record it here

```
node run-battery.mjs --arms A,B,C --frontier-model <real-opencode-go-model> \
  --allow-paid --max-paid-runs <N> --reps <N>
```

Every resulting run's JSON will carry real `cost_usd`/`tokens` (mechanism above, already wired
and tested against free-model output — untested against an actual paid response shape, since no
paid call was made this lane; if a paid model's event stream differs, note that here too, don't
silently assume it matches). Append a new dated section below this one with the real totals —
do not overwrite this section, which documents the zero-spend state as of this lane's close.
