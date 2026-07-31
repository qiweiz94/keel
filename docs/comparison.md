# keel vs. Other Projects

## How keel Differs from Prompt-Based Approaches

CLAUDE.md, AGENTS.md, .cursorrules, .clinerules, and AI agent memory/skills are all **prompt-based governance**. They inject instructions into the AI's system prompt and *hope* the AI follows them.

Research proves this is structurally unreliable:

- Anthropic's own docs state: *"Claude reads it and tries to follow it, but there's no guarantee of strict compliance."*
- Andriushchenko et al. (ICLR 2025) achieved **100% attack success rate** on GPT-4o, Claude 3, and Llama-3
- As context grows, initial instructions are diluted and forgotten
- The AI can "self-bypass" using `--no-verify`, `core.hooksPath`, MCP API writes
- Prompt injection from external files overrides governance instructions

**keel operates at a different layer entirely.** It intercepts tool calls BEFORE execution using:
1. **PreToolUse hooks** (Claude Code, Cline) — hooks fire before the tool runs; the AI receives a `permissionDecision: "deny"` it cannot override
2. **Git hooks** (any AI tool) — catches violations at commit time; works with every AI coding assistant
3. **MCP enforcement server** — real-time policy checking via the Model Context Protocol

| Approach | Mechanism | Can AI Ignore? | Example |
|----------|-----------|---------------|---------|
| Prompt-based | Instructions in system prompt | ✅ Yes — trivially | CLAUDE.md, AGENTS.md, .cursorrules |
| Memory/Skills | Optional context loaded by AI | ✅ Yes — AI chooses to use | Claude memory, skill directories |
| **Hard enforcement** | OS/hook-level block before execution | ❌ No — cannot override | **keel** |

---

## Competitive Landscape

### Comparison Matrix

| Capability | Cupcake | agentsh | Aegis | DashClaw | MS AGT | Guardrails | block-no-verify | Semgrep | Snyk Agent Scan | **keel** |
|---|---|---|---|---|---|---|---|---|---|---|
| **Hard enforcement** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ⚠️ (post-hoc) | ❌ | **✅ 3 layers** |
| **PreToolUse hook** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | **✅** |
| **Git hook level** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | **✅** |
| **MCP enforcement** | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ⚠️ (scan only) | ✅ | **✅** |
| **Git bypass prevention** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | **✅** |
| **Cross-platform** | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | **✅** |
| **Secret detection** | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | **✅** |
| **Audit logging** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | **✅** |
| **Policy-as-code** | Rego | YAML | JSON | YAML | YAML/OPA | Rail | ❌ | YAML | ❌ | **YAML** |
| **CI/CD integration** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | **✅ GitHub Action** |

### Detailed Project Analysis

#### Cupcake (eqtylab/cupcake)
- **Stars**: 282 | **Language**: Rust | **License**: Apache 2.0
- **What it does**: Policy enforcement via OPA/Rego compiled to WASM. Intercepts tool calls through hooks.
- **Strengths**: Deterministic evaluation via Rego/WASM. Multi-agent support.
- **Gaps**: No git hook enforcement. No MCP enforcement server. No secret scanning. No bypass prevention. Single enforcement layer.
- **What we can learn**: Rego-as-WASM for deterministic policy evaluation is powerful — we should add optional Rego engine.

#### agentsh (canyonroad/agentsh)
- **Stars**: 363 | **Language**: Go | **License**: Apache 2.0
- **What it does**: OS-level execution sandboxing via seccomp, eBPF, FUSE, Landlock, ESF. Intercepts at kernel level.
- **Strengths**: Hardest enforcement (kernel-level). Cannot be bypassed by any AI process.
- **Gaps**: No git hook enforcement. Requires kernel dependencies. No CLI/CI mode. Heavy infrastructure.
- **What we can learn**: Optional OS sandbox mode (`keel sandbox`) for high-security environments.

#### Aegis (Justin0504/Aegis)
- **Stars**: 370 | **Languages**: Python, TypeScript, Go | **License**: MIT
- **What it does**: Pre-execution firewall with 5-stage pipeline (Classify, Anomaly, Evaluate, DSL Match, Decide). HTTP/MCP proxy.
- **Strengths**: Anomaly detection pipeline. Multi-language SDK support. Fine-grained classification.
- **Gaps**: No git hook enforcement. Single point of failure (proxy). No bypass prevention.
- **What we can learn**: Anomaly detection classifier could detect novel attack patterns.

#### DashClaw (ucsandman/DashClaw)
- **Stars**: 287 | **Languages**: TypeScript, Python | **License**: MIT
- **What it does**: PreToolUse hooks with remote approval, Ed25519-signed audit ledger, calibrated interruption controller.
- **Strengths**: Tamper-evident audit logs. Remote approval flow. Calibrated interruptions prevent hook timeouts.
- **Gaps**: Documented **18-day enforcement blackout** due to hook misconfig. No git hooks. Single enforcement layer.
- **What we can learn**: Ed25519-signed audit log — prevents tampering with enforcement history.
- **Note**: The 18-day blackout incident is the best argument for multi-layer enforcement.

#### Microsoft Agent Governance Toolkit (microsoft/agent-governance-toolkit)
- **Stars**: 4,900 | **Languages**: Python, TS, Rust, Go, C# | **License**: MIT
- **What it does**: Full policy engine with identity, trust scoring, execution sandboxing, audit, SRE. 10 formal specs, 992 conformance tests. OWASP Agentic Top 10 coverage.
- **Strengths**: Most comprehensive policy engine. Multi-language SDK. Formal specs + extensive tests.
- **Gaps**: In-process enforcement only (if the agent process is compromised, enforcement is bypassed). No git hooks. No bypass prevention. Microsoft-centric.
- **What we can learn**: The formal spec + conformance test approach. We should write spec docs and aim for similar test coverage.

#### Guardrails AI (guardrails-ai/guardrails)
- **Stars**: 7,200 | **Language**: Python | **License**: Apache 2.0
- **What it does**: LLM input/output guardrails. Validates LLM responses against schemas and risk policies. Client-side validation.
- **Strengths**: Pre-built "Hub" of validators. Snowglobe simulation testing. Largest community in this space.
- **Gaps**: Not agent-tool enforcement at all. Text-only validation. Model can ignore guardrails. Not coding-assistant specific.
- **What we can learn**: The Hub concept — a community library of reusable policy templates.

#### block-no-verify (tupe12334/block-no-verify)
- **Stars**: 6 | **Language**: TypeScript | **License**: MIT
- **What it does**: Blocks `--no-verify`, `core.hooksPath` overrides, MCP API direct writes, and hook-manager disable env vars.
- **Strengths**: Comprehensive git bypass prevention. Uses Polyhook for cross-platform support.
- **Gaps**: Single-purpose (git bypass only). No file/command/secret protection. No policy engine.
- **What we can learn**: MCP API write detection — we improved `checkHookBypass` based on this.

#### Semgrep (semgrep/semgrep)
- **Stars**: 16,000 | **Language**: OCaml/Python | **License**: LGPL 2.1
- **What it does**: Static analysis (SAST) for code quality and security. Can run as pre-commit hook or via MCP.
- **Strengths**: Largest community. Thousands of rules. Fast scanning.
- **Gaps**: Post-hoc only (scans code after it's written). No real-time enforcement. AI can bypass with `--no-verify`.
- **What we can learn**: Community rule ecosystem. Users share thousands of rules.

#### Snyk Agent Scan (formerly Invariant Labs MCP-Scan)
- **Stars**: 2,800 | **Language**: Python | **License**: Apache 2.0
- **What it does**: Scans MCP servers, agent skills, and configurations for vulnerabilities. Auto-discovers MCP configs across all major tools.
- **Strengths**: Comprehensive MCP vulnerability scanning. Auto-discovers configs from Claude Code, Cursor, Windsurf, VS Code, Gemini CLI, and more.
- **Gaps**: Scan-only (detective, not preventative). No runtime enforcement. No blocking.
- **What we can learn**: Auto-discover tool configurations — `keel scan` command that detects which AI tools are configured.

---

## What keel Does Differently

### Three Enforcement Layers (No Other Project Has This)

```
Layer 1: PreToolUse Hook (real-time, BEFORE execution)
Layer 2: Git Hook (commit-time, ANY tool)
Layer 3: MCP/CLI/CI (manual, pipeline, audit)
```

Every other project has exactly **one** enforcement layer. If that layer fails, protection drops to zero. keel requires **three independent failures** to lose protection.

### Cross-Platform Git Enforcement
Git hooks work with EVERY AI coding assistant — Cline, Claude Code, Cursor, GitHub Copilot, Aider, Windsurf, Devin. This is the universal enforcement surface.

### Git Bypass Prevention
Only block-no-verify addresses this, and only for git bypass. keel combines git bypass prevention with file/command/secret protection and audit logging.

### Secret Detection in Git Hooks
Only Semgrep does this (post-hoc), and it can be bypassed with `--no-verify`. keel catches secrets at commit time AND prevents bypass.

---

## What We Should Learn From Each Project (Roadmap)

| Priority | Feature | Source | Effort | Status |
|----------|---------|--------|--------|--------|
| P0 | Policy template library (`keel template`) | Guardrails AI | 2 days | ✅ Done |
| P0 | MCP API write detection (improved) | block-no-verify | 1 day | ✅ Done |
| P1 | Auto-discover tool configs (`keel scan`) | Snyk Agent Scan | 3 days | ✅ Done |
| P1 | Tamper-evident audit logs (Ed25519 signed) | DashClaw | 2 days | ✅ Done |
| P1 | ATR rule import (10 categories + lanes) | Agent Threat Rules | 5 days | ✅ Done |
| P2 | Rego as optional policy engine | Cupcake | 5 days | ✅ Done (partial — requires `@open-policy-agent/opa-wasm`) |
| P2 | Reasoning trace analysis | Adrian | 5 days | ✅ Done |
| P2 | Fail-closed guarantee | Doberman | 2 days | ✅ Done |
| P2 | Anomaly detection classifier | Aegis | 5 days | 📋 Planned |
| P2 | Signed action receipts (evidence trail) | Pipelock | 3 days | 📋 Planned |
| P3 | MCP security gateway (bidirectional proxy) | Pipelock, AGT | 5 days | 📋 Planned |
| P3 | OS-level sandbox (`keel sandbox`) | agentsh | 3 weeks | 🔮 Future |
| P3 | Formal specs + conformance tests | MS AGT | Ongoing | 🔮 Future |

---

## Key Insight: Why Multi-Layer Matters

DashClaw documented a real incident where a hook configuration error disabled ALL enforcement for **18 days**. The team **didn't notice** because the audit log showed decisions that were never applied.

With keel's three layers:
- If the PreToolUse hook fails → git hook catches it at commit time
- If git hooks are bypassed → CI/CD pipeline catches it
- If all three fail → audit log provides forensic evidence

**Three independent enforcement layers means three independent failures needed for a breach.**
