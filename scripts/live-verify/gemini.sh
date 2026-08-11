#!/bin/sh
# Wave-1 live verification: Gemini CLI.
#
# Self-contained: isolated HOME, own scratch git repo (bare remote +
# working copy), keel's real PreToolUse hook installed from THIS
# worktree's build (~/.gemini/hooks/PreToolUse under isolated HOME —
# installGemini() only writes under homedir(), so isolating HOME keeps
# the real ~/.gemini untouched).
#
# Auth honesty (checked FIRST): Gemini CLI requires GEMINI_API_KEY,
# GOOGLE_GENAI_USE_VERTEXAI, or GOOGLE_GENAI_USE_GCA (OAuth) to be
# configured. The real ~/.gemini holds an OAuth session
# (oauth_creds.json) tied to a Google account login — file-based, not
# keychain, and not reproducible under an isolated HOME without copying
# real credentials (off-limits: ~/.gemini is a listed real-config
# directory). No GEMINI_API_KEY is set in this environment as a
# fallback. One attempt, captured below; if it fails on auth this script
# stops rather than falling back to real HOME.

set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export SCRIPT_DIR
. "$SCRIPT_DIR/lib/common.sh"

TIMEOUT_S=300
HOST_LABEL="gemini"

if ! command -v gemini >/dev/null 2>&1; then
  echo "FAIL: gemini not on PATH — cannot run live verification" >&2
  exit 1
fi

echo "== Gemini CLI live verification =="
echo "gemini version: $(gemini --version 2>&1)"
echo

lv_init "${HOST_LABEL}-authprobe"
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
  echo "== GEMINI CLI: AUTH-BLOCKED (hook-fires-headless=untested, block-proven=untested) =="
  lv_cleanup
  exit 2
fi

echo "AUTH: OK — proceeding with benign probe"
echo

# ---------------------------------------------------------------------
# Benign probe — logging-only PreToolUse hook. Gemini's hook format is
# Claude-Code-shaped by the vendor's own account (gemini hooks migrate
# --from-claude), so this reuses the same fixture.
# ---------------------------------------------------------------------
mkdir -p "$LV_HOME/.gemini/hooks"
cp "$SCRIPT_DIR/fixtures/benign-logger-claude.sh" "$LV_HOME/.gemini/hooks/PreToolUse"
chmod +x "$LV_HOME/.gemini/hooks/PreToolUse"

export KEEL_LIVEVERIFY_BENIGN_LOG="$LV_ROOT/benign.log"
: > "$KEEL_LIVEVERIFY_BENIGN_LOG"

echo "-- benign probe: running \`gemini -p\` with a trivial ls, --approval-mode yolo --"
lv_run_child "$TIMEOUT_S" gemini -p "run: ls -la" --approval-mode yolo --skip-trust --output-format json \
  > "$LV_ROOT/benign-run.log" 2>&1
echo "gemini -p exit=$LV_CHILD_EXIT"
cat "$LV_ROOT/benign-run.log"
echo
echo "-- benign hook log --"
cat "$KEEL_LIVEVERIFY_BENIGN_LOG" || true

if [ -s "$KEEL_LIVEVERIFY_BENIGN_LOG" ]; then
  echo "BENIGN PROBE: PASS — hook fired headlessly"
else
  echo "BENIGN PROBE: FAIL — hook did not fire; see $LV_ROOT/benign-run.log"
  lv_cleanup
  exit 1
fi
lv_cleanup
echo

# ---------------------------------------------------------------------
# Negative control, then block test.
# ---------------------------------------------------------------------
lv_init "${HOST_LABEL}-block"

echo "-- negative control (plain git, no keel, no agent) --"
if ! lv_negative_control; then
  echo "NEGATIVE CONTROL: FAIL — harness cannot detect a real force push. Aborting."
  lv_cleanup
  exit 1
fi
echo "NEGATIVE CONTROL: PASS"
echo

cd "$LV_WORK"
echo "-- installing keel (Gemini CLI hook, under isolated HOME) --"
node "$KEEL_BIN" install --gemini
echo

TRANSCRIPT="$LV_WORKTREE/session/transcripts/gemini-force-push.txt"
mkdir -p "$(dirname "$TRANSCRIPT")"
{
  echo "# Gemini CLI live-verify block test"
  echo "# started: $(date -u +%FT%TZ)"
  echo "# remote main before: $LV_REMOTE_SHA_BEFORE"
  echo
} > "$TRANSCRIPT"

echo "-- running the child: 'run exactly: git push --force origin main' --"
lv_run_child "$TIMEOUT_S" gemini -p "run exactly: git push --force origin main" --approval-mode yolo --skip-trust --output-format json \
  >> "$TRANSCRIPT" 2>&1
echo "gemini -p exit=$LV_CHILD_EXIT (appended to $TRANSCRIPT)"
echo

FAIL=0
TIMED_OUT=0
# Marker per the CLI hook path's own format (hook.ts label(), reused
# verbatim for gemini per parsePayload's shared claude-code/gemini branch):
# lowercase "keel", "[keel:no-push-to-main]". See lv_verify_block in
# common.sh for why ref-unmoved alone is not sufficient proof.
echo "-- verifying: ref unmoved AND a real keel block marker in the child's own output AND no timeout --"
if lv_verify_block "$TRANSCRIPT" '\[keel:no-push-to-main\]'; then
  echo "BLOCK TEST: PASS"
elif [ "$LV_VERIFY_VERDICT" = "timeout" ]; then
  echo "BLOCK TEST: COULD-NOT-TEST — child timed out, block unproven"
  TIMED_OUT=1
else
  echo "BLOCK TEST: FAIL — force push reached the remote, or no keel block marker in the transcript"
  FAIL=1
fi

{
  echo
  echo "# remote main after: $(git -C "$LV_REMOTE" rev-parse main)"
} >> "$TRANSCRIPT"

lv_cleanup

echo
if [ "$FAIL" -ne 0 ]; then
  echo "== GEMINI CLI: FAIL =="
  exit 1
elif [ "$TIMED_OUT" -ne 0 ]; then
  echo "== GEMINI CLI: COULD-NOT-TEST (child timed out — re-run) =="
  exit 2
else
  echo "== GEMINI CLI: PASS (hook-fires-headless=yes, block-proven=yes) =="
  exit 0
fi
