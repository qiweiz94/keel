# keel integrations — what is supported, and how well

One page for "which platforms does keel work with". The **Verified** column is the
important one: it says how much each row has actually been proven, rather than
implying that everything listed is equally solid.

Verification levels, strongest first:

| Level | Means |
|---|---|
| **live** | keel was loaded and exercised inside the real host on a machine that has it installed |
| **types** | built against the host's installed type definitions or package source, not its docs |
| **docs** | built from published documentation only — the host is not installed here, so the payload shape is unconfirmed |

That distinction is not pedantry. Three times in this project the published docs were
wrong where the installed types were right: OpenClaw's `before_tool_call` event carries
fewer fields than documented, its `requireApproval.timeoutBehavior` is undocumented, and
Cline's real control channel is a `HOOK_CONTROL` line that appears in no doc page.

---

## Native enforcement

Every one of these evaluates a tool call **before it runs** and can stop it.

| Host | Install | Interception point | How it blocks | Verified |
|---|---|---|---|---|
| OpenCode | `keel install --opencode` | `tool.execute.before` plugin | throws | **live** |
| OpenClaw | `keel install --openclaw` | `before_tool_call` plugin | `block: true` / `requireApproval` | **live** — `openclaw plugins list` reports it loaded |
| Claude Code | `keel install --claude-code` | `PreToolUse` hook | exit 2 | types |
| Cline | `keel install --cline` | `PreToolUse` hook | `HOOK_CONTROL` + `cancel: true` | types — read from installed `@cline/core` |
| Gemini CLI | `keel install --gemini` | `PreToolUse` hook | exit 2 | types — Claude-Code-compatible per `gemini hooks migrate --from-claude` |
| Cursor | `keel install --cursor` | `beforeShellExecution` / `beforeMCPExecution` | `{permission: deny\|ask}` | docs |
| Codex CLI | `keel install --codex` | `PreToolUse` hook | exit 2 | docs |
| Hermes | `keel install --hermes` | `pre_tool_call` plugin | `{"action": "block"}` | docs |

`keel install --all` installs every one of them.

### What each host can and cannot do

Capabilities differ, and keel does not pretend otherwise:

| Host | Blocks | Approval gate | Rewrite tool args (`fix` rules) |
|---|---|---|---|
| OpenCode | ✅ | ✅ | ✅ |
| OpenClaw | ✅ | ✅ (fails **closed** on timeout) | ✅ |
| Claude Code / Gemini / Codex | ✅ | ✅ (as a block with the approval path in the message) | ❌ |
| Cline | ✅ | ✅ (as a cancel) | ❌ |
| Cursor | ✅ | ✅ (routes to Cursor's own `ask` UI) | ❌ |
| Hermes | ✅ | ✅ (`approve` — its human gate) | ❌ — `pre_tool_call` cannot modify args, so `fix` rules are advisory there and the installer says so |

---

## Universal paths — no adapter needed

**MCP server** (`keel serve`) exposes 7 tools — `keel_check`, `keel_audit`,
`keel_requirements`, `keel_research`, `keel_fetch`, `keel_search_cache`,
`keel_hypothesis`. Any MCP-capable client can use keel with no keel-specific code:
Windsurf, Zed, Continue, JetBrains AI, and others. This is advisory rather than
blocking — the agent chooses to call it — but it needs no integration work.

**Daemon REST** (`keel daemon`) serves `/v1/check`, `/v1/requirements`, `/v1/health`,
`/v1/research`, `/v1/research/cache`, `/v1/hypothesis`, `/v1/outcome` on
`127.0.0.1:31990` with a bearer token from `~/.keel/daemon-token`. Anything that can
make an HTTP request can enforce through it, in any language.

**`keel hook generic`** — the contract for a host with no bespoke adapter:

```
stdin  : {"tool": "bash", "args": {"command": "rm -rf /"}}
stdout : the block reason, if blocked
exit   : 0 = allow, 2 = blocked
```

That is how Goose, Roo, Kilo, Amp, n8n or a homegrown wrapper integrate today. Adding a
*named* host on top of it is an entry in `HOSTS` (`packages/cli/src/commands/hook.ts`)
plus a branch in `parsePayload`/`renderVerdict` and a test — not a new script.

---

## No interception point exists

Stated plainly rather than left as a gap for the reader to fill in optimistically:

| Host | Why | Best available |
|---|---|---|
| Aider | no plugin or hook API; only a blanket `--yes` confirm toggle | MCP, or wrap the shell it calls |
| GitHub Copilot cloud agent | governance is a network-egress allowlist, not a per-tool-call gate, and it does not cover MCP servers | MCP allowlisting, egress proxy |
| MCP protocol itself | the spec is explicit that consent is a host responsibility, not a protocol guarantee; the interceptor proposal (SEP-1763) is an unsponsored draft | rely on the host's own hook |

---

## Failure behaviour

Two things every adapter gets right, because getting them wrong is how guardrails end up
uninstalled or silently absent:

**Blocking verdicts all block.** `deny`, `block`, `prompt`, `redirect` and `research`
each stop the call. `prompt` used to exit 0 from `keel evaluate`, which made every
approval gate a no-op in every shell-hook host — destructive SQL, protected-branch
pushes, remote execution, history rewrites and publishing all passed through.

**Advisory verdicts never block, but are never silent either.** keel's ladder is
warn-once-then-block, so the first violation of every deny rule arrives as `warn`.
Swallowing it would mean you see nothing, then a hard block on the repeat, with no
warning in between.

**Hermes and OpenClaw fail open by design** — a plugin that throws is skipped and the
call proceeds. Since a thin client cannot bundle the rule engine, both keel plugins
carry a local circuit breaker: if the daemon is unreachable they block only catastrophic
irreversible operations (`rm -rf /`, force-push to a protected branch, `DROP TABLE`,
fork bombs, `mkfs`, raw block-device writes), allow ordinary work, and print a loud
DEGRADED notice. Blocking everything when the daemon is down is what gets a plugin
uninstalled; blocking nothing is what makes it a lie.
