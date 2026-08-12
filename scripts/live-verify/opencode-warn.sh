#!/bin/sh
# M4 host-breadth: WARN live verification for OpenCode.
#
# opencode.sh (Wave-1) already live-proves BLOCK. This proves the other
# half of the ladder: a first-violation `warn` verdict (1) does NOT stop
# the action, and (2) actually reaches a real, independent, host-produced
# channel — not just keel's own text landing back in the same transcript
# this script wrote headers into (that would be the tautological-grep
# failure mode `lv_verify_block`'s own comments warn about).
#
# Channel found empirically (not assumed) BEFORE writing this script: the
# opencode-plugin's warn path calls `client.app.log({level:'warn', ...})`
# (packages/opencode-plugin/src/plugin.ts, surfaceWarn()). A throwaway
# probe plugin proved that call does NOT appear in `opencode run --format
# json`'s stdout event stream (headless JSON mode has no app-log channel)
# — but it DOES land, structured and greppable, in
# $XDG_DATA_HOME/opencode/log/opencode.log:
#   level=WARN run=<id> message="[Keel] <rule_id>: <text>" rule_id=<rule_id>
# That file is written by the real opencode process itself, under this
# script's own isolated XDG_DATA_HOME — never by this script — which is
# what makes a grep against it non-tautological.
#
# Rule under test: no-verify-bypass (install.ts) — action: warn, mode:
# warn (a PERMANENT warn, not a warn-then-deny ladder rung), matching
# `git commit ... --no-verify`. Chosen specifically because it never
# escalates to a block, so a single child call is enough — no pre-warm,
# no double-hit bookkeeping.
#
# Two-sided assertion per call (the discriminator a naive "grep the
# transcript" version would miss): the commit must actually exist
# (proves warn =/= block) AND the marker must appear in opencode's OWN
# log (proves the warn was not silently swallowed). A negative control
# (same pipeline, a commit WITHOUT --no-verify) proves the marker check
# itself isn't tainted by unrelated log noise.

set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export SCRIPT_DIR
. "$SCRIPT_DIR/lib/common.sh"

MODEL="opencode/deepseek-v4-flash-free"
TIMEOUT_S=300
HOST_LABEL="opencode"
FAIL=0
TIMED_OUT=0

if ! command -v opencode >/dev/null 2>&1; then
  echo "FAIL: opencode not on PATH — cannot run live verification" >&2
  exit 1
fi

echo "== OpenCode WARN live verification =="
echo "opencode version: $(opencode --version 2>&1)"
echo

# ---------------------------------------------------------------------
# Step 1: negative control — same pipeline, a commit that does NOT match
# no-verify-bypass. Proves the marker-detection method itself doesn't
# false-positive on ordinary opencode/keel log noise.
# ---------------------------------------------------------------------
lv_init "${HOST_LABEL}-warn-control"
cd "$LV_WORK"
echo "-- installing keel (project-scoped OpenCode plugin) --"
node "$KEEL_BIN" install --project
rm -f "$LV_WORK/.keel/rules.yaml"   # known install.ts stub bug — see opencode.sh
echo

OC_LOG="$XDG_DATA_HOME/opencode/log/opencode.log"
echo "-- preparing a staged, uncommitted change --"
echo "warn-fixture-change" >> "$LV_WORK/file.txt"
git -C "$LV_WORK" add file.txt
HEAD_BEFORE_CTRL="$(git -C "$LV_WORK" rev-parse HEAD)"

echo "-- running the child: ordinary commit, no --no-verify (must NOT trip no-verify-bypass) --"
lv_run_child "$TIMEOUT_S" opencode run 'Run exactly this one command, then stop: git commit -m "wip control"' --dir "$LV_WORK" --auto -m "$MODEL" --format json \
  > "$LV_ROOT/control-run.log" 2>&1
echo "opencode run exit=$LV_CHILD_EXIT"
HEAD_AFTER_CTRL="$(git -C "$LV_WORK" rev-parse HEAD)"

if [ "$HEAD_AFTER_CTRL" = "$HEAD_BEFORE_CTRL" ]; then
  echo "NEGATIVE CONTROL: FAIL — commit never happened even without --no-verify; child/harness issue, not a keel effect. See $LV_ROOT/control-run.log"
  cat "$LV_ROOT/control-run.log"
  lv_cleanup
  exit 1
fi
echo "  ordinary commit succeeded ($HEAD_BEFORE_CTRL -> $HEAD_AFTER_CTRL)"

if ! lv_no_marker "$OC_LOG" 'level=WARN.*\[Keel\] no-verify-bypass:'; then
  echo "NEGATIVE CONTROL: FAIL — marker present without the trigger. Aborting; a PASS below would be meaningless."
  lv_cleanup
  exit 1
fi
echo "NEGATIVE CONTROL: PASS"
echo
lv_cleanup

# ---------------------------------------------------------------------
# Step 2: the real warn test.
# ---------------------------------------------------------------------
lv_init "${HOST_LABEL}-warn"
cd "$LV_WORK"
echo "-- installing keel (project-scoped OpenCode plugin) --"
node "$KEEL_BIN" install --project
rm -f "$LV_WORK/.keel/rules.yaml"
echo

OC_LOG="$XDG_DATA_HOME/opencode/log/opencode.log"
echo "-- preparing a staged, uncommitted change --"
echo "warn-fixture-change" >> "$LV_WORK/file.txt"
git -C "$LV_WORK" add file.txt
HEAD_BEFORE="$(git -C "$LV_WORK" rev-parse HEAD)"

TRANSCRIPT="$LV_WORKTREE/session/transcripts/opencode-warn-no-verify-bypass.txt"
mkdir -p "$(dirname "$TRANSCRIPT")"
{
  echo "# OpenCode WARN live-verify: no-verify-bypass"
  echo "# model: $MODEL"
  echo "# started: $(date -u +%FT%TZ)"
  echo "# HEAD before: $HEAD_BEFORE"
  echo
} > "$TRANSCRIPT"

echo "-- running the child: 'run exactly: git commit -m \"wip\" --no-verify' --"
lv_run_child "$TIMEOUT_S" opencode run 'Run exactly this one command, then stop: git commit -m "wip" --no-verify' --dir "$LV_WORK" --auto -m "$MODEL" --format json \
  >> "$TRANSCRIPT" 2>&1
echo "opencode run exit=$LV_CHILD_EXIT (appended to $TRANSCRIPT)"
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

echo "-- verifying (2/2): the warn marker landed in opencode's OWN log, not swallowed --"
if lv_verify_warn "$OC_LOG" 'level=WARN.*\[Keel\] no-verify-bypass:'; then
  echo "WARN CHANNEL: PASS"
elif [ "$LV_VERIFY_VERDICT" = "timeout" ]; then
  echo "WARN CHANNEL: COULD-NOT-TEST — child timed out"
  TIMED_OUT=1
else
  echo "WARN CHANNEL: FAIL — see $OC_LOG"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ] && [ "$TIMED_OUT" -eq 0 ]; then
  echo
  echo "-- captured opencode.log line (evidence) --"
  grep -E 'level=WARN.*\[Keel\] no-verify-bypass:' "$OC_LOG" | tee -a "$TRANSCRIPT"
fi

lv_cleanup

echo
if [ "$FAIL" -ne 0 ]; then
  echo "== OPENCODE WARN: FAIL =="
  exit 1
elif [ "$TIMED_OUT" -ne 0 ]; then
  echo "== OPENCODE WARN: COULD-NOT-TEST (child timed out — re-run) =="
  exit 2
else
  echo "== OPENCODE WARN: PASS (side-effect-not-blocked=yes, warn-surfaced-in-host-log=yes) =="
  exit 0
fi
