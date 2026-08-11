# session/DECISIONS.md — append-only decision log (v0.3 autonomous build)

- 2026-08-11 supervisor: Plan approved with 6 CTO amendments + §6 contract fix
  (dogfood via hook path, no TTY bypass in any shell). Canonical plan:
  ~/.claude/plans/we-are-working-off-cheerful-dusk.md
- 2026-08-11 supervisor: Wave 1 lane evidence goes to session/EVIDENCE/wave1-<lane>.md
  per lane; supervisor composes phase-0.md at the wave gate to avoid merge
  collisions in a shared file.
- 2026-08-11 supervisor: Lane branches w1-matchfix, w1-fixtures, w1-observed,
  w1-bugcheck in sibling worktrees; merged here at the gate.
- 2026-08-11 supervisor: Lane 7 found bug (c) only HALF-fixed — StateManager had disk
  persistence but ignored KEEL_STATE_DIR (silent fallback to real ~/.keel/state).
  Lane 7 applied the one-line env override (its mandate allowed one-liners proven by
  a failing test). Same character-identical line pushed to lanes 1/2/3 mid-flight so
  parallel duplicates merge cleanly. Gate check: line must appear exactly once after
  merge; re-run lane 7's two-subprocess warn→deny repro on the merged tree.
- 2026-08-11 supervisor: Lane 3 landed observed_action persistence (w1-observed 4e9e479).
  Scope correction accepted pending gate re-verification: receipts/signing are a SEPARATE
  legacy trail (SignedEntry, written by PolicyEngine.audit only; `keel verify` reads only
  that) — AuditEntry/traces compat tested against its real readers instead. Two gaps
  flagged for later waves: (1) MCP/daemon /v1/check writes NO AuditEntry at all
  (pre-existing); (2) traces dir (plugin TRACES_DIR + AuditLog default) has no env
  override — tests exercising the plugin hook directly would write real ~/.keel/traces.
  Assign both when Wave 2/3 lanes are cut. Lane 3 also reports 4 CLI level.test.ts
  ANSI/chalk failures that reproduce on the BASE commit — check in supervisor's own
  gate run before treating as pre-existing.
- 2026-08-11 supervisor: Lane 1 landed (w1-matchfix 8df5adb, 25fa679). PREMISE REVISED:
  `type: command` matching was ALREADY on commandString(); the two raw-JSON haystacks at
  pipeline.ts ~260/~440 were `rate` and `diagnosis` types. Lane fixed those additively
  (command-string tried first/alongside; no previously-matching case can stop matching)
  plus a real nested args.args.command gap in arg-utils commandString(). 11 new tests;
  core 245/245; same 4 pre-existing level.test.ts ANSI failures as lane 3 (confirmed by
  revert). SAME-CLASS SURFACES flagged, not fixed (lane scope): sequencer.ts step.pattern
  and verification.ts matcher.pattern still match raw JSON — ASSIGN to Wave-2 lane 5
  (sequence rules). Pre-existing repo-wide gap: pipeline default overrideStore writes real
  ~/.keel on deny verdicts in tests — ASSIGN with traces-dir override work.
  Lane 1 correctly declined the state-manager one-liner (its tests unaffected); the fix
  arrives via w1-bugcheck and w1-observed branches, identical content.
- 2026-08-11 supervisor: Lane 2 landed (w1-fixtures 76fe304, 86cbdd1): 22 rule dirs,
  46 fixtures, 53/53 tests, wired into root npm test; per-rule isolated pipeline (full
  ruleset would pass vacuously via first-match short-circuit); warn-then-deny ladder
  replayed; mutation-tested the harness itself. Substring-FP class: ALREADY fixed in
  flow-tracker.ts with \b (probes are plain regression guards now); rsync-not-a-sink
  coverage gap documented in a labeled probe.
- 2026-08-11 supervisor RULING on the KEEL_STATE_DIR override (lane 2 reverted it as a
  bypass vector; lanes 3+7 carry it): KEEP the override. Rationale: subprocess state
  tests and isolation genuinely require it, and the enforcement path inherits the HOST
  process env, which the guarded agent does not control mid-session. The bypass concern
  is REAL enough to mitigate: (1) Wave-2 lane 1 adds KEEL_* env mutation to the Tier-1
  agent-self-modification scope; (2) Phase-6 red team assesses the residual vector for
  SECURITY.md honestly. Lane 2's revert stands on its own branch; the override lands
  via w1-bugcheck/w1-observed at the merge.
- 2026-08-11 supervisor: Wave-1 gate CLOSED at eb2bae2 (evidence: phase-0.md).
- 2026-08-11 supervisor: Tier-3 NEW rule YAML (claim-without-evidence,
  test-oracle-tampering, test-before-commit, runaway-budget) — capability lanes ship
  engine code + fixtures + an exact rule snippet in session/proposals/<id>.yaml; the
  supervisor pastes those snippets into both DEFAULT_RULES_YAML files at the Wave-2
  gate (mechanical integration, drift-test + fixture-verified). Avoids two lanes
  editing the single-owner files concurrently.
- 2026-08-11 supervisor: Contract §6 dogfooding is honestly LIMITED: activating a keel
  hook on this very session would require editing the user's real ~/.claude settings,
  which the plan forbids. Compromise: the repo's own .keel/rules.yaml stays active for
  git-level checks; enforcement-path FP data comes from fixture harness, live-verify,
  and evaluate-replay traffic. Goes to HUMAN-CHECKLIST + AUDIT as a deviation note.
- 2026-08-11 supervisor: W2 lane 6 landed (w2-negtests 9ca064d): do-not-ship suite,
  8 assertions incl. a positive control proving the suite can fail. 7/8 pass; the 1
  failure is the DOCUMENTED expected-red (no-verify-bypass still deny, softens to warn
  when w2-rules merges). GATE CHECK: after w2-rules merge this must be 8/8; if
  assertion 6 still fails at the gate, the softening was missed — block the gate.
- 2026-08-11 supervisor: W2 lane 5 landed (w2-seq 566ca50): test-before-commit +
  runaway-budget (2 rules) as pure-YAML proposals; sequencer.ts additive fix + 3
  regression tests; 'verification' added to RuleCategory enum. Elapsed-time budget
  DELIBERATELY skipped (no session-scoped anchor on EnforceInput; naive version
  inherits stale anchors — a control that lies); follow-up documented, not built.
  verification.ts boundary() lines ~126/130 confirmed same bug — w2-claim messaged
  to cover both sites + use the identical RuleCategory token. GATE NOTE: expect a
  small types.ts/rule-parser.ts overlap between w2-seq and w2-claim.
- 2026-08-11 supervisor: W2 lane 8 landed (w2-sandbox 0db6cfd): sandbox-detector with
  injectable probes, 25 tests, print-only suggestion wiring in status + install (no
  DEFAULT_RULES_YAML overlap, 12-line surgical diff). Honest design: detectSandbox()
  returns true|'unknown', never false (finite marker list cannot prove absence);
  Anthropic sandbox-runtime marker SANDBOX_RUNTIME=1 is conditional (proxy-bridge
  path only) — confidence low, documented. ROOT CAUSE of the 4 level.test.ts fails
  identified: FORCE_COLOR=3 present in worker/supervisor shells; reproduced on base.
  w2-dial's ANSI-strip fix is the durable cure — gate expects level.test.ts green in
  FORCE_COLOR=3 env only after w2-dial merges.
