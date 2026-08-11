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
- 2026-08-11 supervisor: GATE-2 incident: untracked .claude/ (keel claude-code project
  install artifact, timestamps 03:16) appeared in the MAIN repo root and tripped the
  shell-level G91 clean-tree merge guard. No worktree contains it; install.ts writes
  to process.cwd() — some test ran an unisolated install with cwd at repo root.
  Writer undetermined; REMOVED (regenerable via keel install --claude-code); the
  test-isolation class goes to the audit. Note for future gates: merges on this
  machine require a FULLY clean tree including untracked files.
- 2026-08-11 supervisor SEMANTIC CHANGE (implemented, not routed): protect-floor
  rules (level: protect) now block on the FIRST hit at every dial, not just the
  protect dial. Trigger: OFFICIAL opencode live-verify on the merged tree showed
  `git push --force origin main` REACHED the remote (main moved 4c84481→1c3f9e4) on
  the child's first attempt — the warn-once grace is a hole for one-shot irreversible
  floor actions. Spec basis: frozen 4.1 "Tier 1 action: block, un-bypassable" + SPEC
  §8. pipeline.ts blockFirst now includes `rule.level === 'protect'`. New test
  protect-floor-first-hit.test.ts pins it AND pins that unleveled deny rules KEEP the
  warn-once ladder (change is scoped, not global). Override-timing note (advisor):
  a floor's first hit now reaches overrideStore.consume() — NOT a regression, the only
  way a floor override exists is a human-run `keel allow` (gated against the agent), so
  honoring it on hit 1 vs hit 2 is correct/better. Live marker pinned to the real id
  `no-force-push` (priority 82 beats no-push-to-main 80). 28 threat-model tests
  encoded the old warn-first floor behavior → reconciliation delegated (Bucket A:
  floor rules evaluated twice, update warn→deny-first; must NOT weaken non-floor
  warn-once assertions). AUDIT.md must feature this with the moved-ref transcript.
- 2026-08-11 supervisor: LIVE-VERIFY OFFICIAL RESULTS (gate-2, on the fixed+merged tree):
  * OpenCode → live (was live). scripts/live-verify/opencode.sh PASS: hook fires headless,
    both force-push blocks proven with the child's own "[Keel] no-force-push" marker, ref
    unmoved, negative control valid. Transcripts pinned *-OFFICIAL-gate2.txt.
  * Claude Code → UPGRADED types→live. One supervisor attempt: project-scoped
    .claude/settings.json PreToolUse hook in a /tmp scratch repo, REAL auth (no
    CLAUDE_CONFIG_DIR isolation — the lane proved isolation loses auth), user's real
    ~/.claude untouched. Child (claude -p, haiku, --dangerously-skip-permissions) tried
    `git push --force origin main`; permission_denials shows the exact Bash command denied,
    child result "blocked by a Keel enforcement hook", remote ref UNCHANGED. Transcript
    session/transcripts/claude-code-force-push.txt. docs/integrations.md updated.
  * Gemini/Codex → unchanged (auth-blocked under isolation; HUMAN-CHECKLIST). Codex not
    installed. Honest, not upgraded.
- 2026-08-11 supervisor: WAVE-2 GATE CLOSED. Full suite green by supervisor's own run:
  core 436/2skip, cli 997/16skip, exit 0. 42 default rules (36 restructured + 6 pasted).
  do-not-ship 8/8. drift 9/9 over 3 sources. All 6 proposal rules paste-safe + fixtured.
- 2026-08-11 supervisor: W3 lane 3 (docs) landed (w3-docs 2e315f4): docs/tiers.md +
  README/ROADMAP fixes, every claim verified live (42 rules confirmed via fresh install;
  floor-first + dial-diff + retrospective output all captured). CORRECTLY documented the
  CURRENT mechanism (manual mode: edit) because keel promote / promotion_fp_threshold did
  NOT exist on its base — they're being BUILT by w3-promotion in parallel. GATE ACTION:
  after w3-promotion merges, reconcile docs/tiers.md to document `keel promote` +
  promotion_fp_threshold as real. Flags: (1) ROADMAP "12 rule types; 7 actions" stale —
  actual 21 types / 10 actions (9 usable, mask rejected); fix at gate. (2) marketing
  draft anecdote numbers unverifiable — leave, not shipped.
- 2026-08-11 supervisor: W3 lane 2 (warn-surface + session-allow) landed (w3-warnsurface
  4ff535a). Advisor caught a would-be regression: permissionDecision:'allow' on a warn
  auto-approves the warned action — fixed to OMIT it (warn = visible message, human still
  prompted). Warn channels: OpenCode verified; all others docs/best-effort → HUMAN-CHECKLIST
  live steps. keel allow --session: RuleOverride.mode:'session' keyed on session_id, threaded
  through all 3 consume() sites, never leaks across sessions (tested). FLAG for gate/audit:
  Cursor warn path uses camelCase but current Cursor docs show snake_case — potential
  no-op on the warn userMessage; block path untouched/tested. Suite in-tree: core 443,
  cli 1030, plugin 57 green.
- 2026-08-11 supervisor: W3 lane 1 (promotion) landed (w3-promotion 88638eb):
  observe-continue fix (observe rules record + CONTINUE; verdict from first non-observe
  match) — found TWO MORE shipped bugs: must-sign-commits + no-push-to-main were blinded
  by the observe rule source-change-requires-test (a push to main sailed through as bare
  allow). 5 stale tests corrected. Promotion pipeline: computePromotionReport (would-block
  rate, eligible/stay_observe/insufficient_data w/ min-eval floor; redirect counts as
  would-block; cwd-scoped denominator). keel promote TTY-gated + added to keel-control-gate
  in both copies. core 439, cli 1027 green (--no-file-parallelism; pre-existing public-v1
  parallel flake noted).
- 2026-08-11 supervisor: W3 lane 5 (opus secreview) landed (w3-secreview, 5 commits).
  CRITICAL findings: (1) argPath missed file_path → ALL filesystem floors dead on
  claude-code/gemini — SUPERVISOR HOTFIXED in main tree + test (verified live). (2) TWO
  one-command disarms: `echo {} > ~/.keel/DISABLED` and a .keel.local.yaml redefining a
  floor id both neutralize protect floors — self-protection is invisible to Bash (21/21
  shell writes to protected paths allowed). Proposal self-protection-write-gate.yaml
  written (14 catch / 17 benign) — PASTE at gate. (3) 28 regex bypasses FIXED (both copies,
  additive, 26+12 fixtures); catch rates honestly up (destructive 46→73%, force-push
  85→92%, etc.) → SECURITY.md. (4) --level flag inert (rules-file level wins) — documented.
  (5) FLAKE root cause: STATE_DIR module-level races on real ~/.keel/state — fix at gate.
  Floor-first confirmed at all 9 level combinations.
- 2026-08-11 supervisor: WAVE-3 GATE CLOSED. Merged secreview/warnsurface/promotion/docs;
  resolved keel-control-gate conflict (union: tab-hardening + promote verb). Applied at gate:
  argPath file_path HOTFIX (filesystem floors resurrected on claude-code — verified live);
  self-protection write-gate PASTED (rule 43, closes echo>DISABLED + tee/cp/git-config
  disarms, verified exit 2); docs/tiers.md reconciled to real keel promote +
  promotion_fp_threshold (all 3 claims verified in code); ROADMAP counts fixed to 21 types/
  10 actions. Full suite green by supervisor's own run: core 454, cli 1116, exit 0.
  RESIDUAL (documented, not fixed — honest): (1) a PRE-EXISTING .keel.local.yaml redefining
  a floor id still overrides it in mergeRules — but WRITING that file is now blocked at both
  tool (argPath fix) and shell (write-gate) paths, so it's a user's own-config choice, not an
  agent bypass; deeper mergeRules "floors non-overridable" is a follow-up. (2) STATE_DIR
  module-level races on real ~/.keel/state → intermittent flake; suite green in normal mode;
  root cause documented for AUDIT. (3) write-gate's bare .keel/DISABLED alt can over-block a
  READ of the sentinel (rare, low-severity) — noted for SECURITY.md.
