# Phase 4 research — Hermes + OpenClaw thin clients, OpenCode daemon-first

Researched 2026-08-04 · sources fetched this session, dates noted per source ·
status: **findings + plan, nothing implemented**

Scope (from §5 Phase 4 of `problem-solving-harness.md`): Hermes `pre_tool_call`
plugin, OpenClaw native TS plugin, both as thin daemon clients
(`keel install --hermes` / `--openclaw`), plus migrating the OpenCode plugin to
be daemon-first.

---

## 1. Sources and their freshness

| Source | URL | Date / version shown |
|---|---|---|
| Hermes plugin developer guide | `hermes-agent.nousresearch.com/docs/developer-guide/plugins` | **no date, no version on page** |
| Hermes hooks (secondary) | search summary of `hermes-agent-docs` | doc repo states verified 2026-05-18; Hermes Agent v0.2.0 |
| OpenClaw plugin hooks | `docs.openclaw.ai/plugins/hooks` | **no date, no version on page** |
| OpenClaw SDK overview | `docs.openclaw.ai/plugins/sdk-overview` | **no date**; mentions a 2026-08-12 legacy-field deprecation |
| OpenClaw building plugins | `docs.openclaw.ai/plugins/building-plugins` | **no date**; references version `2026.3.24-beta.2`, `doc-schema-version: 1` |
| OpenClaw issue #20914 | `github.com/openclaw/openclaw/issues/20914` | opened 2026-02-19, **closed 2026-03-29 as `stale`** |

Freshness caveat, stated plainly: the OpenClaw plugin pages carry **no
last-updated date and no version**, and the only version string found anywhere
is `2026.3.24-beta.2` — a beta, ~4 months old. Anything below sourced only from
those pages is "documented", not "verified against a dated release".

---

## 2. Hermes — the shape is real, but it is Python

**Design-doc correction.** §5 Phase 4 pairs "Hermes `pre_tool_call` plugin" with
"OpenClaw native TS plugin". The hook name is right; the implicit language
assumption is not. Hermes plugins are **Python** with a YAML manifest:

```
~/.hermes/plugins/<name>/
  plugin.yaml      # name, version, provides_hooks: [pre_tool_call], requires_env
  __init__.py      # def register(ctx): ctx.register_hook("pre_tool_call", cb)
```

There is no shared-TypeScript path here. "Thin client" on Hermes means a small
Python HTTP client against the daemon's `/v1/check`, not reused keel code.

**The hook keel needs:**

| Hook | Signature | Return |
|---|---|---|
| `pre_tool_call` | `tool_name, args, task_id` | `{"action": "block"\|"approve", "message": ...}` or `None` |
| `post_tool_call` | `tool_name, args, result, task_id, duration_ms` | ignored |
| `pre_llm_call` | `session_id, user_message, conversation_history, is_first_turn, model, platform` | `{"context": "..."}` — the requirements-injection channel, **10,000-char cap per hook** |
| `on_session_start` / `on_session_end` | `session_id, model, platform` | ignored |

Callbacks may be `async def` or sync, and must accept `**kwargs` for forward
compatibility.

**Verdict mapping:**

| keel action | Hermes |
|---|---|
| `allow` | return `None` |
| `warn` | return `None`, message surfaced via `pre_llm_call` context on the next turn |
| `deny` | `{"action": "block", "message": ...}` |
| `prompt` | `{"action": "approve", "message": ...}` — Hermes' own human gate |
| `redirect` | **no equivalent** — degrades to `block` carrying the directive JSON |
| `fix` (arg rewrite) | **no equivalent** — `pre_tool_call` cannot modify `args` |

---

## 3. OpenClaw — the richest surface of the three

TypeScript. Entry point `definePluginEntry({ id, name, register(api) })` (the SDK
overview also shows a bare `export default async function register(api)`; **pick
one and confirm empirically** — see §6). Manifest `openclaw.plugin.json` (JSON5),
with `activation.onCapabilities: ["hook"]` for a hook-only plugin. Loaded via
`plugins.load.paths` / `plugins.entries.<id>`; a configured `plugins.allow`
allowlist must include it.

`before_tool_call` is a **decision hook** and maps onto keel almost exactly:

```ts
api.on("before_tool_call", async (event) => { ... },
       { matcher: ["exec", "apply_patch"], priority: 50, timeoutMs: 15000 })
```

Event: `{ toolName, params, toolKind, toolInputKind, derivedPaths, runId,
toolCallId, context: { pluginConfig, agentId, sessionKey, runId, abortSignal } }`

Return: `{ params?, block?, blockReason?, requireApproval? }`

| keel action | OpenClaw |
|---|---|
| `allow` | return nothing |
| `deny` | `{ block: true, blockReason }` |
| `prompt` | `{ requireApproval: { title, description, severity, allowedDecisions, onResolution } }` — native `/approve` gate |
| `fix` | `{ params: <rewritten> }` — argument rewriting is first-class |
| `redirect` | **no equivalent** — `{ block: true, blockReason: <directive JSON> }` |

Other hooks worth wiring: `after_tool_call` (observation), `session_start` /
`session_end`, `before_compaction` / `after_compaction` (the requirements
re-injection point, mirroring OpenCode's `experimental.session.compacting`), and
a prompt-contribution hook gated by
`plugins.entries.<id>.hooks.allowPromptInjection: true`.

Semantics that matter: decision hooks run **sequentially, descending priority**;
`block: true` is terminal and skips lower-priority handlers; `block: false` is a
no-op and does **not** clear a prior block; policy-hook timeout defaults to 15s,
overridable per hook via `hooks.timeouts.before_tool_call`.

---

## 4. Three findings that change the plan

### 4.1 Both platforms fail OPEN. keel's posture is fail-closed.

- **Hermes — documented:** "If a hook crashes, it's logged and skipped; other
  hooks and the agent continue." A crashed keel hook = an unguarded tool call.
- **OpenClaw — reported, not documented:** issue #20914, "Plugin load failure
  silently allows all tool calls" — a broken import means `before_tool_call` is
  never registered and every tool call passes. It was **closed as `stale` on
  2026-03-29 without a fix**, and the `critical: true` manifest flag it proposed
  does not appear in the current manifest docs. Treat this as unfixed but
  **verify empirically before building on it** — an issue tracker is not a spec.

This is the opposite of the OpenCode plugin's posture, which fails closed on
malformed rules, on a corrupt kill switch, and on runtime hook failure (all
covered by the load-test). On the new platforms keel cannot guarantee that
posture from inside the plugin. What it *can* do: catch its own errors and
return an explicit block, and make load failure loud. What it cannot do: survive
its own plugin not loading. That limit belongs in §12 (honest boundaries).

### 4.2 Neither platform gives exit codes — the stuck detector degrades.

Hermes `post_tool_call` hands over `result` and `duration_ms`. OpenClaw
`after_tool_call` observes "results, errors, and duration". Neither is
OpenCode's `output.metadata.exit`.

Everything Phase 2a/3 keys on exit codes: `StuckTracker`'s `require_failure` and
`reset_on_success`, `recordAttemptOutcome`, the attempts-to-success and
verification-completion metrics fixed in this session's commit. On Hermes and
OpenClaw those degrade to heuristics over result content unless a failure signal
can be derived from `result` / `errors`. **This is a design decision for the
user, not something to paper over** — the same class of finding as 9d in the
decisions log, and more consequential than the language mismatch.

### 4.3 The OpenCode plugin has zero daemon references today.

Verified: no `daemon`, no `127.0.0.1`, no network call anywhere in
`packages/opencode-plugin/src/plugin.ts` (515 lines). It bundles the whole engine
into a 297 KB single file and evaluates in-process. "Daemon-first migration"
therefore means replacing an in-process engine with a network client, and two
things break:

1. The plugin currently works with **no daemon running at all**. Daemon-first
   needs a fallback, and the fallback posture (in-process engine? fail closed?
   fail open?) is a user decision.
2. `ensureDaemon()` lives in `packages/cli/src/mcp/daemon-client.ts`, not in the
   plugin — the plugin has no spawn path, and adding one puts process management
   inside a hook that runs on every tool call.

---

## 5. Plan (phased, warn-first, capability before enforcement)

**P4.0 — Empirical checks (must run first; see §6).** Two unknowns are only
answerable by running code.

**P4.1 — Daemon client contract.** Extract a documented HTTP contract for
`/v1/check`, `/v1/requirements`, `/v1/outcome` (they exist; `daemon-client.ts`
already exposes `daemonCheck`/`daemonRequirements`/`daemonOutcome`) and write it
down as the interface both new clients target. No new endpoints unless §6 forces
one.

**P4.2 — OpenClaw plugin** (richest surface, lands first, proves the contract):
`before_tool_call` → `/v1/check`; `after_tool_call` → `/v1/outcome`;
`session_start`/`before_compaction` → `/v1/requirements`. Verdict mapping per §3.
Ships with `keel install --openclaw` writing the plugin plus its
`openclaw.plugin.json`, and printing the `plugins.allow` /
`hooks.allowPromptInjection` config the user must add themselves.

**P4.3 — Hermes plugin**: Python `pre_tool_call` → `/v1/check`, `post_tool_call`
→ `/v1/outcome`, `pre_llm_call` → `/v1/requirements` (truncated to the 10k cap).
`keel install --hermes` writes `~/.hermes/plugins/keel/` and prints the
`hermes plugins enable keel` step (plugins are opt-in).

**P4.4 — OpenCode daemon-first**, last and separately reviewable, because it
changes a working guardrail. Gated on an explicit fallback decision from the
user.

**Posture throughout:** warn-first; `redirect` degrades to a block carrying the
directive JSON on both platforms — and unlike OpenCode's redirect, that *does*
consume a block, so the escalation ladder behaves differently per platform. Say
so in the docs rather than pretending parity.

---

## 6. Open questions — two empirical, two for the user

**Empirical (I will run these before writing plugin code):**

1. **OpenClaw `before_tool_call` failure verdict.** Register a hook that throws,
   and one that exceeds `hooks.timeouts.before_tool_call`; observe whether the
   tool ran. Undocumented on every page fetched; #20914 covers *load* failure,
   not *handler* failure.
2. **Whether `after_tool_call` carries anything exit-like.** Log the raw event
   payload. Decides whether §4.2's degradation is real or avoidable.

**For the user:**

3. **Failure posture when the daemon is unreachable** — in-process fallback,
   fail closed, or fail open with a loud warning? Applies to all three clients.
4. **Exit-code substitute.** Accept heuristic failure detection on
   Hermes/OpenClaw, or restrict the stuck detector to platforms with real exit
   codes and say so?

**Also pending:** confirm the entry-point form (`definePluginEntry` vs bare
`export default register`) and check the **2026-08-12** legacy-field deprecation
in the OpenClaw SDK — nine days out, and it could invalidate the entry shape
planned above.
