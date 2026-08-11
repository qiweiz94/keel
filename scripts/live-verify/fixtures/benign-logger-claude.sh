#!/bin/sh
# Benign, keel-independent PreToolUse hook for the Wave-1 live-verify
# benign probe (Claude Code / Gemini, which share the same hook contract
# per gemini-pretooluse.sh's own comment). Reads the payload (env or
# stdin, same fallback keel's own hook uses) and appends one line to a
# log file, then always exits 0 (allow). Never blocks anything.
#
# Purpose: prove the host invokes PreToolUse in headless (-p) mode BEFORE
# trusting keel's own `keel hook <host>` logic — if this never fires, a
# keel block failure would be indistinguishable from "the host never
# called the hook at all".
set -eu

if [ -z "${KEEL_LIVEVERIFY_BENIGN_LOG:-}" ]; then
  echo "benign-logger-claude.sh: KEEL_LIVEVERIFY_BENIGN_LOG not set" >&2
  exit 1
fi

if [ -n "${TOOL_NAME:-}" ]; then
  payload="{\"tool_name\":\"${TOOL_NAME}\"}"
else
  payload="$(cat)"
  [ -z "$payload" ] && payload="null"
fi

printf '%s\n' "{\"ts\":$(date +%s),\"payload\":${payload}}" >> "$KEEL_LIVEVERIFY_BENIGN_LOG"
exit 0
