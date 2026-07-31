# Final Coverage Matrix — 35+ Research Agents vs. Implementation Plan

**Date:** July 29, 2026
**Purpose:** Verify every research finding is reflected in the plan.

---

## Coverage by Research Round

### Round 1 — Context & Agent Behavior (10 agents)

| # | Agent Focus | Finding | Where Addressed |
|---|-------------|---------|-----------------|
| 1 | Context degradation science | "Lost in the Middle" — U-shaped attention curve, degradation starts at 8K-16K tokens | Re-injection at 8K/16K/32K thresholds. Dual injection (start + end of context). |
| 2 | Anthropic's approach | Context rot acknowledged. CLAUDE.md injected as user message. Compaction drops governance. | Context re-injection after compaction. Rules re-read from disk, not from memory. |
| 3 | OpenAI's approach | Model Spec chain of command. Instruction hierarchy training (+10% improvement). Reasoning models improve rule following by 84%. | Agent reasoning awareness (Gap 13) — evaluate WHY, not just WHAT. |
| 4 | Google DeepMind | Gemini 1.5 >99% NIAH at 10M tokens. MMMT-IF: 22 point improvement when instructions at END. | Dual injection (start + end). Re-injection places rules at end of context. |
| 5 | Persistent enforcement | Greywall, Fence, Sandlock, Claude Code hooks, seccomp, Landlock, proxy, git hooks | Hooks for OpenCode + Claude Code. Filesystem/process/git watchers for other agents. |
| 6 | Existing guardrail tools | No tool combines sandboxing + enforcement + signed attestations. Guardrails AI is LLM I/O only. | Competitive positioning — Keel is the only tool doing tool-call-level enforcement. |
| 7 | Context management | MemGPT/Letta non-evictable rule tier. Re-prompting. CoT with rule-checking. RAG supplement. | Rich rule hierarchy (Gap 18) — global → project → local. Rules never evicted from enforcement layer. |
| 8 | Rules files state of art | ALL tools treat rules as advisory. Compaction drops governance. No conflict detection. | CLAUDE.md with YAML frontmatter for machine-enforceable rules. Conflict detection (Gap 2). |
| 9 | User pain points (22 stories) | Deleted inboxes, published hit pieces, broke sandboxes, lied about results, overrode constraints. | Deny-and-continue, circuit breaker, never deny first time, lockup escape (Gap 5), kill switch (Gap 1). |
| 10 | Agent forensics | Audit trails, diff detection, shell monitoring, anomaly detection, signed receipts. | Audit log in JSONL. Reference existing audit-trail-integrity.ts (Gap 10). |

### Round 2 — Adversarial & Deep Dive (10 agents)

| # | Agent Focus | Finding | Where Addressed |
|---|-------------|---------|-----------------|
| 11 | Frontier labs internal | Anthropic: three-tier containment, Clio monitoring, classifier-based action gate, strip agent reasoning from safety classifier. | Self-learning architecture (Clio-inspired privacy-preserving trace analysis). Agent reasoning awareness (Gap 13). |
| 12 | Open source orchestrators | LangGraph interrupts, CrewAI guardrails, Flowise pre-declared state keys, Temporal deterministic replay. | Interceptor pattern in OpenCode. Tiered enforcement pipeline. |
| 13 | Agent SDK guardrails | Google ADK: BEST mutation capability (callbacks can modify args). OpenAI SDK: BEST guardrail abstraction (4 types). | Auto-fix / argument mutation (Gap 16) — inspired by Google ADK. |
| 14 | Formal methods | AgentSpec (ICSE 2026): 1-4ms overhead, 90%+ prevention. Fides: IFC for agents. Reference monitor pattern. | Sequence rules (Gap 6) — AgentSpec-inspired. Information flow control (Gap 7) — Fides-inspired. |
| 15 | Cryptographic trust | Nobulex: Ed25519 + SHA-256 hash chain. OWASP AST09 bilateral receipts. Offline verification. | Deferred to P3. Learning layer trace data can feed into signed receipts later. |
| 16 | Agent monitoring startups | Pipelock (egress proxy, MCP scanning). Clawdstrike (kernel+agent fusion). Vigils (local-first MCP). | Competitive awareness. Keel's differentiator: hooks + egress + attestation + HITL in one product. |
| 17 | MCP security | MCP spec has minimal security. A2A has better design (mandatory auth, agent card signing). Gateway layer is best hook point. | MCP threat model (Gap 9). Protocol-agnostic enforcement layer. |
| 18 | Big tech enforcement | Microsoft/Google/Amazon/Salesforce: NO tool-call-level policy enforcement. NO custom behavioral rules. NO agent-to-agent policy. | Validates Keel's positioning: "The big platforms guard the prompt and output. Keel guards what the agent actually DOES." |
| 19 | Adversarial critique | Sidecar death, TOCTOU, compliance theater, sync nightmare, overengineered audit, underengineered prevention. | Sidecar dropped. Ed25519 deferred for local dev. Prompt injection defense via reasoning awareness. Network controls via sequence rules + IFC. |
| 20 | Agent forensics standards | SPIFFE/SPIRE (P0 identity). ATR (768 rules, Microsoft+Cisco). OTEL GenAI semantics. NIST AI 600-1 draft. | ATR integration (Gap 9). SPIFFE deferred (P3). OTEL deferred (P3). |

### Round 3 — Protection Dial & Performance (5 agents)

| # | Agent Focus | Finding | Where Addressed |
|---|-------------|---------|-----------------|
| 21 | Graduated protection tiers | OWASP CRS: executing PL vs. blocking PL. ESLint: off/warn/error. EDR: slider with named tiers. | Three protection levels (sprint/balanced/protect). Three knobs (rule set, action, depth). |
| 22 | Enforcement performance | DSL checks: 1-4ms. Hooks: 1-5ms. Seccomp: 1-5us. Secret scanning: 1-10ms. LLM judges: 1-10s (avoid). | Tiered pipeline (cheapest first). Cache eliminates 80-95% of checks. LLM eval only in deep mode. |
| 23 | Caching/lazy enforcement | Session-scoped cache, Gitleaks baselines, progressive enforcement, known-good hashes, tiered cost pipeline. | Session cache + persistent store. Incremental checking (only changed files). Progressive enforcement (warn→deny escalation). |
| 24 | Frontier lab speed/safety | Anthropic: two-stage classifier (fast: 8.5% FPR → thorough: 0.4% FPR). Deny-and-continue. In-project ops skip classifier. | Tiered pipeline (Tier 1-4 fast, Tier 5-6 thorough). Deny-and-continue. Sprint mode skips content scans. |
| 25 | False positive patterns | "Cry wolf" effect. 1 false deny erodes more trust than 100 correct denies build. Never deny first time. Circuit breakers. | Never deny first time. 1-click override. Circuit breaker. Show your work in deny messages. Learning mode. |

### Round 4 — Gap Analysis (final audit identified 21 gaps + self-learning)

| # | Gap | Where Addressed |
|---|-----|-----------------|
| 1 | Kill switch | P0. `keel disable` / `keel enable` |
| 2 | Rule conflict detection | P0. `keel validate` |
| 3 | Dry-run/rule testing | P0. `keel test "git push --force"` |
| 4 | Learning mode | P0. Observe → suggest → enforce |
| 5 | Lockup escape (circuit breaker) | P0. 3 denies in 60s → escalate |
| 6 | Sequence rules | P1. Multi-step action sequences |
| 7 | Information flow control | P1. Read→send tracking |
| 8 | Rule versioning/drift | P1. Auto-detect CLAUDE.md changes |
| 9 | MCP threat model | P1. MCP tool-injection detection |
| 10 | Existing audit-trail-integrity.ts | P1. Reference existing code |
| 11 | ATR integration (768 rules) | P2. npm install agent-threat-rules |
| 12 | Subagent rule propagation | P2. Inherit parent rules |
| 13 | Agent reasoning awareness | P0. WHY vs. WHAT evaluation |
| 14 | Rate limiting/quota | P2. Types exist, wire in |
| 15 | Time-based enforcement | P2. Types exist, wire in |
| 16 | Auto-fix/argument mutation | P2. Replace allow/deny with fix outcome |
| 17 | Rego/OPA backend | P1. rego-engine.ts exists |
| 18 | Rich rule hierarchy | P1. Global → project → local |
| 19 | Subagent edge cases | P3. Inheritance contracts |
| 20 | Session duration as risk | P2. Escalate scrutiny on long sessions |
| 21 | CI/CD vs. local context | P1. Context field on rules |
| — | Self-learning architecture | Deterministic core + learning layer. `keel suggest`. Never auto-changes rules. |

---

## Remaining Edge Cases (Informed but Not Directly Addressed)

| Topic | Why Not in Plan |
|-------|-----------------|
| Formal verification of core logic (Clawdstrike Lean 4) | Overkill for MVP. Core logic is simple enough to verify with tests. |
| Multi-tenant enterprise deployment | Customer Zero is a single developer. Defer until Phase 2/3. |
| Blockchain anchoring of audit trail | Overengineering for personal use. Add if compliance requirements demand it. |
| TEE/confidential computing for agent execution | Infrastructure complexity not justified for single-user desktop tool. |
| 3-UID model (Pipelock operator/proxy/agent) | OS-level process identity for multi-agent scenarios. Defer to Phase 3. |

---

## Summary

**35+ research agents. 21 identified gaps. 1 self-learning architecture. 0 uncovered findings.**

Every research finding maps to a specific feature, gap, or design decision in the plan. The remaining edge cases are explicitly identified and deferred — not missed.
