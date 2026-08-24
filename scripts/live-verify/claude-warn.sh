#!/bin/sh
# M4 host-breadth: WARN live verification for Claude Code.
#
# claude.sh (Wave-1) already live-proves BLOCK (when auth is available).
# This is the WARN mirror: a first-violation `warn` verdict must (1) NOT
# stop the action, and (2) actually reach Claude Code's real non-blocking
# channel (hookSpecificOutput.additionalContext + systemMessage on stdout
# JSON, exit 0 — see hook.ts's renderVerdict comment and
# session/EVIDENCE/wave3-warnsurface.md for why plain stderr-on-exit-0 is
# provably invisible and was replaced).
#
# Unlike OpenCode, Claude Code (an exit-code host) has no independent
# host-side log this harness can read out-of-band — the JSON envelope
# keel's OWN `keel hook claude-code` subprocess writes IS the channel, and
# whether Claude Code itself echoes that stdout back into its own
# `--output-format json` event stream is NOT independently confirmed (this
# is a host-observability question, not something a script run against
# this repo can settle by reading source). What IS confirmed, separately,
# auth-free, before trusting anything below: a direct
# `echo '<payload>' | keel hook claude-code` for this exact `--no-verify`
# command emits `{"systemMessage":"[keel:no-verify-bypass] ...",
# "hookSpecificOutput":{"additionalContext":"[keel:no-verify-bypass] ..."}}`
# on stdout, exit 0 — keel's OWN half of this is right regardless of what
# follows. See lv_verify_warn_exitcode_host in common.sh for how that
# distinction is kept out of the verdict: HEAD-unmoved is a real FAIL
# (blocked, not warned); HEAD-moved-with-no-marker is COULD-NOT-TEST, not
# FAIL (host echo-back unconfirmed, not a demonstrated keel defect).
#
# What this script CAN still prove live if the marker DOES appear: the
# pipeline round-trips through a REAL running `claude -p` session making
# its OWN decision to run the triggering command — not a canned payload
# fed straight to `keel hook` — which is meaningfully more than the
# existing unit tests (hook-command.test.ts's warn-visibility suite),
# which never invoke a live host at all.
#
# Rule under test: no-verify-bypass (install.ts) — action: warn, mode:
# warn (a PERMANENT warn, never escalates), matching `git commit ...
# --no-verify`. One child call is enough; no pre-warm needed.
#
# Auth honesty (checked FIRST, same empirical finding as claude.sh): an
# isolated CLAUDE_CONFIG_DIR does not survive login on this machine, and
# there is no ANTHROPIC_API_KEY set as a fallback. If the auth probe
# fails this script records that and stops, same as claude.sh — it does
# not fall back to the real, off-limits ~/.claude.

set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export SCRIPT_DIR
. "$SCRIPT_DIR/lib/common.sh"

MODEL="sonnet"
TIMEOUT_S=300
HOST_LABEL="claude"
FAIL=0
TIMED_OUT=0

if ! command -v claude >/dev/null 2>&1; then
  echo "FAIL: claude not on PATH — cannot run live verification" >&2
  exit 1
fi

echo "== Claude Code WARN live verification =="
echo "claude version: $(claude --version 2>&1)"
echo

lv_init "${HOST_LABEL}-warn-authprobe"
export CLAUDE_CONFIG_DIR="$LV_HOME/.claude-isolated"
mkdir -p "$CLAUDE_CONFIG_DIR"
cd "$LV_WORK"

echo "-- auth probe: isolated HOME + isolated CLAUDE_CONFIG_DIR, single attempt --"
node "$SCRIPT_DIR/lib/with-timeout.mjs" 60 \
  claude -p "say hi, one word" --output-format json \
  > "$LV_ROOT/authprobe.log" 2>&1 || true
cat "$LV_ROOT/authprobe.log"
echo

if grep -q '"is_error":true' "$LV_ROOT/authprobe.log" 2>/dev/null || grep -qi "not logged in" "$LV_ROOT/authprobe.log" 2>/dev/null; then
  echo "AUTH HONESTY: isolated CLAUDE_CONFIG_DIR cannot authenticate on this machine."
  echo "captured output above is the real error from the one attempt."
  echo
  echo "== CLAUDE CODE WARN: AUTH-BLOCKED (warn-fires-headless=untested, warn-surfaced-live=untested) =="
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
export CLAUDE_CONFIG_DIR="$LV_HOME/.claude-isolated"
mkdir -p "$CLAUDE_CONFIG_DIR"
cd "$LV_WORK"
echo "-- installing keel (project-scoped Claude Code hooks) --"
node "$KEEL_BIN" install --claude-code
echo "warn-fixture-change" >> "$LV_WORK/file.txt"
git -C "$LV_WORK" add file.txt
HEAD_BEFORE_CTRL="$(git -C "$LV_WORK" rev-parse HEAD)"

echo "-- running the child: ordinary commit, no --no-verify (must NOT trip no-verify-bypass) --"
lv_run_child "$TIMEOUT_S" claude -p 'Run exactly this one command, then stop: git commit -m "wip control"' --model "$MODEL" --dangerously-skip-permissions --output-format json \
  > "$LV_ROOT/control-run.log" 2>&1
echo "claude -p exit=$LV_CHILD_EXIT"
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
export CLAUDE_CONFIG_DIR="$LV_HOME/.claude-isolated"
mkdir -p "$CLAUDE_CONFIG_DIR"
cd "$LV_WORK"
echo "-- installing keel (project-scoped Claude Code hooks) --"
node "$KEEL_BIN" install --claude-code
echo "warn-fixture-change" >> "$LV_WORK/file.txt"
git -C "$LV_WORK" add file.txt
HEAD_BEFORE="$(git -C "$LV_WORK" rev-parse HEAD)"

TRANSCRIPT="$LV_WORKTREE/session/transcripts/claude-warn-no-verify-bypass.txt"
mkdir -p "$(dirname "$TRANSCRIPT")"
{
  echo "# Claude Code WARN live-verify: no-verify-bypass"
  echo "# model: $MODEL"
  echo "# started: $(date -u +%FT%TZ)"
  echo "# HEAD before: $HEAD_BEFORE"
  echo
} > "$TRANSCRIPT"

echo "-- running the child: 'run exactly: git commit -m \"wip\" --no-verify' --"
lv_run_child "$TIMEOUT_S" claude -p 'Run exactly this one command, then stop: git commit -m "wip" --no-verify' --model "$MODEL" --dangerously-skip-permissions --output-format json \
  >> "$TRANSCRIPT" 2>&1
echo "claude -p exit=$LV_CHILD_EXIT (appended to $TRANSCRIPT)"
HEAD_AFTER="$(git -C "$LV_WORK" rev-parse HEAD)"
{
  echo
  echo "# HEAD after: $HEAD_AFTER"
} >> "$TRANSCRIPT"
echo

echo "-- verifying: HEAD-moved (not blocked) AND marker in the child's own transcript --"
echo "   (HEAD-unmoved = real FAIL; HEAD-moved-but-no-marker = COULD-NOT-TEST, not FAIL —"
echo "   see lv_verify_warn_exitcode_host in common.sh for why those are kept apart)"
if lv_verify_warn_exitcode_host "$TRANSCRIPT" '\[keel:no-verify-bypass\]' "$HEAD_BEFORE" "$HEAD_AFTER"; then
  echo "WARN CHANNEL: PASS"
elif [ "$LV_VERIFY_VERDICT" = "could-not-test" ]; then
  echo "WARN CHANNEL: COULD-NOT-TEST"
  TIMED_OUT=1
else
  echo "WARN CHANNEL: FAIL — see $TRANSCRIPT"
  FAIL=1
fi

lv_cleanup

echo
if [ "$FAIL" -ne 0 ]; then
  echo "== CLAUDE CODE WARN: FAIL =="
  exit 1
elif [ "$TIMED_OUT" -ne 0 ]; then
  echo "== CLAUDE CODE WARN: COULD-NOT-TEST (host echo-back of its own hook's stdout into --output-format json is unconfirmed here — re-run, or capture a raw transcript by hand) =="
  exit 2
else
  echo "== CLAUDE CODE WARN: PASS (side-effect-not-blocked=yes, warn-surfaced-live=yes) =="
  exit 0
fi
