#!/bin/sh
# Shared harness for scripts/live-verify/<host>.sh.
#
# Every host script sources this, then calls the functions below in order.
# Nothing here writes to a real host config directory (~/.claude,
# ~/.config/opencode, ~/.opencode, ~/.gemini, ~/.codex, ~/.keel) — every
# path below lives under $LV_HOME or $LV_ROOT, both freshly created in
# /tmp and torn down by lv_cleanup.
#
# Isolation note (found empirically, not assumed): XDG_CONFIG_HOME /
# XDG_DATA_HOME alone do NOT isolate OpenCode — its global plugin dir
# resolves via bare os.homedir() (~/.opencode/plugins), outside the XDG
# namespace, so a run with only XDG_* overridden still loads the REAL
# ~/.opencode/plugins/keel-enforce.js. HOME must be overridden too. Since
# keel's own state/rules/traces (packages/core/src/enforce/*.ts) also
# resolve through node:os homedir(), isolating HOME alone covers keel's
# side as well as OpenCode's, Gemini's (~/.gemini) and Codex's (~/.codex).

set -eu

# The sourcing host script must `export SCRIPT_DIR=<dir containing it>`
# before `. lib/common.sh` — `$0` inside a sourced file is unreliable
# across sh/bash/dash, so path resolution is the caller's job.
: "${SCRIPT_DIR:?common.sh: caller must export SCRIPT_DIR before sourcing}"
LV_WORKTREE="$(cd "$SCRIPT_DIR/../.." && pwd)"
KEEL_BIN="${KEEL_BIN:-$LV_WORKTREE/packages/cli/bin/keel.js}"

if [ ! -f "$KEEL_BIN" ]; then
  echo "FAIL: KEEL_BIN not found at $KEEL_BIN — run npm run build first" >&2
  exit 1
fi

lv_log() { printf '%s\n' "$*"; }
lv_evidence_line() { printf '  %s\n' "$*"; }

# lv_init <label> [branch]
# Creates the isolated root, HOME, a bin/ dir with a `keel` shim on PATH,
# and a scratch git remote+working-copy pair with a force-push-worthy
# divergence already staged (so a successful force push is OBSERVABLE:
# the remote ref must move to a sha that did not exist on the remote
# before). branch defaults to "main"; pass a non-main name to isolate
# rules that specifically match a protected-branch target (no-push-to-main)
# from rules that match any force push (no-force-push) — the default
# ruleset matches BOTH for a main-branch force push, and the prompt-action
# no-push-to-main rule blocks unconditionally on the first attempt, so it
# is what actually fires there; targeting a non-main branch isolates
# no-force-push's own warn-then-deny ladder.
lv_init() {
  label="$1"
  LV_BRANCH="${2:-main}"
  LV_ROOT="$(mktemp -d "/tmp/keel-liveverify-${label}.XXXXXX")"
  LV_HOME="$LV_ROOT/home"
  LV_BIN="$LV_ROOT/bin"
  LV_REMOTE="$LV_ROOT/remote.git"
  LV_WORK="$LV_ROOT/work"
  mkdir -p "$LV_HOME" "$LV_BIN"

  # keel shim: the templates exec bare `keel`. Point PATH's `keel` at THIS
  # worktree's build so the test proves this worktree, not whatever `keel`
  # (if anything) happens to be globally installed.
  cat > "$LV_BIN/keel" <<SHIM
#!/bin/sh
exec node "$KEEL_BIN" "\$@"
SHIM
  chmod +x "$LV_BIN/keel"

  export HOME="$LV_HOME"
  export XDG_CONFIG_HOME="$LV_HOME/.config"
  export XDG_DATA_HOME="$LV_HOME/.local/share"
  export XDG_CACHE_HOME="$LV_HOME/.cache"
  export XDG_STATE_HOME="$LV_HOME/.local/state"
  export KEEL_STATE_DIR="$LV_HOME/.keel/state"
  export PATH="$LV_BIN:$PATH"

  lv_log "  isolated HOME=$LV_HOME"
  lv_log "  keel shim: $(command -v keel) -> $KEEL_BIN"

  # Bare remote + a working copy with a divergence that FORCES a real ref
  # move on a successful push (not a fast-forward no-op).
  git init -q --bare "$LV_REMOTE"
  git init -q -b "$LV_BRANCH" "$LV_WORK"
  git -C "$LV_WORK" config user.email "liveverify@example.invalid"
  git -C "$LV_WORK" config user.name "liveverify"
  git -C "$LV_WORK" remote add origin "$LV_REMOTE"
  echo "baseline" > "$LV_WORK/file.txt"
  git -C "$LV_WORK" add file.txt
  git -C "$LV_WORK" commit -q -m "baseline commit"
  git -C "$LV_WORK" push -q origin "$LV_BRANCH"
  LV_REMOTE_SHA_BEFORE="$(git -C "$LV_REMOTE" rev-parse "$LV_BRANCH")"
  # Proves the working copy itself can reach the remote — a later
  # non-push is a keel effect, not a wiring artifact (e.g. missing
  # upstream, wrong credentials).
  lv_log "  working copy successfully pushed baseline to origin/$LV_BRANCH — push path is live"

  # Diverge: amend so a plain push is rejected (non-fast-forward) and only
  # --force would move the ref — and it would move it to a DIFFERENT sha,
  # which is what makes "the ref didn't move" a meaningful assertion.
  echo "diverged" >> "$LV_WORK/file.txt"
  git -C "$LV_WORK" add file.txt
  git -C "$LV_WORK" commit -q --amend -m "diverged commit"
  LV_LOCAL_SHA_AFTER="$(git -C "$LV_WORK" rev-parse "$LV_BRANCH")"

  lv_log "  remote $LV_BRANCH before: $LV_REMOTE_SHA_BEFORE"
  lv_log "  local $LV_BRANCH (post-amend, would-be force target): $LV_LOCAL_SHA_AFTER"
  if [ "$LV_REMOTE_SHA_BEFORE" = "$LV_LOCAL_SHA_AFTER" ]; then
    lv_log "FAIL: setup bug — local and remote sha coincide, force push would be a no-op"
    exit 1
  fi
}

# lv_prewarm_hook <host> <command>
# Consumes a deny rule's "first violation only warns" pass via ONE direct
# `keel hook <host>` call, using the exact same isolated HOME/KEEL_STATE_DIR
# already exported by lv_init — so a subsequent violation of the SAME rule
# (matched via warningKey = rule.id) is the second one and actually blocks.
# Only needed for rules that don't have an unconditional first-block
# action (e.g. no-force-push is `action: deny`, which gets the
# warn-once-then-block ladder; no-push-to-main is `action: prompt`, which
# blocks unconditionally and needs no pre-warm — see pipeline.ts:754-776).
lv_prewarm_hook() {
  host="$1"
  cmd="$2"
  payload="$(printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$cmd")"
  out="$(printf '%s' "$payload" | keel hook "$host" 2>&1)" || true
  lv_log "  pre-warm ($host, \"$cmd\"): $out"
}

# lv_negative_control
# Proves the detection method (remote ref sha) actually observes a
# successful force push, using a FRESH copy of the same scratch state —
# no agent, no hook, just git. If this doesn't move the ref, the harness
# itself is broken and any PASS from the real test would be meaningless.
lv_negative_control() {
  ctrl="$LV_ROOT/control-clone"
  git clone -q "$LV_REMOTE" "$ctrl"
  git -C "$ctrl" checkout -q "$LV_BRANCH"
  echo "diverged (control)" >> "$ctrl/file.txt"
  git -C "$ctrl" add file.txt
  git -C "$ctrl" commit -q --amend -m "diverged commit (control)"
  git -C "$ctrl" push -q --force origin "$LV_BRANCH"
  after="$(git -C "$LV_REMOTE" rev-parse "$LV_BRANCH")"
  if [ "$after" = "$LV_REMOTE_SHA_BEFORE" ]; then
    lv_log "FAIL: negative control — unguarded force push did NOT move the remote ref. Harness detection method is broken."
    return 1
  fi
  lv_log "  negative control PASS: unguarded force push moved remote $LV_BRANCH $LV_REMOTE_SHA_BEFORE -> $after"
  # Reset the shared remote back to baseline so the real (guarded) test
  # starts from the same fixture the control just validated.
  git -C "$LV_REMOTE" update-ref "refs/heads/$LV_BRANCH" "$LV_REMOTE_SHA_BEFORE"
  return 0
}

# lv_assert_blocked
# Call AFTER the child session (or timeout). Checks the remote ref did
# NOT move off LV_REMOTE_SHA_BEFORE. On its own this is NOT sufficient
# proof of a block — see lv_verify_block, which is what callers should
# use for an actual PASS/FAIL verdict.
lv_assert_blocked() {
  after="$(git -C "$LV_REMOTE" rev-parse "$LV_BRANCH")"
  if [ "$after" = "$LV_REMOTE_SHA_BEFORE" ]; then
    lv_log "  remote $LV_BRANCH unchanged ($after) — force push did NOT reach the remote"
    return 0
  fi
  lv_log "  remote $LV_BRANCH MOVED $LV_REMOTE_SHA_BEFORE -> $after — force push REACHED the remote (block failed)"
  return 1
}

# lv_verify_block <transcript_file> <marker_regex>
# The real verdict function block tests should call — lv_assert_blocked
# alone is not enough: a timed-out child (LV_CHILD_EXIT=124) never
# attempted the push either, and would read as a false PASS on ref-move
# alone; and a plain string match against a transcript this SAME script
# wrote headers into is a tautological check that can't fail. This
# requires ALL of: the child did not time out, the ref did not move, AND
# the transcript contains a marker that only the CHILD's own captured
# output could have produced (e.g. '\[Keel\] no-force-push' — write such
# markers so they cannot appear in any header this script itself prints
# into the transcript). Sets LV_VERIFY_VERDICT to pass/fail/timeout.
lv_verify_block() {
  transcript="$1"
  marker="$2"
  if [ "${LV_CHILD_EXIT:-0}" -eq 124 ]; then
    lv_log "  child timed out — the push was never confirmed attempted OR refused. Verdict: could-not-test, not PASS."
    LV_VERIFY_VERDICT="timeout"
    return 1
  fi
  if ! lv_assert_blocked; then
    LV_VERIFY_VERDICT="fail"
    return 1
  fi
  if ! grep -qE "$marker" "$transcript"; then
    lv_log "  ref unmoved, but no keel block marker ($marker) found in the child's own transcript output — not enough proof of an actual block attempt"
    LV_VERIFY_VERDICT="fail"
    return 1
  fi
  lv_log "  confirmed: marker \"$marker\" found in the child's own captured output"
  LV_VERIFY_VERDICT="pass"
  return 0
}

# lv_verify_warn <marker_source_file> <marker_regex>
# The `warn` mirror of lv_verify_block — for a verdict that must NOT stop
# the action, so ref/HEAD-unmoved is the wrong signal (a warn and a
# swallowed warn are BOTH "the action happened"). The CALLER must have
# already confirmed the side effect actually occurred (e.g. a new commit
# exists) before calling this — that is the block-vs-warn discriminator.
# This checks the other half: the marker text appears in a channel the
# CALLER's script did not itself write (a host's own log file, or the
# child's own captured stdout for hosts with no independent log), and the
# child did not time out (a timed-out child never got far enough to
# produce a genuine marker either way). Sets LV_VERIFY_VERDICT to
# pass/fail/timeout, same convention as lv_verify_block.
lv_verify_warn() {
  marker_source="$1"
  marker="$2"
  if [ "${LV_CHILD_EXIT:-0}" -eq 124 ]; then
    lv_log "  child timed out — the warn was never confirmed surfaced. Verdict: could-not-test, not PASS."
    LV_VERIFY_VERDICT="timeout"
    return 1
  fi
  if [ ! -f "$marker_source" ] || ! grep -qE "$marker" "$marker_source"; then
    lv_log "  no keel warn marker ($marker) found in $marker_source — warn was swallowed, or never fired"
    LV_VERIFY_VERDICT="fail"
    return 1
  fi
  lv_log "  confirmed: marker \"$marker\" found in $marker_source"
  LV_VERIFY_VERDICT="pass"
  return 0
}

# lv_no_marker <marker_source_file> <marker_regex>
# The warn-path analogue of lv_negative_control: proves the marker check
# above is not tainted (e.g. matching some unrelated, always-present log
# line). Call this BEFORE the rule-triggering command has ever run, using
# a fixture where the same command runs WITHOUT the trigger (no
# --no-verify, etc.) — if the marker is already present, the detector
# itself is broken and any later PASS would be meaningless.
lv_no_marker() {
  marker_source="$1"
  marker="$2"
  if [ -f "$marker_source" ] && grep -qE "$marker" "$marker_source"; then
    lv_log "  FAIL: marker ($marker) found in $marker_source even though the triggering command was never run — detector is tainted."
    return 1
  fi
  lv_log "  confirmed absent: marker \"$marker\" not present in $marker_source without the trigger"
  return 0
}

lv_cleanup() {
  [ -n "${LV_ROOT:-}" ] && rm -rf "$LV_ROOT"
}

# lv_run_child <timeout_seconds> <cmd...>
# Runs a child invocation under the hard-timeout wrapper WITHOUT letting
# this script's `set -e` abort at that line — a 300s timeout (wrapper
# exit 124), a transient model error, or a genuine keel-reported nonzero
# exit must all fall through to the caller's own assertion (lv_assert_blocked)
# instead of killing the script before the remote ref gets checked. Sets
# LV_CHILD_EXIT. Redirect at the call site as usual:
#   lv_run_child 300 opencode run ... >> "$TRANSCRIPT" 2>&1
lv_run_child() {
  timeout_s="$1"
  shift
  set +e
  node "$SCRIPT_DIR/lib/with-timeout.mjs" "$timeout_s" "$@"
  LV_CHILD_EXIT=$?
  set -e
  if [ "$LV_CHILD_EXIT" -eq 124 ]; then
    lv_log "  child TIMED OUT after ${timeout_s}s (exit 124) — block is UNPROVEN, not disproven, for this run"
  fi
}
