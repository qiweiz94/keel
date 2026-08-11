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
- 2026-08-11 supervisor: W2 lane 7 landed (w2-dial 6e332f4): sprint expiry stored IN
  rules.yaml beside level: (same scoping, survives copies, reuses per-call reload —
  correct for process-per-call hosts; verified live: expired sprint enforces like
  balanced on the next evaluate). Transparency diff computed from the real merged
  ruleset via the same pure dialAction() the pipeline enforces with. Floor tests
  assert protect rules never soften and never appear in the diff. level.test.ts
  ANSI-hardened: 27/27 in colored AND NO_COLOR envs. All workspaces green in its
  tree (core 264, cli 649, plugin 56). GATE NOTE: touches types.ts/rule-parser.ts/
  pipeline.ts — expect small overlaps with w2-seq (enum) and possibly w2-claim;
  merge dial after seq/claim, before rules.
- 2026-08-11 supervisor: W2 lane 3 landed (w2-claim dcf223c, d000d8a): claim grammar
  (6 named shapes, fence/URL/quote stripping, hedge suppression), type 'claim' reusing
  VerificationTracker; verification.ts BOTH sites fixed additively; KEEL_TRACES_DIR +
  KEEL_OVERRIDES_DIR per-construction reads (module-level env consts empirically miss
  runtime overrides). Honest finding: EnforceInput.reasoning is UNWIRED in all 6
  hosts — claim text visible only via commit/PR message args; hence confidence: low.
  Disclosed: one stray key briefly written to real ~/.keel/state during a probe,
  removed key-only.
- 2026-08-11 supervisor RULING — observe-mode short-circuit: claim-without-evidence
  and source-change-requires-test share a trigger; first-match short-circuit means one
  swallows the other on the commit-message channel. BOTH order hacks are controls that
  lie. Root-cause fix ASSIGNED to Wave-3 promotion lane: matched mode:observe rules
  record observed_action and CONTINUE; verdict = first non-observe match (Gatekeeper
  dryrun semantics; also makes shadow counts see full traffic). Wave-2 gate keeps file
  order (shipped rule wins; claim underfires until Wave 3 — accepted, logged).
  overrideStoreForStatus module-level import-timing hazard flagged, not fixed.
- 2026-08-11 supervisor: W2 lane 2 landed (w2-slop 6f0a468): two-stage package
  verifier (sync extractor pays nothing on non-installs; async check only on real
  installs), fail-open semantics per amendment 3; scoped-name 404 → prompt not deny
  (public 404 is not proof a private package is fake). Tiered cache TTLs 24h/1h/5min
  by verdict type — documented deviation from flat 24h, ACCEPTED (worst case is
  re-checking sooner, never staleness). Added 'supply-chain' category (enum overlap
  with w2-seq/'verification' at merge — expected). TWO GATE AIDS: (1)
  proposal-fixture-harness.test.ts globs session/proposals/*.yaml so every lane's
  proposal gets fixture coverage with no shared-file edits; (2) assertPasteSafe()
  guards proposals against template-literal corruption — USE IT during the gate paste
  into DEFAULT_RULES_YAML (backticks/escapes in YAML would silently corrupt the JS
  template literal; lane caught this on its own proposal).
- 2026-08-11 supervisor: W2 lane 4 landed (w2-oracle 8012f43): oracle type with dual
  surfaces (content-diff + command), hard recency gate (no recent failure → NO finding,
  not a lower-severity one — the honest call), session-scoped tracker persisted via
  StateManager; tests-read-only shipped as opt-in proposal only. Two engine findings:
  (1) pathMatches in pipeline.ts never escapes bare `*` — `**/.env*` misses .env.local,
  `**/id_rsa*` misses id_rsa.pub — LIVE HOLE in shipped secret-files rule, verified;
  MICRO-LANE w2-pathfix spawned for the fix + regression fixtures. (2) `operations:`
  filters on filesystem rules are dead code (no host populates args.operation) —
  Wave-3/audit note. Fixture-harness gaps (no observe awareness, no exit-code channel)
  → Wave-3 promotion lane scope.
- 2026-08-11 supervisor: Live-verify tail landed (w1-liveverify 4bd8f2a). OpenCode:
  hook fires headless + block PROVEN with real child transcripts (both no-push-to-main
  and, on a non-main branch with pre-warmed ladder, no-force-push). Claude/Gemini/
  Codex: auth-blocked under config isolation (CLAUDE_CONFIG_DIR loses keychain auth;
  no GEMINI/OPENAI keys) → honest HUMAN-CHECKLIST entries, Verified levels unchanged.
  Findings relayed to w2-rules: install --project stub emits `rules:` null that breaks
  evaluate/hook (real bug, fix in-lane); no-force-push is shadowed by no-push-to-main
  for main-target pushes (floor-priority fixture mandated). GATE PLAN: supervisor
  re-runs scripts/live-verify/opencode.sh on the merged tree for the OFFICIAL
  transcript; ONE supervisor attempt at Claude Code via project-scoped
  .claude/settings.json hook in a scratch repo (real auth untouched, isolation
  preserved; if the repo-hook trust gate blocks headless, record honestly).
  Toolbox: with-timeout.mjs wrapper (no coreutils timeout on this machine);
  lv_verify_block gate requires ref-unmoved + non-tautological marker + no timeout.
- 2026-08-11 supervisor: pathfix micro-lane landed (w2-pathfix 55e807f, 5ca185c).
  Root cause: two-pass escape ordering — `*` was never escaped in pass 1 so pass 2's
  `\*`→`[^/]*` NEVER fired; a bare `*` survived as a raw regex quantifier (e.g.
  `**/.env*` compiled to `^.*/\.env*$`, quantifying the letter v). Single-pass fix;
  13 tests (4 reproduce on unpatched code); +18 fixture cases. .pem/.pfx/.p12 matched
  before only by coincidence of `*` position. Sweep: policy-engine has its own
  correct compiler; plugin imports the fixed pipeline. NEW OPEN ITEM relayed to
  w2-rules: drift.test.ts does not guard paths/exclude fields — make the cross-source
  comparison field-complete.
