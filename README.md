# Keel

Enforce rules on AI coding agents — rules that survive context rot, compaction, and agent amnesia.

[![npm](https://img.shields.io/npm/v/@get-keel/cli?label=@get-keel/cli&logo=npm)](https://www.npmjs.com/package/@get-keel/cli)
[![npm](https://img.shields.io/npm/v/@get-keel/opencode-plugin?label=@get-keel/opencode-plugin&logo=npm)](https://www.npmjs.com/package/@get-keel/opencode-plugin)
[![npm](https://img.shields.io/npm/v/@get-keel/core?label=@get-keel/core&logo=npm)](https://www.npmjs.com/package/@get-keel/core)

```bash
npm install -g @get-keel/cli
keel install --opencode        # Wire the OpenCode plugin
keel validate                  # Check your rules
```

Keel public packages require Node.js 22.12.0 or newer.

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
                → Prompt rules: always block until `keel allow <id> --once`
              → Allow / Warn / Deny / Prompt / Fix
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

  - id: git-history-rewrite
    type: command
    match: "git filter-branch|git rebase|git reset (--hard|--soft|--keep|--merge|HEAD~)|git commit --amend|git stash (drop|clear)"
    action: prompt
    message: "Git history mutation — this rewrites shared history. Approval required."
```

The shipped defaults (`~/.keel/rules.yaml`) cover the classes the community
red-teams converged on: destructive commands (`rm -rf` variants, disk
destroyers, `chmod -R 777`, fork bombs), `curl | sh` pipe-exec, hardcoded
secrets and credential files (`.env*`, `.ssh`, `*.pem`, `.npmrc`), env-var
credential exposure, secret exfiltration (read-then-curl), force-push /
hook-bypass / test-faking, and approval gates for DB destruction, pushes to
protected branches, and on-the-fly package execution (`npx`/`bunx`/`dlx` —
the slopsquatting vector).

### Optional rules (documented examples, not shipped)

These are judgment-call rules with real false-positive tradeoffs, so they ship
as examples instead of defaults. Copy them into `~/.keel/rules.yaml` if they
fit your workflow:

```yaml
  # Staging everything can commit .env and build artifacts by accident.
  - id: no-git-add-all
    type: command
    match: "git add -A( |$)|git add [.]( |$)"
    action: warn
    message: "Stage files explicitly to avoid committing unwanted files."

  # Unpinned installs are how hallucinated package names (slopsquatting) land.
  - id: no-unpinned-install
    type: command
    match: "(npm|yarn|pnpm) (install|add) [^@]*( |$)|pip install [^=]* ( |$)"
    action: warn
    message: "Pin exact versions (--save-exact) and verify the package exists."

  # Reading a file and then deleting it is how agents delete the wrong thing.
  - id: no-delete-after-read
    type: sequence
    steps:
      - tool: ReadFile
      - tool: Bash
        pattern: "rm "
    action: warn
    message: "You read this file then deleted it — verify the target."

  - id: no-gpg-bypass
    type: command
    match: "git commit --no-gpg-sign"
    action: warn
    message: "Fix GPG issues, don't bypass signing."
```

### Actions

| Action | Behaviour |
|--------|-----------|
| `allow` | Log only, no enforcement |
| `warn` | Warns on first violation, blocks on repeat |
| `deny` | Warns first, denies on repeat |
| `block` | Always blocks immediately |
| `prompt` | Always blocks and requires `keel allow <rule-id> --once` (approval gate for irreversible operations) |
| `fix` | Rewrites the command (e.g. adds `--signoff`) |
| `report` | Logs only, no enforcement |

### Approving gated actions

`action: prompt` rules (and repeated deny blocks) require an explicit
one-time approval:

```bash
keel allow git-history-rewrite --once   # 5-minute one-time override
keel allow no-force-push                # persistent override (24h)
```

Overrides are stored in `~/.keel/overrides.json` and are consumed by the next
violation of the rule.

### Receipts and the signing key

Every gated or blocked action is written to `<project>/.keel/receipts/`
as a signed, hash-chained entry (verify with `keel verify`). The Ed25519
signing keypair is created at `<project>/.keel/receipt-key.json` on
first use — **add `.keel/receipts/` and `.keel/audit/` to your project's
`.gitignore`** so the private key is never committed. The key can be rotated
by deleting the file; receipts signed with the old key will no longer verify.

Standing requirements go in `~/.keel/requirements.md` (and optionally
`.keel/requirements.md` per project) — injected into the system prompt every turn.

## Protection Levels (the speed dial)

Three levels tune how much friction keel applies. Set the dial with:

```bash
keel level               # show the current level (global + project)
keel level protect       # set the global dial (writes ~/.keel/rules.yaml)
keel level sprint --project   # set the project dial (.keel/rules.yaml)
keel enforce --level=protect --persist   # same, from the enforce command
```

The OpenCode plugin reads the level on every tool call, so the change takes
effect immediately — no restart.

| Level | deny/block rules | Depth of checks | Use when |
|-------|------------------|-----------------|----------|
| `sprint` | downgraded to warnings | fast — content/sequence/flow/reasoning skipped | iterating quickly, agent is trusted-ish |
| `balanced` | warn once, then block on repeat (default) | full — content, sequence, and flow checks on | day-to-day work |
| `protect` | block after a first warning | deep — sequence, flow, and reasoning checks at full strength | irreversible or high-risk work |

`prompt` approval gates are **never downgraded** at any level — irreversible
operations always require `keel allow <rule-id> --once`.

Rules can declare `level: protect` to make them **floors**:

```yaml
- id: my-strict-rule
  type: command
  match: "something"
  action: deny
  level: protect   # always enforced — never downgraded by the sprint dial
```

Every rule is active at every dial. The dial softens enforcement globally
(sprint downgrades deny/block to warn), and `level: protect` exempts a rule
from that downgrade — it is never silently disabled when the dial is low.

## Writing Rules

Rules are YAML in `~/.keel/rules.yaml` (global), `.keel/rules.yaml` (project),
or local override files. Project rules override global rules with the same id.

```yaml
version: 1
level: balanced
rules:
  - id: no-force-push
    type: command
    match: "git push --force(?!-with-lease)"
    action: deny
    message: "Use --force-with-lease instead of --force."
```

Common fields: `id` (unique), `type`, `action`, `message`, and optionally
`level` (strictness floor — `protect` = never downgraded by the dial),
`priority` (higher = evaluated first), `context` (`local`, `ci`, or both).

| Type | What it matches | Key fields |
|------|-----------------|------------|
| `command` | tool command strings | `match` (regex), `match_prefix`, `match_regex` |
| `filesystem` | file paths and operations | `paths`, `operations` (read/write/delete/overwrite/glob), `exclude` |
| `content` | file contents (balanced+) | `patterns` (`regex`/`prefix`) |
| `network` | outbound hosts | `match`, `except` (allowlisted domains) |
| `env` | environment variables | `vars` |
| `rate` | call frequency | `window_seconds`, `max_calls` |
| `time` | scheduled windows | `schedule` |
| `sequence` | step ordering (balanced+) | `steps` |
| `flow` | data-flow sources→sinks (balanced+) | `sources`, `sinks` |
| `session` | session duration | `max_duration_minutes` |
| `verification` | evidence-before-action obligations | `trigger`, `satisfy`, `boundaries`, `verification_window_seconds` |
| `context` | standing requirements | `message` |

Actions: `allow` (log), `warn` (first warn, then block), `deny` (warn once,
block on repeat), `block` (always block), `prompt` (always block until
`keel allow <id> --once`), `fix` (rewrite the command), `report` (log).

Examples:

```yaml
# Block writes to secrets, allow reads
- id: protect-env
  type: filesystem
  paths: ["**/.env", "**/*.pem"]
  operations: [write, delete]
  action: deny
  message: "Secrets are read-only."

# Require a successful test run before any commit
- id: test-before-commit
  type: verification
  trigger: { tools: [WriteFile, edit], pattern: "src/" }
  satisfy: { tools: [Bash], pattern: "(npm test|npm run test|vitest|jest)" }
  boundaries:
    commit: { pattern: "git commit", action: warn }
  verification_window_seconds: 300
  action: deny
  message: "Source changes require a successful test run before commit."

# Approve network egress, except known registries
- id: no-external-network
  type: network
  match: "."
  except: [api.github.com, registry.npmjs.org]
  action: deny
  message: "Block external network access except GitHub and npm."
```

After editing rules: `keel validate` checks syntax and conflicts. The plugin
hot-reloads changed rules on the next tool call.

## Supported Agents

| Agent | Integration | Enforced at | Status |
|-------|------------|-------------|--------|
| OpenCode | Plugin (4 hooks) | Tool-call time | ✅ Working |
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
npm run test -w @get-keel/core              # 82 tests
node packages/cli/bin/keel.js validate  # Run locally
```

The OpenCode plugin has a single canonical source:
`packages/opencode-plugin/src/plugin.ts`. The generated delivery files
(`packages/cli/templates/keel-enforce.js` and the bundled
`@get-keel/opencode-plugin/dist/index.js`) are built from it verbatim by
`npm run build -w @get-keel/opencode-plugin`. Never edit generated artifacts
directly — edit the source and re-run the build.
