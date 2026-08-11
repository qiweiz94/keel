# Phase 0 / Wave 1 gate evidence (supervisor-composed)

Per-lane evidence: wave1-lane1.md (match surface), wave1-lane2.md (fixture harness),
wave1-lane3.md (observed_action), wave1-lane7.md (legacy bugs). Merges: 9db0c95,
6bb3731, a1bd64e, 340f3a5 — all conflict-free; KEEL_STATE_DIR override present exactly
once post-merge (grep count = 1, state-manager.ts:21).

## Supervisor gate run (merged tree, own hands)
- `npm run build` → exit 0 (gate1-build.log)
- `npm test` → core 249/249 PASS; cli 616/620 — the 4 failures are level.test.ts
  ANSI-color assertions. Verified env-dependent, NOT behavioral: same file with
  NO_COLOR=1 FORCE_COLOR=0 → 13/13 PASS. Pre-existing (three lanes independently
  reproduced identical failures on base via stash/revert). Hardening note filed:
  level.test.ts should strip ANSI before asserting.
- Bug (c) reproduced end-to-end by supervisor: two `keel evaluate` subprocesses,
  isolated HOME + KEEL_STATE_DIR, deny rule at balanced:
  call 1 → {"action":"warn", ... "Next time will be blocked."}
  call 2 → {"action":"deny","message":"escalation probe"}
  state dir after: circuit-breaker.json, deny-first-time.json. duration_ms=2 per call.
- Bug (a): lane 7 ran built CLI `keel lessons --help` clean (wave1-lane7.md).
- observed_action: covered by lane 3's tests (audit.test.ts +4, signing-chain
  regression), reproduced in supervisor suite run. Direct plugin-hook e2e deliberately
  NOT run: traces dir has no env override yet (would write real ~/.keel/traces);
  assigned to Wave 2.

## Wave-1 outcomes vs plan
- Bug (b) premise REVISED: command-type matching already used commandString();
  real fixes = rate/diagnosis surfaces + nested args.args.command unwrap (11 tests).
- Substring-FP class already fixed in flow-tracker.ts (\b); 6 regression probes added;
  rsync-not-a-sink coverage gap documented.
- Same-class JSON surfaces flagged, assigned Wave 2: sequencer.ts step.pattern,
  verification.ts matcher.pattern.
- KEEL_STATE_DIR override ruling: kept; KEEL_* env mutation added to Wave-2 Tier-1
  self-modification scope; Phase-6 red team assesses residual vector.
