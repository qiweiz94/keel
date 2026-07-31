# Keel

Enforce rules on AI coding agents — rules that survive context rot, compaction, and agent amnesia.

[![npm](https://img.shields.io/npm/v/@get-keel/cli?label=@get-keel/cli&logo=npm)](https://www.npmjs.com/package/@get-keel/cli)
[![npm](https://img.shields.io/npm/v/@get-keel/opencode-plugin?label=@get-keel/opencode-plugin&logo=npm)](https://www.npmjs.com/package/@get-keel/opencode-plugin)
[![npm](https://img.shields.io/npm/v/@get-keel/core?label=@get-keel/core&logo=npm)](https://www.npmjs.com/package/@get-keel/core)

```bash
npm install -g @get-keel/cli   # or: keel install --opencode after install
keel install --opencode        # Wire the OpenCode plugin
keel validate                  # Check your rules
```

## The Problem

AI agents follow your rules at turn 1, ignore them at turn 20+. The "Lost in the Middle" (Liu et al. 2023) effect causes degradation starting at 8K-16K tokens. Every existing approach (CLAUDE.md, AGENTS.md, .cursorrules) is advisory-only — none enforce.

## The Solution

Keel enforces rules OUTSIDE the agent's context window. Three layers:

1. **OpenCode permissions** — pattern matching in `opencode.json`. Always enforced.
2. **Keel plugin** — hooks tool execution in OpenCode. Warns on first violation, denies on repeat; verification obligations are satisfied only by successful test commands; state survives restarts.
3. **Standing requirements** — injected into the system prompt every turn via `experimental.chat.system.transform`, and embedded in compaction context.

Verified in `opencode run` (headless), `opencode serve`, and the TUI.

## Quick Start

```bash
# Global install (all projects)
keel install --opencode

# Project install (committed to the repo, shared with your team)
keel install --project

# Restart OpenCode — rules are enforced immediately.

# Manage rules
keel validate              # Check for conflicts
keel evaluate --tool Bash --args '{"command":"git push --force"}'   # Test a rule
keel suggest               # Analyze audit trail

# Self-improvement
keel lessons               # Extract lessons from violations
keel gather                # Distill audit history into standing requirements
keel gather --apply-and-save  # Append proposed rules (review first!)
keel schedule daily        # Automate gather via launchd/cron
keel watch                 # Live audit monitor

# Other agents
keel install --claude-code # Claude Code hooks (true blocking)
keel install --cline       # Cline (.clinerules + MCP check server)
keel install --cursor      # Cursor (.cursor/rules advisory rules)
keel install --codex       # Codex CLI (AGENTS.md instructions)
```

## How It Works

```
Agent action → OpenCode permission check (Layer 1)
             → Keel plugin tool.execute.before (Layer 2)
               → Regex match against rules
               → Fix rules mutate the command (e.g. add --signoff)
               → Deny rules: warn first time, deny on repeat
             → Allow / Warn / Deny / Fix
             → Audit log (JSONL) → keel suggest / lessons / gather
```

Standing requirements are injected into the system prompt on EVERY turn, so
long sessions can't forget them:

```
Agent turn → experimental.chat.system.transform → system prompt + requirements
Compaction → experimental.session.compacting    → summary + requirements
```

## Rules

Rules go in `~/.keel/rules.yaml` (global) or `.keel/rules.yaml` (project).
Project rules override global rules for the same rule id.

```yaml
version: 1
level: balanced
rules:
  - id: no-force-push
    type: command
    match: "git push --force(?!-with-lease)"
    action: deny
    message: "Use --force-with-lease instead of --force."

  - id: must-sign-commits
    type: command
    match: "git commit"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    message: "Auto-adding --signoff to commits."
```

Standing requirements go in `~/.keel/requirements.md` (and optionally
`.keel/requirements.md` per project) — injected into the system prompt every turn.

## Supported Agents

| Agent | Integration | Enforced at | Status |
|-------|------------|-------------|--------|
| OpenCode | Plugin (3 hooks) | Tool-call time | ✅ Working |
| Claude Code | PreToolUse/PostToolUse hooks | Tool-call time | ✅ Working |
| Cline | `.clinerules` + MCP check server | Advisory | ✅ Installed |
| Cursor | `.cursor/rules` declarative | Advisory | ✅ Installed |
| Codex CLI | AGENTS.md instructions | Advisory | ✅ Installed |

## The Self-Improvement Loop

```
Agent actions → Audit log → keel suggest / lessons → Pattern extraction
                                                    ↓
User approves ← Rule generation ← keel gather ←─────┘
```

The learning layer NEVER modifies rules automatically. It only suggests —
`keel gather --apply` prints proposed rules, `--apply-and-save` appends them
after your review. `keel schedule` runs the analysis automatically via
launchd (macOS) or cron (Linux).

## Development

```bash
npm run build                           # Build all packages
npm run test -w @get-keel/core              # 55 tests
node packages/cli/bin/keel.js validate  # Run locally
```

The OpenCode plugin has a single canonical source:
`packages/cli/templates/keel-enforce.js` — installed plugin files and the
`@get-keel/opencode-plugin` npm package are built from it verbatim.
