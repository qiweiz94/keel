#!/bin/sh
# M4 host-breadth: WARN live verification for Gemini CLI.
#
# gemini.sh (Wave-1) already live-proves BLOCK (when auth is available).
# This is the WARN mirror — same reasoning and same rule under test
# (no-verify-bypass) as claude-warn.sh, since hook.ts reads Gemini through
# the identical Claude-Code-shaped payload/response contract (`gemini
# hooks migrate --from-claude`). See claude-warn.sh's header comment for
# why the child's own transcript is the channel this can observe (Gemini,
# like Claude Code, is an exit-code host with no independent log this
# harness reads out-of-band the way OpenCode's opencode.log allows).
#
# Auth honesty (checked FIRST, same empirical finding as gemini.sh): the
# real OAuth session under ~/.gemini is file-based and off-limits under
# this lane's isolation constraint; no GEMINI_API_KEY is set as a
# fallback in this environment. One attempt, captured below; if it fails
# on auth this script stops rather than falling back to real HOME.

set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export SCRIPT_DIR
. "$SCRIPT_DIR/lib/common.sh"

TIMEOUT_S=300
HOST_LABEL="gemini"
FAIL=0
TIMED_OUT=0

if ! command -v gemini >/dev/null 2>&1; then
  echo "FAIL: gemini not on PATH — cannot run live verification" >&2
  exit 1
fi

echo "== Gemini CLI WARN live verification =="
echo "gemini version: $(gemini --version 2>&1)"
echo

lv_init "${HOST_LABEL}-warn-authprobe"
cd "$LV_WORK"

echo "-- auth probe: isolated HOME, single attempt --"
node "$SCRIPT_DIR/lib/with-timeout.mjs" 60 \
  gemini -p "say hi, one word" --output-format json \
  > "$LV_ROOT/authprobe.log" 2>&1 || true
cat "$LV_ROOT/authprobe.log"
echo

if grep -qi "auth method\|not logged in\|GEMINI_API_KEY" "$LV_ROOT/authprobe.log" 2>/dev/null; then
  echo "AUTH HONESTY: isolated HOME has no Gemini auth (OAuth session is file-based under"
  echo "the real ~/.gemini, off-limits; no GEMINI_API_KEY set as a fallback)."
  echo "captured output above is the real error from the one attempt."
  echo
  echo "== GEMINI CLI WARN: AUTH-BLOCKED (warn-fires-headless=untested, warn-surfaced-live=untested) =="
  lv_cleanup
  exit 2
fi
echo "AUTH: OK — proceeding"
lv_cleanup
echo

# ---------------------------------------------------------------------
# Negative control.
# ---------------------------------------------------------------------
lv_init "${HOST_LABEL}-warn-control"
cd "$LV_WORK"
echo "-- installing keel (Gemini CLI hook, under isolated HOME) --"
node "$KEEL_BIN" install --gemini
echo "warn-fixture-change" >> "$LV_WORK/file.txt"
git -C "$LV_WORK" add file.txt
HEAD_BEFORE_CTRL="$(git -C "$LV_WORK" rev-parse HEAD)"

echo "-- running the child: ordinary commit, no --no-verify (must NOT trip no-verify-bypass) --"
lv_run_child "$TIMEOUT_S" gemini -p 'Run exactly this one command, then stop: git commit -m "wip control"' --approval-mode yolo --skip-trust --output-format json \
  > "$LV_ROOT/control-run.log" 2>&1
echo "gemini -p exit=$LV_CHILD_EXIT"
HEAD_AFTER_CTRL="$(git -C "$LV_WORK" rev-parse HEAD)"

if [ "$HEAD_AFTER_CTRL" = "$HEAD_BEFORE_CTRL" ]; then
  echo "NEGATIVE CONTROL: FAIL — commit never happened even without --no-verify; child/harness issue. See $LV_ROOT/control-run.log"
  cat "$LV_ROOT/control-run.log"
  lv_cleanup
  exit 1
fi
echo "  ordinary commit succeeded ($HEAD_BEFORE_CTRL -> $HEAD_AFTER_CTRL)"

if ! lv_no_marker "$LV_ROOT/control-run.log" '\[keel:no-verify-bypass\]'; then
  echo "NEGATIVE CONTROL: FAIL — marker present without the trigger. Aborting; a PASS below would be meaningless."
  lv_cleanup
  exit 1
fi
echo "NEGATIVE CONTROL: PASS"
lv_cleanup
echo

# ---------------------------------------------------------------------
# The real warn test.
# ---------------------------------------------------------------------
lv_init "${HOST_LABEL}-warn"
cd "$LV_WORK"
echo "-- installing keel (Gemini CLI hook, under isolated HOME) --"
node "$KEEL_BIN" install --gemini
echo "warn-fixture-change" >> "$LV_WORK/file.txt"
git -C "$LV_WORK" add file.txt
HEAD_BEFORE="$(git -C "$LV_WORK" rev-parse HEAD)"

TRANSCRIPT="$LV_WORKTREE/session/transcripts/gemini-warn-no-verify-bypass.txt"
mkdir -p "$(dirname "$TRANSCRIPT")"
{
  echo "# Gemini CLI WARN live-verify: no-verify-bypass"
  echo "# started: $(date -u +%FT%TZ)"
  echo "# HEAD before: $HEAD_BEFORE"
  echo
} > "$TRANSCRIPT"

echo "-- running the child: 'run exactly: git commit -m \"wip\" --no-verify' --"
lv_run_child "$TIMEOUT_S" gemini -p 'Run exactly this one command, then stop: git commit -m "wip" --no-verify' --approval-mode yolo --skip-trust --output-format json \
  >> "$TRANSCRIPT" 2>&1
echo "gemini -p exit=$LV_CHILD_EXIT (appended to $TRANSCRIPT)"
HEAD_AFTER="$(git -C "$LV_WORK" rev-parse HEAD)"
{
  echo
  echo "# HEAD after: $HEAD_AFTER"
} >> "$TRANSCRIPT"
echo

echo "-- verifying (1/2): the commit actually happened — warn must NOT block --"
if [ "$HEAD_AFTER" = "$HEAD_BEFORE" ]; then
  echo "SIDE EFFECT: FAIL — HEAD did not move; --no-verify commit was blocked (or never attempted), not warned"
  FAIL=1
else
  echo "SIDE EFFECT: PASS — HEAD moved $HEAD_BEFORE -> $HEAD_AFTER; the commit went through"
fi

echo "-- verifying (2/2): the warn marker is in the child's own captured output --"
if lv_verify_warn "$TRANSCRIPT" '\[keel:no-verify-bypass\]'; then
  echo "WARN CHANNEL: PASS"
elif [ "$LV_VERIFY_VERDICT" = "timeout" ]; then
  echo "WARN CHANNEL: COULD-NOT-TEST — child timed out"
  TIMED_OUT=1
else
  echo "WARN CHANNEL: FAIL — see $TRANSCRIPT"
  FAIL=1
fi

lv_cleanup

echo
if [ "$FAIL" -ne 0 ]; then
  echo "== GEMINI CLI WARN: FAIL =="
  exit 1
elif [ "$TIMED_OUT" -ne 0 ]; then
  echo "== GEMINI CLI WARN: COULD-NOT-TEST (child timed out — re-run) =="
  exit 2
else
  echo "== GEMINI CLI WARN: PASS (side-effect-not-blocked=yes, warn-surfaced-live=yes) =="
  exit 0
fi
