# Keel Enforce — Product Specification

**Version:** 1.0
**Date:** July 29, 2026
**Status:** Final — single source of truth for all product decisions

---

## 1. Product Overview

### One-Line Pitch
A deterministic enforcement layer for AI coding agents that makes your rules stick regardless of context length — reliable by default, smarter over time.

### Vision
Agents should follow your rules. Not because they remember them, but because they CAN'T bypass them. Keel enforces rules OUTSIDE the agent's context window — the agent can forget, but the enforcement still applies.


### Core Principles

| Principle | Meaning |
|-----------|---------|
| **Deterministic core** | Same input → same output. `keel test` is reproducible. Pipeline is ordered and predictable. No hidden state. |
| **Learning layer never actuates** | Learning layer observes, analyzes, suggests. NEVER writes to the rules file. The user decides. |
| **Never deny first time** | First violation of any rule is always `warn`. Escalate to `deny` on repeat. Requires in-process or persistent state to work across calls. One false positive erodes more trust than 100 correct denies build. |
| **Two mechanisms, one goal** | Voluntary (rules re-injected into context) + Involuntary (external interception via hooks/filesystem/process). Neither alone is sufficient. |
| **Customer Zero first** | Build for our own workflow first (OpenCode). Expand outward. |

### Who It Serves
- **Primary:** You (Customer Zero) — a developer who uses AI agents and needs hard enforcement of rules
- **Secondary:** Other developers using Claude Code, Cline, Cursor, Codex CLI, and similar agents
- **Tertiary:** CI/CD pipelines, team environments, multi-agent setups

---

## 2. Architecture

### High-Level Structure

```
┌──────────────────────────────────────────────────────────────┐
│                     LEARNING LAYER                           │
│  (reads audit log, analyzes patterns, suggests — never      │
│   modifies rules or enforcement behavior)                    │
│                                                              │
│  ┌────────────┐  ┌──────────┐  ┌────────────────┐           │
│  │ Trace      │  │ Pattern  │  │ Suggestion     │           │
│  │ Collector  │→│ Analyzer │→│ Engine          │           │
│  │ (audit log)│  │          │  │ (keel suggest)  │           │
│  └────────────┘  └──────────┘  └────────────────┘           │
└──────────────────────────────────────────────────────────────┘
                           │ user reviews & approves
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                     DETERMINISTIC CORE                        │
│  (unchanged by learning layer — user edits CLAUDE.md)        │
│                                                              │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Rules    │→│ Enforcement  │→│ Action   │→│ Audit   │ │
│  │ CLAUDE.md│  │ Pipeline     │  │ (allow/  │  │ Log     │ │
│  │ YAML     │  │ (7 tiers)    │  │ deny/warn│  │ JSONL   │ │
│  │ front-   │  │              │  │ /fix)    │  │         │ │
│  │ matter   │  │ Cache → Regex│  └──────────┘  └─────────┘ │
│  └──────────┘  │ → Path/Time  │                             │
│                │ → Rate → Con-│                             │
│                │ tent → Seq   │                             │
│                │ → Reasoning  │                             │
│                └──────────────┘                             │
└──────────────────────────────────────────────────────────────┘
```

### Two Layers, One Goal

| Layer | What | Survives context? | Mechanism |
|-------|------|-------------------|-----------|
| **Voluntary** | Rules re-injected into agent's context at strategic points | No — but helps the agent try | Token threshold monitoring, re-injection at 8K/16K/32K |
| **Involuntary** | External interception (hooks, filesystem, shell) | **Yes** — cannot be forgotten | Pre-execution hooks, OS-level enforcement, watchers |

Layer 2 is the differentiator. All existing tools (CLAUDE.md, AGENTS.md, .cursorrules) rely on Layer 1 only.

### Deterministic Guarantees

| Component | Guarantee |
|-----------|-----------|
| Rule evaluation | Same tool + same args + same rules = same verdict. Always. |
| Rule file format | CLAUDE.md YAML frontmatter. One schema. No hidden state. |
| Protection levels | sprint/balanced/protect have fixed rule sets. No auto-escalation. |
| Action cache | sha256(tool + args + rule_version) → same result every time. |
| `keel test` | Always returns the same result for the same input. Testable. |
| `keel validate` | Always reports the same conflicts for the same rules. |
| Tiered pipeline | Checks always run in the same order. Predictable performance. |
| Re-injection thresholds | Always fire at the same token counts. No adaptive thresholds by default. |

---

## 3. User Experience

### Commands

Status: ✅ = built, 🚧 = planned (spec'd but not implemented)

| Command | Status | Purpose |
|---------|--------|---------|
| `keel enforce` | ✅ | Activate enforcement for current session |
| `keel enforce --level=sprint|balanced|protect` | ✅ | Set protection level |
| `keel enforce --learn` | ✅ | Learning mode (observe only, never block) |
| `keel enforce init` | ✅ | Create sample CLAUDE.md with Keel rules |
| `keel enforce --audit` | ✅ | Show recent violations |
| `keel test "git push --force"` | ✅ | Dry-run an action against current rules |
| `keel test --from-audit <path> --new-rule <yaml>` | 🚧 | Test new rule against past trace (stub) |
| `keel validate` | ✅ | Check rules for conflicts, syntax, drift |
| `keel disable` | ✅ | Kill switch — suspend all enforcement |
| `keel enable` | ✅ | Re-enable after disable |
| `keel suggest` | ✅ | Analyze audit trail, suggest rule improvements |
| `keel allow <rule-id> --once` | ✅ | One-time override for a blocked action |
| `keel evaluate --tool <name> --args <json>` | ✅ | JSON-in/JSON-out for programmatic use |
| `keel lessons` | ✅ | Extract self-improvement lessons from audit logs |
| `keel watch` | ✅ | Live audit trail monitor |
| `keel install --opencode` | ✅ | Wire OpenCode plugin (global) + create default rules |
| `keel install --project` | ✅ | Wire OpenCode plugin + rules in current project |
| `keel install --claude-code` | ✅ | Wire Claude Code PreToolUse/PostToolUse hooks |
| `keel install --cline` | ✅ | Wire Cline (.clinerules + MCP check server) |
| `keel install --cursor` | ✅ | Wire Cursor (.cursor/rules advisory rules) |
| `keel install --codex` | ✅ | Wire Codex CLI (AGENTS.md instructions) |
| `keel gather` | ✅ | Distill audit history into standing requirements (marker-based) |
| `keel gather --apply-and-save` | ✅ | Append gathered rules to rules.yaml (after review) |
| `keel schedule daily\|weekly` | ✅ | Auto-run gather via launchd (macOS) / cron (Linux) |
| `keel schedule --remove` | ✅ | Remove the scheduled job |

### Protection Dial

Three knobs, independently adjustable:

**Knob 1: Rule Set**

| Level | Active rules |
|-------|-------------|
| `sprint` | Critical only (destructive commands, secrets, force push) |
| `balanced` | Standard (critical + file ops, network, git hygiene) |
| `protect` | All (everything + anomaly detection + behavioral patterns) |

**Knob 2: Action on match**

| Action | Effect |
|--------|--------|
| `report` | Log only, no user-visible feedback |
| `warn` | Show warning, do not block |
| `deny` | Block action, agent retries |
| `fix` | Modify arguments to make action safe (e.g., strip `--force`) |

**Knob 3: Enforcement Depth**

| Depth | Checks | Per-call overhead |
|-------|--------|-------------------|
| `fast` | Regex + allowlist cache + path check | ~0.01ms |
| `full` | Fast + content scan + git diff scan | ~1-10ms |
| `deep` | Full + LLM-based evaluation (rare) | ~1-10s (ambiguous cases only) |

**Default presets:**

```
protect:   rule_set=all      action=deny     depth=deep
balanced:  rule_set=standard action=deny     depth=full    (default)
sprint:    rule_set=critical action=warn     depth=fast
```

Overrides: `keel enforce --level=sprint --action=deny`

### Workflow

```
# First time in a project:
$ keel enforce init          # Creates CLAUDE.md with sample rules
$ keel validate              # Check for conflicts
$ keel test "git push --force"  # Verify rules work

# Daily use:
$ keel enforce --level=sprint   # Quick prototyping
$ keel enforce                  # Default (balanced)
$ keel enforce --level=protect  # Before deploy

# When a rule causes issues:
$ keel disable --until=3600     # Temporarily disable
$ keel allow never-force-push --once  # One-time override

# Learning:
$ keel enforce --learn          # Observe mode
$ keel suggest                  # Get improvement suggestions

# After making rule changes:
$ keel validate
$ keel test "rm -rf /src"
```

---

## 4. Rule System

### Format: `.keel/rules.yaml` (standalone YAML)

Rules are stored in `.keel/rules.yaml` (project-level) or `~/.keel/rules.yaml` (global). These files are read by the plugin OUTSIDE the agent's context window.

The same YAML format also works inside `AGENTS.md` (OpenCode) or `CLAUDE.md` (Claude Code) using YAML frontmatter, but the recommended approach is standalone `.keel/rules.yaml`:

```yaml
# ~/.keel/rules.yaml — Keel enforced rules
version: 1
level: balanced
rules:
  - id: never-force-push
    type: command
    match: "git push --force"
    action: deny
    level: sprint
    priority: 10
    message: "Never force push to git branches"

  - id: must-sign-commits
    type: command
    match: "git commit"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    message: "Auto-adding --signoff to commits"

  - id: no-external-network
    type: network
    match: "."
    except: [api.github.com, registry.npmjs.org]
    action: deny
    level: protect
    message: "Block external network except GitHub and npm"
```

### Rule Types

| Type | Description | Example |
|------|-------------|---------|
| `command` | Match shell commands | `match: "git push --force"` |
| `filesystem` | Restrict file operations | `paths: ["!/src/*"]`, `operations: [delete]` |
| `content` | Scan file contents | `patterns: [{regex: "GH_TOKEN"}]` |
| `env` | Protect environment variables | `vars: ["OPENAI_API_KEY"]` |
| `network` | Control egress | `match: "."` with `except: [github.com]` |
| `rate` | Rate limit tool calls | `window_seconds: 60`, `max_calls: 5` |
| `time` | Time-based restrictions | `schedule: {start: "09:00", end: "17:00"}` |
| `sequence` | Multi-step action patterns | `steps: [{tool: ReadFile}, {tool: HttpRequest}]` |
| `flow` | Information flow control | `sources: [".env"]`, `sinks: ["network"]` |
| `mcp` | MCP-specific threats | `mcp_check: tool_descriptions` |
| `session` | Session-level rules | `max_duration_minutes: 120` |
| `inheritance` | Subagent rule propagation | `propagate_rules: all` |
| `context` | Context management | Re-injection thresholds |

### Rule Fields (all rule types)

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier |
| `type` | Yes | Rule type from table above |
| `level` | No | `sprint` \| `balanced` \| `protect` (default: `balanced`) |
| `scope` | No | `global` \| `user` \| `project` \| `folder` \| `session` |
| `context` | No | `[local]` \| `[ci]` \| `[local, ci]` (default: both) |
| `action` | Yes | `report` \| `warn` \| `deny` \| `fix` |
| `message` | Yes | Human-readable description |
| `priority` | No | Higher = evaluated first (default: 0) |
| `unless_reasoning` | No | Regex — allow if agent's reasoning matches |
| `unless` | No | Array of `{regex}` patterns to exclude |

### Rule Hierarchy

```
~/.keel/rules.yaml           ← Global rules (all projects)
  ^ overridden by
project/.keel/rules.yaml     ← Keel-native project rules (committed)
  ^ overridden by
project/AGENTS.md            ← OpenCode rules (committed)
  ^ overridden by
project/CLAUDE.md            ← Legacy Claude Code rules (fallback)
  ^ overridden by
project/AGENTS.local.md      ← Local overrides (gitignored)
  ^ overridden by
project/CLAUDE.local.md      ← Legacy local overrides (fallback)
```

Priority: `.keel/rules.yaml` > `AGENTS.md` > `CLAUDE.md`. The system tries each path in order and uses the first one found. More specific scope wins for same rule id across levels.

**AGENTS.md is the recommended format for OpenCode users.** CLAUDE.md is only supported for Claude Code backward compatibility.

### Conflict Detection

`keel validate` reports:

```
✗ CONFLICT: no-external-network blocks all egress
  but must-sign-commits requires `git push`
  which needs network access to api.github.com
  → Rule "no-external-network" overrides "must-sign-commits"
  → Add api.github.com to no-external-network's except list
```

Conflicts are detected automatically on `keel validate` and shown as warnings during `keel enforce`.

### Versioning / Drift Detection

Auto-detect CLAUDE.md changes on every tool call. If hash changed since last check, re-parse rules and flush cache. Log the change.

```
$ keel validate
  CLAUDE.md: v3 → v4 (2 mins ago)
  Changes:
    + no-external-network (new rule)
    ~ no-install-without-approval (action: warn → deny)
  Cache: flushed (3 rules changed)
```

---

## 5. Enforcement Engine

### Tiered Pipeline

7 tiers, cheapest first. First definitive match short-circuits:

```
Agent calls tool
    │
    ▼
Tier 1: Session cache hit? ──Yes──▶ Return cached verdict (instant)
    │ No
    ▼
Tier 2: Regex blocklist match? ──Yes──▶ DENY (~0.01ms)
    │ No
    ▼
Tier 3: Simple conditional (path, tool name, time, MCP)? ──Yes──▶ DENY (~0.1ms)
    │ No
    ▼
Tier 4: Rate limit exceeded? ──Yes──▶ DENY (~0.01ms)
    │ No
    ▼
Tier 5: File content scan (only if changed)? ──Yes──▶ DENY (~1-10ms)
    │ No
    ▼
Tier 6: Sequence + flow violation? ──Yes──▶ DENY (~0.5ms)
    │ No
    ▼
Tier 7: Reasoning coherence check (agent-aware)? ──Flag──▶ WARN (~5-50ms)
    │ No
    ▼
Cache result as ALLOW → ALLOW
```

Tiers 6-7 only run in `deep` mode (protect level) or for ambiguous cases.

### Caching

**Session cache**: `sha256(tool + args + rule_version)` → verdict. After ~50 calls, 80-95% hit rate. LRU eviction at 10,000 entries. ~200 bytes per entry = ~2MB.

**Persistent cache**: Same mechanism, persisted to `~/.keel/cache/known-good.json`. Invalidated when rules change (detected by CLAUDE.md content hash).

**Content tracker**: Tracks file content hashes. Only re-scans files that changed since last check.

**Incremental checking**: Git operations only scan the diff (`git diff HEAD~1..HEAD`), not the entire repo. Gitleaks-style baseline support.

### Sequence Detection

Sliding window of recent actions (configurable, default 60s). On each new action, check if it completes any forbidden sequence:

```yaml
- id: no-leak-credentials
  type: sequence
  steps:
    - tool: ReadFile
      path: ".env"
    - tool: HttpRequest
  sequence_window_seconds: 30
  action: deny
```

Uses backward matching: current action = last step in sequence, walk backward through recent history matching preceding steps.

### Information Flow Control

Simplified version of Microsoft Fides. Tags data as it flows through tools:

1. When a tool reads a sensitive file (`.env`, `.ssh/`, `credentials`, `token`, etc.), tag the output data
2. When a network tool receives tagged data, flag as IFC violation
3. Tags are session-scoped, expire after 1000 entries

```yaml
- id: no-credential-egress
  type: flow
  sources:
    - path: ".env"
    - path: "*/.env"
  sinks:
    - network
  action: deny
```

### Context Hygiene (Supersedes Token-Threshold Re-Injection)

**Current approach (implemented July 30, 2026):** The plugin hooks `experimental.chat.system.transform` to inject standing requirements into the system prompt on EVERY turn. This is more effective than token-threshold re-injection because:

1. Requirements are present from turn 1, not just when a threshold is crossed
2. No "gap" between threshold crossings where requirements degrade
3. Also hooks `experimental.session.compacting` to embed requirements in compaction summaries

The `context-manager.ts` token-threshold system (re-inject at 8K/16K/32K) is preserved for agents/compatibility modes that don't support the per-turn injection hook.

| Mechanism | When it fires | Scope |
|-----------|--------------|-------|
| `experimental.chat.system.transform` (primary) | Every LLM turn | OpenCode only |
| `experimental.session.compacting` (backup) | Before session compression | OpenCode only |
| ContextManager token thresholds (legacy) | At 4K/8K/16K/32K tokens | All agents |

**Standing requirements file:** `~/.keel/requirements.md` — user writes their standing requirements. The plugin reads, converts to compact format, and injects.

### Rate Limiting

```yaml
- id: limit-installs
  type: rate
  match: "npm install"
  window_seconds: 60
  max_calls: 5
  action: deny
```

Scoped to session. Existing `RateLimit` type in codebase supports this.

### Time-Based Enforcement

```yaml
- id: no-after-hours
  type: time
  schedule:
    start: "09:00"
    end: "17:00"
    days: [Monday, Tuesday, Wednesday, Thursday, Friday]
  subjects:
    - patterns:
        - regex: "git push.*(production|main)"
  outside_schedule_action: prompt
```

Existing `TimeRule` type in codebase supports this.

### Auto-Fix / Argument Mutation

Instead of blocking, modify tool arguments to make them safe:

```yaml
- id: never-force-push
  type: command
  match: "git push --force"
  action: fix
  fix:
    - pattern: "--force"
      replace: ""
```

Returns the mutated command to the agent. Agent executes the safe version.

### Rego/OPA Backend (Optional)

For complex rules beyond YAML frontmatter capabilities. The codebase already has `packages/cli/src/rego-engine.ts`.

```rego
package keel
default allow := true
allow := false if {
    input.tool == "WriteFile"
    some path in ["/etc", "/usr", "/var"]
    startswith(input.args.path, path)
}
```

Compiled to WASM via `keel policy build`. Evaluated in sandboxed WASM runtime (~0.01ms overhead).

---

## 6. Per-Agent Integration

### OpenCode (Plugin-based)

Keel integrates as an **OpenCode plugin** that hooks into multiple lifecycle events:

```
Plugin hooks:
├─ experimental.chat.system.transform  → inject standing requirements every turn (Tier 1)
├─ experimental.session.compacting      → embed requirements in compaction summary (Tier 2)
├─ tool.execute.before                  → enforce rules on every tool call (Tier 3)
└─ audit trail                          → JSONL records for keel suggest/lessons/watch
```

The plugin is **self-contained** (only node builtins) so it runs unmodified in
OpenCode's Bun runtime. It does not import `@keel/core` — rule parsing and
warn-then-deny state are implemented inline. Enforcement state persists across
tool calls (in-memory closure) AND across processes (deny-first-time JSON in
`~/.keel/state/`, 24h TTL).

```javascript
// Actual hook implementation — canonical source:
// packages/cli/templates/keel-enforce.js
export default {
  id: 'keel-enforce',
  server: async (input) => {
    return {
      'tool.execute.before': async (input, output) => {
        // warn on first violation of a deny rule, deny on repeat
        // fix rules mutate output.args (e.g. git commit → git commit --signoff)
      },
      'experimental.chat.system.transform': async (input, output) => {
        output.system.push(requirementsBlock)   // every LLM turn
      },
      'experimental.session.compacting': async (input, output) => {
        output.context.push(requirementsBlock)  // survives compaction
      },
    }
  },
}
```

**Canonical source & install paths (verified 2026-07-30):**

```
packages/cli/templates/keel-enforce.js   ← single source of truth
  ├─ keel install --opencode  → ~/.opencode/plugins/keel-enforce.js   (global, all projects)
  ├─ keel install --project   → <project>/.opencode/plugins/keel-enforce.js
  └─ @keel/opencode-plugin    → dist/index.js (built verbatim from the template)
```

Global rules come from `~/.keel/rules.yaml`; if a project has
`<project>/.keel/rules.yaml`, its rules override global rules for the same id.
Both `~/.keel/requirements.md` and `<project>/.keel/requirements.md` are
injected into system prompts. If `rules.yaml` is missing, the plugin
self-bootstraps defaults (zero-config install).

**Verified behavior matrix (2026-07-30, live tests):**

| Hook / behavior | TUI | `opencode run` | `opencode serve` |
|---|---|---|---|
| Plugin auto-load (V1 format, `.js` only) | ✅ | ✅ | ✅ |
| `tool.execute.before` deny (throw blocks call) | ✅ | ✅ | ✅ |
| Warn→deny escalation across processes | ✅ | ✅ | ✅ (persisted state) |
| `experimental.chat.system.transform` per turn | ✅ | ✅ | ✅ |
| `experimental.session.compacting` | ✅ | ✅ | ✅ |
| Kill switch (`~/.keel/DISABLED`) | ✅ | ✅ | ✅ |

**Gotchas (from OpenCode source, dev branch):**
- Only `*.ts` / `*.js` files auto-load from plugin directories — `.mjs` is
  silently ignored (glob `{plugin,plugins}/*.{ts,js}`).
- File plugins MUST export `id` — OpenCode throws "Path plugin must export id"
  otherwise. The `export const` style in OpenCode docs is the legacy format.
- `--pure` flag disables all external plugins.
- Project config `opencode.json` with `"plugin": ["@keel/opencode-plugin"]`
  loads the npm package; both file and npm copies can be installed (they are
  treated as separate plugins).

**Installation:** `keel install --opencode` (global) or `keel install --project`
(project). No `opencode.json` entry needed for file plugins.

**Two-layer enforcement:**

| Layer | Mechanism | Enforced by |
|-------|-----------|-------------|
| Layer 1 | OpenCode bash permission patterns (`opencode.json`) | OpenCode's permission engine |
| Layer 2 | Keel plugin `tool.execute.before` | Keel's enforcement pipeline |
| Layer 3 | Standing requirements injection | Keel plugin via system.transform |

### Claude Code (Hooks)

`PreToolUse` hook calls `keel evaluate`. Returns `deny` or `allow`.

```bash
.claude/hooks/PreToolUse/keel-enforce
```

`PostToolUse` hook checks context tags and re-injects rules.

```bash
.claude/hooks/PostToolUse/keel-reinject
```

### Cline / Cursor / Codex CLI (Filesystem + Process Monitoring)

No blocking hooks available. Enforcement is detection-based:

| Watcher | Detection method |
|---------|-----------------|
| Filesystem | fswatch (macOS) / inotify (Linux) |
| Process | ps output / /proc scanning |
| Git | .git directory monitoring + gitleaks |

Detected violations are logged and alerted. Agent actions cannot be blocked — only caught after the fact.

### MCP Servers

Rules apply to MCP tool calls. MCP tool descriptions are treated as untrusted input — scanned for hidden instructions. Tool result changes mid-session detected and flagged.

```yaml
- id: no-mcp-injection
  type: mcp
  mcp_check: tool_descriptions
  action: warn
```

---

## 7. Learning System

### Architecture

```
Audit Log (JSONL) → Pattern Analyzer → Suggestion Engine → User Reviews
                                                              │
                                                     Approve ─┴─ Reject
                                                         │
                                                   User edits
                                                   .keel/rules.yaml
                                                   or AGENTS.md
```

**The learning layer NEVER modifies the rules file.** It only reads the audit log and produces suggestions for the user to review.

### Data Collected

Every enforcement decision records:

| Field | Description |
|-------|-------------|
| `session_id` | Unique session identifier |
| `timestamp` | When the action occurred |
| `turn_number` | Which turn in the session |
| `tool` | Tool name (Bash, ReadFile, WriteFile, etc.) |
| `args` | Tool arguments (sanitized for privacy) |
| `rule_id` | Which rule matched (null = no match) |
| `action` | allow \| deny \| warn \| fix |
| `level` | Protection level at time of check |
| `cache_hit` | Whether result came from cache |
| `duration_ms` | How long the check took |
| `context_tokens` | Approximate token count at time of check |
| `agent` | Which agent (opencode, claude-code, etc.) |
| `subagent_of` | Parent session (null if not a subagent) |

### Analysis Dimensions

| Dimension | What it detects | Suggests |
|-----------|----------------|----------|
| Rule fire rate | Which rules trigger most | Downgrade unused rules, upgrade hot rules |
| Override rate | Rules users override | Downgrade from deny → warn |
| Cache efficiency | Cache hit/miss ratio | Increase cache size, enable persistent |
| Violation hot spots | Token ranges with most violations | Adjust re-injection thresholds |
| Tool frequency | Most-called tools | Add rate limits |
| Action sequences | Common multi-step patterns | Add sequence rules |
| Data flow paths | File → network patterns | Add IFC rules |
| False positive rate | Denies that are overridden | Add exceptions, tune patterns |
| Level utilization | Whether protect mode catches anything unique | Adjust default level |

### Suggestion Output

```
$ keel suggest
Based on 47 sessions across 3 projects:

📊 Rule performance:
  never-force-push: fired 12 times, 0 false positives → keep at deny ✓
  no-external-network: fired 47 times, 41 were npm install
    → suggest adding registry.npmjs.org to except list

💡 New rule suggestions:
  "limit-npm-installs" — npm install called 15x avg/session
    → create rate limit rule? [y/N]
  "detect-read-after-config" — ReadFile(config) then HttpRequest
    → add sequence rule? [y/N]
```

### Suggestion Lifecycle

1. User runs `keel suggest`
2. Learning layer analyzes all trace data
3. Generates suggestions with confidence ratings
4. User reviews — approves or rejects each
5. Approved changes: user edits CLAUDE.md manually
6. Rejected changes: reason recorded for future tuning
7. Learning layer never bypasses step 5

---

## 8. Safety & Trust

### False Positive Protection

| Protection | Mechanism |
|-----------|-----------|
| Never deny first time | First violation of any rule → `warn`. Escalate to `deny` on repeat. |
| One-click override | Every deny includes `keel allow <rule-id> --once`. User overrides in 1 command. |
| Circuit breaker | If a rule fires 3+ times in 60s for same tool without user confirming, surface alert: "Agent is stuck. Approve once or investigate." |
| Show your work | Deny message includes: rule ID, exact match, file+line, how to fix, how to override. |
| Feedback loop | `keel feedback --false-positive` flags a deny for review. Tunes rules per-project. |

### Deny-and-Continue (from Anthropic)

```
Agent: git push --force origin main
Keel:  ⚠ Action blocked by rule "never-force-push"
       • Use `git push origin main` instead (no --force)
       • Override: `keel allow never-force-push --once`
       • First violation → warning. Next time will be blocked.
```

Agent retries with safe approach. Session continues.

### Kill Switch

```
$ keel disable                    # Disable all enforcement
  → All enforcement suspended. Will re-enable on next agent restart.

$ keel disable --until=3600       # Disable for 1 hour
  → Auto-enables at 14:30.

$ keel enable                     # Re-enable manually
```

Sentinel file at `~/.keel/DISABLED`. Expires automatically. Reset on restart.

### Lockup Escape

When the same rule denies the same tool 3+ times in 60 seconds:

```
⚠ Your agent is stuck trying to do "git push --force"
  It has been blocked 3 times in 60s by rule "never-force-push".
  ▶ Approve once: `keel allow never-force-push --once`
  ▶ Stop agent: interrupt with Ctrl+C
  ▶ Investigate: review CLAUDE.md rules
```

### Acceptable False Positive Rates

| Context | FP Rate Target | Reasoning |
|---------|---------------|-----------|
| Hard deny (no override) | <0.1% | Essentially never — reserved for catastrophic actions |
| Soft deny (one-click override) | <3% | Override is fast but still a friction point |
| First denial of any kind | 0% | Never deny an action the first time a rule fires |
| After user enables strict mode | <1% | User opted in, knows the risk |

### Why These Numbers

From research: a single false deny erodes more trust than 100 correct denies build. Users who experience a false positive disable the tool or seek alternatives. The system is designed to make false positives survivable and invisible.

---

## 9. Audit & Insights

### Audit Log

Format: JSONL, one entry per line. Stored at `~/.keel/traces/YYYY-MM-DD.jsonl`.

Entry fields (see Section 7 for full schema). Each entry is emitted synchronously after each enforcement decision.

### Viewing

```
$ keel enforce --audit
  Recent violations:
    [47]  git push --force → DENIED by never-force-push
    [32]  wrote to /etc/hosts → DETECTED by no-system-files (logged)
```

### Suggestion Engine

```
$ keel suggest                    # All sessions
$ keel suggest --since=2026-07-28  # Specific date
$ keel suggest --level=protect    # For specific protection level
```

### Versioning

Rules version tracked via content hash of CLAUDE.md. Each change is logged:

```
$ keel validate
  CLAUDE.md: v3 → v4
  Cache: flushed (rules changed)
```

---

## 10. Existing Code to Reuse

| File | Lines | Purpose |
|------|-------|---------|
| `packages/core/src/types.ts` | 328 | All types including new enforce types |
| `packages/core/src/policy-engine.ts` | 835 | Core policy evaluation (extend for agent-aware pipeline) |
| `packages/core/src/signing.ts` | 284 | Ed25519 signing (exported audit reports) |
| `packages/core/src/receipts.ts` | 216 | Action receipts (compliance exports) |
| `packages/cli/src/rego-engine.ts` | 231 | Rego/WASM policy evaluation (backdoor for complex rules) |
| `packages/cli/src/anomaly.ts` | — | Anomaly detection patterns (adapt for behavior) |
| `packages/cli/src/reasoning.ts` | — | Reasoning trace analysis (adapt for reasoning tier) |
| `packages/cli/src/commands/check.ts` | 199 | Existing check command (adapt for enforce) |
| `packages/cli/src/commands/audit.ts` | — | Existing audit command (extend for enforce) |
| `packages/cli/src/commands/evaluate.ts` | 71 | JSON-in/JSON-out enforcement evaluation |
| `packages/cli/src/commands/lessons.ts` | 350 | Self-improvement lesson extraction |
| `packages/cli/src/commands/watch.ts` | 100 | Live audit trail monitoring |
| `packages/cli/src/commands/install.ts` | 350 | Environment setup and plugin wiring |
| `packages/core/src/enforce/state-manager.ts` | 120 | Cross-process state persistence |
| `packages/core/src/keel-core.ts` | 27 | Bundle entry point for plugin |
| `packages/opencode-plugin/` | — | npm package `@keel/opencode-plugin` |
| `packages/cli/templates/opencode-plugin-v2.mjs` | — | Plugin template for install |
| `~/code/trading-claw/investing/lib/audit-trail-integrity.ts` | — | Audit trail integrity patterns to reference |

---

## 11. Build Plan

### Priority Tiers

**P0 — Critical safety (build first, before anything else)**

| # | Feature | Effort | Depends on |
|---|---------|--------|-----------|
| 1 | Kill switch (`keel disable` / `keel enable`) | 30 lines | None |
| 2 | Rule conflict detection (`keel validate`) | 80 lines | Rule parser |
| 3 | Dry-run / rule testing (`keel test`) | 60 lines | Enforcement pipeline |
| 4 | Learning mode (observe → suggest → enforce) | Extend existing | Audit log |
| 5 | Lockup escape (circuit breaker) | 60 lines | Pipeline |
| 13 | Agent reasoning awareness (WHY vs. WHAT) | 150 lines | Pipeline |

**P1 — Core enforcement (build in Phase 1)**

| # | Feature | Effort | Depends on |
|---|---------|--------|-----------|
| 6 | Sequence rules (multi-step) | 200 lines | Action history buffer |
| 7 | Information flow control | 300 lines | Data tagging infrastructure |
| 8 | Rule versioning / drift detection | 100 lines | Rule parser |
| 17 | Rego/OPA backend (wire existing rego-engine.ts) | 100 lines | Pipeline |
| 18 | Rich rule hierarchy (global → project → local) | 80 lines | Rule parser |
| 21 | CI/CD vs. local context awareness | 60 lines | Pipeline |

**P2 — Quality of life (Phase 1 or early Phase 2)**

| # | Feature | Effort | Depends on |
|---|---------|--------|-----------|
| 9 | MCP server threat model | 80 lines | MCP integration |
| 10 | Reference existing audit-trail-integrity.ts | 5 lines | None (documentation) |
| 14 | Rate limiting / quota enforcement | 80 lines | Pipeline (types exist) |
| 15 | Time-based enforcement | 50 lines | Pipeline (types exist) |
| 16 | Auto-fix / argument mutation | 120 lines | Pipeline |
| 20 | Session duration as risk signal | 50 lines | Context manager |

**P3 — Multi-agent and ecosystem (expand scope)**

| # | Feature | Effort | Depends on |
|---|---------|--------|-----------|
| 11 | ATR integration (768 rules) | npm install | Pipeline |
| 12 | Subagent rule propagation | 100 lines | Session management |
| 19 | Subagent edge cases (inheritance contracts) | 150 lines | Subagent integration |

### Build Phases

**Phase 1 — OpenCode Only (this week)**

| Day | Focus | Deliverables |
|-----|-------|-------------|
| 1 | Types + parser | Updated types.ts, rule-parser.ts |
| 1 | Pipeline base | pipeline.ts (Tiers 1-5), cache.ts |
| 2 | Pipeline advanced | sequencer.ts, flow-tracker.ts, context-manager.ts |
| 2 | Audit + CLI | audit.ts, enforce.ts CLI command |
| 3 | Commands | test.ts, validate.ts, disable.ts |
| 3 | Learning | suggester.ts, suggest.ts CLI command |
| 4 | OpenCode integration | Wire evaluateToolCall into OpenCode's tool dispatch |
| 4 | Your rules | Write CLAUDE.md for your projects |

**Phase 2 — Claude Code (following week)**

| Day | Focus | Deliverables |
|-----|-------|-------------|
| 5 | Hooks | PreToolUse hook script, PostToolUse re-injection |
| 5 | CLI | `keel evaluate` command (for hooks to call) |
| 6 | Audit viewer | Cross-agent audit log viewer |

**Phase 3 — Other agents (when needed)**

| Day | Focus | Deliverables |
|-----|-------|-------------|
| 7 | Watchers | Filesystem (fswatch), process, git |
| 7 | MCP | MCP threat model rules |
| 8 | Notifications | Desktop alerts on violations |

---

## 12. Research Appendix

### Round 1 — Context & Agent Behavior

| # | Source | Key Finding | Applied as |
|---|--------|-------------|-----------|
| 1 | Liu et al. 2023 "Lost in the Middle" | U-shaped attention curve, degradation at 8K-16K tokens | Re-injection at 8K/16K/32K thresholds. Dual injection (start + end). |
| 2 | Anthropic engineering blog | Context rot acknowledged. CLAUDE.md injected as user message. Compaction drops governance. | Rules re-read from disk after compaction. Code hooks for enforcement. |
| 3 | OpenAI Model Spec, IH-Challenge paper | Chain of command. Instruction hierarchy training (+10%). Reasoning models improve rule following. | Agent reasoning awareness (Gap 13). |
| 4 | Google Gemini 1.5 report, MMMT-IF | >99% NIAH retrieval at 10M. 22 point improvement when instructions at END. | Dual injection. Re-inject at end of context. |
| 5 | Greywall, Fence, Sandlock, seccomp, Landlock | OS-level sandboxing for AI agents exists (Linux). macOS has Seatbelt. | Hooks for OpenCode + Claude Code. Filesystem/process/git watchers. |
| 6 | Guardrails AI, NeMo, LangFuse | No tool combines sandboxing + enforcement + attestations. | Keel is the only tool doing tool-call-level enforcement. |
| 7 | MemGPT/Letta, re-prompting research | Non-evictable rule tier. Periodic re-injection. CoT with rule-checking. | Rich rule hierarchy. Rules never evicted from enforcement layer. |
| 8 | Claude Code GitHub issues, Reddit | ALL tools treat rules as advisory. No conflict detection. Compaction drops governance. | Machine-enforceable rules. Conflict detection (Gap 2). |
| 9 | HN, Reddit, Twitter (22 stories) | Deleted inboxes, published hit pieces, broke sandboxes, lied about results. | Deny-and-continue, circuit breaker, never deny first time, kill switch. |
| 10 | Agent forensics research | Audit trails, diff detection, shell monitoring, signed receipts exist. | JSONL audit log. Reference existing integrity checker. |

### Round 2 — Adversarial & Deep Dive

| # | Source | Key Finding | Applied as |
|---|--------|-------------|-----------|
| 11 | Anthropic auto mode, Clio | Three-tier containment. Strip agent reasoning from safety classifier. Clio privacy-preserving monitoring. | Self-learning architecture. Reasoning coherence check (Gap 13). |
| 12 | LangGraph, CrewAI, Temporal | Interrupts, guardrails, deterministic replay as enforcement patterns. | Interceptor pattern in OpenCode. Tiered pipeline. |
| 13 | Google ADK, OpenAI Agents SDK | ADK: best mutation (callbacks modify args). OpenAI: best guardrail abstraction (4 types). | Auto-fix/argument mutation (Gap 16). |
| 14 | AgentSpec (ICSE 2026), Fides (Microsoft) | 1-4ms overhead, 90%+ prevention. IFC prevents data leakage. | Sequence rules (Gap 6). IFC (Gap 7). |
| 15 | Nobulex, OWASP AST09 | Ed25519 + SHA-256 hash chain. Bilateral receipts for compliance. | Deferred to P3. |
| 16 | Pipelock, Clawdstrike, Vigils | Real products in this space. Pipelock (egress), Clawdstrike (kernel+agent fusion). | Keel's differentiator: hooks + egress + attestation + HITL combined. |
| 17 | MCP spec, OWASP MCP Top 10 draft | MCP has minimal security. Gateway layer is best hook point. | MCP threat model (Gap 9). Protocol-agnostic enforcement. |
| 18 | MS Copilot Studio, Google Vertex, AWS Bedrock | NO tool-call-level enforcement. NO custom behavioral rules. | Validates Keel's positioning. |
| 19 | Adversarial critique | Sidecar death, TOCTOU, compliance theater, sync nightmare. | Sidecar dropped. Ed25519 deferred. LLC via reasoning awareness. |
| 20 | ATR (768 rules), SPIFFE/SPIRE, OTEL | ATR: production at Microsoft+Cisco. SPIFFE: workload identity standard. | ATR integration (Gap 11). SPIFFE deferred (P3). |

### Round 3 — Protection Dial & Performance

| # | Source | Key Finding | Applied as |
|---|--------|-------------|-----------|
| 21 | OWASP CRS, ESLint, EDR | Paranoia levels (PL1-PL4). Off/warn/error trifecta. Slider with named tiers. | Three protection levels. Three knobs (rule set, action, depth). |
| 22 | AgentSpec benchmarks, hook latency | DSL checks: 1-4ms. Hooks: 1-5ms. LLM judges: 1-10s (avoid). | Tiered pipeline (cheapest first). Cache eliminates 80-95%. |
| 23 | Gitleaks baselines, OPA WASM | Baseline caching, incremental scanning, tiered cost pipeline. | Session cache + persistent store. Incremental checking. |
| 24 | Anthropic two-stage classifier | Fast: 8.5% FPR → thorough: 0.4% FPR. Deny-and-continue. | Tiered pipeline. Sprint skips content scans. |
| 25 | CrowdStrike, EDR false positive research | "Cry wolf" effect. Never deny first time. Circuit breakers. | Never deny first time. Circuit breaker. One-click override. |

### Round 4 — Gap Analysis (21 gaps + self-learning)

All 21 gaps documented in Section 11 with P0-P3 priorities. Self-learning architecture in Section 7.

### Deferred Items

| Topic | Why Deferred |
|-------|-------------|
| Formal verification (Lean 4) | Overkill for MVP. Core logic testable with unit tests. |
| Multi-tenant enterprise | Customer Zero is single developer. Defer to Phase 2/3. |
| Blockchain anchoring | Overengineering for personal use. Add if compliance requires. |
| TEE/confidential computing | Infrastructure complexity not justified for desktop tool. |
| 3-UID model (operator/proxy/agent) | OS-level process identity. Defer to Phase 3. |
| SPIFFE/SPIRE agent identity | Workload identity standard. Defer to multi-agent scenarios. |
| OTEL GenAI semantic conventions | Observability standard. Defer to Phase 3. |
| NIST AI 600-1 / EU AI Act mapping | Compliance frameworks. Defer to enterprise expansion. |

---

## 13. Key Decisions Log

| # | Date | Decision | Rationale |
|---|------|----------|-----------|
| 1 | 2026-07-29 | **Deterministic core + learning layer** | Reliability first. Learning layer never actuates. User retains control. |
| 2 | 2026-07-29 | **Never deny first time** | Research shows 1 false positive erodes more trust than 100 correct blocks build. |
| 3 | 2026-07-29 | **Two mechanisms, one goal** | Context re-injection (voluntary) + external enforcement (involuntary). Neither alone is sufficient. |
| 4 | 2026-07-29 | **Kill switch is P0** | CrowdStrike lesson: a faulty rule must be disable-able without rebooting. |
| 5 | 2026-07-29 | **CLAUDE.md with YAML frontmatter** (superseded by #15) | Compatible with existing tools. No new format to learn. Both sides stay in sync. Now superseded — `.keel/rules.yaml` is the primary format. |
| 6 | 2026-07-29 | **OpenCode first, then expand** | Customer Zero uses OpenCode. Build deepest integration for primary agent first. |
| 7 | 2026-07-29 | **No sidecar daemon** | Users won't install a daemon. History confirms this. Hook/plugin integration instead. |
| 8 | 2026-07-29 | **Sequence rules + IFC are P1** | Catches the most dangerous failure mode: "read .env then send to API." |
| 9 | 2026-07-29 | **Ed25519 deferred for local dev** | Signed receipts add compliance value for export, zero value for local debugging. |
| 10 | 2026-07-29 | **Three protection levels, not one** | Different contexts need different strictness. Sprint for speed, protect for safety. |
| 11 | 2026-07-29 | **Standing requirements ≠ Keel rules** | Requirements prevent wrong decisions (voluntary, system prompt). Rules catch wrong decisions (involuntary, tool dispatch). Both needed. |
| 12 | 2026-07-29 | **Plugin imports @keel/core in-process** | Subprocess model breaks state-dependent features (first-time warning, circuit breaker, rate limiting, sequences, cache). In-process fixes all at once. |
| 13 | 2026-07-29 | **Context hygiene via system.transform + session.compacting** | Proactive injection keeps requirements fresh every turn. Compaction survival prevents loss on context shrink. More effective than reactive re-injection at token thresholds. |
| 14 | 2026-07-29 | **Bug fixes first, then new system** | Fix what's broken before building new features. Prerequisite for reliable foundation. |
| 15 | 2026-07-29 | **AGENTS.md replaces CLAUDE.md as primary rule format** | OpenCode uses AGENTS.md. Rule parser hierarchy: `.keel/rules.yaml` > `AGENTS.md` > `CLAUDE.md` (CLAUDE.md kept as fallback for Claude Code users). |
| 16 | 2026-07-29 | **Session log appended to SPEC.md** | Capture failures and decisions from each session so the north star doc doesn't lose context. Every standing requirement is the result of a specific failure. |

---

## 14. Open Questions

| Question | Status |
|----------|--------|
| Should the learning layer support network effects (cross-user learning)? | Deferred. Customer Zero is single-user. |
| Should rules support conditional activation ("if rule X fires > N times, activate rule Y")? | Future enhancement. Not in scope. |
| Should audit logs support export to OTEL/SIEM? | Deferred to Phase 3. |
| Should Keel have a GUI dashboard? | Deferred. CLI + terminal UI sufficient for now. |

---

*This document is the single source of truth for the Keel Enforce product. All design decisions, features, and priorities are captured here. If it's not in this document, it's not part of the product.*

---

## 15. Standing Requirements System (Context Hygiene)

**Date:** July 30, 2026
**Status:** Implemented and verified — plugin injects standing requirements every turn, enforces rules at tool-call level

### Problem

The core problem is NOT which file format to use (CLAUDE.md vs AGENTS.md). The core problem is:

> **LLMs forget standing requirements that were stated early in a conversation, due to "Lost in the Middle" context degradation (Liu et al. 2023). Degradation starts at 8K-16K tokens. By turn 80+, early instructions are buried under ~50K tokens and ignored.**

This manifests as:
- Agent defaults to recently-accessed information over standing requirements (CLAUDE.md vs AGENTS.md)
- Agent claims completion without verification (build check ≠ test pass)
- Agent proposes patch-level fixes instead of root-cause fixes
- Agent chooses formats/conventions without asking the user

### Architecture

Three-tier defense, each addressing a different failure mode:

```
Tier 1 — Proactive Context Hygiene (plugin → system prompt)
  Hook: experimental.chat.system.transform
  Effect: Injects standing requirements into system prompt EVERY turn
  Catches: Agent forgetting requirements before making decisions
  Mechanism: Plugin reads .keel/requirements.md → compact prompt block → appended to output.system

Tier 2 — Compaction Survival (plugin → compaction prompt)
  Hook: experimental.session.compacting
  Effect: Embeds requirements in compaction summary
  Catches: Requirements lost when context is compressed
  Mechanism: Plugin appends requirements to output.context before LLM generates summary

Tier 3 — Reactive Enforcement (plugin → tool dispatch)
  Hook: tool.execute.before
  Effect: Blocks/warns/fixes violations at the tool call level
  Catches: Agent making wrong decision despite Tiers 1-2
  Mechanism: In-process EnforcementPipeline from @keel/core bundle
```

### Standing Requirements File

Location: `.keel/requirements.md`
Format: Markdown with sections. Each section becomes a compact prompt injection.

```markdown
# Standing Requirements

## Agent identity
- The primary agent is OpenCode. Use AGENTS.md for agent instructions.
- Never write to CLAUDE.md.

## Verification culture
- Before ANY "done" claim:
  1. Run the project's test command (e.g., `npm test`)
  2. Include the test output as evidence
  3. List what was changed and how each change was verified
- A compile check is NOT verification. Tests must pass.

## Decision-making
- When choosing a format, convention, or tool: ASK the user what they use.
- Before making naming/file-structure decisions, verify against user's stated preferences.

## Plan quality
- Before proposing a plan, identify what root causes it does NOT address.
- Distinguish between symptom patches and root-cause fixes.
- Be honest about what you have verified vs what you haven't tested.
```

The plugin reads this file, converts each line into a compact instruction, and injects it via `experimental.chat.system.transform` on every turn.

### Standing Requirements vs. Keel Rules

| | Standing Requirements | Keel Rules |
|---|---|---|
| Location | `.keil/requirements.md` | `.keil/rules.yaml` |
| Target | Agent's system prompt (voluntary) | Enforcement plugin (involuntary) |
| Mechanism | Plugin → system prompt injection | Plugin → tool.execute.before pipeline |
| Effect | Agent "remembers" what to do | Agent is blocked from doing wrong |
| Survives context? | Yes — re-injected every turn | Yes — external to context entirely |

Both are needed. Standing requirements PREVENT wrong decisions. Keel rules CATCH wrong decisions.

### Plugin Architecture (v2)

Instead of spawning `keel evaluate` as a subprocess (state doesn't persist between calls), the plugin:

1. Imports a bundled @keel/core (`keel-core.mjs`) directly in-process
2. Holds EnforcementPipeline state in plugin closure memory
3. All state persists between tool calls within the same OpenCode session
4. StateManager persists cross-session state to disk

This fixes:
- First-time warning (state persists → first call warns, second denies)
- Circuit breaker (accumulates denials across calls in same session)
- Rate limiting (tracks across calls)
- Sequence detection (action history persists across calls)
- Cache (avoids re-evaluating same tool call)

### Self-Improvement Loop

```
Agent actions → plugin records tool calls → audit log (JSONL)
                                              ↓
                                   keel suggest (pattern analysis)
                                              ↓
                                   Lessons extracted:
                                   - Claim without evidence
                                   - Build-not-test verification
                                   - Format default without asking
                                   - Context drift violations
                                              ↓
                                   User reviews → approves → new rules
                                              ↓
                                   Plugin picks up new rules next tool call
```

The loop closes. The system gets better over time.

### Key Metrics

| Metric | Target | How to measure |
|--------|--------|----------------|
| Requirements visible at turn 50+ | 100% turns with injection | Plugin logs each injection |
| Violations caught proactively (Tier 1) | >50% of potential violations | Compare injection count vs deny count |
| First-time warning effectiveness | 1st call warns, 2nd denies | `denyFirstTime` map in StateManager |
| Self-improvement cycle time | <1 week from pattern to rule | `keel suggest` → user approval → enforcement |

---

## 16. Session Log: 2026-07-29 — Context Degradation & Standing Requirements

**Session purpose:** Building Keel enforcement system. User acting as Customer Zero.

### Failures Observed

| # | Failure | Turn | Root Cause | Current Fix | Permanent Fix |
|---|---------|------|------------|-------------|---------------|
| 1 | Agent used CLAUDE.md despite user saying OpenCode uses AGENTS.md | 80+ | Standing requirement buried under ~50K tokens | User corrected agent | Context hygiene (Tier 1) — inject requirements every turn |
| 2 | Agent claimed bugs fixed after build passed (tests still failed) | Multiple | "Build = verification" pattern, no enforcement | User ran tests, found failures | `verify-before-claim` rule + requirement "test before claiming done" |
| 3 | Agent defaulted to CLAUDE.md format instead of asking | Multiple | Recently-accessed pattern > early instruction | User corrected | Requirement "ask before defaulting on format" |
| 4 | Agent proposed patch-level fixes for architectural issues | 100+ | Pattern of shallow problem-solving | User pushed back | Requirement "identify root causes not addressed" |
| 5 | First-time warning never graduated to denial | Architecture | Subprocess-per-call, state lost between calls | Persist state (bug fix) | In-process plugin (Phase 2) |
| 6 | `keel lessons` crashed on first run | Test | `require()` in ESM module | Fix import (bug fix) | N/A — one-line fix |
| 7 | `no-destructive-commands` rule never matched | Design | `^` anchors incompatible with JSON args | Remove `^` (bug fix) | Pipeline handles `args.command` extraction |

### Design Decisions Made

| # | Decision | Rationale |
|---|----------|-----------|
| 11 | 2026-07-29 | **Standing requirements ≠ Keel rules** | Requirements prevent wrong decisions (voluntary). Rules catch wrong decisions (involuntary). Both needed. |
| 12 | 2026-07-29 | **Plugin imports @keel/core in-process** | Subprocess model breaks all state-dependent features. In-process fixes all of them at once. |
| 13 | 2026-07-29 | **Context hygiene via system.transform + session.compacting** | Proactive injection keeps requirements fresh. Compaction survival prevents loss on context shrink. |
| 14 | 2026-07-29 | **Bug fixes first, then new system** | Fix what's broken before building new features. Prerequisite for everything else. |
| 15 | 2026-07-29 | **Self-improvement loop closes via keel suggest → user approval** | Learning layer never writes rules automatically. But the gap between detection and enforcement should be minimal. |
| 16 | 2026-07-29 | **AGENTS.md replaces CLAUDE.md as the rule file format** | OpenCode uses AGENTS.md, not CLAUDE.md. Rule parser hierarchy updated: `.keel/rules.yaml` > `AGENTS.md` > `CLAUDE.md`. |

### Execution Plan

```
Phase 1 — Bug fixes (immediate) ✅
  ├─ Fixed require() in lessons.ts
  ├─ Removed ^ anchors from destructive-commands rules (regex vs JSON args)
  ├─ Build + verify fixes
  └─ 55/55 tests pass

Phase 2 — In-process pipeline ✅
  ├─ Created @keel/core bundle entry point (keel-core.mjs)
  ├─ Discovered correct plugin format: export default { id, server }
  ├─ Plugin self-contained (no bundle dependency) — simpler and more reliable
  └─ State survives within session (plugin memory) and across sessions (StateManager)

Phase 3 — Context hygiene ✅ (see above)

Phase 3 — Context hygiene ✅
  ├─ Created .keel/requirements.md (draft from this session)
  ├─ Context injector built into plugin (no separate file needed)
  ├─ Added system.transform + session.compacting hooks to plugin
  └─ Requirements injected every turn, survive compaction

Phase 4 — StateManager (cross-session state) ✅
  ├─ Created state-manager.ts
  ├─ Integrated into EnforcementPipeline
  └─ Integrated into self-contained plugin (denyFirstTime persists across sessions)

Phase 5 — Self-improvement loop (implemented 2026-07-30)
  ├─ keel lessons works (fixed in Phase 1)
  ├─ keel suggest works with lesson extraction integrated
  ├─ keel watch — live audit monitor
  ├─ keel gather — BUILT: distills audit history into requirements.md between
  │   keel:gather markers (user-authored sections preserved). --apply prints
  │   proposed rules; --apply-and-save appends after review.
  └─ Automated scheduling — BUILT: keel schedule daily|weekly installs a
      launchd (macOS) / cron (Linux) job running `keel gather --since 7`.

Multi-harness (implemented 2026-07-30):
  ├─ keel install --claude-code — PreToolUse (keel evaluate, exit 2 = deny)
  │   + PostToolUse (requirements re-injection). TRUE blocking.
  ├─ keel install --cline — .clinerules + keel MCP server (advisory)
  ├─ keel install --cursor — .cursor/rules/keel.mdc (advisory)
  └─ keel install --codex — AGENTS.md instructions section (advisory)
```

### Standing Requirements (Draft, from this session)

Extracted verbatim from conversation. These will go into `.keel/requirements.md`:

```
1. OpenCode is the primary agent. Use AGENTS.md for agent instructions. Never write to CLAUDE.md.
2. Before ANY "done" claim: run npm test, include output as evidence.
3. A compile check is NOT verification. Tests must pass.
4. When choosing a format/convention: ASK the user. Never default.
5. Product name is "keel". Never "ai-enforce".
6. Before proposing a plan: identify what root causes it does NOT address.
7. Distinguish between symptom patches and root-cause fixes.
8. Be honest about what you've verified vs what you haven't tested.
9. At 16K+ tokens, re-check standing requirements — they degrade from context.
```

---
