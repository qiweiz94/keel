#!/usr/bin/env node
/**
 * @get-keel/cli postinstall script
 * Runs after npm install -g @get-keel/cli to print setup instructions.
 *
 * This is the first thing a new user reads, so it must stay in sync with the
 * hosts `keel install` actually supports — a banner that omits shipped
 * integrations is how people conclude a feature does not exist.
 */

console.log(`
╔══════════════════════════════════════════════════════════╗
║                keel installed!                           ║
╚══════════════════════════════════════════════════════════╝

Start here — see what's unprotected on this machine:

  keel scan                   # audit agents + MCP servers, ranked by severity

Then wire enforcement into your agents:

  keel install --all          # every host detected here
  keel install --opencode     # or one at a time:
  keel install --claude-code
  keel install --cursor
  keel install --cline
  keel install --codex
  keel install --gemini
  keel install --openclaw
  keel install --hermes
  keel install --project      # commit config to a repo your team shares

  # restart the agent — rules are enforced on the next tool call

Day to day:

  keel level sprint|balanced|protect   # the speed dial
  keel validate               # check rules for conflicts
  keel audit --tail 20        # what got blocked, and why
  keel allow <rule-id> --once # approve one gated action
  keel retrospective          # where agents kept circling
  keel dashboard              # interactive control panel

Rules:                  ~/.keel/rules.yaml
Standing requirements:  ~/.keel/requirements.md
Docs:                   https://github.com/qiweiz94/keel
Integrations:           https://github.com/qiweiz94/keel/blob/main/docs/integrations.md
`)
