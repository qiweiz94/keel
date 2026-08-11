# Keel v0.3 — Autonomous Build Session Audit

Branch `v0.3-autonomous` (77 commits off `main`). Nothing pushed, published, or posted.
Supervisor: Fable (planning + routing + all gate verification). Workers: Sonnet
(implementation), Haiku (light lanes), Opus (security review + red-team). Full decision
trail in `session/DECISIONS.md`; per-lane evidence in `session/EVIDENCE/`.

The three lists below are in the format the contract requires. The "Untested / unverified"
list is deliberately populated — an empty one would be a red flag, not an achievement.

---

## Verified working (supervisor ran the verification itself)

- **Full test suite green in normal mode:** core 454 passed / 2 skipped; CLI 1116 passed /
  16 skipped; opencode-plugin load-test passing; exit 0. Run by the supervisor on the final
  merged tree, output in `session/EVIDENCE/` and the gate logs.
- **The three carried-in bugs:** (a) `lessons.ts` ESM `require()` crash — already fixed
  (confirmed by running the built CLI). (b) command rules matched against
  `JSON.stringify(args)` — the real gap was in `rate`/`diagnosis` surfaces and a nested
  `args.args.command` shape; fixed additively, 11 regression tests. (c) subprocess state
  reset — `StateManager` had disk persistence but ignored `KEEL_STATE_DIR`; one-line fix,
  then warn→deny escalation across two real `keel evaluate` subprocesses reproduced by the
  supervisor (call 1 warns, call 2 denies, state files on disk).
- **The 43-rule three-tier default ruleset** (Tier 1 protect-floor / Tier 2 balanced /
  Tier 3 observe), every rule carrying `severity`×`confidence`×`rationale`×`false_positives`
  metadata. Drift test guards all three former rule sources (install.ts, plugin.ts,
  enforce-init) field-complete. Per-rule fixture harness (must-block/must-allow) covers
  every rule; do-not-ship negative suite (no entropy scanning, no blanket rm -rf, no blanket
  network block, no hard test-edit block, `--no-verify` warns not denies, no LLM-judge gate)
  is green.
- **Protect floors block on the FIRST hit at every dial.** This is a semantic change the
  supervisor made mid-session after **OpenCode live-verify proved** a child agent's
  `git push --force origin main` reached the remote through the old warn-once grace (remote
  main moved `4c84481→1c3f9e4`). Now scoped to `level: protect` rules; unleveled deny rules
  keep the warn-once ladder (both directions tested). Confirmed by the opus review across all
  nine level combinations.
- **`observed_action` is persisted** to the audit trail (was computed but dropped), with a
  backward-compat test proving old entries still parse and `keel verify`'s separate signed
  chain is untouched.
- **Observe-continue semantics:** a `mode: observe` rule now records and *continues*
  evaluation instead of short-circuiting — which surfaced and fixed two shipped bugs where
  `must-sign-commits` and `no-push-to-main` were being blinded by an observe rule.
- **Verification-enforcement (the thesis), all observe-mode, deterministic:** claim-to-
  evidence, test-oracle tampering (recency-gated), test-before-commit, runaway-budget,
  slopsquatting install gate (fail-open on network failure). Each with synthetic must-fire
  AND must-not-fire fixtures.
- **Friction calibration:** sprint auto-expiry (4h, reverts to balanced, read fresh per
  call — no daemon); dial transparency (per-rule action-change diff computed from the real
  merged ruleset); promotion pipeline (`keel retrospective` would-block-rate section,
  `promotion_fp_threshold` default 0.001, `keel promote <id>` human-TTY-gated); sandbox
  detect-and-suggest (never auto-applies).
- **Two security holes found by the opus review and fixed + verified live by the supervisor:**
  (1) filesystem floors were **dead on Claude Code / Gemini** — `argPath()` didn't read the
  `file_path` key those hosts send; fixed, a `.claude/settings.json` write now denies exit 2.
  (2) the agent could disarm keel via `echo {} > ~/.keel/DISABLED` (and `tee`/`cp`/
  `git config core.hooksPath`); closed by the new `no-self-protection-write` floor rule, all
  variants now deny exit 2.
- **Live host verification (honesty ratchet, transcripts committed):**
  - **OpenCode — live.** `scripts/live-verify/opencode.sh` PASS on the final tree: hook
    fires headless, both force-push blocks proven with the child's own `[Keel] no-force-push`
    marker, remote ref unmoved, negative control valid. (`session/transcripts/opencode-*`)
  - **Claude Code — UPGRADED types→live.** A real `claude -p` child (real auth, project-
    scoped hook, user's `~/.claude` untouched) ran `git push --force origin main`; its own
    `permission_denials` record shows the command blocked, remote ref unchanged.
    (`session/transcripts/claude-code-force-push.txt`)
- **28 regex bypasses closed** by the opus review (mkfs variants, `rm -fr`/`-r -f`, `$HOME`,
  reversed `dd`, `git push origin +main:main`, `curl|zsh`, multi-stage `curl|base64 -d|sh`,
  `DROP\nTABLE`, …), with must-block fixtures; honest per-rule catch-rate table in
  `SECURITY.md`.

## Confirmed bugs remaining / residuals (known, documented, NOT fixed)

- **`.keel.local.yaml` floor override.** A *pre-existing* local rules file that redefines a
  `level: protect` rule id still overrides that floor in the hierarchy merge. Mitigated:
  *writing* that file is now blocked on both the tool path (argPath fix) and the shell path
  (`no-self-protection-write`), so it is a user's own-config decision, not an agent bypass.
  The deeper fix — making floors non-overridable in `mergeRules` — is a deliberate follow-up.
- **`no-self-protection-write` can over-block a READ of the sentinel.** Its bare
  `.keel/DISABLED` alternative matches any command containing that literal, so
  `cat ~/.keel/DISABLED` would also deny. Low severity (reading the sentinel is rare and
  harmless); accepted for the security value of blocking the write disarm.
- **`--level` flag is inert.** `keel evaluate --level protect` on a sprint project does not
  raise the dial; the rules-file `level:` wins. Documented, not changed.
- **STATE_DIR test-isolation flake.** `STATE_DIR` is resolved at module load, so tests that
  don't isolate via their own dirs can race on the developer's real `~/.keel/state`
  (intermittent, ~1-in-3 on two block-first assertions; a *blanket* `KEEL_STATE_DIR` override
  makes it worse for tests that isolate via `HOME` instead). The suite is green in normal
  mode; the fix (per-construction env read, mirroring the traces/overrides dirs already
  fixed) is a follow-up.
- **Residual bypass classes no regex closes** (documented in `SECURITY.md`): intra-token
  quoting, shell variable indirection, interpreter one-liners (`python -c "os.system(...)"`),
  and symlink/relative-path redirection. Keel raises the cost of these; it does not claim to
  stop a determined, injection-driven agent. Prompt injection remains unsolved industry-wide.

## Untested / unverified code paths (honest gaps)

- **In-session warn visibility is verified live only on OpenCode.** The Claude Code / Gemini
  (`additionalContext`+`systemMessage`), Codex (`systemMessage`), Cline (`HOOK_CONTROL`),
  Cursor (`userMessage`/`agentMessage`), and OpenClaw (`api.logger.warn`) warn channels are
  wired from docs/best-effort and were NOT exercised against a live host. Per-host live steps
  are in `session/HUMAN-CHECKLIST.md`. Cursor additionally has a camelCase-vs-snake_case key
  discrepancy flagged on the warn path (block path unaffected).
- **Gemini CLI, Codex CLI live-verify: not done.** Both are auth-blocked under config
  isolation on this machine (Gemini needs `GEMINI_API_KEY`; Codex isn't installed and needs
  `OPENAI_API_KEY`). Verified levels unchanged; manual procedures in the checklist.
- **Cursor / Cline / Hermes: no headless path attempted** (contract scope). Docs-level only.
- **The promotion pipeline is demonstrated, not burned in.** This session did not
  continuously dogfood keel's hooks on itself (that would require editing the user's real
  `~/.claude`, which the plan forbids), so real observe-mode trace volume is minimal. The
  mechanism is tested and demonstrated on synthetic traces; no rule was promoted (correct —
  promotion is the user's decision). See `session/PROMOTION-REPORT.md`.
- **`EnforceInput.reasoning` is unwired in all surveyed hosts**, so the claim-to-evidence
  detector can only see claim text in commit/PR message arguments today — it ships at
  `confidence: low` for exactly this reason. Wiring reasoning through hosts is unbuilt.
- **A stray `.claude/` install artifact appeared in the repo root mid-session** (an
  unisolated test wrote it via `process.cwd()`); removed. The test-isolation class that let
  it happen is noted but not swept.

## What "done" explicitly does NOT include

No promotion of any observe rule; no publish/release; no Windows test support; no
Cursor/Cline/Hermes live verification; no GIF recording; nothing pushed or posted anywhere.
Final state is local commits on `v0.3-autonomous` awaiting the user's review.
