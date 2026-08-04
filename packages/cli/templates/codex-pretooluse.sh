#!/bin/sh
# keel — Codex CLI PreToolUse hook.
#
# Codex feeds a JSON payload on stdin. Exit code 2 blocks the call and
# shows stderr to the model; any other non-zero marks the hook failed but
# lets execution continue (fail-open), so a blocking verdict MUST exit 2
# and nothing else.
#
#   payload : { tool_name, tool_input, session_id, cwd, hook_event_name, ... }
#
# ⚠ UNVERIFIED AGAINST A LIVE HOST. Codex CLI is not installed on the
# machine this was written on, so the payload shape comes from Codex's
# documentation rather than from installed types. Everywhere both were
# available in this project the docs were wrong in some detail. The keel
# side (which verdicts block) is verified; the field names are not.
#
# Codex hooks require the hook file's hash to be trusted before it runs.
#
# Install with: keel install --codex
# Requires `keel` on PATH.

PAYLOAD=$(cat)

if command -v python3 >/dev/null 2>&1; then
  TOOL=$(printf '%s' "$PAYLOAD" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("tool_name") or "unknown")' 2>/dev/null)
  ARGS=$(printf '%s' "$PAYLOAD" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get("tool_input") or {}))' 2>/dev/null)
else
  TOOL=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"tool_name":"\([^"]*\)".*/\1/p')
  ARGS="{}"
fi
[ -n "$TOOL" ] || TOOL="unknown"
[ -n "$ARGS" ] || ARGS="{}"

RESULT=$(keel evaluate --tool "$TOOL" --args "$ARGS" --agent codex 2>/dev/null)
EXIT=$?

if [ "$EXIT" -eq 1 ]; then
  MESSAGE=$(printf '%s' "$RESULT" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | sed 's/\\n/ /g')
  ACTION=$(printf '%s' "$RESULT" | sed -n 's/.*"action":"\([a-z]*\)".*/\1/p')
  case "$ACTION" in
    prompt) echo "Keel requires approval: ${MESSAGE:-approval required}" >&2 ;;
    redirect|research) echo "Keel redirected this action: ${MESSAGE:-do the required step first}" >&2 ;;
    *) echo "Keel blocked this action: ${MESSAGE:-rule violation}" >&2 ;;
  esac
  exit 2
fi

if [ "$EXIT" -eq 2 ]; then
  echo "Keel could not initialize enforcement. Check 'keel validate' and ~/.keel/rules.yaml." >&2
  exit 2
fi

exit 0
