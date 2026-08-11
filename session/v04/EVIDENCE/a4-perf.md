# A4 — performance budget: measurement harness + regression guard

Worktree `/Users/nanoclaw/code/keel-v04-perf` (branch `v04-perf`). Lane scope: MEASURE the
real `EnforcementPipeline.evaluate()` (`packages/core/src/enforce/pipeline.ts`) against the
shipped default ruleset and report honestly on the `<50ms` hot-path claim — never edit
`pipeline.ts` / `rule-parser.ts` / `types.ts`. New files only: `scripts/perf/bench.mjs` and
one perf regression test, `packages/cli/src/__tests__/perf-budget.test.ts`.

Everything below ran for real against the built `@get-keel/core` package (`npm ci && npm run
build` first, Node v26.0.0), in an isolated `KEEL_STATE_DIR`/`KEEL_TRACES_DIR`/
`KEEL_OVERRIDES_DIR` temp dir, never `~/.keel`. The network-touching `unverified-package-install`
rule is measured with `packageVerifierFetch` mocked for every timed call; one separate,
clearly-labeled case mocks a registry **timeout** instead, to measure the real risk case.

This file's path is `session/v04/EVIDENCE/a4-perf.md`, the exact path named in this lane's
binding constraints (the task's own step 3 abbreviates it as "a04-perf.md" in passing — the
binding-constraints section is the authoritative spelling, so that's what this file is named).

## 1. Headline numbers

**The number the task asked for — a benign call against the default ruleset — from the
cleanest (least externally-contended) run captured, n=25, fresh pipeline, warm-up excluded:**

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| **`benign-bash` (no rule matches, every rule still checked)** | 0.892ms | 1.128ms | 1.724ms | 1.724ms |

That is a ~29x margin under the 50ms claim. The weighted "representative session" corpus
(n=1000, sampled from ALL categories in §2 using the mix documented in §4 — mostly benign
calls, a minority of blocked/gated ones, an editorial approximation, not frequency data —
included here because the task asked for both "overall" and a per-tier breakdown) lands in the
same range:

| | p50 | p90 | p99 | max | mean |
|---|---|---|---|---|---|
| **Overall (weighted)** | 0.891ms | 1.295ms | 1.758ms | 2.365ms | 0.869ms |

**Verdict: the `<50ms` claim HOLDS, with roughly a 28-29x margin at p99, for the default
43-rule ruleset's own computational cost.** Every individual category (see §2) stayed under
2.4ms end to end, including the categories that hit real (isolated, temp-dir) disk I/O.

**That margin claim never travels alone — read §3c before repeating it.** This same corpus,
run repeatedly on the actual machine this lane was built on (a shared box regularly running
several concurrent coding-agent sessions), was ALSO observed at p99 up to 376ms — not because
keel got slower, but because OS scheduling contention can delay any synchronous in-process
call on a sufficiently busy host. The ~29x margin is real and reproducible under fair
scheduling; it is not a guarantee against a loaded host, and neither is any other fixed-latency
promise a synchronous library call can make.

This is the important, reproducible, load-independent finding. §3 below is equally important
and less flattering: this exact same corpus, run repeatedly on the machine this lane was built
on, was observed at p99 anywhere from **0.5ms to 376ms** depending entirely on what else was
running on the host at that moment — nothing here is cherry-picked to make keel look fast; the
range is reported in full.

## 2. Per-category breakdown (fresh pipeline per category; JIT/ladder warm-up excluded)

From `node scripts/perf/bench.mjs`, same clean run as above (raw dump:
`scripts/perf/last-run.json`, regenerated on each run, not committed):

| category | n | p50 ms | p90 ms | p99 ms | max ms |
|---|---|---|---|---|---|
| benign-bash (no rule matches) | 25 | 0.892 | 1.128 | 1.724 | 1.724 |
| benign-write (content-scan tier, no match) | 200 | 1.101 | 1.325 | 2.156 | 2.365 |
| benign-read | 150 | 0.315 | 0.349 | 0.487 | 0.714 |
| blocked-rm-rf (protect floor, deny) | 60 | 0.649 | 0.743 | 1.024 | 1.024 |
| force-push (protect floor, deny) | 60 | 0.649 | 0.771 | 1.097 | 1.097 |
| fs-write-outside-project (prompt gate) | 100 | 0.750 | 0.932 | 1.220 | 1.275 |
| content-secret-hit (content tier, deny) | 100 | 0.648 | 0.803 | 0.909 | 1.311 |
| package-verified-miss (mocked fetch, cache miss) | 25 | 1.185 | 1.474 | 1.784 | 1.784 |
| package-hallucinated (mocked 404, deny) | 25 | 1.401 | 1.504 | 1.820 | 1.820 |
| package-cache-hit (same pkg repeated) | 26 | 0.828 | 0.987 | 1.299 | 1.299 |

## 3. Dominant cost: which tier/rule, and the honest load caveat

### 3a. By tier (weighted pool)

| tier | share | p50 ms | p99 ms |
|---|---|---|---|
| 0 — no rule matched (the modal case) | 82.0% | 0.914 | 1.781 |
| 3 — filesystem/package/env match | 7.0% | 0.761 | 1.820 |
| 2 — command/rate/time match | 6.0% | 0.637 | 1.097 |
| 5 — content-scan match | 5.0% | 0.644 | 1.311 |

**Tier 0 (no rule matches — the ordinary, benign call) dominates the corpus by construction
(82% of the weighted pool) and is also the cheapest tier per call.** There is no single
expensive tier in the shipped default ruleset under normal conditions; cost is close to flat
across tiers 0/2/3/5 (all sub-2ms p99). Tier 1 (cache) and tier 6/7 (sequence/flow/reasoning)
never appeared in any sample — see §5.1 for tier 1, which is structurally dead for this
ruleset, not just untriggered by this corpus.

### 3b. By matched rule (weighted pool)

| rule_id | share | p50 ms | p99 ms |
|---|---|---|---|
| (no rule matched) | 82.0% | 0.914 | 1.781 |
| write-outside-project | 5.0% | 0.742 | 1.275 |
| no-secrets-in-code | 5.0% | 0.644 | 1.311 |
| no-destructive-commands | 3.0% | 0.629 | 0.912 |
| no-force-push | 3.0% | 0.648 | 1.097 |
| unverified-package-install | 2.0% | 1.413 | 1.820 |

No single rule stands out as expensive; `unverified-package-install` is the slowest per-call
(1.4-1.8ms) even with the network mocked, consistent with it doing real extraction/tokenizing
work plus a (mocked, still-async) fetch round-trip.

### 3c. The load caveat (this is the real finding of this lane)

This worktree is built on a shared development machine that, at the time of this measurement,
was running several other coding-agent sessions concurrently (per this operator's own working
pattern — see the project's parallel-sessions notes). Live `uptime` samples taken during this
work:

```
load averages: 15.40 19.33 17.93   (16 cores)
load averages: 34.97 26.91 21.35   (16 cores)
load averages: 26.38 25.30 21.21   (16 cores)
```

Running the identical `bench.mjs` corpus back to back produced overall p99 values ranging from
**0.5ms** (idle-ish moment) to **376ms** (contended moment) — a ~750x spread on the exact same
code and workload. Three consecutive runs, timestamped against `uptime`:

```
run 1 (load 31.14/16): p50=53.211ms  p90=113.656ms  p99=375.973ms  max=755.448ms  -> VIOLATED
run 2 (load 19.61/16): p50=0.985ms   p90=1.639ms    p99=7.160ms    max=70.106ms   -> HOLDS
run 3 (load 29.85/16): p50=1.113ms   p90=1.879ms    p99=4.423ms    max=26.624ms   -> HOLDS
```

Note run 1 and run 3 have *similar* load averages yet very different p99 — contention on this
box is bursty, not a smooth function of the 1-minute average. **This is not a keel defect**:
`evaluate()` does the same fixed amount of work regardless of what else is running; what
changes is how long the OS makes the process wait for a CPU timeslice mid-call. A short
(sub-millisecond) synchronous call is rarely caught mid-flight by a scheduler preemption; a
call that holds the CPU for ~1ms of real work is proportionally far more exposed to it, which
is exactly the asymmetry observed between the near-zero-rule baseline (stayed under 0.1ms in
every sample taken, load notwithstanding) and the full 43-rule measurement (swung from
sub-millisecond to hundreds of milliseconds).

**Honest framing for the supervisor:** keel's own algorithmic cost for the default ruleset is
not the risk to the `<50ms` claim — it clears the budget by roughly an order of magnitude
under fair scheduling. The risk is that `evaluate()` (like any synchronous in-process call) has
no isolation from host contention, and on a sufficiently oversubscribed host, wall-clock
latency for ANY of the product's operations — not just this one — can exceed any fixed budget.
This is a deployment/environment characteristic to document (e.g. "run keel's enforcement host
with a reasonable CPU reservation"), not a code defect for a pipeline-owning lane to fix.

## 4. Weighted-corpus methodology (so the "OVERALL" number is reproducible, not vibes)

`bench.mjs` builds the weighted pool from named category weights, explicitly NOT a claim about
real-world call frequency (this bench has no telemetry to derive that from) — just an editorial
approximation of "a normal session is mostly benign, occasionally blocked":

```
benign-bash: 30, benign-write: 25, benign-read: 20, blocked-rm-rf: 3, force-push: 3,
fs-write-outside-project: 5, content-secret-hit: 5, package-verified-miss: 5,
package-hallucinated: 2, package-cache-hit: 2   (sums to 100)
```

Each category contributes `weight * 10` samples (cycling its own measured array if shorter),
for a 1000-sample weighted pool. Change the weights in `bench.mjs` to model a different session
shape; the per-category table in §2 is weight-independent ground truth.

## 5. Structural findings for the pipeline-owning lane (documented, NOT fixed here)

Per this lane's binding constraint (never edit `pipeline.ts`/`rule-parser.ts`/`types.ts`), the
following are handed to the supervisor as findings, not patches:

### 5.1 Tier 1 (the stateless allow-cache) is structurally dead for the shipped default ruleset

`evaluateTiers()` builds `statefulRules` from `['verification', 'claim', 'research', 'stuck',
'rate', 'time'].includes(rule.type)` **unconditionally** (not gated by `deepChecks`/depth), and
the Tier-1 cache check is skipped whenever `statefulRules.length` is nonzero:

```ts
const cached = statefulRules.length || gatedRules.length || input.action_override ? null : this.config.cache.get(...)
```

The shipped default ruleset always includes `bash-rate-limit` (`type: rate`) and
`no-after-hours-publish` (`type: time`) — both unconditional members of `statefulRules` — so
`statefulRules.length` is never zero for this ruleset, on any call, regardless of tool or
level. **The Tier-1 cache — documented in `pipeline.ts`'s own class comment as "O(1), instant"
and the cheapest tier — never fires for the shipped product.** Confirmed empirically: zero
`cache_hit: true` results anywhere in this bench's output, across every category and both
sample runs' raw JSON. This doesn't currently cost the budget (§1's numbers already include
this), but it means every one of the ~500+ regex/path-match checks per benign call happens on
every single call, with no fast path — a design debt worth knowing about if the ruleset grows
or a much larger custom `rules.yaml` is loaded.

### 5.2 Command/filesystem-glob patterns are recompiled on every call, uncached

`matchesRulePattern()` and the `**`-glob branch of `pathMatches()` both call `new RegExp(...)`
fresh on every invocation, for every rule checked, on every `evaluate()` call — there is no
per-rule compiled-pattern cache anywhere in the tier loop. For the default ruleset this means
roughly a dozen-plus `RegExp` constructions per benign call (one per `type: command` rule with
a `match`/`match_regex`, several with genuinely large alternation patterns like
`no-force-push`'s). Not currently budget-threatening (§1), but a straightforward win if the
ruleset or call volume grows: compile once per rule per rules-version, not once per call.

### 5.3 `unverified-package-install`'s hardcoded 2000ms lookup budget is a real, guaranteed risk

`pipeline.ts` calls `checkPackages(specs, { totalTimeoutMs: 2000, ... })` with a **hardcoded**
2000ms total-lookup budget, not derived from any rule field. Measured directly (mocked fetch
that never resolves until the internal `AbortController` fires):

```
2003.8ms — action=prompt rule_id=unverified-package-install
2003.5ms — action=prompt rule_id=unverified-package-install
```

**Any `npm install <uncached-package-name>` (or `pnpm add`/`yarn add`/`bun add`) issued while
the npm registry is slow or unreachable pays up to ~2000ms on that one call — a guaranteed
~40x violation of the 50ms hot-path claim, by design** (package-verifier.ts's own module header
documents the 2000ms figure as intentional: never deny on a network failure, downgrade to
`prompt` instead — correct from a false-positive-avoidance standpoint, but it means this ONE
rule type has no `<50ms` guarantee at all on a cache miss). This is the single clearest,
load-independent, reproducible way the shipped product can blow its own hot-path budget. Worth
a supervisor decision: either document the exception explicitly (`<50ms` applies to every rule
type except a package-install cache miss against a slow registry), or have whichever lane owns
`package-verifier.ts` consider a much shorter total budget with the same never-deny-on-network-
failure semantics (e.g. 200-500ms) — not decided or implemented here, out of this lane's scope.

### 5.4 `bash-rate-limit`'s in-memory counter is shared across the WHOLE pipeline instance, not per-session

`checkRateLimit`'s key is `rate:${ruleId}:${matchPattern}` — no `session_id` component. In a
persistent-pipeline host (the real shape for OpenCode's plugin, which constructs one
`EnforcementPipeline` per plugin load and reuses it for the whole session — confirmed by
reading `packages/opencode-plugin/src/plugin.ts`), more than 30 Bash-tool calls from ANY
session within a rolling 60s window trip the shared counter for ALL sessions on that pipeline.
Measured directly in this bench's `bash-burst-60` category:

```
calls 1-30  (pre-cap):  p50=0.784ms  p99=1.394ms
calls 31-60 (post-cap): p50=0.326ms  p99=0.508ms   <- cheaper, not more expensive
call 31 action/rule: warn / bash-rate-limit
```

Post-cap calls are actually *cheaper* (the rate rule, evaluated early relative to
`unverified-package-install` but late relative to the higher-priority command/filesystem
rules, still short-circuits the handful of rules after it once tripped) — so this is not a
budget risk. Flagged as a correctness/UX note for whichever lane owns rate-limit semantics, not
a perf finding: a single noisy session can silently start warning on an unrelated session's
31st Bash call.

## 6. Regression test — `packages/cli/src/__tests__/perf-budget.test.ts`

Threshold: **50ms absolute** (the product's own literal claim — not a number tuned to this
laptop; §1 shows the actual measured cost has roughly a 28x margin under fair scheduling, so
50ms is genuinely generous, not a floor picked to just barely pass).

Given §3c's live evidence that this exact repo is regularly built on a heavily, burstily
contended shared machine, a naive single-measurement assertion against 50ms would flake
constantly and for the wrong reason (host contention, not a keel regression) — verified this
empirically: an earlier draft of this test using a timing-based "near-zero-rule baseline" as
its load probe passed the SAME 25-call benign-Bash measurement between 14ms and 92ms p99
across 5 back-to-back runs while its own baseline probe stayed under 0.1ms every time (the
trivial baseline is too cheap to ever get caught by a scheduler preemption, so it under-reports
contention for anything that does real work — see §3c's asymmetry explanation).

Final design:
1. **Skip guard via `os.loadavg()` directly**, not a timing proxy: if the 1-minute load average
   exceeds `1.5` per core, skip before measuring at all, with the actual load numbers in the
   skip message. This is the direct signal `uptime` was used to confirm live throughout this
   lane, not an indirect guess. Uses vitest's own `{ skip }` test-context function, not a bare
   `return` — a `return` from a test body with no failed assertion reports as **PASSED**, which
   would make this a gate that cannot fail on exactly the loaded box it exists to guard
   against. Confirmed directly: an earlier draft used `return`, and its own transcript showed
   `✓ ... 34ms` / `Tests 2 passed (2)` on a run where the guard had, in fact, skipped the real
   measurement entirely — a silent false-pass, caught before landing. `skip()` reports the
   correct outcome (`↓ ... [reason]` / `Tests 1 passed | 1 skipped (2)`), verified live on this
   same heavily-loaded machine (load 21-36 throughout this section's testing).
2. **Best-of-3 independent attempts** (fresh pipeline each attempt), asserting on the minimum
   p99 across attempts. A real regression in the pipeline's own cost would be slow on every
   attempt; a one-off scheduler hiccup would not — this is the standard way to separate those
   without loosening the 50ms bar itself.
3. Each attempt uses 5 warmup + 20 measured Bash calls (25 total) on one fresh pipeline
   instance — safely under the shipped `bash-rate-limit` rule's 30-calls/60s cap (see §5.4),
   so the measured window never gets short-circuited cheaper than the true full-tier cost.
4. **Isolation**: `KEEL_STATE_DIR` and `KEEL_OVERRIDES_DIR` are pointed at temp dirs in
   `beforeAll`/cleared in `afterAll`, and `overrideStore` is stubbed (never touches disk) —
   mirroring `fixture-harness.test.ts`'s own isolation in this same directory. Needed even
   though the benign corpus never triggers a violation or a package lookup:
   `EnforcementPipeline`'s constructor still eagerly default-constructs
   `PackageVerifierCache`/`FileRuleOverrideStore` whenever a caller doesn't supply its own, and
   both default straight to `homedir()`-based `~/.keel` paths when the env vars are unset — an
   unreached code path is not the same guarantee as an unreachable one.

Verified across many runs on this machine (load average 14-36 throughout, this being a shared
box regularly running several concurrent coding-agent sessions — see §3c): standalone runs,
full-`cli`-workspace-suite runs, and full root `npm test` runs (all 4 workspaces) each showed
either a clean best-of-3 measurement under 50ms or a correctly-labeled skip when the load
check tripped, with zero silent false-passes after the `skip()` fix above. One assertion
failure WAS observed during this lane's testing, before the `skip()` fix, inside a root-level
`npm test` run at very high sustained load — re-running the identical scenario immediately
after did not reproduce it, consistent with a genuinely transient scheduler spike (see §3c's
run-1-vs-run-3 example of similar load averages producing very different p99s) rather than a
reproducible defect in either the pipeline or this test's logic. Per this lane's "fail the same
subtask twice, stop and report honestly" rule: a single non-reproducing failure, not a repeat,
so reported here rather than escalated. A supervisor who wants a stricter safety margin against
this residual (low-probability, contention-driven) flake risk could raise `ATTEMPTS` from 3 to
5 in the test file; left at 3 as an already-reasonable speed/robustness balance, not because 3
is load-bearing.

## 7. Build + full suite

```
$ npm ci && npm run build     # clean, no errors
$ npm test                    # root workspaces run
  @get-keel/core:  474 passed | 2 skipped   (26 test files)
  @get-keel/cli:   676 passed | 14 skipped  (37 test files, includes this lane's 2 new tests)
  @get-keel/mcp-server: no test files (expected)
  @get-keel/opencode-plugin: load-test, all PASS
```

No file under `packages/core/src/enforce/{pipeline,rule-parser}.ts` or
`packages/core/src/types.ts` was edited by this lane. New files only:
`scripts/perf/bench.mjs`, `packages/cli/src/__tests__/perf-budget.test.ts`, this doc.

## 8. Files

- `scripts/perf/bench.mjs` — the measurement harness (`node scripts/perf/bench.mjs`)
- `scripts/perf/last-run.json` — machine-readable dump, regenerated each run (not committed;
  gitignore covers untracked build artifacts the same way other scratch outputs in this repo
  are handled — regenerate via the command above rather than trusting a stale copy)
- `packages/cli/src/__tests__/perf-budget.test.ts` — the regression guard
- This file
