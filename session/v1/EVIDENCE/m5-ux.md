# M5-UX — adoption surface (E1 onboarding + E2 report)

Lane: `v1-m5-ux`, worktree `/Users/nanoclaw/code/keel-v1-m5-ux`. All commands
below run against the real built CLI (`packages/cli/dist/index.js`) with
`HOME` redirected to scratch directories under
`/private/tmp/claude-501/.../scratchpad/m5ux/` — never the real
`~/.claude`/`~/.keel`.

## Summary of changes

- `packages/cli/src/commands/scan.ts` — once a host is genuinely enforced,
  scan now points at `keel report` ("Run `keel report` to see what keel has
  caught so far") instead of ending on a bare "no risks / N findings" list.
  Only fires when `protection.some(p => p.enforced)`, so it never dangles a
  reference to a report that would be empty.
- `packages/cli/src/commands/install.ts` — the "Next steps" list gained a
  4th line closing the scan → install loop: "Run `keel scan` again — it
  should now show this host as ✓ enforced." Minimal, additive, own comment
  block, does not touch `KEEL_HOME` resolution. Gated on `wiredAnyHost`
  (see "Caught in review" below — a bare `keel install` wires no host at
  all, and the line must not print then).
- `packages/cli/src/commands/retrospective.ts` — added `computeActionSummary()`
  (new exported function + `ActionSummary`/`RuleTally` types). Tallies raw
  enforcement action counts (blocked / warned / redirected / observe-fires)
  from the same trace stream and `isBefore`/`TRACKED_AGENTS` filter every
  other metric in this file already uses, so `keel report` and
  `keel retrospective` can never silently disagree on what counts as a real
  evaluation. No existing function's behavior changed.
- `packages/cli/src/commands/report.ts` — **new** `keel report` command:
  "what did keel do for you" — blocks/warns/redirects/observe-fires plus
  promotion candidates, over a session (`--session <id>`) or a week
  (default `--since`, last 7 days). Reuses `loadTraceEntries`,
  `computeActionSummary`, `computePromotionReport`, `collectObserveRuleIds`
  from retrospective.ts rather than re-deriving anything.
- `packages/cli/src/index.ts` — wired `keel report` (new command, new
  import). No existing command touched.

Generated code (`packages/cli/src/core/**`, `templates/keel-enforce.js`) was
never hand-edited — only rebuilt via `npm run build` from source.

---

## Caught in review (advisor pass) — two real bugs, fixed and tested

An advisor review of the first cut of this work caught two problems before
they shipped. Both are fixed, both now have a regression test, and both are
reflected in the sections below.

**1. A bare `keel install` (no flags) lied about what it had done.**
`installCommand`'s host blocks are all `if (options.X || options.all)`, and
commander does **not** default `--all` to `true` despite its help text
saying "(default)" — so `keel install` with zero flags wires no host at
all; it only creates `~/.keel/rules.yaml` and `traces/`. The first cut of
the step-4 line printed unconditionally, so a user running bare
`keel install` would be told to re-run `keel scan` and expect to see a host
enforced that was never wired. Verified before the fix:

```
$ HOME=<fresh> keel install     # no flags
  ✓ Created ~/.keel/rules.yaml
  ✓ Ensured ~/.keel/traces/ exists

  Next steps:
    1. Review ~/.keel/rules.yaml and customize
    2. Run `keel install --opencode` to wire the OpenCode plugin
    3. Run `keel validate` to check for conflicts
    4. Run `keel scan` again — it should now show this host as ✓ enforced   ← FALSE
```

Fixed by gating the line on `wiredAnyHost` — the same disjunction that
actually gates every host-install call. Verified after the fix (same
command, no flags):

```
  Next steps:
    1. Review ~/.keel/rules.yaml and customize
    2. Run `keel install --opencode` to wire the OpenCode plugin
    3. Run `keel validate` to check for conflicts
```

No line 4. `keel install --claude-code` (an actual host) still shows it —
captured in Step 2 of the walkthrough below. Regression test:
`scan-install-flow.test.ts` → "a bare `keel install` (no flags) wires no
host and must not claim scan will now show one enforced".

**2. The "eligible for promotion" render path had never actually rendered.**
E2 names four things: blocks / warns / observe-fires / **promotion
candidates**. The first cut's `report.test.ts` only unit-tested
`computePromotionReport`'s math (agrees with `computeActionSummary` on the
denominator) — every captured CLI sample happened to have `"promotion": []`,
so the `eligible.length > 0` branch in `report.ts` (the actual "N rules
eligible for promotion" + "Promote with: `keel promote`" text) had zero
test coverage and zero real output ever observed. Fixed by adding a
CLI-level test that writes a real project `.keel/rules.yaml` (one
`mode: observe` rule, `promotion_fp_threshold: 0.5` so `minEvaluations`
is only 2 — no need to fabricate 1000+ trace lines) plus a handful of
non-blocking observe-matches, spawns the real CLI, and asserts on the
actual "eligible for promotion" text and the `--json` payload's
`recommendation: "eligible"`. Sample output is captured in E2 below.

While building that fixture, one more thing surfaced worth deciding
explicitly rather than silently: `reportCommand` scopes `mode: observe`
promotion candidates by `process.cwd()` (which rules.yaml hierarchy is
"active"), not by `--project` (which only filters the trace entries).
This exactly mirrors `retrospectiveCommand`'s existing behavior — kept
that way on purpose so the two commands never disagree on the same trace
file — and is now called out in a code comment in `report.ts` plus noted
under E2 below, rather than left as an undocumented surprise.

---

## E1 — onboarding walkthrough: scan → install → scan

Fixture: fake `$HOME` with claude-code's real on-disk MCP config shape
(`~/.claude.json`'s `projects.<path>.mcpServers`) carrying one unpinned
`npx` server (`weather-mcp-server`, no version pin — the exact
slopsquatting/dependency-confusion vector `assessRisk` exists to catch), and
a project directory with no keel install yet.

### Step 1 — `keel scan` (before install)

```
keel scan — auditing this machine's AI agent setup

  Scanning: .../m5ux/walkthrough-project

  Found 1 AI coding assistant(s):

  claude-code
    Config files: 1
      .../m5ux/walkthrough-home/.claude.json
    MCP servers: 2
      - weather (stdio:npx)
      - internal-api (http:http://internal.example.com:8080/mcp)

  Enforcement coverage

    ✗ unprotected  claude-code

  3 findings

     HIGH    MCP server installs an unpinned package at launch
     claude-code → MCP server "weather": npx -y weather-mcp-server
     → Pin the version (e.g. weather-mcp-server@1.2.3). Unpinned runners resolve to whatever is newest at launch, which is the slopsquatting and dependency-confusion vector.

     HIGH    MCP server uses an unencrypted transport
     claude-code → MCP server "internal-api": http://internal.example.com:8080/mcp
     → Use https:// (or wss://). Tool arguments and results — which routinely include file contents and credentials — travel over this connection in cleartext.

     HIGH    1 agent host can run tools with no enforcement
     claude-code
     → Run `keel install --all` (or `--<host>` individually). Until then nothing stops these agents from running a destructive command.

  MCP servers execute commands on your machine with your privileges.

SCAN EXIT=0
```

Genuine findings, each with evidence (the actual config line) and a concrete
remediation. No "no risks found" fabrication needed — this repo/host
combination really is unpinned and unencrypted. No `keel report` pointer
yet, correctly, since nothing is enforced.

### Step 2 — `keel install --claude-code`

```
  ✓ Created ~/.keel/rules.yaml
  ✓ Ensured ~/.keel/traces/ exists
  ✓ Installed PreToolUse hook → .../walkthrough-project/.claude/hooks/PreToolUse/keel-enforce
  ✓ Installed PostToolUse hook → .../walkthrough-project/.claude/hooks/PostToolUse/keel-reinject
  ✓ Installed PostToolUse verify hook → .../walkthrough-project/.claude/hooks/PostToolUse/keel-verify
  ✓ Installed Stop hook → .../walkthrough-project/.claude/hooks/Stop/keel-claim
  ✓ Registered hooks in .../walkthrough-project/.claude/settings.json

  Next steps:
    1. Review ~/.keel/rules.yaml and customize
    2. Restart Claude Code for the hooks to take effect
    3. Run `keel validate` to check for conflicts
    4. Run `keel scan` again — it should now show this host as ✓ enforced

INSTALL EXIT=0
```

Line 4 is the new close-the-loop message.

### Step 3 — `keel scan` (after install)

```
keel scan — auditing this machine's AI agent setup

  Scanning: .../m5ux/walkthrough-project

  Found 1 AI coding assistant(s):

  claude-code
    Config files: 1
      .../m5ux/walkthrough-home/.claude.json
    MCP servers: 2
      - weather (stdio:npx)
      - internal-api (http:http://internal.example.com:8080/mcp)

  Enforcement coverage

    ✓ enforced     claude-code
                   .../walkthrough-project/.claude/hooks/PreToolUse/keel-enforce

  2 findings

     HIGH    MCP server installs an unpinned package at launch
     claude-code → MCP server "weather": npx -y weather-mcp-server
     → Pin the version (e.g. weather-mcp-server@1.2.3). Unpinned runners resolve to whatever is newest at launch, which is the slopsquatting and dependency-confusion vector.

     HIGH    MCP server uses an unencrypted transport
     claude-code → MCP server "internal-api": http://internal.example.com:8080/mcp
     → Use https:// (or wss://). Tool arguments and results — which routinely include file contents and credentials — travel over this connection in cleartext.

  MCP servers execute commands on your machine with your privileges.

  Run `keel report` to see what keel has caught so far.

SCAN EXIT=0
```

The loop closes visibly: `✗ unprotected` → `✓ enforced`, the
`agent-unprotected` finding disappears (the two MCP findings install
legitimately cannot fix — the config itself is still unpinned/plaintext —
correctly remain), and the new `keel report` pointer appears now that
there's something real to report on.

### Clean-repo control (no fabricated findings)

```
$ HOME=<empty-fake-home> keel scan --dir <clean-repo>
keel scan — auditing this machine's AI agent setup

  Scanning: .../m5ux/clean-repo

  No AI coding assistants detected on this machine.

  No risks found.

EXIT=0
```

No agent hosts, no invented findings — confirms scan stays honest on a
genuinely clean machine rather than manufacturing noise.

### Test coverage

New: `packages/cli/src/__tests__/scan-install-flow.test.ts` — spawns the
real CLI (not in-process) through the full loop above and asserts:
unprotected + evidence + remediation before install; the hook file actually
lands on disk and install prints the verify-with-scan line; scan flips to
enforced, drops the fixed finding, keeps the still-real MCP finding, and
only now shows the `keel report` pointer. Second test asserts `keel report`
on a home with zero traces states "No enforcement traces in this window"
honestly rather than printing a look-alike zero table.

---

## E2 — `keel report`: what did keel do for you

### Sample: mixed window (deny, warn, and two observe-mode matches on one call)

```
  ⚓ keel report — what keel did for you
  2026-08-05 → 2026-08-12

  4 tool calls evaluated across 2 session(s)

  blocked        1  25.0%
  warned        1  25.0%
  redirected    0  0.0%
  observed      2  (mode: observe — shadow-recorded, never blocked)

  Most active blocking/redirect rules
    no-verify-commits             1×

  Most active warning rules
    no-destructive-rm             1×

  Most active observe rules
    observe-large-diff            2×
```

### `--json`

```json
{
  "window": { "start": "2026-08-05", "end": "2026-08-12" },
  "sessions": 2,
  "action_summary": {
    "total_evaluations": 4,
    "blocked": 1,
    "warned": 1,
    "redirected": 0,
    "observe_fires": 2,
    "top_blocking_rules": [{ "rule_id": "no-verify-commits", "count": 1 }],
    "top_warning_rules": [{ "rule_id": "no-destructive-rm", "count": 1 }],
    "top_observe_rules": [{ "rule_id": "observe-large-diff", "count": 2 }]
  },
  "promotion": []
}
```

`promotion` is empty here because this fixture's project has no
`mode: observe` rules configured — not because promotion candidates never
render. See the dedicated sample right after the empty-window check below
for a case where a rule actually clears its threshold.

### `--session s2` (single-session scope)

```
  ⚓ keel report — what keel did for you
  2026-08-05 → 2026-08-12  session: s2

  2 tool calls evaluated across 1 session(s)

  blocked        0  0.0%
  warned        0  0.0%
  redirected    0  0.0%
  observed      2  (mode: observe — shadow-recorded, never blocked)

  Most active observe rules
    observe-large-diff            2×
```

### Empty window (honesty check — no fabricated summary)

```
  ⚓ keel report — what keel did for you
  2026-08-05 → 2026-08-12

  No enforcement traces in this window.
  Nothing to report yet — keel records a trace every time an installed
  hook evaluates a tool call. Run an agent session, or widen --since.
```

### Promotion candidates actually rendering

Fixture: a real project `.keel/rules.yaml` with one `mode: observe` rule
(`observe-candidate`) and a loosened `promotion_fp_threshold: 0.5` (so only
2 evaluations are needed to trust the rate — no need to fabricate 1000+
trace lines), plus 3 synthetic evaluations, all non-blocking:

```
  ⚓ keel report — what keel did for you
  2026-08-05 → 2026-08-12

  3 tool calls evaluated across 1 session(s)

  blocked        0  0.0%
  warned        0  0.0%
  redirected    0  0.0%
  observed      3  (mode: observe — shadow-recorded, never blocked)

  Most active observe rules
    observe-candidate             3×

  1 rule eligible for promotion:
    observe-candidate             0 would-block(s) in 3 evals, this project (0.000%) — eligible for promotion to warn
    Promote with: keel promote <rule-id> (run from your own terminal — never through the agent)
```

This is the branch the first cut of this lane never actually exercised
(see "Caught in review" above) — now covered by a CLI-level test that
spawns the real binary against this exact fixture and asserts on this
exact text plus the `--json` payload's `recommendation: "eligible"`.

### Test coverage

New: `packages/cli/src/__tests__/report.test.ts` — unit tests against
`computeActionSummary()` (blocked/warned/redirected bucketing, observe-fires
counting that prefers the comprehensive `observed_matches` list over the
legacy single-slot field and does not double count, untracked-agent
filtering matching `isBefore` everywhere else in this file, honest
all-zero output on an empty window, top-5 ranking) and `buildReportPayload`
scoping (by session id, by project cwd substring). One cross-check asserts
`computeActionSummary` and `computePromotionReport` agree on the evaluation
denominator for the same entries, since a silent mismatch there would make
`keel report` and `keel retrospective` tell two different stories from the
same trace file. A CLI-level test (spawns the real binary, not in-process)
exercises the promotion-eligible render path shown above end to end,
including the `--json` payload.

`keel retrospective` itself is unchanged — `keel report` is a separate,
narrower, more discoverable surface for the literal "what did keel do for
me" question; the deeper session-productivity metrics
(attempts-to-success, stuck loops, churn) stay in `retrospective`.

---

## Full test suite (npm test, output shown, not piped)

Final run, after both fixes from the advisor pass:

```
> @get-keel/core@0.4.0 test
 Test Files  34 passed (34)
      Tests  597 passed | 2 skipped (599)

> @get-keel/cli@0.4.0 test
 Test Files  46 passed (46)
      Tests  825 passed | 14 skipped (839)

> @get-keel/mcp-server@0.4.0 test
 Test Files  1 passed (1)
      Tests  6 passed (6)

> @get-keel/opencode-plugin@0.4.0 test
All checks passed (63/63)
```

Baseline before any change (captured at the start of this lane): CLI 810
passed | 15 skipped (44 files, 825 total). Now: 825 passed | 14 skipped
(46 files, 839 total) — net +14 tests, matching the two new files exactly
(`scan-install-flow.test.ts`: 3 tests, `report.test.ts`: 11 tests). The
skip count moving 15→14 is `perf-budget.test.ts`'s own machine-load skip
guard, unrelated to this diff. Zero regressions, zero failures.

One transient failure was observed on an earlier full-suite run before the
promotion-eligible test existed: `perf-budget.test.ts`'s p99 hot-path
latency assertion, caused by machine load during the parallel 46-file run
(the test's own diagnostic reported 14.1/16 cores load average). Re-run in
isolation: 2/2 passed. That file imports only from the core enforcement
pipeline and `node:os`/`node:fs` — nothing in this lane's diff touches it.
The final run above is clean end to end with no such contention.
