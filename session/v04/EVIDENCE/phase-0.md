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

## CORRECTION (2026-08-11, from Phase-3 red-team — honesty ratchet)
The "floors non-overridable — VERIFIED LIVE … closes the last un-bypassable residual"
claim above is OVERSTATED. It is true ONLY on the ACTION axis: an override lowering the
action (deny→warn/allow) or dropping `level: protect` is correctly rejected. BUT mergeRules'
tightensOrEqual compares the ACTION FIELD ONLY — an override that keeps `action: deny +
level: protect` while adding `mode: observe` (silences the rule to allow) OR a no-op `match`
(replaces the floor with one that doesn't match the dangerous command) STILL neutralizes the
floor. Reproduced by the red-team on two floor ids in the shipped scope topology (floor at
user, override at project). Reachability is unchanged — writing the override file is blocked
on both shell and tool paths — so it is a PRE-EXISTING-USER-CONFIG residual, not a
one-command agent bypass. SUPERVISOR ACTION: extend the mergeRules floor guard to also reject
overrides that weaken via `mode` or change `match` (queued after the strengthening battery so
the main-tree build isn't disturbed mid-run).
