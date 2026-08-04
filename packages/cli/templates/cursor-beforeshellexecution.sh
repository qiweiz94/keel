#!/bin/sh
# keel — Cursor beforeShellExecution / beforeMCPExecution hook.
#
# Cursor feeds the hook a JSON payload on stdin and reads a decision from
# stdout:
#
#   payload : { command | tool_name, tool_input, cwd, conversation_id, ... }
#   stdout  : { "permission": "allow" | "deny" | "ask",
#               "userMessage": "...", "agentMessage": "..." }
#
# ⚠ UNVERIFIED AGAINST A LIVE HOST. Cursor is not installed on the machine
# this was written on, so this contract comes from Cursor's documentation
# rather than from installed type definitions. Everywhere both were
# available in this project the docs were wrong in some detail, so treat
# the exact field names as the first thing to check if it misbehaves. The
# keel side (which verdicts block) is verified.
#
# Pair it with "failClosed": true in .cursor/hooks.json so a crash in this
# script denies rather than silently allowing.
#
# Install with: keel install --cursor
# Requires `keel` on PATH.

PAYLOAD=$(cat)

if command -v python3 >/dev/null 2>&1; then
  TOOL=$(printf '%s' "$PAYLOAD" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("tool_name") or ("bash" if d.get("command") else "unknown"))' 2>/dev/null)
  ARGS=$(printf '%s' "$PAYLOAD" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps(d.get("tool_input") or ({"command":d["command"]} if d.get("command") else {})))' 2>/dev/null)
else
  TOOL="bash"
  ARGS=$(printf '%s' "$PAYLOAD" | sed -n 's/.*\("command":"[^"]*"\).*/{\1}/p')
fi
[ -n "$TOOL" ] || TOOL="unknown"
[ -n "$ARGS" ] || ARGS="{}"

RESULT=$(keel evaluate --tool "$TOOL" --args "$ARGS" --agent cursor 2>/dev/null)
EXIT=$?

decide() {
  ESCAPED=$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  printf '{"permission":"%s","userMessage":"%s","agentMessage":"%s"}\n' "$1" "$ESCAPED" "$ESCAPED"
}

if [ "$EXIT" -eq 1 ]; then
  MESSAGE=$(printf '%s' "$RESULT" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | sed 's/\\n/ /g')
  ACTION=$(printf '%s' "$RESULT" | sed -n 's/.*"action":"\([a-z]*\)".*/\1/p')
  case "$ACTION" in
    # `ask` routes to Cursor's own approval UI, which is the closest thing
    # to keel's `prompt`. It still stops the call from running unattended.
    prompt) decide ask "Keel requires approval: ${MESSAGE:-approval required}" ;;
    redirect|research) decide deny "Keel redirected this action: ${MESSAGE:-do the required step first}" ;;
    *) decide deny "Keel blocked this action: ${MESSAGE:-rule violation}" ;;
  esac
  exit 0
fi

if [ "$EXIT" -eq 2 ]; then
  decide deny "Keel could not initialize enforcement. Check 'keel validate' and ~/.keel/rules.yaml."
  exit 0
fi

decide allow ""
exit 0
