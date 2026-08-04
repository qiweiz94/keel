# Handoff: keel problem-solving harness

**Last updated:** 2026-08-04 · **Repo:** `/Users/nanoclaw/code/keel`
READ THIS FIRST — the standing requirements at the bottom are non-negotiable project culture.

---

## 1. What this project is

**keel** (product name — never "ai-enforce", never anything else) is a guardrail +
workflow-governor for AI agents working on this Mac. It sits between the agent and the
shell/file tools and:

1. **Enforces rules** — policy rules (rules.yaml) evaluated on every tool call, with a
   warn → block escalation ladder, a human-run approval path (`keel allow <id> --once`),
   and a speed dial (`keel level sprint|balanced|protect`) that scales friction.
2. **Guides the workflow** — the "problem-solving harness" program turns keel into a
   workflow governor: research-first, root-cause-first, no-circling agents.

Architecture: **one engine, one daemon, thin clients.** `packages/core` (pure evaluation
engine), `packages/cli` (commands + `keel daemon` REST server + MCP gateway),
`packages/opencode-plugin` (thin client for OpenCode; canonical template at
`packages/cli/templates/keel-enforce.js`).

- Daemon endpoints: `/v1/check`, `/v1/requirements`, `/v1/health`, `/v1/research`,
  `/v1/research/cache`, `/v1/hypothesis`, `/v1/outcome`. Idle-exit after 10 min.
  Token auth (`~/.keel/daemon-token`, 0600, atomic create).
- MCP tools: `keel_check`, `keel_audit`, `keel_requirements`, `keel_research`,
  `keel_fetch`, `keel_search_cache`, `keel_hypothesis`.

## 2. Program status

| Phase | What | Status |
|---|---|---|
| 0 | Requirements protocols in `~/.keel/requirements.md` | ✅ `b95821e`, `0f55eeb` |
| 1 | Research capability: `/v1/research`, SSRF-hardened fetcher, MCP research tools, `research` rule type | ✅ `59f398a` |
| 2a | Stuck detector: `stuck` type, `StuckTracker`, fingerprinting, `redirect` action | ✅ `6ae6c07` |
| 2b | Root-cause marker: `ProblemLedger`, `keel_hypothesis`, `diagnosis` type | ✅ `d3aa821` |
| 2c | Research-before-solve obligation | ✅ `bcbeb86` |
| 3 | **Learning loop — `keel retrospective`** | ✅ **shipped-partial** `a189931`, corrected `9fd8f5a` |
| 4 | Cross-platform thin clients (Hermes, OpenClaw, OpenCode daemon-first) | ⏳ next — research done, `77a60dd` |

Design record — read before changing anything: **`docs/problem-solving-harness.md`**
(audit findings §2.1, decision table §3.1, algorithms §6.1–6.2, checklist §11,
boundaries §12, **decisions log §9 at the end — append, never rewrite**).
Phase 4 research brief: `docs/research/phase-4-cross-platform-2026-08-04.md`.

## 3. Current state (2026-08-04)

**All suites green:** core 219/219 (13 files) · cli 349/349 (27 files) · plugin
load-test all checks passed. Homebrew deployment is byte-identical to the repo dist.

**Phase 3 shipped what:** `keel retrospective [--since] [--project] [--json] [--write]`
computing all eight §6 metrics, plus workflow lesson keys (`stuck-loop`,
`no-research-before-solve`, `no-pivot`) wired through `keel gather` into the
requirements.md markers. Verified end-to-end on 9,694 real trace entries.

**Phase 3 deferred (declared in §5/§6/§11, NOT built):** week-over-week deltas,
`keel postmortem`, lesson decay, lessons.json v2 reads. See decisions-log row 9c.

**Plugin refreshed 2026-08-04 22:57** (row 9d resolved). The user ran
`keel install --opencode`; `~/.opencode/plugins/keel-enforce.js` is now byte-identical
to `packages/cli/templates/keel-enforce.js` and carries `recordAttemptOutcome` (Phase 2a
exit-code telemetry, absent from the previous build), `turnCounters` (real
`turn_number`), and `enforcedAction`/`observed_action` (observe mode).

**Still true until OpenCode is restarted:** traces written before the restart carry no
`exit` and no `turn_number`, so `keel retrospective` reports 0 for
attempts-to-success and verification-completion on historical data. Those metrics only
become meaningful for sessions run against the new build. Do not read a 0 there as a
code defect — check `MAX(t)` on traces carrying an `exit` field first.

**Open gaps found by external research (row 12):** no shadow/observe rule state; the
stuck detector misses oscillation and semantic livelock; no reproduction-test-before-fix
gate; `turn_number` still hardcoded 0 at `plugin.ts:308` (blocks same-turn conjunction
rules); users approve 93% of permission prompts, so adopt deny-and-continue and track
actionable rate.

## 4. Operational knowledge (critical)

- **Verification culture (hard rule):** before claiming done/fixed/tested, run the tests
  and show the output. Build ≠ verification. **Never pipe the test command** through
  `grep`/`head` — the fake-satisfy heuristic treats it as swallowed evidence and re-arms
  the obligation.
- **Fixture tests confirm only the case you imagined.** Two of three metric fixes in
  `a189931` were still wrong and were caught by re-running them against the built
  artifact with a *multi-occurrence* fixture. Any metric over a sequence needs one.
- **Control gate:** the agent CANNOT run `keel install|allow|level|disable|enforce`.
  Those are human-run. Surface `keel allow <id> --once`; never invent a workaround.
- **Homebrew paths** (the old handoff had these wrong — `@get-keel/core` is *not* a
  top-level package):
  - CLI dist → `/opt/homebrew/lib/node_modules/@get-keel/cli/dist`
  - Core dist → `/opt/homebrew/lib/node_modules/@get-keel/cli/node_modules/@get-keel/core/dist`
  - Template → `/opt/homebrew/lib/node_modules/@get-keel/cli/templates/keel-enforce.js`
  - Source template lives at `packages/cli/templates/keel-enforce.js`, not repo root.
  - **Build before testing** — the CLI build does `rmSync('src/core')` then re-copies
    `../core/src`, so testing first exercises a tree the build then regenerates.
  - After deploying, grep the deployed dist for a symbol only the change introduces.
- **Live plugin scans `~/.opencode/plugins` content:** anything containing banned
  literals is cancelled — `rm -rf`, `git push --force`, sink verbs
  (`curl|wget|fetch|http|https|nc|netcat|socat`), and **any string containing `nc`**
  (which matches `sync`). Commit messages must avoid these words too.
- **User-owned, agent must not touch:** `~/.keel/rules.yaml`, `~/.opencode/plugins/`.
- **State files:** `~/.keel/state/ledger.json`, traces in `~/.keel/traces/`,
  retrospectives in `~/.keel/retrospectives/`. `KEEL_STATE_DIR` overrides.
- **Stuck protocol:** stop after 2 failed identical attempts, escalate (search the exact
  error → ask the user → change approach), never circle. **This applies to the agent as
  much as to the thing being governed.**
- **Freshness:** check dates/versions of docs and packages; "latest" is a claim, verify.
  Stale sources are a root cause — this file included.

## 5. Standing requirements (survive compaction — non-negotiable)

- Agent identity: primary agent is OpenCode; agent-facing instructions live in AGENTS.md
  (never CLAUDE.md).
- keel stops bad behavior and warns — it is NOT meant to slow work. First deny
  violations warn only; repeats block. Approvals are human-run, never self-approved.
  Friction scales with the dial.
- Verification: tests must pass and be shown; a compile check is NOT verification.
- Decision-making: ASK before choosing formats/tools/naming. "I believe it works" is not
  evidence.
- Product name is "keel" — never ai-enforce.
- Plan quality: name root causes vs symptoms; state what a plan does NOT address; be
  honest about untested things.
- Context awareness: at high token counts, re-check these requirements; a standing
  requirement wins over newer info.
- Problem-solving protocol: research first (newest sources, cite URL + date),
  first-principles, root cause before fix, patch is last, verify against newest docs.
- Stuck detection: stop after 2 failed attempts; escalate in order; say you are stuck.
- Evidence & freshness: pinned ≠ current; stale sources are a root cause.
- Irreversible operations: enumerate inbound references before recommending; state
  verified vs assumed.
