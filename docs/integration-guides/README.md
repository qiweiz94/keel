# Integration guides — index

Per-host setup guides. For the honest Block/Warn verification matrix across
every host (what's `live`, `types`, or `docs`-confidence), see
[`docs/integrations.md`](../integrations.md) — that page is the single
source of truth for verification claims; the guides below link to it rather
than restate it.

## Natively-supported hosts (`keel install --<flag>`)

| Host | `keel install` flag | Can block? | Guide |
|---|---|---|---|
| OpenCode | `--opencode` | **Yes — live-verified, block and warn** | [`opencode.md`](opencode.md) |
| OpenClaw | `--openclaw` | Yes (via keel daemon) | [`openclaw.md`](openclaw.md) |
| Claude Code | `--claude-code` | Yes (live-verified block) | [`claude-code.md`](claude-code.md) |
| Cline | `--cline` | Yes (types-verified) | [`cline.md`](cline.md) |
| Gemini CLI | `--gemini` | Yes (types-verified) | [`gemini.md`](gemini.md) |
| Cursor | `--cursor` | Yes (docs-verified) | [`cursor.md`](cursor.md) |
| Codex CLI | `--codex` | Yes (docs-verified) | [`codex.md`](codex.md) |
| Hermes | `--hermes` | Yes (via keel daemon) | [`hermes.md`](hermes.md) |

`keel install --all` wires every one of them at once.

## Advisory-only hosts (no tool-interception point)

These hosts have no hook keel can attach a blocking check to. The
integration is a standing-requirements file the agent reads at session
start — a reminder, not a control. For hard enforcement on the same project,
also install one of the natively-supported hosts above.

| Host | Guide |
|---|---|
| Aider | [`aider.md`](aider.md) |
| GitHub Copilot | [`github-copilot.md`](github-copilot.md) |

## Anything else

Two universal paths need no bespoke adapter or guide:

- **`keel serve`** — an MCP server (7 tools) for any MCP-capable client:
  Windsurf, Zed, Continue, JetBrains AI, and others.
- **`keel hook generic`** — a plain stdin contract (`{tool, args}` in, exit 0
  allow / exit 2 block) for wrapping anything that can shell out before it
  acts.

Full detail on both, and the hosts with no interception point at all (where
even the advisory layer doesn't apply): [`docs/integrations.md`](../integrations.md).

## Coverage notes (as of this pass)

- Every host `keel install` has a flag for now has a guide. Before this
  pass, `opencode` — the only `live`-verified host, and the host the thesis
  experiment ([`session/v04/EXPERIMENT.md`](../../session/v04/EXPERIMENT.md))
  actually ran on — had none; `codex`, `gemini`, `openclaw`, and `hermes`
  were also missing.
- `cursor.md` and `cline.md` predated the real blocking hooks
  `keel install --cursor`/`--cline` now wire (`.cursor/hooks.json` +
  `beforeShellExecution`/`beforeMCPExecution`, and `~/.cline/hooks/PreToolUse`
  respectively) — both described those hosts as advisory-only. Both guides
  are corrected in this pass to describe the real hook. The install
  command's own console output for Cursor and Codex CLI still prints a
  stale "no blocking hooks — advisory only"-style line in one or two spots
  (`packages/cli/src/commands/install.ts`); flagged in `codex.md`'s
  Verification status section rather than silently patched, since it's a
  source-code change outside this docs pass's scope.
