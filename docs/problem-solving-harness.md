# Keel Problem-Solving Harness — Design & Findings

Status: approved for implementation (2026-08-04) · Owner: keel maintainers
Scope: turning keel from a guardrail ("block bad actions") into a
**problem-solving governor** ("detect the stall, redirect to the missing
capability, verify with evidence, and learn so the same stall never costs a
second session").

---

## 1. Executive summary

The user's pain: **AI agents circle on the same problems, get stuck, patch
symptoms instead of root causes, and solve against stale knowledge** instead
of searching for the newest data first. The question posed was "harness vs
prompt engineering?"

The answer is a **four-layer stack** — and the evidence already in keel's
own traces proves that prompting alone is insufficient:

| Layer | Keel artifact | Binding | Failure mode it fixes | Blind spot |
|---|---|---|---|---|
| Prompt | `~/.keel/requirements.md` injected every turn + at compaction | soft | sets priors: research-first, root-cause, stuck protocol | cannot stop a loop mid-flight — a stuck agent ignores standing text |
| Enforcement | rule engine, runs outside the context window | hard | **circling**, in the moment | cannot create capability (no search tool exists today) |
| Tooling | research/plan MCP tools + daemon endpoints | capability | **no-research-before-solve** at the causal level | unused without discipline |
| Feedback | traces → lessons → gather → requirements auto-evolution | compounding | **getting measurably smarter over time** | needs volume + honest signal |

**Which pain, which layer:** *Circling* is primarily fixed by enforcement (a
stuck-loop detector + `redirect` action that fires outside the agent's
context window). *No research before solving* is fixed by tooling (the
capability) made binding by enforcement (a research-before-solve obligation).
The prompt layer sets priors; the feedback layer compounds.

**The honest verdict:** prompt-only has already failed *empirically* — the
requirements are injected every turn and agents still circle. The harness
thesis: you cannot prompt your way out of behavioral failure modes; you
engineer the environment (tooling), the constraints (enforcement), and the
learning (feedback). Keel's structural advantage is that it observes
**outside the context window** (tool calls, args, exit codes, verdicts) —
which is precisely where circling lives.

---

## 2. The problem, with evidence from keel's own traces

Real trace data (`~/.keel/traces/*.jsonl`, 8,700+ entries analyzed):

- One session: `git add -A && git commit -m "..."` **denied 3× by the same
  rule** (`source-change-requires-test`) — the agent kept retrying the
  identical command against the same gate.
- One session: **25 edit→test→edit churn cycles** on the same file —
  symptom-patching without ever changing the approach.
- Repeated `no-after-hours-publish`, `publish-gate`, `no-exfil-flow`
  violations on the same commands — the agent did not read the rule message
  or change its invocation.
- The `keel:gather` feedback loop has already closed once (audit history →
  requirements.md), but the injected bullets are static and the telemetry
  beneath them is truncated.

**Root causes in the harness itself:**

1. **No outcome telemetry.** The plugin's `tool.execute.after` reads
   `output.metadata.exit` (to satisfy verification rules) but **drops it**
   from the trace (`packages/opencode-plugin/src/plugin.ts:473-474`).
   Keel cannot tell a failed attempt from a successful one — the single
   highest-leverage gap (a one-line fix).
2. **Turn/token telemetry hardcoded to 0** (`plugin.ts:306-307`) — session
   reconstruction and token-hotspot analysis are structurally blind; the
   FlowTracker's per-turn tags collide.
3. **No web-search or fetch capability anywhere.** Grep of the CLI for
   network code: zero outbound utilities. The MCP server exposes only
   `keel_check` / `keel_audit` / `keel_requirements`.
4. **No stuck-loop detector on identical failing commands.** Rate rules
   count all calls of a tool; the circuit breaker keys on `rule:tool`, not
   on "same command, no progress".
5. **No research-before-solve obligation** — no rule type for it.
6. **Reasoning is redacted** (`audit-redaction.ts:25-27` redacts it to a
   constant) — no claim-quality or root-cause-hypothesis check can run in
   real time.

**Have vs missing (grounded):**

| Capability | HAVE | MISSING |
|---|---|---|
| Requirements injected every turn + survive compaction | ✅ `plugin.ts:477-494` | — |
| Verification obligations with anti-fake-satisfy + commit/push boundaries | ✅ `verification.ts:66-150` | — |
| External-edit re-arming (worktree fingerprint) | ✅ `plugin.ts:318-330` | — |
| Offline learning loop (lessons/suggest/gather → requirements.md) | ✅ `lessons.ts`, `gather.ts` | data-driven bullets; bug fixes (`lessons.ts:275` typo, dead gather mappings) |
| Trace of every tool call | ✅ `plugin.ts:285-293` | exit codes, turns, tokens, cwd, reasoning, output hashes |
| Circuit breaker / lockup escape (3 denies/60s) | ✅ `pipeline.ts:505-549` | fires on rule:tool, not same failing command |
| Agent self-monitoring (keel_audit MCP tool) | ✅ `mcp/server.ts` | — |
| Research-before-solve rule type | ❌ | new `research` obligation type |
| Web-search / fetch tool (keel-provided) | ❌ | daemon `/v1/research` + MCP tools |
| Per-session research/notes store, injected like requirements | ❌ | session ledger + cache |
| Stuck-loop detection (identical failing command) | ❌ | StuckTracker + fingerprinting |
| Real-time "claimed done without evidence" check | ❌ (offline only) | response-level check |
| Reasoning capture + quality analysis | ❌ (redacted) | local reasoning store |

---

## 3. Design principles

1. **Keel is a deterministic engine with no LLM access** (SPEC.md §1). It
   cannot *think* first-principles — it **enforces the workflow shape**
   (research evidence, hypothesis record, no identical retries) and
   **requires the outputs of thinking** as structured events. The agent
   supplies cognition; keel supplies memory, ordering, and escalating
   guidance.
2. **One engine, one runtime, thin clients.** The daemon owns enforcement
   and workflow state; every integration (plugin, hooks, MCP, gateway,
   Hermes/OpenClaw) is a thin client.
3. **Friction scales with the dial, not with rule count** (balance
   philosophy). Sprint = warn/guidance only; balanced = warn → redirect →
   block; protect = block-first.
4. **Enforcement shapes observable action loops; prompts shape cognition.**
   Everything unobservable from tool calls stays advisory — pretending
   otherwise teaches agents to route around the rules.
5. **Capability before enforcement.** A research-before-solve obligation
   with no research tool is unsatisfiable and would poison trust. Tooling
   lands a beat before its enforcement.
6. **Warn on evidence.** New behavior rules are warn-first; deny only at
   escalation thresholds; `keel allow` remains the human override.

---

## 4. The design

### 4.1 New rule types

#### `type: research` — research-before-solve obligation

Mirror of the `verification` three-part structure (trigger → obligation,
satisfy → discharge, boundaries → gates), with the temporal direction
inverted: armed by a **failing attempt**, discharged by **research
evidence**, gated at the **next fix action**.

```yaml
- id: research-before-fix
  type: research
  trigger:
    tools: [Bash]
    pattern: "(npm test|npm run test|vitest|jest|npm run build|tsc)"
    exit: nonzero              # NEW matcher field — only arm when the command FAILED
  satisfy:
    tools: [Bash, WebSearch, WebFetch, mcp__keel__keel_research]
    pattern: "(curl|npm view|npm info|pip index|WebSearch|WebFetch|keel_research)"
  topics: ["api", "docs", "deprecat"]   # evidence must tag ≥1 of these
  boundaries:
    edit:
      pattern: "apply_patch|write|edit"
      action: redirect          # NEW action (see 4.2)
    commit:
      pattern: "git commit"
      action: warn
  research_window_seconds: 600
  freshness_seconds: 1800       # evidence older than this does NOT discharge
  action: redirect
  message: "`npm test` is failing and you are about to patch it without checking the latest docs. Research first: keel_research(query: \"<the failing module/error>\")."
```

Semantics map one-to-one onto `verification.ts` (obligation key, arm via
`observeTrigger`, discharge via `markSatisfied` + `isFakeSatisfy` guard,
window TTL, `boundary()` gates — factored into a shared
`boundary-match.ts`).

**Boundaries so it never stalls legitimate work:**

- The trigger is a *failing* command — green-field writes never arm it.
- It redirects but never blocks on first occurrence; `keel allow` is never
  required — compliance clears it.
- Offline agents (research backend `none`): the directive adapts to "state
  diagnosis evidence instead" — network absence is not a policy violation.

#### `type: stuck` — identical-failing-command loop detector

Extends the rate machinery with **command identity** (fingerprint),
**failure awareness** (exit codes), and **escalating guidance**:

```yaml
- id: stuck-npm-test-loop
  type: stuck
  match: "(npm test|npm run test|vitest|jest|npm run build|tsc)"
  window_seconds: 900
  max_attempts: 3              # identical FAILING fingerprint ≥ 3 in window → fire
  fingerprint: auto            # 'auto' | 'exact' | 'none'
  require_failure: true        # only count exit != 0
  reset_on_success: true       # exit 0 on the same fingerprint resets the counter
  escalation:
    - at: 3
      action: redirect
      message: "`<fingerprint>` has failed 3x in 15min — stop retrying. keel_research the error, then keel_hypothesis a root-cause statement before the next attempt."
    - at: 5
      action: deny
      message: "5 identical failures — retrying without research is blocked. Record a hypothesis or ask the user."
  action: warn
```

- **Fingerprint**: `commandFingerprint()` normalizes commands (collapse
  whitespace, strip PIDs/ports/hashes/timestamps, normalize `-m "..."`
  payloads, truncate) — "identical" means *same failing attempt*, not the
  same string.
- **Progress resets**: a passing test run, a research call, a write to a
  new file, or a changed approach pauses/clears the counter — legitimate
  second approaches are never penalized.
- **Swallow guard**: `npm test || true` exiting 0 must NOT reset the
  counter (reuse `isFakeSatisfy`, `verification.ts:101-108`).

#### `type: diagnosis` — root-cause marker before complex/destructive fixes

A ledger-query rule: on a complex/destructive fix (refactor/migrate/delete),
check whether a root-cause hypothesis exists for the current problem in the
ProblemLedger (within a window). Discharges on `keel_hypothesis` events or
actual investigation evidence (`git log/blame/bisect`, `git diff`).

This is where "first-principles" becomes enforceable: the hypothesis is a
structured record (`statement`, `evidence[]`, `status`) that keel persists,
verifies against later outcomes, and **falsifies when the next verification
run still fails** — "I guessed" becomes visible in the post-mortem.

### 4.2 The `redirect` action

A new first-class `EnforcementAction`:

- **Structured, model-visible course correction** — interrupts the specific
  tool call once, carries a machine-readable directive
  (`RedirectDirective`: kind, required_tools, target, rationale, rule_id,
  problem_key, attempts, suggested_call).
- **Not a deny**: no warn-once escalation, no circuit-breaker arming, no
  override consumption.
- **Not a warn**: it must reach the model (the plugin throws
  `[Keel] REDIRECT <rule_id>: <directive JSON>` — the only channel that
  guarantees visibility outside the context window).
- **Self-clears on compliance**: the agent runs the required tool
  (`keel_research` / `keel_hypothesis`), the obligation discharges, and the
  same action then passes.
- **Throttled** (`redirect_throttle_seconds`, default 300 per problem_key)
  — the harness reminds, it doesn't nag.

Escalation ladder (dial-aware):

| Dial | First redirect | Repeated redirect (same rule:problem) |
|---|---|---|
| sprint | downgraded to warn + directive text | warn again |
| balanced | redirect | prompt (needs `keel allow <id> --once`) after `block_after_redirects: 2` (default 3) |
| protect | redirect | deny after 1st repeat |

### 4.3 Daemon evolution

Today: `/v1/check`, `/v1/requirements`, `/v1/health`, per-cwd pipeline
cache, shared StateManager, bearer token, idle shutdown. Add:

| Endpoint | Purpose |
|---|---|
| `POST /v1/research` | search (query) or fetch (url); SSRF-guarded; session cache with `fetched_at`; writes evidence to the ledger; clears pending research obligations |
| `GET /v1/research/cache` | session research entries (freshness evidence) |
| `GET /v1/context` | session problem state: failing commands + attempts, fix attempts, research evidence, hypotheses, plans, problem status |
| `POST /v1/outcome` | the after-hook channel: exit codes, durations → StuckTracker + ledger + verification satisfaction (moves the plugin's in-process satisfaction into the shared engine) |
| `POST /v1/stuck` / `GET /v1/stuck` | loop-detection service with escalation directives |
| `POST /v1/plan` | register a fix plan (steps + hypothesis); deterministic gap analysis (missing hypothesis / research / verification) |

The **ProblemLedger** (`packages/core/src/enforce/problem-ledger.ts`)
persists problems/evidence/hypotheses/plans via the StateManager atomic
write pattern at `~/.keel/state/ledger.json`. `problem_key` is
deterministic: `sha256(cwd + firstFailingFingerprint + affectedPath)`.

### 4.4 MCP tools

Add to `packages/cli/src/mcp/server.ts` (all thin daemon clients):

| Tool | Purpose |
|---|---|
| `keel_research` | search the web for the newest info on the exact module/API/error; records evidence; satisfies research obligations |
| `keel_fetch` | SSRF-guarded fetch + sanitize to readable text (strip scripts/styles, 1 MB cap) |
| `keel_search_cache` | list session research with `fetched_at` timestamps |
| `keel_hypothesis` | record a root-cause hypothesis (statement + evidence ids); satisfies diagnosis obligations; falsifiable |
| `keel_plan` | register a fix plan; harness flags gaps |
| `keel_stuck` | ask whether the session is stuck and what to do next |
| `keel_context` | retrieve session problem state |

### 4.5 Research layer (`/v1/research`)

- **Backends**: `duckduckgo` (keyless HTML endpoint — default, zero config),
  `api` (user-configured `KEEL_SEARCH_API_URL` + `KEEL_SEARCH_API_KEY`),
  `none` (offline — directives tell the agent to use platform-native
  search). Env vars follow the established `KEEL_*` convention; the API key
  is env-only, never persisted, never logged.
- **Session cache**: daemon memory (authoritative) + disk mirror at
  `~/.keel/cache/research/<session>/<sha256>.json` (0600, atomic writes);
  TTL = `freshness_seconds`; `fetched_at` is the freshness timestamp.
- **Freshness rules**: new `freshness`/`topics` rule fields — "is the
  agent's knowledge fresh?" becomes a checkable property. Stale or missing
  research → `research`/`redirect` directive instead of allow.
- **Ship vs delegate**: keel ships the *freshness gate* (the moat — no
  other tool enforces research-before-solve) + a minimal hardened
  fetch/search shim so the gate is satisfiable out of the box. The search
  engine itself is delegated (platform-native search in Hermes/OpenClaw can
  satisfy the gate via a `research_completed` recording call in v2).

### 4.6 Traces and telemetry

- **One-line fix first**: record `exit` in `tool.execute.after`; real
  `turn_number`/`context_tokens`; `cwd`. Everything downstream depends on
  these.
- New typed `event` field: `attempt` (fingerprint, exit_code, duration,
  problem_key, outcome), `research` (evidence_id, query, topics, cached),
  `hypothesis`, `redirect`, `problem` (status transitions).
- Research queries are kept in traces (not secrets); **results** stay out —
  full content lives only in the cache files (0600).
- `keel postmortem <problem_key|session_id>` renders a per-problem
  timeline: attempts with exit codes, research, hypotheses, redirects,
  resolution.

---

## 5. Roadmap (phases)

### Phase 0 — Prompt quick-win (hours, zero code) — IN PROGRESS

New `~/.keel/requirements.md` sections (drafted; see the file itself for
the shipped text):

- **Problem-solving protocol** — research first, first-principles, root
  cause before fix, patch-is-last, cite sources with dates, verify against
  newest docs.
- **Stuck detection protocol** — stop after 2 failed attempts, escalate in
  order (search → ask user → change approach), say you are stuck, no
  circling.
- **Evidence & freshness** — check dates/versions, "latest" is a claim,
  pinned ≠ current, stale sources are a root cause.

Delivery: global `~/.keel/requirements.md` + optional project
`.keel/requirements.md`; dial-aware filtering (`[sprint]`/`[full]` line
tags) in the plugin + daemon `/v1/requirements` (fix the daemon's
project-first single-file inconsistency — merge global then project so every
client injects identical text); session context card injected as a third
block (PROBLEM / ATTEMPTED / RULES HIT / RESEARCH / FRESHNESS / STUCK /
NEXT BEST STEP — machine-derived from traces).

Verification: injection tests still pass; the new sections appear in
`keel requirements` and the plugin's transform output. Honest caveat:
Phase 0 alone will not fix the pain — it raises priors and produces the
trace baseline that makes Phases 1-3 measurable.

### Phase 1 — Research capability (the causal fix for "no research")

Daemon `/v1/research` + `/v1/research/cache` (SSRF-hardened fetcher,
search backends, session cache); MCP `keel_research` / `keel_fetch` /
`keel_search_cache`; `freshness`/`topics` rule fields; cost guardrails
(rate rules on `keel_research`, query-hash cache); privacy (research only
via the daemon, DLP-scanned, queries scrubbed from traces).

Verification: handler tests, cache-hit test, rate-rule firing, MCP
registration test, freshness-rule staleness test.

### Phase 2 — Workflow enforcement (the teeth)

`research` obligation type + `redirect` action; `stuck` rule type
(fingerprint + escalation); `diagnosis` type + ProblemLedger +
`keel_hypothesis`; `/v1/outcome` channel; plugin redirect surfacing.

Verification: obligation arming/discharge tests, StuckTracker tests
(identical calls → warn → redirect → deny; progress resets; session
isolation), redirect payload shape, protect escalation, shared-state tests.

### Phase 3 — The learning loop (keel gets measurably smarter)

Telemetry fixes land first (exit codes, turns, cwd). Metrics (see §6);
`keel retrospective` (per-project weekly report with week-over-week deltas);
new lesson categories (`circling`, `no-research-before-solve`) flowing
through the existing `keel gather` → requirements.md markers; lesson decay;
`keel postmortem`.

Verification: fixture-trace tests for new lesson categories; retrospective
output fixture; gather idempotency.

### Phase 4 — Cross-platform (breadth, not pain)

Hermes `pre_tool_call` plugin + OpenClaw native plugin as thin daemon
clients; OpenCode plugin migrates to daemon-first (one escalation state
across every platform); gateway routes research through `/v1/research` +
DLP-scans responses; `keel install --hermes` / `--openclaw`.

---

## 6. Metrics (exact formulas over trace fields)

All counts use before-hook entries, noise-filtered
(`agent === 'opencode-plugin'`); exit codes make them exact once Phase 3's
telemetry lands (heuristic fallbacks documented until then):

1. **Attempts-until-success (AUS)** — per session: `min i` such that call
   `i` is a non-fake test with a pass, minus the index of the first source
   edit. Weekly: median + p90.
2. **Stuck-loop count** — clusters of `(rule_id, normalize(command))` with
   count ≥ 3 within `min(20 calls, 30 min)`.
3. **Research-before-solve compliance** — `t(first search) < t(first
   edit)` per session; weekly share of sessions with source edits.
4. **Time-to-first-search** — `t(first websearch|webfetch|grep) − t(first
   call)`; weekly median.
5. **Symptom-vs-root-cause proxy** — churn triples (same-file
   edit→test→edit, ≤8 calls apart) / source edits; same-test-file repeats.
6. **Verification completion rate** — sessions with pass evidence /
   sessions with ≥1 source edit.
7. **Deny-repeat rate** — clusters with count ≥ 2 / (deny + warn + prompt
   events) — does the agent comply with the blocking message or circle?
8. **Pivot recovery rate** — among stuck sessions: executed a research
   call or changed `cmd_family` within 5 calls after the 2nd repeat; plus
   `median AUS(pivoted) − median AUS(never-pivoted)` — the headline
   "keel made agents measurably better" number.

`keel retrospective [--since <date>] [--project <path>] [--json]
[--write]` renders the weekly table with week-over-week deltas, top problem
signatures, and lessons written.

---

## 7. Security

- **SSRF** (the research endpoint must never become a proxy vector):
  scheme allow-list (http/https only); private/link-local/metadata IP
  deny-lists; hostname deny-list (localhost, metadata hosts); DNS
  resolution + re-check of every resolved address; re-check on every
  redirect hop (max 3); no ambient credentials; timeouts (connect 5s,
  total 15s); response-size cap (1 MB stream abort); content sanitization
  (strip script/style/svg/iframe, `on*=` attrs, `javascript:`/`data:`
  URIs); per-session rate cap.
- **Secrets**: `KEEL_SEARCH_API_KEY` env-only, never persisted, never in
  traces/receipts/MCP responses; add it to the `no-credential-echo` env-rule
  vars.
- **Privacy**: research only via the daemon (one governed path);
  per-project domain allowlists via existing `network` rule `except`;
  gateway DLP-scans research output; flow rules already stop sensitive-file
  reads reaching network sinks; research queries scrubbed from traces.
- **Control surface unchanged**: dial/allow/disable remain TTY-human-only;
  the daemon binds 127.0.0.1 with the 0600 bearer token.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Research-first adds latency | query-hash cache (identical queries free within TTL); freshness bounds re-fetches; rate rules; sprint dial downgrades the obligation to warn; redirect fires only when evidence is stale |
| Agents ignore prompts (Phase 0) | precisely why Phase 2 exists — enforcement runs outside the context window; Phase 0 is an explicit stopgap |
| False stuck-detection | progress resets (test pass, research, new file, changed approach); ≥3 identical fingerprints with zero progress required; warn → redirect → deny ladder; per-project thresholds; `keel allow` override |
| Privacy of web research | daemon-only path, allowlists, DLP scan, scrubbed traces, pluggable provider incl. local-only |
| API costs | cache, rate rules, `max_results` caps, provider choice |
| Rule bloat from auto-evolution | human gate on `gather --apply-and-save` (already enforced); lesson decay TTL; last-known-good reload keeps a typo'd rules file from disabling enforcement |
| Cross-platform state drift | Phase 4 daemon migration collapses enforcement state into one process |

---

## 9. Decisions and status log

| # | Decision | Status |
|---|---|---|
| 1 | Harness = 4 layers (prompt + enforcement + tooling + feedback); not either/or | ✅ approved |
| 2 | Order is load-bearing: capability (P1) before enforcement (P2) | ✅ approved |
| 3 | P0 + P1 + P2 = the actual harness (80/20); P3/P4 compound/broaden | ✅ approved |
| 4 | Research backend default: keyless DuckDuckGo; `api` and `none` backends supported | ✅ approved (per recommendation) |
| 5 | Enforcement posture: warn-first; deny only at escalation thresholds | ✅ approved (per recommendation) |
| 6 | Start with P0 immediately (requirements.md) | 🔨 in progress |

---

## 10. The vision (end-to-end)

A typical stuck session, once the harness ships. The agent starts on a
flaky build failure. The injected protocol says research first, and
`keel_research` exists, so the session begins with a freshness-gated
search: results carry `fetched_at`, and a freshness rule warns when they
are stale — "newest data" is a checked property, not a hope. The agent
states its version assumptions, derives a root-cause hypothesis
(`keel_hypothesis`), and edits `src/`. That edit arms the
research-before-solve obligation; the earlier research satisfies it, so no
boundary fires. The first fix fails. The second attempt — same approach,
same tool — fires the stuck detector's warn. The third identical attempt
triggers the redirect: keel interrupts outside the context window, where
the agent's own degraded attention cannot ignore it — "You are circling on
the same fix. Stop. Run `keel_research` on the failing dependency and state
a root-cause hypothesis before the next attempt." The agent pivots; the
search reveals an upstream major-version bump; the root cause was never the
build config. It fixes, runs the tests — satisfying the verification
obligation with real evidence, not `|| true` — and commits. That evening
the user runs `keel retrospective`: a one-page debrief of the loop, the
redirect that broke it, and a proposed rule. `keel gather` folds the lesson
between the markers of requirements.md, and tomorrow's session starts with
the knowledge injected at zero cost.

Guardrail, harness, and memory in one daemon.
