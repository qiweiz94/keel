#!/bin/sh
# keel-reinject — standing requirements re-injection for Claude Code
#
# PostToolUse hook. Outputs the standing requirements block so long sessions
# re-read them after every tool use (combats context drift).
#
# Env provided by Claude Code:
#   TOOL_NAME     — the tool that ran
#   TOOL_INPUT    — JSON of the tool input
#   TOOL_RESPONSE — JSON of the tool output
#
# Install with: keel install --claude-code

REQS=~/.keel/requirements.md
PROJECT_REQS=.keel/requirements.md

{
  echo
  echo "<keel-standards>"
  if [ -f "$REQS" ]; then
    cat "$REQS"
  fi
  if [ -f "$PROJECT_REQS" ]; then
    echo
    echo "## Project requirements"
    cat "$PROJECT_REQS"
  fi
  echo "</keel-standards>"
  echo
} 2>/dev/null

exit 0
