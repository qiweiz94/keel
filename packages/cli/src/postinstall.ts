#!/usr/bin/env node
/**
 * @get-keel/cli postinstall script
 * Runs after npm install -g @get-keel/cli to print setup instructions.
 */

console.log(`
╔══════════════════════════════════════════════════════════╗
║                keel installed!                           ║
╚══════════════════════════════════════════════════════════╝

Wire the OpenCode plugin (rules enforced on every tool call):

  keel install --opencode
  # restart OpenCode — rules are enforced immediately

Standing requirements are injected into the system prompt every
turn, and the audit trail powers self-improvement:

  keel validate               # Check rules for conflicts
  keel suggest                # Analyze the audit trail
  keel lessons                # Extract lessons from violations
  keel gather                 # Distill history into requirements
  keel schedule daily         # Automate gather (launchd/cron)
  keel watch                  # Live audit monitor

Other agents:

  keel install --claude-code  # Claude Code hooks (blocking)
  keel install --cline        # Cline (.clinerules + MCP check)
  keel install --cursor       # Cursor (.cursor/rules advisory)
  keel install --codex        # Codex CLI (AGENTS.md instructions)

Rules:      ~/.keel/rules.yaml
Standing requirements: ~/.keel/requirements.md
Docs:       https://github.com/qiweiz94/keel
`)
