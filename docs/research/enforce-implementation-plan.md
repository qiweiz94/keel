# Keel Enforce — Implementation Plan (Customer Zero)

**Date:** July 29, 2026
**Focus:** You. Your agents. Your rules. Your codebase.

---

## 1. What You Get

A single command that makes your rules stick regardless of context length:

```
$ keel enforce                  # Enforce rules for current agent
$ keel enforce --init           # Create rule file from template
$ keel enforce --level=strict   # Run in strict mode (slower, safer)
$ keel enforce --level=fast     # Run in fast mode (minimal checks)
$ keel enforce --audit          # Show recent violations
```

Three protection levels, dialable per session:

| Level | Precision | Speed | Best for |
|-------|-----------|-------|----------|
| `protect` | Maximum | Slowest | Production deployments, CI/CD |
| `balanced` | High | Normal | Daily development (default) |
| `sprint` | Core only | Fastest | Prototyping, exploration |

OpenCode gets deepest integration (native tool-call interception). Other agents get the best available — hooks for Claude Code, filesystem monitoring for Cline/Cursor/Codex CLI.

---

## 2. The Protection Dial

Three independent knobs, inspired by OWASP CRS Paranoia Levels + Anthropic's permission modes:

### Knob 1: Rule Set — which rules are active

| Level | Active rules | What's checked |
|-------|-------------|----------------|
| `sprint` | Critical only | Destructive commands, secrets, force push |
| `balanced` | Standard | Critical + file operations, network, git hygiene |
| `protect` | All | Everything + anomaly detection + behavioral patterns |

### Knob 2: Action — what happens when a rule matches

| Action | Effect | Use case |
|--------|--------|----------|
| `report` | Log only, no user-visible feedback | Learning mode, establishing baseline |
| `warn` | Show warning, do not block | First-time violations, low-severity rules |
| `deny` | Block action, agent retries | Repeated violations, high-severity rules |

**Critical rule**: Never deny first time. The first violation of any rule is always `warn`. If the same rule matches again in the same session, escalate to `deny`.

### Knob 3: Enforcement depth — how thoroughly checks are performed

| Depth | Checks used | Per-call overhead |
|-------|------------|-------------------|
| `fast` | Regex + allowlist cache + path check | ~0.01ms |
| `full` | Fast + content scan + git diff scan | ~1-10ms |
| `deep` | Full + LLM-based evaluation (rare) | ~1-10s (only for ambiguous cases) |

### Default presets

```
protect:   rule_set=all      action=deny     depth=deep
balanced:  rule_set=standard action=deny     depth=full    (default)
sprint:    rule_set=critical action=warn     depth=fast
```

Users override any knob individually:
```
$ keel enforce --level=sprint --action=deny   # sprint rules, but deny violations
$ keel enforce --level=protect --depth=fast   # all rules, but skip content scans
```

---

## 3. How It Works

Two mechanisms work together:

| Layer | What | Survives context? |
|-------|------|-------------------|
| **Voluntary** | Rules re-injected into agent's context at strategic points | No — but helps the agent try |
| **Involuntary** | External interception (hooks, filesystem, shell) | **Yes** — cannot be forgotten |

Layer 2 is the key. The agent can forget the rule, but the enforcement still applies.

### Enforcement Pipeline (Tiered Cost)

Checks run in order from cheapest to most expensive. First match short-circuits:

```
Agent calls tool
    │
    ▼
Tier 1: Allowlist cache hit? ──Yes──▶ ALLOW (instant)
    │ No
    ▼
Tier 2: Blocklist pattern match? ──Yes──▶ DENY (~0.01ms, regex)
    │ No
    ▼
Tier 3: Simple conditional (path, tool name)? ──Yes──▶ DENY (~0.1ms)
    │ No
    ▼
Tier 4: File content scan? ──Yes──▶ DENY (~1-10ms, only if file changed)
    │ No
    ▼
Tier 5: Cache result as ALLOW for next time
    ▶ ALLOW
```

Tier 6 (LLM-based eval) only runs in `deep` mode and only for actions that pass all cheaper tiers but still look suspicious. Results cached aggressively.

---

## 4. Rule Format

Rules live in `CLAUDE.md` at your project root. YAML frontmatter for machine-enforceable rules:

```markdown
---
keel:
  version: 1
  level: balanced            # default protection level for this project
  rules:
    - id: never-force-push
      type: command
      match: "git push --force"
      action: deny
      level: sprint           # even in sprint mode, this rule is active
    - id: no-delete-outside-src
      type: filesystem
      path: "!/src/*"
      operations: [delete, overwrite]
      action: deny
      level: balanced
    - id: must-sign-commits
      type: git
      flag: "--signoff"
      action: require
      level: balanced
    - id: no-external-network
      type: network
      except: [api.github.com, registry.npmjs.org]
      action: deny
      level: protect           # only checked in protect mode
    - id: re-inject-rules
      type: context
      at_tokens: [8000, 16000, 32000]
      action: re-inject
      level: sprint            # always re-inject, even in sprint mode
---

# CLAUDE.md — rules for this project

## Git rules
- NEVER use `git push --force`
- ALWAYS sign commits with `--signoff`

## Filesystem rules
- NEVER delete or overwrite files outside `/src`
```

Each rule has a `level` field. Rules with `level: sprint` are always active. Rules with `level: balanced` activate in balanced and protect modes. Rules with `level: protect` only activate in protect mode.

**Existing CLAUDE.md files work unchanged** — Keel treats rules without frontmatter as `level: balanced`, `action: warn`.

---

## 5. Caching Strategies (The Speed Secret)

These bring per-call overhead near zero for repeated actions:

### Session-scoped action cache

Key: `sha256(tool_name + json_args)` → verdict. On subsequent identical calls, return cached verdict instantly.

```typescript
class ActionCache {
  private cache = new Map<string, { verdict: string; count: number }>()
  private maxSize = 10000

  get(tool: string, args: unknown): string | null {
    const key = this.hash(tool, args)
    const entry = this.cache.get(key)
    if (entry) {
      entry.count++
      return entry.verdict
    }
    return null
  }

  set(tool: string, args: unknown, verdict: string) {
    const key = this.hash(tool, args)
    this.cache.set(key, { verdict, count: 1 })
    if (this.cache.size > this.maxSize) {
      // Evict least-used entry
      let minCount = Infinity, minKey = ''
      for (const [k, v] of this.cache) {
        if (v.count < minCount) { minCount = v.count; minKey = k }
      }
      this.cache.delete(minKey)
    }
  }
}
```

**Impact**: After ~50 tool calls in a session, 80-95% of subsequent calls hit the cache. Zero rule evaluation needed.

### Known-good persistent store

Same mechanism, persisted across sessions. Keyed by `sha256(tool + args + rule_version)`. Invalidated when rules change (detected by hash change on CLAUDE.md).

### Incremental checking

- **File content**: Only scan files that changed (tracked via fswatch/inotify events). If a file hasn't changed since last check, skip content rules.
- **Git operations**: Only scan the diff (`git diff HEAD~1..HEAD`), not the entire repo. Baseline support (like Gitleaks `--baseline-path`) to skip known-clean commits.
- **Progressive enforcement**: Start in `warn` mode for new rules. Escalate to `deny` only after observing the same violation pattern 3+ times.

---

## 6. False Positive Protection

**The golden rule**: A single false deny erodes more trust than 100 correct denies build. This system is designed around that.

| Protection | Mechanism |
|-----------|-----------|
| Never deny first time | First violation of any rule → `warn` only. Escalate to `deny` on repeat |
| One-click override | Every deny includes `keel allow` suggestion. User overrides in 1 command |
| Circuit breaker | If a rule fires 5+ times without user confirming ("yes, block this"), auto-downgrade to `warn` |
| Show your work | Deny message includes: rule ID, exact match, file+line, how to fix, how to override |
| Feedback loop | `keel feedback --false-positive` flags a deny for review. Tunes rules per-project |
| Learning mode | `keel enforce --learn` runs all rules in `report` mode. After N sessions, suggests `warn` or `deny` based on actual violation patterns |

### Deny-and-continue (from Anthropic)

When Keel denies an action, the agent gets a nudge, not a dead end:

```
Agent: git push --force origin main
Keel:  ⚠ Action blocked by rule "never-force-push"
       • Use `git push origin main` instead (no --force)
       • Override: `keel allow never-force-push --once`
       • This was a first violation → warning only. Next time will be blocked.
```

The agent retries with `git push origin main` (without `--force`). The session continues.

---

## 7. OpenCode Integration (Deepest)

Since OpenCode is your agent, Keel is compiled in natively. No hook wrapping needed.

### What changes in OpenCode:

**1. Interceptor in tool-call loop**

Every tool call goes through Keel's policy engine BEFORE execution:

```typescript
const result = await keel.evaluate({
  tool: toolName,
  args: toolArgs,
  cwd: process.cwd(),
  session_id: sessionId,
  context_tokens: currentTokenCount,
  level: currentProtectionLevel,      // from CLI flag or config
})
if (result.action === 'deny') {
  return {
    type: 'text',
    text: `⚠ Action blocked by Keel rule "${result.rule_name}": ${result.message}\n` +
          `   Override: \`keel allow ${result.rule_id} --once\``
  }
}
if (result.action === 'warn') {
  // Execute the tool but log the warning
  console.warn(`⚠ Keel warning: ${result.message}`)
}
// Proceed with tool execution
```

**2. Context re-injection hook**

When context crosses thresholds (8K, 16K, 32K tokens), or after compaction, re-read CLAUDE.md and inject rules at the END of context:

```typescript
if (contextUtilization > nextThreshold || afterCompaction) {
  const rules = readRulesMarkdown(level)  // Only inject rules relevant to current level
  injectIntoContext(rules, 'end')
  nextThreshold *= 2
}
```

At `protect` level, re-inject at 4K, 8K, 16K, 32K. At `sprint` level, only at 16K and 32K.

**3. Audit log**

Every denied or warned action is logged:

```typescript
keel.log({
  timestamp: new Date().toISOString(),
  session_id: sessionId,
  turn_number: currentTurn,
  tool: toolName,
  args: sanitize(args),
  rule_id: result.rule_id,
  action: result.action,          // 'deny' | 'warn' | 'report'
  level: currentProtectionLevel,
})
```

### Files to create/modify:

| File | What |
|------|------|
| `src/keel/interceptor.ts` | Tool-call interceptor + tiered evaluation |
| `src/keel/context-manager.ts` | Token counting + rule re-injection |
| `src/keel/audit.ts` | Audit log (append-only JSONL) |
| `src/keel/rule-parser.ts` | Read + parse CLAUDE.md frontmatter |
| `src/keel/policy-engine.ts` | Tiered evaluation engine |
| `src/keel/cache.ts` | Session + persistent action cache |
| `src/keel/cli.ts` | `keel enforce` commands |
| Agent main loop | Insert interceptor before tool dispatch |

---

## 8. Claude Code Integration (Hooks)

Claude Code's `PreToolUse` hooks provide blocking — but only for tools that pass the hook's `matcher` + `if` filters.

### Hook script: `.claude/hooks/PreToolUse/keel-enforce`

```bash
#!/bin/bash
INPUT=$(cat)
TOOL=$(echo "$INPUT" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).tool)")
ARGS=$(echo "$INPUT" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.stringify(JSON.parse(d).args))")

# Evaluate against keel policy (fast path: ~1ms for cache hit)
RESULT=$(keel evaluate --tool "$TOOL" --args "$ARGS" --level "$KEEL_LEVEL" 2>/dev/null)

case "$RESULT" in
  deny)
    echo '{"decision": "deny", "permissionDecisionReason": "Blocked by Keel rule"}'
    ;;
  warn)
    # Allow but log. Claude Code hooks can't surface warnings to user directly.
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
```

Context re-injection via `PostToolUse` hook:

```
.claude/hooks/PostToolUse/keel-reinject
```

Checks Claude Code's context-awareness tag (`<system_warning>Token usage: X/200000</system_warning>`), re-injects rules if above threshold.

### Files:

| File | What |
|------|------|
| `.claude/hooks/PreToolUse/keel-enforce` | Shell script calling `keel evaluate` |
| `.claude/hooks/PostToolUse/keel-reinject` | Context re-injection hook |
| `~/.config/keel/config.yaml` | Global config (default level, etc.) |

---

## 9. Cline / Cursor / Codex CLI (Filesystem + Process Monitoring)

No blocking hooks available. Enforcement is **detection-based** — violations are detected and logged after the fact.

| Watcher | What it detects | How |
|---------|----------------|------|
| **Filesystem** | Unauthorized file creates/modifies/deletes | fswatch / inotify |
| **Process** | Dangerous commands (rm -rf, curl pipe bash) | Shell history + process list |
| **Git** | Force push, unsigned commits, secret leakage | .git watcher + gitleaks |

At `sprint` level, only git watcher is active (detect force push + secrets). At `balanced`, all three watchers. At `protect`, watchers + periodic full scans.

---

## 10. Build Order

### Phase 1 — OpenCode Only (you, this week)

| Day | What | Priority |
|-----|------|----------|
| 1 | Rule parser: read CLAUDE.md frontmatter | Core |
| 1 | Policy engine with tiered evaluation + level support | Core |
| 2 | Action cache (session + persistent) | Speed |
| 2 | Interceptor in OpenCode's tool-call loop | Core |
| 3 | Context manager: token tracking + re-injection | Quality |
| 3 | Audit log | Foundation |
| 4 | `keel enforce` CLI with --level flag | Core |
| 4 | Write rules for your own projects | You |

### Phase 2 — Claude Code (following week)

| Day | What |
|-----|------|
| 5 | PreToolUse hook script |
| 5 | PostToolUse re-injection hook |
| 6 | `keel evaluate` CLI command (for hooks to call) |
| 6 | Cross-agent audit log viewer |

### Phase 3 — Other agents (when needed)

| Day | What |
|-----|------|
| 7 | Filesystem watcher (fswatch) |
| 7 | Process detector |
| 8 | Git watcher + gitleaks integration |
| 8 | Desktop notifications |

---

## 11. Existing Code to Reuse

| File | Lines | Used for |
|------|-------|----------|
| `packages/core/src/policy-engine.ts` | 835 | Core evaluation logic (extend for agent tool calls + level awareness) |
| `packages/core/src/types.ts` | 115 | `EnforcementAction`, `ToolCallEvent`, `AuditEntry` (add level field) |
| `packages/core/src/signing.ts` | 284 | Ed25519 signatures (for exported audit reports) |
| `packages/cli/src/anomaly.ts` | — | Anomaly detection (use in `protect` level only) |

---

## 12. What Research Informed This Design

| Finding | Source | Applied as |
|---------|--------|------------|
| Two-stage classifier (fast + thorough) | Anthropic auto mode | Tiered enforcement pipeline (Tier 1-4 fast, Tier 5-6 thorough) |
| Deny-and-continue, not deny-and-halt | Anthropic | Agent retries with alternate approach |
| Never deny first time | CrowdStrike postmortem, EDR research | First violation → warn, escalate to deny |
| Executing PL vs. Blocking PL | OWASP CRS | Protection levels (sprint/balanced/protect) |
| Off/warn/error trifecta | ESLint | Report/warn/deny action per rule |
| In-project ops skip classifier | Anthropic | `sprint` level skips content scans entirely |
| Action-result cache | Gitleaks baseline, OPA WASM | Session-scoped cache eliminates 80-95% of checks |
| Circuit breaker for rule updates | CrowdStrike outage | Auto-downgrade rules that produce false positives |
| 0.4% FPR is acceptable; 17% FNR is honest | Anthropic | Shared numbers for users to understand tradeoffs |

---

## Summary

You, as Customer Zero, get:

1. **Three protection levels** — `sprint` (fast, core checks only), `balanced` (default), `protect` (thorough, slower). Dial per session.
2. **OpenCode enforces rules natively** — tool calls checked BEFORE execution via tiered pipeline
3. **Cached evaluation** — 80-95% of repeated checks return instantly from cache
4. **False positive protection** — never deny first time, one-click override, circuit breakers
5. **Context re-injection** — rules re-injected at strategic token thresholds
6. **Same rule file** (`CLAUDE.md` with YAML frontmatter) — works everywhere

---

**Ready to execute when you are.**
