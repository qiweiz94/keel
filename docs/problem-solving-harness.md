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
 7. **No per-session task memory.** StateManager persists rule-level
    counters only; there is no notion of "what the agent is trying to
    accomplish", so no detector can distinguish productive exploration
    from circling.
 8. **The CLI `audit` command and the plugin disagree.** `audit.ts` reads
    the legacy `<project>/.keel/audit/audit.log`; the plugin writes
    `~/.keel/traces/`. Two views of the same events.

### 2.1 Complete audit findings (verified trace schema, bugs, analysis rules)

**Verified live trace schema** (every plugin record, from 8,700+ real
entries): `t` (epoch ms), `timestamp`, `agent`, `session_id`, `tool`,
`args` (redacted via `projectAuditArgs` — SAFE_KEYS: command, cmd, path,
file, filePath, url, uri, host, operation, tool, oldString, newString
truncated at 2000 chars; write content and reasoning are `[redacted]`),
`rule_id`, `action`, `message`, `hook`. Search calls are identifiable
(`websearch.query`, `webfetch.url`, `grep.pattern`); test calls are
identifiable (bash command matching `/npm|pnpm|yarn|bun|npx vitest|jest|
pytest|go test/`).

**Analysis noise to filter (mandatory for every detector/lesson):** the
`keel evaluate` test harness writes entries with `agent: "unknown"`, no
`hook`, and fixture rules (`protect-only-level-inheritance-*`,
`dangerous`, `strict-action`). On one sample day they were 224 of 3,201
entries and created hundreds of false "repeat" hits. **All detection must
require `hook` present or `agent === 'opencode-plugin'`.**

**Known bugs and stubs found in the existing learning loop:**

| Bug | Location | Impact |
|---|---|---|
| `--apply-and-save` advertised but does not exist | `lessons.ts:329` | users think rules were applied |
| `file.replace('.jsonl',')')` filter typo | `lessons.ts:275` | lesson scan works only by lexicographic luck |
| Dead gather category mappings (`build-not-test`, `sequence-violation`) | `gather.ts:29,45` | dead code; stale `~/.keel/lessons.json` contains a lesson `extractLessons` cannot produce |
| `testFromAudit` counts entries instead of re-evaluating | `test.ts:132-137` | "rule replay against old traces" is a stub |
| `buildClaims` findIndex across all entries, not the same turn | `lessons.ts:114` | claim-without-evidence lesson misattributes |
| `keel watch --json` accepted but ignored | `watch.ts` | — |
| Token-hotspot analysis meaningless | `suggester.ts:42-57` | plugin records `context_tokens: 0` |
| Override detection is a string heuristic | `suggester.ts:33` | `message.includes('--once')` |
| SPEC §7 lesson approve/reject lifecycle is display-only | `SPEC.md:784-792` | no `[y/N]` gate implemented |
| FlowTracker tags keyed `flow:<session>:<turn>` with turn always 0 | `flow-tracker.ts:52,74` | multiple reads in one session collide |

**Ranked gaps by leverage (highest first):**

1. Record execution outcomes — `exit_code`, `output_hash`, `duration_ms`
   in `tool.execute.after`. Zero new infra; everything else depends on it.
2. Real-time identical-command stuck-loop detector (Pattern A, §6.1).
3. Research-before-solve obligation + a keel-provided search MCP tool +
   per-session research store injected like requirements — the single
   highest-leverage *missing affordance*; turns keel from blocker into
   enabler.
4. Fix telemetry plumbing (`turn_number`, `context_tokens`, `cwd`,
   `level`).
5. Persist reasoning locally instead of redacting; wire the Tier-7
   reasoning analyzer (`reasoning.ts:42-91`) into the plugin so
   reasoning-quality checks run at every call, not just protect.
6. Real-time "claim without evidence" check (verification obligations
   prove tests ran; nothing catches the agent *asserting* done/fixed).
7. Fix and enrich the learning loop (bugs above; data-driven gather
   bullets with counts + example turns).
8. Session/task memory (`task_id`/goal field; per-session state that
   survives restarts).

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

### 3.1 Prompt vs enforce — the decision table

Governing principle: **keel enforces observable action loops; prompts shape
cognition. Everything unobservable from tool calls stays advisory** —
pretending otherwise teaches agents to route around the rules.

| # | Behavior | PROMPT | ENFORCE | Mechanism |
|---|---|---|---|---|
| 1 | Research/search before solving | ✅ Problem-solving protocol | **Partial — sequence rule**: `edit`/`write` into `src/` with no prior research call in the session window → warn (balanced) / prompt (protect) | existing `sequence` type; new rule id `research-before-edit` |
| 2 | First-principles thinking | ✅ protocol | ❌ unobservable — skip | — |
| 3 | Root cause before fix | ✅ protocol | ❌ semantic claim. **Enforce the partner**: source changes without a passing test are already gated (`source-change-requires-test`) — the test gate is the root-cause proxy: symptom patches rarely pass | exists |
| 4 | Cite sources with dates | ✅ protocol | ❌ unobservable | — |
| 5 | Check newest version when an error mentions one | ✅ Evidence & freshness | **Weak — warn-level command rule**: `npm install <pkg>@<version>` pins → warn "check what's current first" | `type: command, action: warn` |
| 6 | Don't circle / stuck escalation | ✅ Stuck protocol | **Yes — the strongest enforcement case**: identical-command repeat rule (3rd → warn, 5th → prompt with approval path) | new `stuck` type (§4.1) |
| 7 | Escalate to the user when stuck | ✅ protocol | **Partial**: `action: prompt` on the 5th repeat; high-stakes actions already surface approval paths | exists |
| 8 | Verify before claiming done | ✅ existing Verification culture | ✅ exists | `source-change-requires-test` + `no-skip-tests` |

Summary of new rules to add (all warn-first per the balance philosophy):
`research-before-edit` (sequence, warn), `no-repeat-loops` (stuck, warn →
prompt), `check-version-before-pin` (command, warn). Everything else stays
prompt-layer only.

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

#### `type: research` (freshness form) — "knowledge freshness" gate

Distinct from the research-before-solve obligation: this one fires when the
agent is about to act on **stale or missing knowledge**, not after a
failure. First-class `research` verdict (blocks like `prompt`, satisfier is
*research performed*):

```yaml
- id: freshness-openai-sdk
  type: research
  level: balanced
  action: research            # first-class verdict — blocks on first hit
  priority: 60
  topics:                     # matched against command args + reasoning
    - "openai[ -]?(sdk|python|node)|responses api"
  except:                     # same semantics as network rules' `except`
    - "openai.com/docs"       # already targeting an official doc domain
  max_age_hours: 24           # staleness horizon for the session cache
  message: "Research is stale for OpenAI SDK changes (last fetched >24h ago). Run keel_research {query} first."
```

Semantics:

- Evaluated like the network matcher: on topic match (command + reasoning)
  and no `except`, probe the session research cache; fresh evidence →
  allow; missing/stale → `research` directive.
- **Not subject to warn-once escalation** — like `prompt`, it blocks on
  the first hit; the satisfier is the research performed, not a second
  attempt. The directive is self-clearing on compliance.
- **Excluded from the Tier-1 allow-cache** (stateful per session) — a
  cached `allow` would let stale knowledge through forever.
- Integration: OpenCode plugin throws `[Keel] research required:
  <suggestion>`; MCP `keel_check` returns `isError: true` with the
  directive; gateway treats it as blocked; trace + signed receipt record
  `action: 'research'`.
- **v1/v2 satisfier gap**: the rule reads keel's cache. If the agent
  researches via Hermes `web_search` instead of `keel_research`, keel
  cannot see it. v1 = the directive always suggests `keel_research`/`keel_fetch`
  (strict, zero platform cooperation). v2 = a `research_completed { topic,
  source, fetched_at }` recording call so platform-native search satisfies
  the rule instead of bypassing it.



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

**Configuration (env only — never hardcoded, never persisted):**

| Env var | Purpose | Default |
|---|---|---|
| `KEEL_SEARCH_BACKEND` | `duckduckgo` \| `api` \| `none` | `duckduckgo` (keyless HTML endpoint) |
| `KEEL_SEARCH_API_URL` | Base URL for a custom search API (SearXNG, Tavily, Brave…) | unset |
| `KEEL_SEARCH_API_KEY` | Key for the custom backend — env-only, never written to disk or logs; add to the `no-credential-echo` vars | unset |
| `KEEL_RESEARCH_CACHE_DIR` | Cache override | `~/.keel/cache/` |
| `KEEL_RESEARCH_MAX_AGE_HOURS` | Default freshness horizon for rules that omit `max_age_hours` | `24` |
| `KEEL_RESEARCH_TIMEOUT_MS` | Total page/search timeout | `15000` |
| `KEEL_RESEARCH_MAX_BYTES` | Response cap before sanitization | `1048576` (1 MB) |
| `KEEL_RESEARCH_MAX_TEXT` | Sanitized text cap (≈ 15k tokens) | `60000` chars |

**Cache entry shape** (`~/.keel/cache/research/<session>/<sha256>.json`,
0600, atomic tmp+rename writes):

```ts
interface ResearchEntry {
  key: string                  // sha256(session_id, topic)
  topic: string                // normalized query or URL
  kind: 'search' | 'fetch'
  session_id: string
  fetched_at: number           // epoch ms — the freshness timestamp
  expires_at: number           // fetched_at + max_age (set at insert)
  results?: SearchResult[]     // search mode: { title, url, snippet, rank }
  text?: string                // fetch mode (sanitized)
  title?: string
  url?: string
  source: 'duckduckgo' | 'api' | 'platform'
  truncated: boolean
}
```

Per-session rate cap on `/v1/research` (default 20 ops/session, keyed
`research:<session_id>` via the StateManager rate pattern). Full results
never enter traces — only counts and topic tags.

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

**Global vs project division of labor:**

| Source | Carries | Example |
|---|---|---|
| `~/.keel/requirements.md` (global) | Universal protocols — problem-solving, stuck, evidence & freshness, identity, verification, dial | applies to every project |
| `<project>/.keel/requirements.md` (project) | Project-specific research surface — where the newest truth lives for THIS repo: canonical doc URLs, tracked API/package versions, known-stale files, project anti-circling notes | "This repo's truth: docs/API.md (2026-07); track `@auth/core` ≥ 0.40" |

**Dial-aware injection:** `[sprint]` = included at all levels, `[full]` =
excluded at sprint (sprint keeps only the first bullet of each protocol
section — the minimal anti-circling guardrails), untagged = included
everywhere. Implemented once in a shared `selectRequirements(sources,
level)` used by both the plugin and the daemon (one engine, thin clients).
The daemon's `/v1/requirements` also gains `?level=` filtering and
`?format=json` (`{ sections: [{ name, dial, lines }] }`) so Hermes/OpenClaw
clients inject byte-identical text with zero keel-specific logic.

**Authoring note (plugin behavior to respect):** `requirementLines()`
(plugin.ts:295-302) strips `#` headings, drops lines starting with `[` or
`<!--`, and flattens each file into one bullet list. Drafted text must
survive that — no content may depend on headings, and the `[` prefix is
reserved for the dial tags above. Project bullets don't visually override
global ones; use an explicit `(project)` prefix tag if needed (the `[`-form
is dropped).

**Session context card** (injected as a third block after requirements,
~14 lines, machine-derived, clearly labeled auto-generated so agents don't
mistake machine state for user instructions):

```markdown
## Session context (keel, auto-generated)
PROBLEM: <1 line — from `keel note` or first failing action; else "not provided">
ATTEMPTED: 3 edits to src/auth.ts · 4 test runs (12 pass / 1 fail) · 1 install
RULES HIT: no-force-push (deny ×1) · no-fix (warn ×2) · bash-rate-limit (warn ×1)
RESEARCH: 1 webfetch this session (no dated sources ≥ 2026-07)
FRESHNESS: @auth/core pinned 0.35 (lockfile) — registry shows 0.41 (2026-07-30)
STUCK: identical `npm test` ×3 — escalate: search → ask user → change approach
NEXT BEST STEP: webfetch @auth/core@0.41 changelog; re-check refresh handler
```

- `PROBLEM` — best-effort: `keel note <text>` writes
  `~/.keel/state/session-notes.json` keyed by session_id; else first
  denied/failed action; else "not provided".
- `ATTEMPTED` / `RULES HIT` / `RESEARCH` / `STUCK` — machine-derived from
  traces (counts per tool, per rule id, research-tool count,
  identical-command counter).
- `FRESHNESS` — best-effort from a small pinned-versions registry (`keel
  note` or project requirements entries); falls back to "no version info".
- `NEXT BEST STEP` — nudge from the STUCK row (search → ask → change
  approach); agents may ignore it.
- The plugin generates it offline from its own JSONL; the daemon is the
  canonical generator. `experimental.session.compacting` embeds the same
  selected content — compaction is exactly when the card is most needed.

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

### 6.1 Stuck detection algorithms (exact)

Input: per-session stream of **before-hook** entries, noise-filtered
(`hook === 'tool.execute.before'` AND `agent === 'opencode-plugin'`).
Fields used: `t`, `tool`, `args.command` (bash), `args.filePath`
(edit/write), `args.pattern` (grep), `args.query` (websearch), `args.url`
(webfetch), `rule_id`, `action`, `message`.

**Command normalization** ("identical" means *same failing attempt*, not
the same string — real data shows `git commit -m "fix: ..."` retried with
different messages):

```
normalize(cmd):
  1. collapse whitespace
  2. replace temp paths ($TMPDIR, /var/folders/.../T/) with <TMP>
  3. strip git commit -m "…" / -m '…' payloads → -m "<msg>"
  4. replace quoted strings longer than 12 chars → "<s>"
  5. replace hex runs ≥ 8 chars → <H>
  6. truncate to 160 chars

near_identical(a, b):
  normalize(a) == normalize(b)
  OR (len ≥ 40 AND Jaccard(token sets) ≥ 0.8)   # tokens: whitespace-split, len ≥ 3, stopwords dropped
```

**Pattern A — repeated identical/near-identical failing command:**
ring buffer of the last 20 before-hook calls per session; key
`(rule_id, normalize(command))` for bash calls with action ∈ {deny, warn,
prompt}; count within `min(20 calls, 30 min)`; count ≥ 3 → stuck,
count == 2 → pre-stuck. (Real-data evidence: a `git commit` denied 3× by
`source-change-requires-test`; a `TMP=$(mktemp -d) && mkdir …` denied 3×
by `verify-before-irreversible`.)

**Pattern B — churn (edit → test-fail → edit cycles):**
`churn_cycle(F) = edit(F) … testCmd … edit(F)` with ≤ 8 calls between the
edits and the same normalized `filePath` F; ≥ 2 cycles for the same F
(i.e. F edited ≥ 3 times with ≥ 2 interleaved test runs) → churn.
Test-command regex: `/npm|pnpm|yarn|bun|npx vitest|jest|pytest|go test/i`.
Fake-swallow regex (reuse `isFakeSatisfy`,
`verification.ts:101-108`): `--help|--list|--dry-run|--version`,
`|| true`, `; exit 0`, `| cat|tee|head|tail|grep|true`. (Real-data
evidence: 25 same-file edit→test→edit triples in one session.)

**Pattern C — no-progress:**
last 25 before-hook calls (or 10 min); `SOURCE_EDITS ≥ 6` AND no progress
event → no-progress. Progress = a non-fake test command, a research call
(websearch | webfetch | grep | glob), a question to the user (`question`
tool), or a write to a new file.

**Response ladder** (runs inside the plugin after `pipeline.evaluate`,
catches loops no rule fires on):

```
RESPOND(session, pattern, count):
  if count == 2 or 1 churn cycle or no-progress:
      surfaceWarn('stuck-loop', directive(count), session)   # once per session
  if count >= 3 or 2 churn cycles:
      if level == 'sprint': surfaceWarn('stuck-loop', directive(count), session)
      else:                 throw Error('[Keel] stuck-loop: ' + directive(count))

directive(count) = "You have retried the same command ${count} times against the same rule (${rule_id}). "
  + "This is a stuck loop. Stop retrying. SEARCH FIRST: use websearch/webfetch, read the project docs "
  + "and the blocking rule's message ('${rule_message}'), then either satisfy the rule or change approach. "
  + "Repeating the identical call will keep failing."
```

Counters reset on any progress event (passing test, research call,
command-cluster change). State: in-memory ring buffers per session,
persisted to `~/.keel/state/stuck.json` so loops survive restarts.

### 6.2 Offline post-mortem (per session)

`analyzeSession()` (used by `keel lessons`, `keel gather`,
`keel retrospective`):

- **Outcome classifier**: `success` (a non-fake test run followed by no
  same-file edit within the next 8 calls), `stuck` (Pattern A/B/C fired),
  `blocked` (last action ∈ {deny, block, prompt}), `interrupted`
  (anything else). The pass-heuristic is the fallback until exit codes
  land in traces.
- **Problem signature**: top-5 edited files (by count), top-3 rules among
  deny/warn/prompt, repeated normalized commands (count ≥ 3), topic =
  `rule-loop:<top rule>` | `churn:<top file>` | `general`.
- **Approaches & pivots**: sliding window of 5 calls; feature signature =
  {tool, file, cmd_family}; a **pivot** is where Jaccard(signature(w_i),
  signature(w_{i+1})) < 0.4; segments labeled by dominant activity
  (edit/test/search/read/mixed).

**Lessons v2 schema** (`~/.keel/lessons.json`, backward-compatible
envelope — existing `ExtractedLesson[]` core preserved; `lessons.ts` reads
accept `Array.isArray(data) ? data : data.sessions`):

```json
{
  "version": 2,
  "window": { "start": "2026-07-28", "end": "2026-08-03" },
  "sessions": [{
    "session_id": "ses_...", "project": "/path", "date": "2026-08-03",
    "outcome": "success",
    "problem_signature": { "topic": "rule-loop:source-change-requires-test",
      "files": [...], "rules": [...], "repeated_commands": ["git add -A && git commit -m <msg>"] },
    "stats": { "tool_calls": 2471, "attempts_to_success": 132, "stuck_loops": 1,
      "churn_cycles": 25, "pivots": 4, "time_to_first_search_s": 183,
      "research_before_edit": false },
    "approaches": [{ "start_t": ..., "end_t": ..., "label": "read", "calls": 14, "files": [] }],
    "pivot_points": [{ "t": ..., "from": "edit", "to": "search" }],
    "lessons": [{ "key": "research-before-edit", "text": "Edited before searching…", "confidence": 0.7 }]
  }],
  "aggregate": { "sessions": 41, "success": 22, "stuck": 6, "blocked": 4,
    "interrupted": 9, "stuck_rate": 0.15, "median_attempts_to_success": 47,
    "median_time_to_first_search_s": 120 }
}
```

**Lesson templates (only with evidence):** `research-before-edit` (first
edit precedes first research call), `stuck-loop` (Pattern A ≥ 1),
`no-pivot` (pivots == 0 AND stuck), `late-pivot` (pivots ≥ 2 AND stuck).
`keel gather` emits a problem-solving block inside the markers only when
evidence ≥ 2 sessions (or ≥ 1 stuck session), with counts:

```markdown
### Problem-solving
- Research before editing: sessions that searched first resolved in fewer attempts (median 6 vs 14 tool calls, 3 of 5 sessions this window).
- Do not retry an identical blocked command: 6 stuck loops observed; read the rule message and change approach instead.
- Switch approach after 2 failed attempts: 4 of 6 stuck sessions recovered after pivoting; sessions that never pivoted stayed stuck.
```

**Metric honesty note:** AUS/compliance can only *prove* improvement once
the same trace format persists across weeks; the lessons.json v2 envelope
change needs a CHANGELOG migration note.

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
| 6 | Start with P0 immediately (requirements.md) | ✅ shipped (2026-08-04) |
| 7 | Phase 1 — research capability: `/v1/research` + `/v1/research/cache`, `keel_research` / page-retrieval / `keel_search_cache` MCP tools, SSRF-hardened fetcher, `research` rule type + action + `topics`/`max_age_hours`, session cache | ✅ shipped (commit `59f398a`, 2026-08-04) |
| 8 | Phase 2 — workflow enforcement | 🔨 in progress |
| 8a | Phase 2a — `stuck` rule type, `redirect` action + directive, command fingerprinting, exit-code telemetry | ✅ shipped (commit `6ae6c07`, 2026-08-04) |
| 8b | Phase 2b — ProblemLedger + `keel_hypothesis`, `diagnosis` type, `/v1/outcome` | ✅ shipped (commit `d3aa821`, 2026-08-04) |
| 8c | Phase 2c — research-before-solve obligation (trigger/satisfy/boundaries with exit matcher) | ✅ shipped (commit `bcbeb86`, 2026-08-04) |
| 9 | Phase 3 — the learning loop (retrospective, metrics, lessons) | 🔨 next |
| 9a | Phase 3 (part) — `keel retrospective` with all eight §6 metrics; workflow lesson keys (`stuck-loop`, `no-research-before-solve`, `no-pivot`) wired through `keel gather` into the requirements.md markers | ✅ shipped (commit `a189931`, 2026-08-04) |
| 9b | Phase 3 review fixes landed in the same commit: after-hook records paired **positionally** (matching by fingerprint alone made every fail→pass run score as never verified — §6 metrics 1 and 6 were blind to exactly the recoveries they exist to count); project-scoped reports re-aggregate instead of printing all-projects numbers; stuck clusters bounded to §6.1's `min(20 calls, 30 min)` sliding window; pivot recovery anchored on the stuck cluster rather than on rule-less entries colliding at key `null:`; `lessons.ts` now shares the `redirect`-aware `VERDICTS` list; `lessons.ts:339` window-filter typo repaired (§2.1) | ✅ shipped (commit `a189931`, 2026-08-04) |
| 9c | Phase 3 **deferred** — declared in §5/§6/§11 but NOT built: week-over-week deltas, `keel postmortem` (`postmortem.ts` does not exist), lesson decay, lessons.json v2 reads. Recorded deviations: the retrospective uses exact fingerprints only (§6.1's `nearIdentical` Jaccard fallback unused); `--write` appends, so re-running a week duplicates its block | ⏳ open |
| 9d | **Rollout dependency (blocks exact metrics).** Verified 2026-08-04: 2,753 after-hook records across 2026-08-01..04 carry **zero** `exit` fields — the live `~/.opencode/plugins/keel-enforce.js` (18:15 build) predates Phase 2a's outcome telemetry (`recordAttemptOutcome` absent). Until `keel install --opencode` refreshes it, attempts-to-success and verification-completion read 0 on real traces regardless of this phase's correctness. Human-run; the agent's control gate blocks `keel install` | ✅ **resolved 2026-08-04 22:57** — user ran `keel install --opencode`; live plugin is now byte-identical to the canonical template and carries `recordAttemptOutcome`, `turnCounters`, `enforcedAction`, `observed_action` (282,623 → 300,081 bytes). Exit codes and turn numbers begin flowing into traces **after the next OpenCode restart**; `keel retrospective` stays uninformative until sessions run against the new build |
| 9e | **Correction to 9b.** A self-review found two of 9b's three fixes still wrong, both demonstrated against the built artifact rather than inferred. (i) Attempts-to-success scanned from index 0, so a suite run passing *before* the first source edit — the ordinary baseline-first workflow — produced a **negative** count and the real post-edit pass was never examined; the median across a baseline session and an honest one read **0.5**, an improvement that never happened. A pass now counts only after the first source edit, and a session with no source edit reports `null`. **Deviation from §6 metric 6** ("sessions with pass evidence"): that evidence must post-date the first edit, because a green run predating every edit verifies nothing. (ii) Pivot recovery anchored on whichever stuck cluster repeated first, crediting a session that broke one loop while still circling on another; every cluster is now evaluated. Also: dead `extractWorkflowLessons` export removed, trace agent filter widened to a list so Phase 4 clients are not silently absent. **Lesson: fixture tests confirm only the case you imagined — any metric over a sequence needs a multi-occurrence fixture.** | ✅ shipped (commit `9fd8f5a`, 2026-08-04) |
| 10 | Phase 4 — cross-platform thin clients (Hermes `pre_tool_call`, OpenClaw native TS plugin, OpenCode plugin daemon-first migration, `keel install --hermes/--openclaw`) | 🔨 next |
| 11 | **Cross-platform research (2026-08-04)** — verified: Claude Code, Cursor, Codex CLI, OpenClaw and Hermes **all fail open** when a pre-tool hook errors or times out (OpenClaw issue #20914 closed as stale, unfixed). A daemon-first shim therefore needs a **local circuit breaker**, or a daemon outage silently removes enforcement. Claude Code / Cursor / Codex converged on one stdin-JSON `PreToolUse` contract — one shim covers three platforms, better ROI than Hermes. Aider and Copilot cloud expose no pre-tool hook at all; MCP SEP-1763 is an unsponsored draft. Full brief: `docs/research/phase-4-cross-platform-2026-08-04.md` | 📋 recorded |
| 11a | **Foundations shipped (2026-08-04).** (a) `turn_number` telemetry is real — one model call = one turn, counted per session in the plugin and recorded in traces. This closes the §2.1 known bug and unblocks same-turn conjunction rules: with the constant 0, `flow-tracker.ts:52` collapsed every turn into one bucket, so a "secret read + network sink in the same turn" rule degraded to session-wide and would have generated false positives. Verified against the previous build, which recorded `turn_number: undefined`. (b) **Rule catalog metadata**: `category`/`severity`/`confidence`/`maturity`/`rationale`/`remediation`/`false_positives`/`review_by`, plus **`mode: observe \| warn \| block`** — an enforcement axis independent of `action`, so a rule can burn in against real traffic and be measured before it ever interrupts (Cloudflare WAF log mode, OPA Gatekeeper dryrun). `severity` and `confidence` are separate axes per Semgrep/Falco. Observe results carry `observed_action` for "would have blocked N times". All new enums validated at parse — a typo'd `mode` that silently enforced would be the worst failure shape a guardrail has | ✅ shipped (commit `2c6eb43`, 2026-08-04) |
| 12 | **Gaps found by external research (2026-08-04), not yet built** — (a) no **shadow/observe** rule state, though log-first rollout is universal practice (Cloudflare WAF, OPA Gatekeeper `dryrun→warn→deny`); `report` may already be the primitive. (b) Stuck detector counts identical fingerprints only, so it misses **A-B-A-B oscillation** and **semantic livelock** (25% of long-duration agent failures; one case burned 208 steps invisibly). Threshold of 3 is validated by the field — add detectors, don't loosen it. (c) No **reproduction-test-before-fix** gate, the strongest mechanically-checkable root-cause signal known (+30% plausible fixes, Google BRT, arXiv 2502.01821). (d) `turn_number` is still hardcoded 0 (`plugin.ts:308`), so `flow-tracker.ts:52` collapses every turn into one bucket — **same-turn conjunction rules are unshippable until that is fixed**. (e) Balance evidence: users approve **93%** of permission prompts (Anthropic telemetry) — adopt deny-and-continue, and track *actionable rate* as the fatigue indicator. | ⏳ open |

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

## 11. Implementation checklist (files touched)

| File | Change |
|---|---|
| `packages/core/src/types.ts` | `RuleType` + `research`/`stuck`/`diagnosis`; `EnforcementAction` + `redirect`/`research`; `RedirectDirective`; `VerificationMatcher.exit`; `EnforceInput.exit_code`/`attempt_id`; `EnforceResult.directive`/`attempt_id`; `AuditEntry` event fields; rule fields (`topics`, `freshness_seconds`, `max_age_hours`, `max_attempts`, `fingerprint`, `escalation`, `require_hypothesis`, `hypothesis_tools`, `fallback_tools`, `redirect_throttle_seconds`, `block_after_redirects`) |
| `packages/core/src/enforce/verification.ts` | factor `matches()`/`boundary()` into shared `boundary-match.ts`; add `exit` matching |
| `packages/core/src/enforce/research-tracker.ts` | new — mirrors VerificationTracker (research-before-solve) |
| `packages/core/src/enforce/stuck-tracker.ts` | new — fingerprint counting, escalation, reset-on-success |
| `packages/core/src/enforce/command-fingerprint.ts` | new — `commandFingerprint()` |
| `packages/core/src/enforce/problem-ledger.ts` | new — problems/evidence/hypotheses/plans, StateManager-persisted at `~/.keel/state/ledger.json` |
| `packages/core/src/enforce/research/{fetcher,search,research-cache,freshness}.ts` | new — SSRF-guarded fetch, backends, session cache, staleness |
| `packages/core/src/enforce/state-manager.ts` | + `research`, `stuck`, `ledger` stores (same atomic pattern) |
| `packages/core/src/enforce/pipeline.ts` | config + `researchTracker`/`stuckTracker`/`ledger`; new rule branches; `markResearchSatisfied`; `recordAttemptOutcome`; `researchDirective`; directive in `result()` |
| `packages/core/src/enforce/rule-parser.ts` | validate new types/actions/fields; `research` must NOT join `notImplemented` |
| `packages/core/src/enforce/audit.ts` / `audit-redaction.ts` | event fields; research-query scrubbing |
| `packages/core/src/enforce/index.ts` / `keel-core.ts` | export new trackers |
| `packages/cli/src/commands/daemon.ts` | `/v1/research`, `/v1/research/cache`, `/v1/context`, `/v1/stuck`, `/v1/outcome`, `/v1/plan`; `/v1/requirements` merge + dial filter + `?format=json` |
| `packages/cli/src/research/research-service.ts` | new — fetch + disk cache (daemon-side) |
| `packages/cli/src/mcp/daemon-client.ts` | 5+ new client fns |
| `packages/cli/src/mcp/server.ts` | 5+ new tool definitions + handlers |
| `packages/opencode-plugin/src/plugin.ts` | redirect + research surfacing; `/v1/outcome` reporting; exit/turn/cwd in records; dial-aware requirement selection; session context card injection |
| `packages/cli/src/commands/lessons.ts` | bug fixes (§2.1); `stuck-loop`/`research-before-edit`/pivot lessons; lessons.json v2 reads |
| `packages/cli/src/commands/gather.ts` | data-driven bullets; `keel:workflow` block; lesson decay |
| `packages/cli/src/commands/suggest.ts` / `watch.ts` | heuristic fixes (§2.1) |
| `packages/cli/src/commands/retrospective.ts` | new — weekly report; `keel postmortem` in `postmortem.ts` |
| `packages/cli/src/index.ts` | register `retrospective`, `postmortem`, `note` |
| `packages/cli/src/commands/install.ts` | `no-credential-echo` + `KEEL_SEARCH_API_KEY`; `--hermes`/`--openclaw` (Phase 4) |
| `docs/problem-solving-harness.md` | this document |

## 12. Honest boundaries (what this design does NOT solve)

- **It enforces workflow shape, not cognition.** An agent can record a
  garbage hypothesis and pass. The falsification loop (hypothesis →
  verification still fails → `status: falsified`) makes that visible and
  escalatable, but keel never judges the hypothesis content.
- **Same root cause, different files/symptoms is not detectable.** Churn
  is keyed on same-file edits; a root cause that manifests across files
  will be under-counted (Pattern B limitation).
- **No LLM synthesis.** Lessons are template-based; there is no
  natural-language root-cause analysis.
- **The redirect lever depends on the hook channel.** On platforms where
  keel runs only via MCP (no before-hook), redirects degrade to verdict
  text the agent reads after calling `keel_check` — guidance still works,
  enforcement of *interruption* doesn't.
- **Stuck detection is exit-code-dependent.** Agents that never run shell
  commands (pure MCP edits) are tracked via fix-attempt repetition instead
  — the `stuck` rule's `match` should list edit tools too when that is the
  target.
- **The loop detector counts identical fingerprints.** "Same problem,
  different command each time" is caught by the diagnosis obligation (no
  hypothesis before repeated destructive edits), not by fingerprint
  counting.
- **Trace redaction** (write content `[redacted]`, diffs truncated at
  2000 chars) limits edit-diff analysis.
- **Metrics need format stability.** AUS/compliance can only prove
  improvement once the same trace format persists across weeks.
