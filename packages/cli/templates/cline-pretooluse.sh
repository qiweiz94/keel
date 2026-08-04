#!/bin/sh
# keel — Cline PreToolUse hook.
#
# Cline runs hooks as subprocesses, feeding the event payload as JSON on
# stdin and reading a control object back from stdout. Contract taken from
# the installed package (@cline/core dist/hooks/subprocess.d.ts,
# hook-file-config.d.ts), not from docs:
#
#   payload  : { preToolUse: { toolName, parameters } , ... }
#   control  : a line "HOOK_CONTROL<TAB>{json}" on stdout; the LAST such
#              line wins, else the whole stdout is parsed as the JSON.
#   HookOutput: { cancel?, errorMessage?, contextModification?, context?,
#                 overrideInput?, review? }   -- cancel:true stops the call
#
# Install with: keel install --cline
# Requires `keel` on PATH.

PAYLOAD=$(cat)

# Pull toolName and the parameters object out of the payload. Cline nests
# them under preToolUse. Prefer python3 for correct JSON handling and fall
# back to sed so the hook still works on a machine without it — a hook
# that errors is a hook Cline skips, which is a silent fail-open.
if command -v python3 >/dev/null 2>&1; then
  TOOL=$(printf '%s' "$PAYLOAD" | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("preToolUse") or {}).get("toolName") or "unknown")' 2>/dev/null)
  ARGS=$(printf '%s' "$PAYLOAD" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps((d.get("preToolUse") or {}).get("parameters") or {}))' 2>/dev/null)
else
  TOOL=$(printf '%s' "$PAYLOAD" | sed -n 's/.*"toolName":"\([^"]*\)".*/\1/p')
  ARGS="{}"
fi
[ -n "$TOOL" ] || TOOL="unknown"
[ -n "$ARGS" ] || ARGS="{}"

RESULT=$(keel evaluate --tool "$TOOL" --args "$ARGS" --agent cline 2>/dev/null)
EXIT=$?

emit_cancel() {
  # Escape the message for JSON: backslashes, quotes, then newlines.
  ESCAPED=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  printf 'HOOK_CONTROL\t{"cancel":true,"errorMessage":"%s"}\n' "$ESCAPED"
}

if [ "$EXIT" -eq 1 ]; then
  # A blocking verdict: deny, block, prompt, redirect or research. `prompt`
  # is included deliberately — it means "needs `keel allow <id> --once`",
  # and letting it through would make every approval gate a no-op.
  MESSAGE=$(printf '%s' "$RESULT" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | sed 's/\\n/ /g')
  ACTION=$(printf '%s' "$RESULT" | sed -n 's/.*"action":"\([a-z]*\)".*/\1/p')
  case "$ACTION" in
    prompt) emit_cancel "Keel requires approval: ${MESSAGE:-approval required}" ;;
    redirect|research) emit_cancel "Keel redirected this action: ${MESSAGE:-do the required step first}" ;;
    *) emit_cancel "Keel blocked this action: ${MESSAGE:-rule violation}" ;;
  esac
  exit 0
fi

if [ "$EXIT" -eq 2 ]; then
  emit_cancel "Keel could not initialize enforcement. Check 'keel validate' and ~/.keel/rules.yaml."
  exit 0
fi

exit 0
