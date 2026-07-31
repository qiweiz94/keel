#!/bin/sh
# keel-enforce — Keel enforcement for Claude Code
#
# PreToolUse hook. Blocks tool calls that violate Keel rules.
# Exit codes (Claude Code contract): 0 = allow, 2 = deny (stderr is shown to the model).
#
# Env provided by Claude Code:
#   TOOL_NAME    — the tool about to be called (Bash, Read, Write, ...)
#   TOOL_INPUT   — JSON of the tool input, e.g. {"command":"git push --force"}
#   TOOL_USE_ID  — unique call id
#
# Requires `keel` on PATH. Install with: keel install --claude-code

RESULT=$(keel evaluate --tool "$TOOL_NAME" --args "$TOOL_INPUT" --agent claude-code 2>/dev/null)
EXIT=$?

if [ "$EXIT" -eq 1 ]; then
  # deny/block — extract the message and surface it to the model
  MESSAGE=$(printf '%s' "$RESULT" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | sed 's/\\n/ /g')
  echo "Keel blocked this action: ${MESSAGE:-rule violation}" >&2
  exit 2
fi

if [ "$EXIT" -eq 2 ]; then
  echo "Keel could not initialize enforcement. Check 'keel validate' and ~/.keel/rules.yaml." >&2
  exit 2
fi

exit 0
