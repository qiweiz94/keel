#!/bin/sh
# keel — Claude Code PreToolUse hook.
#
# Claude Code passes the call in the environment (TOOL_NAME, TOOL_INPUT)
# rather than on stdin; `keel hook claude-code` reads either.
# Exit 2 blocks and shows stderr to the model.
#
# Install with: keel install --claude-code
exec keel hook claude-code
