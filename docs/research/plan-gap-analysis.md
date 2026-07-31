# Plan Gap Analysis — Auditing 35 Research Agents Against the Implementation Plan

**Date:** July 29, 2026
**Purpose:** Identify everything the research found that the implementation plan is missing, underweighting, or getting wrong.

---

## Coverage Map

| Research Round | Agents | Findings Fully in Plan | Partially | Missing |
|---------------|--------|----------------------|-----------|---------|
| **1. Context & Agents** | 10 | 4 | 3 | 3 |
| **2. Adversarial & Deep Dive** | 10 | 1 | 2 | 7 |
| **3. Protection Dial** | 5 | 5 | 0 | 0 |
| **Total** | **25** | **10** | **5** | **10** |

---

## CRITICAL GAPS (Must Fix)

### Gap 1: No Kill Switch / Emergency Escape

**Found by:** Adversarial agent #9 (CrowdStrike postmortem), false positive research

**The problem:** If Keel's enforcement causes a problem (blocks a legitimate action, enters a crash loop, a rule update breaks the workflow), how does the user disable it? The CrowdStrike 2024 global outage ($5.4B in losses) was caused by a faulty security rule with no way to roll back remotely.

**What the plan says:** Nothing.

**What should be there:**

```
$ keel disable           # Disable all enforcement immediately
$ keel enable            # Re-enable
$ keel disable --until=3600  # Disable for 1 hour (for demos, etc.)
```

The kill switch must:
- Be a SINGLE command (no flags to remember)
- Work even if the config file is corrupted (built-in default)
- Print a warning: "All enforcement disabled until `keel enable`"
- Auto-re-enable on agent restart (so a forgotten disable doesn't leave you unprotected forever)

### Gap 2: No Rule Conflict Detection

**Found by:** Rules files research agent, adversarial agent #9

**The problem:** When two rules contradict (e.g., "deny all network access" vs. "allow api.github.com"), ALL existing tools silently pick one arbitrarily. The agent follows whichever rule happens to be evaluated last. The user has no idea there's a conflict.

**What the plan says:** Nothing.

**What should be there:**

```
$ keel validate           # Check rules for conflicts
  ✓ never-force-push: OK
  ✓ no-delete-outside-src: OK
  ✗ CONFLICT: no-external-network blocks all egress
    but must-sign-commits requires `git push`
    which needs network access to api.github.com
    → Rule "no-external-network" overrides "must-sign-commits"
    → Action: escalate to user, or add exception
```

Also: validate runs automatically when CLAUDE.md changes. Conflicts shown as warnings in the terminal.

### Gap 3: No Rule Testing / Dry-Run Mode

**Found by:** Rules files research, ADK guardrails research (Google ADK allows mutation of tool args for testing)

**The problem:** Users add a rule, then have to let their agent actually try the forbidden action to see if it works. No way to preview "what would happen if I add rule X?"

**What the plan says:** Nothing.

**What should be there:**

```
$ keel test "git push --force origin main"
  → DENY by rule "never-force-push"
  → Would return: "Use `git push origin main` instead"

$ keel test "npm install some-package"
  → ALLOW (no matching rule)

$ keel test "rm -rf /src" --level=sprint
  → ALLOW (sprint mode skips filesystem rules)
```

Also: `keel test --file` to test against a trace file:

```
$ keel test --from-audit ~/.keel/audit/last-session.jsonl --new-rule "no-external-network"
  → Rule would have blocked 12 actions in last session
  → 3 of those appear legitimate (false positives)
  → Add `allow:` exceptions for those 3?
```

### Gap 4: No Learning Mode

**Found by:** Progressive enforcement research, false positive research, ESLint adoption patterns

**The problem:** Going from "no rules" to "full enforcement" is jarring. Users don't know what rules they need. Rules that seem good in theory cause false positives in practice.

**What the plan says:** "`keel enforce --learn` runs all rules in `report` mode. After N sessions, suggests `warn` or `deny`."

**What should actually be there (details):**

Phase 1 — Observe:
```
$ keel enforce --learn
  → All rules in `report` mode (log only)
  → Records: "session 1: 47 tool calls, 3 would-have-been-denied"
```

Phase 2 — Suggest (after 3 sessions or explicit `keel learn --report`):
```
$ keel learn --report
  Summary for this project (3 sessions, 212 tool calls):
  Rules that would have fired:
    never-force-push:     0 violations (safe to keep at deny)
    no-delete-outside-src: 1 violation (false positive — was intentional)
      → Action: downgrade to `warn` for this project
    no-external-network:   12 violations (all `npm install` calls)
      → Action: add `npmjs.org` to except list
    Recommended new rule: "no-install-without-approval"
      → Pattern: `npm install` without `--save-exact` → 4 violations
```

Phase 3 — Apply:
```
$ keel learn --apply    # Apply all suggestions
$ keel learn --apply-rule no-external-network  # Apply one
```

### Gap 5: No Multi-Step / Sequence Rules

**Found by:** AgentLTL research (FO-LTL trace verification), AgentSpec (multi-step enforcement), Claude PreToolUse hooks research

**The problem:** The plan only has single-action rules ("don't run this command"). Critical violations are SEQUENCES — "read .env file, then call external API with the contents." No existing tool enforces this.

**What the plan says:** Only single-action rules.

**What should be there:**

Add a new rule type `sequence`:

```yaml
- id: no-leak-credentials
  type: sequence
  steps:
    - tool: ReadFile
      path: ".env"
    - tool: (HttpRequest|ShellCommand)
  window: 30        # within 30 seconds
  action: deny
```

```yaml
- id: no-read-after-delete
  type: sequence
  steps:
    - tool: DeleteFile
    - tool: ReadFile
      path: "${same_file}"      # same file argument
  window: infinite              # any time in session
  action: deny
```

Implementation: A sliding window buffer of recent actions. On each new action, check if it completes any forbidden sequence.

### Gap 6: No Information Flow Control

**Found by:** Microsoft Fides research (arXiv:2505.23643, IFC for AI agents), formal methods research

**The problem:** "Read .env" is harmless. "Call external API" is harmless. "Read .env THEN call external API with the contents" is data exfiltration. Single-action rules can't catch this. IFC tracks which data flows where.

**What the plan says:** Nothing.

**What should be there:**

```yaml
- id: no-credential-egress
  type: flow
  sources:                          # data sources
    - path: ".env"
    - path: "*/.env"
    - var: "GH_TOKEN|OPENAI_API_KEY"
  sinks:                            # where data can go
    - deny: network                 # but NOT to external APIs
```

Implementation: Tag data as it flows through tools. When a tool reads a sensitive file, tag the output. If a network tool receives tagged data, flag it. This is a simplified version of Microsoft Fides.

### Gap 7: No Rule Versioning / Drift Detection

**Found by:** Rules files research (Claude Code compaction loses rules), audit trails research

**The problem:** Rules live in CLAUDE.md in the repo. They change over time. But Keel doesn't detect when rules changed, what changed, or whether the change was intentional.

**What the plan says:** "Keyed by sha256(tool + args + rule_version). Invalidated when rules change (detected by hash change on CLAUDE.md)."

**What should actually be there:**

```
$ keel validate        # Also shows rule version info
  CLAUDE.md: v3 → v4 (2 mins ago)
  Changes:
    + no-external-network (new rule)
    - no-delete-outside-src (removed)
    ~ no-install-without-approval (action: warn → deny)
  Cache: flushed (3 rules changed)
```

Auto-detect CLAUDE.md changes on every tool call. If changed since last check, re-parse and flush cache. Log the change to audit trail.

---

## IMPORTANT GAPS (Should Add)

### Gap 8: No MCP Server Threat Model

**Found by:** MCP security research, MCP prompt injection research

**The problem:** MCP servers can change their tool descriptions mid-session (tool poisoning). They can inject prompts through tool responses. The plan doesn't address MCP at all.

**What the plan says:** Nothing.

**What should be there:**

For MCP-connected agents, rules should apply to MCP tool calls:
```yaml
- id: no-mcp-injection
  type: mcp
  check: tool_descriptions   # Check for hidden instructions in tool descriptions
  action: warn               # Warn when MCP tool descriptions change mid-session
```

Also: MCP server descriptions are untrusted input. Rules should apply to MCP tool results the same way they apply to file content.

### Gap 9: No ATR (Agent Threat Rules) Integration

**Found by:** Agent forensics standards research

**The problem:** There are 768 pre-built detection rules (MIT-licensed, production at Microsoft and Cisco AI Defense) for agent threats. The plan doesn't use them.

**What the plan says:** Nothing.

**What should be there:**

```
$ pip install atr-engine     # or npm install agent-threat-rules
```

On every tool call, also run ATR rules. Results feed into the audit log as additional signals. ATR rules are MIT-licensed and cover prompt injection, tool poisoning, credential harvesting, etc.

Not critical for MVP but easy to add and valuable.

### Gap 10: No Audit Trail Integrity (Existing Code Not Referenced)

**Found by:** Emerging standards research (found existing `audit-trail-integrity.ts` in user's codebase)

**The problem:** The user already has an audit trail integrity checker at `~/code/trading-claw/investing/lib/audit-trail-integrity.ts`. The plan designs a new audit log from scratch without reusing this.

**What the plan says:** "Audit log (append-only JSONL)."

**What should be there:** Reference the existing code. Even if it's in a different project, the patterns (timestamp monotonicity, duplicate ID checks, required-field validation) should be reused.

### Gap 11: No Escape Hatch for Agent Lockup

**Found by:** User pain points research (22 stories of agents misbehaving)

**The problem:** If Keel denies an action and the agent can't find an alternative path, it may loop, retry the same blocked action repeatedly, or freeze. The plan doesn't handle this.

**What the plan says:** "Deny-and-continue — agent retries with alternate approach."

**What should also be there:**

```yaml
- id: circuit-breaker
  type: meta
  condition: "3 denials in 60 seconds for the same rule"
  action: escalate          # Stop the agent, ask user
```

When the same rule denies the same tool 3+ times with no progress, Keel should surface to the user: "Your agent is stuck trying to do X. It's been blocked 3 times. Approve once, or stop the agent?"

### Gap 12: No Multi-Agent Rule Propagation

**Found by:** Anthropic's internal architecture (subagents don't inherit rules), Claude Code hooks (subagent blind spots)

**The problem:** When OpenCode spawns a subagent, the subagent doesn't inherit the rules. The subagent can violate rules that the parent agent would follow.

**What the plan says:** Nothing.

**What should be there:** Rules should propagate to subagents. The subagent's Keel context inherits the parent's rules + protection level.

---

## ENHANCEMENT SUGGESTIONS (Nice to Have)

| Finding | Source | Suggestion |
|---------|--------|-----------|
| AgentSpec DSL reference monitors | Formal methods research | Consider AgentSpec-style DSL for complex rules (predicate-based, LLM-generated rules with 95.56% precision) |
| OWASP AST09 bilateral receipts | Crypto trust research | Add optional bilateral receipt mode for compliance export. Not needed in MVP. |
| SPIFFE/SPIRE agent identity | Standards research | Future: issue SPIFFE identities to agents. Not needed for single-user. |
| OTEL GenAI semantic conventions | Standards research | Future: export audit trail as OTEL spans. Not needed in MVP. |
| NIST AI 600-1 / EU AI Act mapping | Standards research | Map rules to compliance frameworks when expanding beyond single user. |

---

## Summary: What to Add to the Plan

### P0 — Add now, before building

| # | Gap | Effort | Why |
|---|-----|--------|-----|
| 1 | Kill switch (`keel disable`) | 1 file, 30 lines | Without this, a bad rule blocks ALL work. Must exist on day 1. |
| 2 | Rule conflict detection (`keel validate`) | 1 file, ~80 lines | Silent conflict resolution erodes trust. Must detect and report. |
| 3 | Dry-run / rule testing (`keel test`) | 1 file, ~60 lines | Only way to test rules without disrupting work. Critical for trust. |
| 4 | Learning mode details (`keel enforce --learn`) | Extend existing | The plan mentions it but underspecifies it. Needs phases: observe → suggest → apply. |
| 5 | Escape hatch for agent lockup | Extend existing | Circuit breaker when agent loops on a blocked action. |

### P1 — Add in Phase 1 or early Phase 2

| # | Gap | Effort | Why |
|---|-----|--------|-----|
| 6 | Sequence rules (multi-step) | ~200 lines, new type | Catches data exfiltration that single-action rules miss |
| 7 | Information flow control | ~300 lines, new type | Read-then-send patterns are the most dangerous agent failure mode |
| 8 | Rule versioning / drift detection | ~100 lines | Ensures user knows when rules changed and cache is valid |
| 9 | MCP server threat model | ~80 lines | MCP servers are an attack vector; rules should cover them |
| 10 | Reference existing audit-trail-integrity.ts | 5 lines in docs | Don't reinvent what's already in the user's codebase |

### P2 — Add when expanding beyond OpenCode

| # | Gap | Effort | Why |
|---|-----|--------|-----|
| 11 | ATR integration (768 rules) | `npm install agent-threat-rules` | Production-grade detection rules from Microsoft/Cisco |
| 12 | Multi-agent rule propagation | ~100 lines | Subagents need to inherit parent rules |

---

## ROUND 2 FINDINGS (8 More Gaps from Final Audit)

A final audit of all 35 research findings against the plan found 8 additional gaps:

### Gap 13: No Agent Reasoning Awareness (WHY vs. WHAT)

**Found by:** Anthropic auto mode (two-stage classifier evaluates intent), Google DeepMind Semantic Governance, OpenAI instruction hierarchy

**The problem:** The plan checks WHAT the agent does (tool called, file written) but never WHY. A `git push --force` could be either malicious or a legitimate force-push to a personal fork. The plan can't distinguish them.

**What should be there:**

Add a "reasoning coherence check" between Content Scan and LLM stages. When the agent exposes chain-of-thought, evaluate whether the proposed action is consistent with its stated goal:

```
Tier 4.5: Reasoning coherence check (agent-aware)
  If agent reasoning is available:
    "I need to force-push to my personal fork to fix a broken merge"
    → Compare against rule "never-force-push"
    → If rule has `unless: "personal fork"`, ALLOW
    → Otherwise, DENY with context-aware message
```

Model this on Anthropic's two-stage classifier: fast heuristic first, then LLM-based evaluation for ambiguous cases.

```yaml
- id: no-force-push
  type: command
  match: "git push --force"
  action: deny
  unless_reasoning: "personal.*fork|backup.*branch"  # optional reasoning exception
```

**Effort:** ~150 lines for reasoning parser + coherence check
**Why include:** Catches the "I meant to do that" vs. "this is dangerous" distinction. Reduces false positives significantly.

### Gap 14: No Rate Limiting / Quota Enforcement

**Found by:** Existing types.ts already has RateLimit rules, agent-skills OPA policies, CodiLime OPA deployment

**The problem:** An agent can call `npm install` 100 times in a session. Or write to the same file 50 times. The plan doesn't limit frequency or volume.

**What should be there:**

The existing `RateLimit` type in `packages/core/src/types.ts` already supports:
```typescript
interface RateLimit {
  name: string
  scope: 'tool' | 'repo' | 'user'
  window: number         // seconds
  max_calls: number
  action: EnforcementAction
  message: string
}
```

Add a rate limit pipeline stage between Cache and Regex:
```yaml
- id: rate-limit-installs
  type: rate
  scope: tool
  window: 60         # per minute
  max_calls: 5
  match: "npm install"
  action: deny
```

**Effort:** ~80 lines (types already exist, just wire into pipeline)
**Why include:** Prevents runaway agent behavior. The types already support it. Trivial to add.

### Gap 15: No Time-Based Enforcement

**Found by:** Existing types.ts already has TimeRule, CodiLime OPA maintenance windows, ABAC time rules

**The problem:** Can't express "no deploys after 6pm Friday" or "read-only on weekends."

**What should be there:**

The existing `TimeRule` type already supports:
```typescript
interface TimeRule {
  name: string
  timezone?: string
  schedule?: { start: string; end: string; days?: string[] }
  subjects: ({ patterns: { regex?: string }[]; paths?: string[] })[]
  outside_schedule_action: EnforcementAction
  message: string
}
```

```yaml
- id: no-after-hours-deploy
  type: time
  timezone: America/Los_Angeles
  schedule:
    start: "09:00"
    end: "17:00"
    days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
  subjects:
    - patterns:
        - regex: "git push.*(production|main)"
  outside_schedule_action: prompt
  message: "Pushing to production after hours requires confirmation"
```

**Effort:** ~50 lines (types already exist)
**Why include:** The types exist. This is wiring them into the pipeline. Prevents late-night accidents.

### Gap 16: No Auto-Fix / Argument Mutation

**Found by:** Google ADK callback mutation research, CloudMatos Aegis (sanitize outcome), Guardrails AI (fix mode)

**The problem:** Keel can only ALLOW or DENY. It cannot MODIFY. Instead of blocking `git push --force` completely, Keel could strip `--force` and let the safe version execute.

**What should be there:**

Add a `fix` outcome to the existing `allow/protect/warn/deny` actions:

```yaml
- id: never-force-push
  type: command
  match: "git push --force"
  action: fix                          # Don't block, strip --force
  fix:
    - pattern: "--force"
      replace: ""                      # Remove --force flag
  message: "Removed --force flag"
```

```yaml
- id: no-absolute-paths
  type: filesystem
  match: "write-file"
  args:
    path: "/**"                        # matches absolute paths
  action: fix
  fix:
    - pattern: "^/"
      replace: "./"                    # Convert to relative path
  message: "Converted absolute path to relative"
```

**Effort:** ~120 lines (new fix engine in pipeline + fix outcome type)
**Why include:** More useful than deny-and-continue. The agent gets what it needs, safely. Reduces false positive frustration.

### Gap 17: No Rego/OPA Backend for Complex Rules

**Found by:** Existing rego-engine.ts in codebase, CodiLime OPA deployments, CloudMatos Aegis, Kyndryl policy-as-code

**The problem:** YAML frontmatter rules work for simple patterns. Complex rules (multi-condition, cross-referencing, computed policies) need a real policy engine. Rego is the industry standard.

**What should be there:**

The codebase already has `packages/cli/src/rego-engine.ts` — this is a Rego evaluation engine. Wire it in as an alternative policy backend:

```yaml
# rule.rego in project root
package keel

import future.keywords.if

default allow := true

allow := false if {
    input.tool == "WriteFile"
    some path in ["/etc", "/usr", "/var"]
    startswith(input.args.path, path)
}

allow := false if {
    input.tool == "ShellCommand"
    contains(input.args.command, "rm -rf /")
}
```

Rules in CLAUDE.md frontmatter get compiled to Rego. Users who need complex logic can write Rego directly.

**Effort:** ~100 lines (rego-engine.ts exists; wire into tiered pipeline)
**Why include:** OPA/Rego is emerging as the industry standard for agent policy. The code already exists. Exposing it as an option future-proofs the rule system.

### Gap 18: No Rich Rule Hierarchy (Global → Project → Folder)

**Found by:** AGENTS.md hierarchical standard, .editorconfig model, hierarchical context patterns

**The problem:** The plan has one CLAUDE.md per project. But the user might want global rules (`~/.keel/rules.yaml`), team rules (committed to repo), and folder-specific rules.

**What should be there:**

```
~/.keel/rules.yaml           ← Global rules (all projects)
  ^
  | overridden by
  |
project/CLAUDE.md            ← Project rules (committed)
  ^
  | overridden by
  |
project/CLAUDE.local.md      ← Local overrides (gitignored)
  ^
  | overridden by
  |
project/src/CLAUDE.md        ← Folder-scoped rules
```

Conflict resolution: more specific scope wins. `action: deny` in global + `action: warn` in local → local wins.

**Effort:** ~80 lines (hierarchy resolver)
**Why include:** Matches how CLAUDE.md already works (global → user → project → local). Users expect this.

### Gap 19: No Subagent Edge Case Protection (Grandchild Propagation)

**Found by:** arXiv "When Child Inherits" paper (Cai, Zhang, Hei, May 2026) — four vulnerability classes in subagent inheritance

**The problem:** The plan says "rules propagate to subagents." But propagation has edge cases: what about grandchild subagents? What about memory inheritance? What about resource access?

**What should be there:**

For each subagent spawn, define an inheritance contract:
- What rules propagate? (all → only global-scope → none)
- What memory propagates? (sanitized? truncated?)
- What resource access propagates? (subset? fresh tokens?)
- What happens at termination? (child state merged? quarantined?)

```yaml
- id: subagent-contract
  type: inheritance
  scope: subagent
  propagate_rules: all                # all rules propagate to children
  propagate_memory: false            # don't propagate agent memory
  resource_access: restrict          # fresh tokens, subset of parent resources
  termination: quarantine            # child state quarantined after exit
```

**Effort:** ~150 lines (inheritance contract engine)
**Why include:** Research shows 4 vulnerability classes in subagent inheritance. Important if OpenCode uses subagents.

### Gap 20: No Session Duration as Risk Signal

**Found by:** Claude Code session limits, agent-skills concurrent session controls

**The problem:** Long-running sessions have degraded quality and higher risk. The plan treats a 5-minute session and a 5-hour session identically.

**What should be there:**

```yaml
- id: session-rotation
  type: session
  max_duration_minutes: 120
  action: escalate            # Alert user to consider session refresh
```

When session exceeds duration threshold, escalate scrutiny level. At protect level, require re-auth every 60 minutes.

**Effort:** ~50 lines (session timer + threshold check)
**Why include:** Simple addition. Long sessions are higher-risk by definition (more context, more drift, more actions).

### Gap 21: No CI/CD vs. Local Context Awareness

**Found by:** CodiLime OPA CI/CD pipeline, Claude Code managed settings vs. local

**The problem:** The same rule set doesn't fit local dev and CI/CD. In CI/CD, you want stricter enforcement. Locally, you want speed.

**What should be there:**

```yaml
- id: no-force-push
  type: command
  match: "git push --force"
  action: deny
  context: [local, ci]          # Applies in both contexts

- id: no-unpinned-deps
  type: command
  match: "npm install (?!.*--save-exact)"
  action: den y
  context: [ci]                 # Only in CI/CD
  level: sprint                 # Active even in sprint mode for CI
```

Detection: auto-detect CI environment variables (`CI=true`, `GITHUB_ACTIONS=true`). Also allow manual override.

**Effort:** ~60 lines (context detection + rule filtering)
**Why include:** Different contexts need different strictness. Prevents CI from blocking valid dev workflows.

---

## Updated Summary: Complete Gap List (21 items)

### P0 — Critical safety (build before anything else)

| # | Gap | Effort |
|---|-----|--------|
| 1 | Kill switch (`keel disable`) | 30 lines |
| 2 | Rule conflict detection (`keel validate`) | 80 lines |
| 3 | Dry-run / rule testing (`keel test`) | 60 lines |
| 4 | Learning mode (observe → suggest → enforce) | Extend existing |
| 5 | Escape hatch for agent lockup (circuit breaker) | 60 lines |
| 13 | Agent reasoning awareness (WHY vs. WHAT) | 150 lines |

### P1 — Core enforcement (build in Phase 1)

| # | Gap | Effort |
|---|-----|--------|
| 6 | Sequence rules (multi-step actions) | 200 lines |
| 7 | Information flow control (read→send tracking) | 300 lines |
| 8 | Rule versioning / drift detection | 100 lines |
| 17 | Rego/OPA backend for complex rules | 100 lines (code exists) |
| 18 | Rich rule hierarchy (global → project → folder) | 80 lines |
| 21 | CI/CD vs. local context awareness | 60 lines |

### P2 — Quality of life (build in Phase 1 or early Phase 2)

| # | Gap | Effort |
|---|-----|--------|
| 9 | MCP server threat model | 80 lines |
| 10 | Reference existing audit-trail-integrity.ts | 5 lines in docs |
| 14 | Rate limiting / quota enforcement | 80 lines (types exist) |
| 15 | Time-based enforcement | 50 lines (types exist) |
| 16 | Auto-fix / argument mutation | 120 lines |
| 20 | Session duration as risk signal | 50 lines |

### P3 — Multi-agent and ecosystem (expand scope)

| # | Gap | Effort |
|---|-----|--------|
| 11 | ATR integration (768 rules) | npm install |
| 12 | Subagent rule propagation | 100 lines |
| 19 | Subagent edge case protection (grandchild, memory, etc.) | 150 lines |
