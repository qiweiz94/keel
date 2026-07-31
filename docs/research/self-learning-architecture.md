# Self-Learning Architecture — Deterministic Core + Learning Layer

**Date:** July 29, 2026
**Principle:** Reliable by default, smarter over time. Never surprise the user.

---

## The Tension

| Property | Deterministic | Self-Learning |
|----------|--------------|---------------|
| Same input → same output | ✅ Always | ❌ Can drift |
| Predictable under test | ✅ Yes | ❌ Non-deterministic |
| User can verify behavior | ✅ `keel test` works | ❌ Hard to verify |
| Adapts to new patterns | ❌ Static rules | ✅ Improves over time |
| Finds unknown threats | ❌ Only known patterns | ✅ Discovers anomalies |

**The solution: keep them separate.** A deterministic enforcement core that never changes without user approval. A learning layer that observes, analyzes, and suggests — but never actuates.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 LEARNING LAYER                       │
│  (observes, analyzes, suggests — never enforces)     │
│                                                      │
│  ┌────────────┐  ┌──────────┐  ┌───────────────┐   │
│  │ Trace      │  │ Pattern  │  │ Suggestion    │   │
│  │ Collector  │→│ Analyzer │→│ Engine        │   │
│  └────────────┘  └──────────┘  └───────┬───────┘   │
│                                         │           │
│                            ┌───────────┴──────┐    │
│                            │ User reviews      │    │
│                            │ suggestions,      │    │
│                            │ approves/rejects  │    │
│                            └───────────┬──────┘    │
│                                         │           │
└─────────────────────────────────────────┼───────────┘
                                          │ approved
                                          ▼
┌─────────────────────────────────────────────────────┐
│               DETERMINISTIC CORE                     │
│  (unchanged by learning layer — user controls it)    │
│                                                      │
│  ┌────────┐  ┌──────────┐  ┌────────┐  ┌────────┐  │
│  │ Rules  │→│ Pipeline │→│ Action  │→│ Audit  │  │
│  │ (YAML) │  │ (tiered) │  │ (allow/ │  │ Log    │  │
│  └────────┘  └──────────┘  │ deny)   │  └────────┘  │
│                            └────────┘                │
└─────────────────────────────────────────────────────┘
```

**Key rule: The learning layer NEVER writes to the rules file. Only the user does.**

---

## What the Learning Layer Observes

Every enforcement decision is recorded as a structured event:

```typescript
interface KeelEvent {
  session_id: string
  timestamp: string
  turn_number: number
  protection_level: 'sprint' | 'balanced' | 'protect'
  tool: string
  args: unknown
  rule_id: string | null      // which rule matched (null = no match)
  action: 'allow' | 'deny' | 'warn' | 'fix'
  cache_hit: boolean
  context_tokens: number
  duration_ms: number
  agent: string               // opencode, claude-code, etc.
  subagent_of: string | null  // parent session if subagent
}
```

This is the same audit log used for debugging. The learning layer reads it passively.

---

## What the Learning Layer Analyzes

### 1. Rule Effectiveness

| Metric | What it tells | Action |
|--------|--------------|--------|
| Fire count per rule | How often does this rule trigger? | If 0, suggest removing or downgrading |
| True positive rate | How many denies are followed by user override? | If high override rate, suggest downgrading to warn |
| False positive rate | How many denies are reported as false positives? | If >5%, suggest tuning |
| Rule conflict frequency | How often do two rules contradict? | Suggest conflict resolution |
| Time-to-first-fire | When in the session do rules trigger? | If always late, suggest earlier re-injection |

### 2. Cache Effectiveness

| Metric | What it tells | Action |
|--------|--------------|--------|
| Hit rate | How many checks return from cache? | If low, suggest increasing cache size |
| Eviction rate | How often are cache entries purged? | If high, suggest larger max size |
| Stale hit rate | Are cached results ever invalid? | If yes, debug cache invalidation |

### 3. Agent Behavior Patterns

| Pattern | What it detects | Action |
|---------|----------------|--------|
| Tool call sequences | Common multi-step patterns | Suggest sequence rules |
| Data flow paths | Which files → which network APIs | Suggest IFC rules |
| Error recovery patterns | How does agent respond to denies? | Suggest deny-and-continue improvements |
| Subagent behavior | Do subagents violate more rules? | Suggest inheritance contract tightening |
| Context degradation | Do violations cluster at high token counts? | Suggest re-injection threshold adjustments |

### 4. Anomaly Detection

| Signal | What it detects | Action |
|--------|----------------|--------|
| Tool novelty | First use of a tool in session | Flag for review |
| Frequency spike | Tool called 10x normal rate | Suggest rate limiting rule |
| Argument shape drift | Arguments changing pattern | Suggest content scanning rule |
| Temporal anomaly | Tool called at unusual hour | Suggest time-based rule |
| Sequence anomaly | Unexpected tool ordering | Suggest sequence rule |

---

## What the Learning Layer Suggests

### Format: `keel suggest` command

```
$ keel suggest
Based on 47 sessions across 3 projects:

📊 Rule performance:
  never-force-push: fired 12 times, 0 false positives → keep at deny ✓
  no-external-network: fired 47 times, 41 were npm install → suggest adding npmjs.org to except list
  no-delete-outside-src: fired 3 times, 3 overrides → suggest downgrading to warn

💡 New rule suggestions:
  "limit-npm-installs" — npm install called 15x avg/session → create rate limit rule? [y/N]
  "detect-read-after-config" — ReadFile(config) followed by HttpRequest → add sequence rule? [y/N]
  "check-late-violations" — 73% of violations occur after 16K tokens → adjust re-injection? [y/N]

⚙️ Performance suggestions:
  "enable-persistent-cache" — cache miss rate is 60%, persistent cache could save ~2s/session
  "upgrade-to-balanced" — only 3 rules active in sprint mode, 0 violations in last 10 sessions
  "downgrade-to-sprint" — 0 violations in protect mode that balanced wouldn't catch

⚠️ Potential issues:
  Rule conflict: no-external-network blocks npmjs.org, but limit-npm-installs expects npm traffic
  → Add exception to no-external-network, or limit-npm-installs won't fire
```

### Suggestion lifecycle:

```
Collect data ──▶ Analyze ──▶ Generate suggestions ──▶ User reviews
                                                          │
                                                    ┌─────┴─────┐
                                                    │           │
                                                Approve      Reject
                                                    │           │
                                              Update rules    Record reason
                                              file           for future tuning
```

---

## What Stays Deterministic

The following NEVER change without explicit user action:

| Component | Deterministic guarantee |
|-----------|------------------------|
| Rule evaluation | Same tool + same args + same rules = same verdict. Always. |
| Rule file format | CLAUDE.md YAML frontmatter. One schema. No hidden state. |
| Protection levels | sprint/balanced/protect have fixed rule sets. No auto-escalation. |
| Action cache | sha256(tool + args + rule_version) → same result every time. |
| `keel test` | Always returns the same result for the same input. Testable. |
| `keel validate` | Always reports the same conflicts for the same rules. |
| Tiered pipeline | Checks always run in the same order. Predictable performance. |
| Re-injection thresholds | Always fire at the same token counts. No adaptive thresholds by default. |

---

## What Is Self-Learning

| Component | Learns from | Changes without user approval? |
|-----------|-------------|-------------------------------|
| `keel suggest` | All sessions, all projects, all agents | **No** — only suggests, never changes |
| Learning mode | Observed violations | **No** — user approves each suggestion |
| Anomaly detection | Session baselines | **No** — flags for review, never blocks |
| Cache tuning | Hit/miss rates | **No** — suggests cache size changes |
| False positive tracking | User override rate | **No** — suggests rule downgrades |
| Pattern discovery | Action sequences | **No** — suggests new rules, never creates them |

**The only automatic behavior:** Cache eviction (LRU) — this is deterministic (always evicts least-used entry) and has no correctness impact.

---

## Why This Architecture Maps to Research Findings

| Finding | Applied as |
|---------|-----------|
| Anthropic Clio privacy-preserving monitoring | Learning layer reads only anonymized events, never raw content |
| ESLint off→warn→error adoption path | Learning mode (observe→suggest→enforce) mirrors this |
| OWASP CRS executing PL vs. blocking PL | `keel enforce --learn` runs rules in report mode; user decides when to enforce |
| False positive "cry wolf" effect | Never deny first time + circuit breaker + suggest downgrade are all automated FP protection |
| CrowdStrike circuit breaker | Learning layer detects rule that fires too often without confirmation → suggests downgrade |
| Anthropic deny-and-continue | Agent gets feedback; learning layer tracks recovery success rate |
| Progressive enforcement | Starting permissive, learning suggests tightening based on observed violations |
| Gitleaks baseline caching | Learning layer tracks which checks are redundant across sessions |
| Agent-SafetyBench | Learning layer provides continuous eval of rule effectiveness |
| ClashEval (conflicting context) | Learning layer tracks when agent overrides rules based on conflicting context |

---

## Implementation

### Phase 1 — Data Collection (built into enforce pipeline)

Every enforcement decision emits an event. Events are stored as JSONL in `~/.keel/traces/`. No analysis yet — just collection.

```
~/.keel/
  traces/
    2026-07-29.jsonl    ← All events for today
    2026-07-28.jsonl
  cache/
    known-good.json      ← Persistent action cache
    baselines/           ← File content hashes, known-clean commits
  config.yaml            ← Global keel configuration
```

### Phase 2 — Analysis (when user runs `keel suggest`)

```
$ keel suggest                      # Analyze all traces, show suggestions
$ keel suggest --since=7d           # Last 7 days only
$ keel suggest --project=./web-app  # Specific project only
```

Analysis is deterministic — running `keel suggest` on the same traces always produces the same suggestions. This means suggestions are reproducible and auditable.

### Phase 3 — Learning Mode (extends existing `--learn` flag)

```
$ keel enforce --learn              # Observe mode + analysis
$ keel enforce --learn --apply      # Observe + auto-apply safe suggestions
$ keel enforce --learn --dry-run    # Show what would change, don't apply
```

Safe suggestions (auto-apply in `--apply` mode):

| Suggestion type | Auto-apply safe? | Why |
|----------------|-----------------|-----|
| Add npmjs.org to except list | Yes | Only expands allowlist |
| Downgrade rule from deny → warn | Yes | Reduces restrictiveness |
| Increase cache size | Yes | Performance only, no correctness impact |
| Adjust re-injection thresholds | Yes | Only changes timing, not behavior |

Unsafe suggestions (always require approval):

| Suggestion type | Why unsafe |
|----------------|------------|
| Add new rule | May produce false positives |
| Upgrade rule from warn → deny | May block legitimate actions |
| Remove exception from allowlist | May break legitimate workflows |
| Change protection level default | Affects all sessions |

---

## Summary

**Deterministic core:** Rules always evaluate the same way. `keel test` is reproducible. Pipeline is ordered and predictable. Cache is content-addressed. No hidden state.

**Self-learning layer:** Reads the audit log. Analyzes patterns. Suggests improvements. NEVER touches the rules file. The user decides.

**The user's experience:** "Keel does what I tell it, every time. And over time, it helps me write better rules without me having to notice the patterns myself."
