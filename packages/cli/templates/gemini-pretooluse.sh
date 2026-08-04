#!/bin/sh
# keel — Gemini CLI PreToolUse hook.
#
# Gemini's hook format is Claude-Code-shaped: `gemini hooks migrate
# --from-claude` exists specifically to convert between them. The call
# arrives either in the environment (TOOL_NAME / TOOL_INPUT) or on stdin
# as {tool_name, tool_input}; `keel hook gemini` reads either.
# Exit 2 blocks and shows stderr to the model.
#
# If Gemini's format has drifted, `gemini hooks migrate --from-claude`
# against a Claude Code config is the supported conversion path.
#
# Install with: keel install --gemini
exec keel hook gemini
