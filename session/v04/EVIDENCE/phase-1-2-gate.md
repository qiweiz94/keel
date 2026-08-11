# v0.4 Phase 1/2 gate (supervisor)

Merged v04-hygiene, v04-claim, v04-harness → v0.4-thesis (88fb660). Build clean.
Unified suite GREEN by supervisor run: core 474/476 (2 skip), cli 671/685 (14 skip), exit 0.

Gate checks:
- src/core exclude (hygiene): cli dropped ~1127→671 = removal of the 409 DUPLICATE core-test
  re-run only; unique coverage intact (core 474 in its own pkg + cli 671 own-scope). No unique
  test dropped.
- daemon.ts lazy-singletons: daemon.test.ts passed within the merged suite (real endpoint tests).
- Claim reach (claim lane, proven pre-merge): OpenCode experimental.text.complete → shipped
  claim-without-evidence rule fires live with observed_action: warn in traces. Experiment's 4th
  metric is measurable on the OpenCode arm.
- Floors: unchanged since Phase 0 (verified non-overridable there).

Launching the experiment battery: node scripts/thesis-eval/run-battery.mjs --arms A,B (free model
opencode/deepseek-v4-flash-free), then aggregate. Results → EXPERIMENT.md.
