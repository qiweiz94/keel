# How keel compares

A map of the space, and where keel sits in it. Every project listed here is solving a
real problem — mostly a *different* one. This page is meant to help you pick the right
tool, including when that tool isn't keel.

> **On numbers:** this page deliberately carries no star counts or benchmark figures.
> They rot within weeks and can't be verified by a reader months later. Links go to the
> projects themselves so you can check current state yourself.

---

## The category distinction that matters

Most "AI guardrail" tools fall into one of four groups. They are not substitutes.

| Group | Enforces on | Example projects | Can the agent ignore it? |
|---|---|---|---|
| **Prompt-based guidance** | the model's attention | `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, agent memory/skills | Yes — it's a request |
| **Output validation** | LLM text responses | [Guardrails AI](https://github.com/guardrails-ai/guardrails) | N/A — validates text, not tool calls |
| **Static analysis** | source code, after it's written | [Semgrep](https://github.com/semgrep/semgrep) | Findable after the fact; the write already happened |
| **Tool-call interception** | the action, before it runs | **keel**, [Cupcake](https://github.com/eqtylab/cupcake), and others below | No — the call is gated |

keel is in the fourth group. If what you need is "stop bad code from reaching main,"
Semgrep is a better answer. If you need "stop the agent from running `rm -rf` or
force-pushing at 2am," that's this group.

### Why prompt-based guidance isn't enforcement

This is keel's core premise, so it should be checkable rather than asserted:

- Anthropic's own documentation describes `CLAUDE.md` as something Claude "reads and
  tries to follow," without a guarantee of strict compliance.
- Instruction-following degrades as context grows — the "Lost in the Middle" effect
  ([Liu et al., 2023](https://arxiv.org/abs/2307.03172)) shows retrieval accuracy
  dropping for content in the middle of long contexts.
- Compaction discards earlier turns by design.
- An agent that *wants* to proceed can use `--no-verify`, `core.hooksPath`, or direct
  file writes to route around anything advisory.

None of that makes prompts useless — keel ships standing requirements precisely because
prompts help. It makes them insufficient *on their own*.

---

## Tool-call interception: who does what

| Project | Interception point | Policy language | Notable strength |
|---|---|---|---|
| **keel** | host hooks/plugins (8 hosts), MCP, generic stdin | YAML (enforced); Rego/WASM tooling exists but is experimental and NOT wired into enforcement — see below | breadth of hosts; approval gates; signed receipts |
| [Cupcake](https://github.com/eqtylab/cupcake) | tool-call hooks | Rego compiled to WASM | deterministic policy evaluation |
| [agentsh](https://github.com/canyonroad/agentsh) | OS kernel (seccomp, eBPF, Landlock) | Go config | strongest enforcement boundary — survives a compromised agent process |
| [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit) | in-process SDK | YAML / OPA | formal specs, conformance test suite, OWASP Agentic Top 10 mapping |
| [Snyk Agent Scan](https://github.com/snyk/agent-scan) (formerly Invariant MCP-Scan) | none — scanner | — | MCP config discovery and vulnerability scanning |

**On the Rego/WASM cell specifically, since this table puts keel next to
Cupcake (whose entire mechanism IS Rego/WASM):** keel ships
`packages/cli/src/rego-engine.ts` and a standalone `keel policy
init|build|eval` CLI command set for writing and hand-evaluating `.rego`
policies compiled to WASM — but no `.rego`/`.wasm` policy is ever consulted
when an agent actually takes an action. `keel hook`, the OpenCode plugin,
and `keel daemon` all evaluate only YAML `rules.yaml`. Treat this as an
experimental, unsupported side tool, not a second enforced policy language
on par with Cupcake's — see `SPEC.md`'s "Rego/OPA Backend" section and
`ROADMAP.md` for the honest version of this line.

**Where keel is genuinely weaker:** `agentsh` enforces at the kernel. keel enforces
in-process, which means a compromised agent process defeats it — stated plainly in
[SECURITY.md](../SECURITY.md). If your threat model includes a hostile agent binary
rather than a careless one, kernel-level sandboxing is the correct choice. See
[docs/defense-in-depth.md](defense-in-depth.md) for a layered pattern that combines
keel with a container/microVM boundary rather than treating this as an either/or.

**Where the Microsoft toolkit is ahead:** formal specifications and conformance testing.
That's a discipline worth copying, not a gap to spin.

---

## What keel actually offers

Three independent enforcement surfaces, so a single misconfiguration doesn't drop
protection to zero:

```
1. Tool-call interception  — plugin/hook per host, before execution   (primary)
2. Git hooks               — commit-time, works with ANY agent        (keel init --hooks)
3. CLI / CI / MCP          — keel evaluate, keel enforce --ci, keel serve
```

The second is the one people underestimate: git hooks are agent-agnostic, so they cover
tools keel has no adapter for — including ones with no interception point at all.

Beyond that:

- **Approval gates** (`action: prompt`) — irreversible operations block until a human
  runs `keel allow <id> --once`. Never downgraded by the protection level.
- **Signed, hash-chained receipts** — tamper-evident enforcement history (`keel verify`).
- **A speed dial** — `sprint` / `balanced` / `protect`, because a guardrail that can't be
  loosened gets uninstalled instead.
- **Honest host verification levels** — [docs/integrations.md](integrations.md) marks each
  host `live`, `types`, or `docs` rather than implying all are equally proven.
- **`keel scan`** — audits which agents on a machine have no enforcement at all, and
  flags MCP servers running unpinned packages or plaintext transports.

### Spend control: a rolling alert, a rolling rate limit, or a session budget

LLM-spend tooling looks like one category from a distance but splits into two on
inspection, and it's worth being precise about which side keel's `type: budget` rule
sits on:

- **Langfuse** — alerts and dashboards only. Its own docs describe the mechanism as
  "[set up alerts](https://langfuse.com/docs/observability/features/alerts): get
  notified automatically when spend crosses a threshold," alongside a dashboard for
  browsing cost by model/tag/user. Nothing in Langfuse's documented model-usage-and-cost
  flow stops a call from happening.
- **Helicone** — genuinely does block, but on a different axis than "this session is
  over budget." Its rate-limit header supports a cost-based unit (`u=cents`, e.g.
  "500 cents = $5") that returns a real `429` when tripped — that's real enforcement,
  not just an alert. But it's a **rolling time-window** limit (`w=<seconds>`, minimum
  60), not a cumulative session or task total, and it only fires for traffic actually
  routed through Helicone's own gateway (`ai-gateway.helicone.ai`) — it enforces at a
  network proxy sitting in front of the model, not at the point a coding agent decides
  to keep working.
- **keel's `type: budget` rule** (`session-spend-limit`) measures real spend directly
  from a host's own local transcript or session record — a Claude Code JSONL
  transcript's usage fields, an OpenCode session row's `cost`/token columns — with no
  proxy or network intermediary in the path at all. It tracks a **cumulative session
  total** against `max_tokens`, not a per-minute burn rate, and enforcement happens at
  the tool-call boundary itself: measure at Stop/PostToolUse, persist the verdict, deny
  the *next* PreToolUse call if over budget (two-phase by construction, because Claude
  Code's Stop hook cannot itself block — see `packages/core/src/enforce/budget-tracker.ts`).

**Be precise about what's shipped today.** `session-spend-limit` ships `mode: observe`
in the default install — evaluated and recorded on every matching call, never
interrupting yet. That's not the same caution that keeps Langfuse alert-only by design;
it's a narrower, stated reason: the Claude Code reader depends on model-string
normalization with a real failure mode (a short alias like `claude-sonnet-5` must never
get silently priced as an official dated model ID), and that needs to survive real
traffic before this rule denies anything (see [docs/tiers.md](tiers.md)). The honest
framing is "capable of hard enforcement, unlike Langfuse's alert-only design — not yet
interrupting by default, unlike Helicone's proxy rate limit which already does." Promoting
it to `warn`/`block` is a one-line `rules.yaml` edit once a deployment has burned it in.

---

## Choosing

| If you need… | Use |
|---|---|
| Stop an agent running destructive commands, now | keel |
| Enforcement that survives a compromised agent process | agentsh, or a container |
| Vulnerabilities in the code your agent wrote | Semgrep, Snyk |
| Audit MCP servers for supply-chain risk | `keel scan`, Snyk Agent Scan |
| Validate LLM text output against a schema | Guardrails AI |
| Enterprise policy with formal conformance testing | Microsoft AGT |

These compose. Running keel and Semgrep together is a reasonable setup — they gate
different things at different times.
