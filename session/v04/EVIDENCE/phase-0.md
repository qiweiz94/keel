# v0.4 Phase 0 gate evidence (supervisor-verified)

Merged v04-floor → v0.4-thesis at 8d21f88. Lane also fixed a 4th same-class bug
(problem-ledger.ts ledgerPath not joining the filename under a blanket state dir).

## Supervisor's own verification (findings are hypotheses until reproduced)
- **Floors non-overridable — VERIFIED LIVE.** Project with no-force-push (level: protect,
  deny) + a .keel.local.yaml redefining the SAME id as `warn`: a `git push --force origin
  feature-x` still DENIES with the floor's own message ("floor-held"), byte-identical to the
  no-override control. The local downgrade was rejected. Closes the last un-bypassable
  residual from v0.3 AUDIT.
- **Write-gate read FP — VERIFIED LIVE.** `cat ~/.keel/DISABLED` → exit 0 (allow);
  `echo x > ~/.keel/DISABLED` → exit 2 (deny). Read passes, write still blocked.
- **Full suite normal mode — GREEN by supervisor run:** core 465/465 (2 skip), cli
  1127/1127 (16 skip), exit 0.
- ACTION_STRENGTH order (deny/block 4 > prompt 3 > mask/fix/redirect 2 > warn 1 >
  allow/report/research 0) gates the floor-override; mutation-tested by the lane.

## Accepted residuals (product code correct; test-hygiene follow-ups)
- Blanket `KEEL_STATE_DIR` mode: 6-7 non-deterministic failures remain — ProblemLedger
  tests racing on one shared ledger.json across CONCURRENT test files (no cross-process
  locking). Pre-existing concurrency gap, NOT the StateManager fix (its own tests pass both
  modes). ASSIGNED to a bounded test-hygiene lane.
- Running the suite intermittently mutates the real ~/.keel/state via level-reload.test.ts's
  top-level HOME mutations at collection time. A footgun (pollutes user state); ASSIGNED to
  the same hygiene lane. Product code unaffected.
