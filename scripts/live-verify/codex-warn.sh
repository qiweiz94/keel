#!/bin/sh
# M4 host-breadth: WARN live verification for Codex CLI.
#
# codex.sh (Wave-1) already live-proves BLOCK when Codex is installable
# and authenticated. This is the WARN mirror — same reasoning and rule
# under test (no-verify-bypass) as claude-warn.sh/gemini-warn.sh. Codex's
# warn envelope is `{"systemMessage": "..."}` only (hookSpecificOutput is
# deliberately omitted — see hook.ts's comment on the external
# permissionDecision:'allow' rejection report, #249), still carrying the
# same `[keel:no-verify-bypass]` marker text. Codex is likewise an
# exit-code host with no independent log this harness reads out-of-band —
# see claude-warn.sh's header in full for why a marker-absent-but-
# HEAD-moved result is COULD-NOT-TEST rather than FAIL (Codex's own
# echo-back of its hook's stdout into its own output is not independently
# confirmed), and for the auth-free `keel hook codex` check that
# validates keel's own half of this separately from host auth.
#
# Per the binding constraint this attempts exactly ONE throwaway install
# (npm install --prefix into a scratch /tmp dir, never -g, never touching
# any global npm state), same as codex.sh. If install or auth fails, this
# records that honestly and stops.

set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export SCRIPT_DIR
. "$SCRIPT_DIR/lib/common.sh"

TIMEOUT_S=300
HOST_LABEL="codex"
INSTALL_DIR=""
FAIL=0
TIMED_OUT=0

cleanup_install_dir() {
  [ -n "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR"
}

echo "== Codex CLI WARN live verification =="

if command -v codex >/dev/null 2>&1; then
  echo "codex already on PATH ($(command -v codex)) — using it as-is rather than shadowing with a throwaway install."
  CODEX_BIN_RESOLVED="$(command -v codex)"
else
  INSTALL_DIR="$(mktemp -d /tmp/keel-codex-warn-throwaway.XXXXXX)"
  echo "codex not installed — attempting ONE throwaway install into $INSTALL_DIR"
  if ! npm install --prefix "$INSTALL_DIR" @openai/codex > "$INSTALL_DIR/npm-install.log" 2>&1; then
    echo "CODEX INSTALL: FAILED — captured npm output:"
    cat "$INSTALL_DIR/npm-install.log"
    echo
    echo "== CODEX CLI WARN: NOT INSTALLABLE (warn-fires-headless=untested, warn-surfaced-live=untested) =="
    cleanup_install_dir
    exit 2
  fi
  CODEX_BIN_RESOLVED="$INSTALL_DIR/node_modules/.bin/codex"
  echo "CODEX INSTALL: OK -> $CODEX_BIN_RESOLVED"
fi
echo

lv_init "${HOST_LABEL}-warn-authprobe"
export CODEX_HOME="$LV_HOME/.codex-isolated"
mkdir -p "$CODEX_HOME"
cd "$LV_WORK"

echo "-- auth probe: isolated HOME + isolated CODEX_HOME, single attempt --"
node "$SCRIPT_DIR/lib/with-timeout.mjs" 60 \
  "$CODEX_BIN_RESOLVED" exec --skip-git-repo-check "say hi, one word" < /dev/null \
  > "$LV_ROOT/authprobe.log" 2>&1 || true
cat "$LV_ROOT/authprobe.log"
echo

if grep -qi "401 Unauthorized\|Not authenticated\|codex login" "$LV_ROOT/authprobe.log" 2>/dev/null; then
  echo "AUTH HONESTY: isolated CODEX_HOME cannot authenticate on this machine (no OPENAI_API_KEY,"
  echo "real ~/.codex auth off-limits). captured output above is the real error from the one attempt."
  echo
  echo "== CODEX CLI WARN: AUTH-BLOCKED (warn-fires-headless=untested, warn-surfaced-live=untested) =="
  lv_cleanup
  cleanup_install_dir
  exit 2
fi
echo "AUTH: OK — proceeding"
lv_cleanup
echo

# ---------------------------------------------------------------------
# Negative control.
# ---------------------------------------------------------------------
lv_init "${HOST_LABEL}-warn-control"
export CODEX_HOME="$LV_HOME/.codex-isolated"
mkdir -p "$CODEX_HOME"
cd "$LV_WORK"
echo "-- installing keel (Codex CLI hook, under isolated HOME) --"
node "$KEEL_BIN" install --codex
echo "warn-fixture-change" >> "$LV_WORK/file.txt"
git -C "$LV_WORK" add file.txt
HEAD_BEFORE_CTRL="$(git -C "$LV_WORK" rev-parse HEAD)"

echo "-- running the child: ordinary commit, no --no-verify (must NOT trip no-verify-bypass) --"
lv_run_child "$TIMEOUT_S" "$CODEX_BIN_RESOLVED" exec --skip-git-repo-check 'Run exactly this one command, then stop: git commit -m "wip control"' < /dev/null \
  > "$LV_ROOT/control-run.log" 2>&1
echo "codex exec exit=$LV_CHILD_EXIT"
HEAD_AFTER_CTRL="$(git -C "$LV_WORK" rev-parse HEAD)"

if [ "$HEAD_AFTER_CTRL" = "$HEAD_BEFORE_CTRL" ]; then
  echo "NEGATIVE CONTROL: FAIL — commit never happened even without --no-verify; child/harness issue. See $LV_ROOT/control-run.log"
  cat "$LV_ROOT/control-run.log"
  lv_cleanup
  cleanup_install_dir
  exit 1
fi
echo "  ordinary commit succeeded ($HEAD_BEFORE_CTRL -> $HEAD_AFTER_CTRL)"

if ! lv_no_marker "$LV_ROOT/control-run.log" '\[keel:no-verify-bypass\]'; then
  echo "NEGATIVE CONTROL: FAIL — marker present without the trigger. Aborting; a PASS below would be meaningless."
  lv_cleanup
  cleanup_install_dir
  exit 1
fi
echo "NEGATIVE CONTROL: PASS"
lv_cleanup
echo

# ---------------------------------------------------------------------
# The real warn test.
# ---------------------------------------------------------------------
lv_init "${HOST_LABEL}-warn"
export CODEX_HOME="$LV_HOME/.codex-isolated"
mkdir -p "$CODEX_HOME"
cd "$LV_WORK"
echo "-- installing keel (Codex CLI hook, under isolated HOME) --"
node "$KEEL_BIN" install --codex
echo "warn-fixture-change" >> "$LV_WORK/file.txt"
git -C "$LV_WORK" add file.txt
HEAD_BEFORE="$(git -C "$LV_WORK" rev-parse HEAD)"

TRANSCRIPT="$LV_WORKTREE/session/transcripts/codex-warn-no-verify-bypass.txt"
mkdir -p "$(dirname "$TRANSCRIPT")"
{
  echo "# Codex CLI WARN live-verify: no-verify-bypass"
  echo "# started: $(date -u +%FT%TZ)"
  echo "# HEAD before: $HEAD_BEFORE"
  echo
} > "$TRANSCRIPT"

echo "-- running the child: 'run exactly: git commit -m \"wip\" --no-verify' --"
lv_run_child "$TIMEOUT_S" "$CODEX_BIN_RESOLVED" exec --skip-git-repo-check 'Run exactly this one command, then stop: git commit -m "wip" --no-verify' < /dev/null \
  >> "$TRANSCRIPT" 2>&1
echo "codex exec exit=$LV_CHILD_EXIT (appended to $TRANSCRIPT)"
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
cleanup_install_dir

echo
if [ "$FAIL" -ne 0 ]; then
  echo "== CODEX CLI WARN: FAIL =="
  exit 1
elif [ "$TIMED_OUT" -ne 0 ]; then
  echo "== CODEX CLI WARN: COULD-NOT-TEST (host echo-back of its own hook's stdout into its own output is unconfirmed here — re-run, or capture a raw transcript by hand) =="
  exit 2
else
  echo "== CODEX CLI WARN: PASS (side-effect-not-blocked=yes, warn-surfaced-live=yes) =="
  exit 0
fi
