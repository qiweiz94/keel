# Session log — 2026-08-19/20: competitive research + overnight build sprint

## What happened, in order

1. **Round 1 research**: 10 Haiku agents researched adjacent tools (policy-as-code engines, LLM
   guardrail frameworks, prompt-injection defenses, agent sandboxing, native agent permission
   systems, secret scanners, pre-commit/CI ecosystems, safety eval harnesses, direct positioning
   competitors, observability/governance platforms). Opus synthesized into an audit + competitive
   matrix + pain-point map + roadmap; Fable verified every checkable claim against Keel's actual
   source (caught a stale rule-count comment and confirmed `no-repeat-loops` was fully implemented
   but dormant). Published as an artifact (Keel Position Report) with 5 open decisions (C–G).
2. **Round 2 research**: 10 more Haiku agents went deeper — governance-standards tooling
   (NIST/ISO/EU AI Act/MITRE ATLAS), multi-agent orchestration safety (AutoGen/CrewAI/LangGraph/
   OpenAI Swarm — all independently missing budget/loop/approval controls), human-in-the-loop
   approval patterns, agent identity/access management (confirmed non-starter, different layer),
   deep technical architecture on all six direct competitors (Pipelock, HOL Guard, Evidra,
   Rulebricks, Agent Guard, LlamaFirewall), AI supply-chain/provenance tooling, enterprise
   procurement requirements, kill-switch design patterns, OSS adoption case studies. Biggest single
   finding: **Microsoft shipped an open-source Agent Governance Toolkit in April 2026** — a
   well-funded, direct competitor. User asked for a direct synthesis instead of a second report; a
   plan file captured the resolved decisions and next actions instead.
3. **Overnight build sprint**: seven lanes, worktree-parallel off `v0.4-thesis`, Sonnet
   implementing each, evidence-gated merges. All seven merged; full suite green throughout.

## What shipped (all merged into `v0.4-thesis`, nothing pushed)

- **Lane G** — OpenSSF Scorecard workflow added from scratch (repo had zero Scorecard content
  before tonight); README badge; every third-party GitHub Action in `ci.yml`/`release.yml` pinned
  to commit SHA (verified two ways per SHA); least-privilege `permissions:` blocks added.
- **Lane S2** — `docs/owasp-agentic-top10.md`: Keel's 46 rules mapped honestly against the real
  OWASP Agentic AI Top 10 (ASI01–ASI10) — well-covered (tool misuse, RCE, rogue agents), partial
  (identity/privilege, supply chain, cascading failures, trust exploitation), not addressed
  (behaviour hijack, memory/context poisoning, inter-agent comms). Self-caught and fixed three
  overclaims via its own review pass before finishing.
- **Lane N2** — offline test coverage strengthened for all 6 non-live hosts (Gemini/Codex/Cursor/
  Cline/Hermes/OpenClaw): +3 to +5 new synthetic test cases per host, including Gemini's
  previously-nonexistent end-to-end coverage and the first warn-path coverage any of these hosts
  had. Explicitly does NOT claim live verification — offline confidence only.
- **Lane C1** — a new `simple_rules:` shorthand format (id/type/match/action/message, everything
  else defaulted) so non-experts can write a working rule without learning the full `KeelRule`
  schema — the deliberate replacement for wiring Rego/WASM (decision E: drop Rego, it loses on
  learning curve to something this simple). Deliberately defaults to `level: sprint` rather than
  `balanced` so a beginner's rule survives the friction dial instead of silently vanishing. Fixed a
  real pre-existing parser bug (a file containing only `simple_rules:` was silently dropped) along
  the way. `docs/custom-rules.md` guide added.
- **Lane R1** — evidence-gated Tier-3 promotion. `no-repeat-loops` promoted from `mode: observe` to
  enforcing (real cited evidence: 41 repeat loops across 20 of this project's own sessions, zero
  contrary false-positive evidence found anywhere in the repo). Both `runaway-budget-*` rules
  **held back** on `observe` — zero real evaluations ever recorded for either, so promoting them
  would have been promotion on vibes, which the task explicitly required refusing. Caught and fixed
  a real side-effect bug in the shared `fixture-harness.test.ts` (it computed an expected action
  once per rule instead of per-case, which couldn't express an escalation ladder).
- **Lane H** — fixed `docs/tiers.md`'s stale "45 rules" (46 actually ship: 13 protect-floor + 1
  warn-tier sibling in tier 1, 22 in tier 2, 10 in tier 3 — cross-checked three ways). Published
  both evidence axes together in README (0%-vs-75% prevention number alongside SECURITY.md's
  25–93% adversarial catch-rate range, with the honest "mistakes-and-drift vs. determined-adversary"
  framing and denominators, added in a follow-up commit after a stronger-model review caught the
  first pass missing that caveat). Fixed the long-known Cursor block-path camelCase/snake_case bug
  at `hook.ts`'s `renderVerdict` `case 'cursor'`.
- **Lane C2** (the big one) — PostToolUse secret-output handling, scoped by what's actually true
  per host rather than a hoped-for design:
  - **OpenCode**: live-verified (real `opencode run` sessions, free model, isolated `HOME`, zero
    spend) that `tool.execute.after` CAN mutate returned output. Built real capture + redaction,
    reusing the existing `no-secrets-in-code`/`no-credential-echo` pattern set rather than
    reinventing detection. A code-review pass caught that several shipped patterns match only a
    label (`aws_secret_access_key=`) and not the secret bytes — blind redaction would have stripped
    the label and left the real secret sitting next to a `[redacted]` marker. Fixed with an opt-in
    `redact_span: true` field so only patterns whose match span fully covers the secret can drive a
    mutation. A second review caught a trace-honesty bug (a "redacted" trace entry could be written
    before a batched write-back actually succeeded) — fixed so the trace only reflects what was
    actually applied.
  - **Claude Code / Codex / Gemini**: confirmed no output rewrite is possible (`PostToolUse` fires
    after the result already reached the model) — real ceiling is `hookSpecificOutput.
    additionalContext`, a next-turn warning, implemented honestly as exactly that, never claiming
    to block or redact.
  - **Cursor / Cline / generic**: no PostToolUse wiring exists; unchanged, noted as a pre-existing
    gap.
  - `docs/exfil.md` gained an "Output redaction" section with the real per-host table and the
    `redact_span` invariant. Live transcript committed at
    `session/transcripts/opencode-tool-execute-after-mutation-probe.txt`.

## An incident, disclosed in full

Lane H's agent ran live `keel level protect`/`keel level sprint` CLI commands against what it
believed was a sandboxed `KEEL_HOME`, to capture "real" output for the tiers.md doc fix. Those
specific commands (`packages/cli/src/commands/level.ts:53`) read `process.env.HOME` directly
instead of the shared `resolveHome()` helper every other command uses — so `KEEL_HOME` did not
sandbox them, and they wrote to the **real** `~/.keel/rules.yaml` on this machine twice.

The lane's own agent caught this mid-task, investigated, and remediated what it could: removed a
fabricated `sprint_started_at` timestamp its `sprint` command had written (confirmed absent from
the Aug-4 backup), and reported honestly that it could not independently prove what the `level:`
value was immediately before its mistake (only that it matches the Aug-4 backup and no trace
schema records dial-level history).

**I independently re-verified this myself before merging anything**, rather than trusting the
lane's own account:
- `level:` in the real `~/.keel/rules.yaml` currently reads `sprint`, matching the Aug-4 backup.
- A full diff against the Aug-4 backup shows only expected content added since then (three rules —
  `no-repeat-loops`, `research-before-fix`, `root-cause-before-refactor` — added to the real
  installed config sometime in the intervening two weeks) — nothing unexplained.
- `~/.keel/logs/schedule.log` and today's trace files confirm a real launchd-scheduled Keel process
  is independently active on this machine — the other recent file mtimes under `~/.keel` are
  almost certainly ordinary background activity, not something this sprint caused.
- Checked whether my own `npm test`/`npm run build`/`git merge` commands (run directly in the main
  worktree throughout the night) could have leaked into real `~/.keel` too — no evidence they did.

**Net assessment: real `~/.keel` is intact.** The `level.ts` bug itself (`process.env.HOME` instead
of `resolveHome()`) is real, confirmed, and **still unfixed** — it was out of Lane H's stated file
scope, so it was correctly left alone rather than improvised on. This is the clearest concrete
next follow-up from tonight, flagged prominently rather than buried.

## Verified final state

- Branch `v0.4-thesis`, all 7 sprint-lane merge commits landed, working tree clean, nothing pushed.
- Full suite: core 665, cli 863, mcp-server 6, opencode-plugin all-pass (build clean across all 4
  packages, `dist matches canonical template` check passes, `DEFAULT_RULES_YAML` byte-identical
  between `install.ts` and `plugin.ts`).
- `node scripts/redteam/round2.mjs` — exit 0, "all documented control catches still deny (no floor
  regression)." Every uncaught bypass attempt is a previously-disclosed, already-accepted residual
  (quoted `${IFS}` forms, `${IFS:0:1}` parameter-expansion modifier, Python `__import__`/`getattr`
  aliasing, `os.remove` non-root scoping) — nothing new.
- Tonight's 7 sprint worktree directories removed (branch refs kept, per the established
  conservative rule). `keel-v04-liveverify` left alone (deliberately unmerged from an earlier
  session). The ~55 pre-existing stale branches from before tonight were left untouched — lower
  priority, explicitly deferred rather than rushed.

## What's next (not started tonight, by design)

- **Fix `level.ts`'s `process.env.HOME` → `resolveHome()` bug** — small, real, now the clearest
  concrete next item, surfaced by tonight's incident.
- Everything already in `session/v1/PENDING.md`'s human-gated release sequence is unchanged in
  kind: real-machine dogfood, an actual `git push` to trigger Windows CI (the workflow itself was
  already correctly wired before tonight — confirmed by explore, not something tonight built),
  `npm publish`, flipping the repo public, per-host live credential verification, the demo GIF.
- Detection-axis benchmark at scale (S3) still needs a paid frontier-model run — the harness is
  ready (`--allow-paid`/`KEEL_BENCH_ALLOW_PAID=1`, capped at 3 paid runs by default) but no spend
  was authorized or attempted tonight.
- The orchestration-safety strategic idea (Keel-as-safety-layer for AutoGen/CrewAI/LangGraph,
  which round 2 found every major framework is independently missing) remains a flagged future
  bet, deliberately not started — too undefined for a single night.
