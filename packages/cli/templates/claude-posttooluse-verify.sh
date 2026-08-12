#!/bin/sh
# keel — Claude Code PostToolUse hook (claim-to-evidence discharge).
#
# v1 M2-B1: this is the "satisfy" half of the verification/claim
# obligation OpenCode's tool.execute.after handler already provides
# (pipeline.markVerificationSatisfied) — Claude Code and the other
# exit-code hosts had no equivalent post-action call until this hook.
# Runs ALONGSIDE keel-reinject (claude-posttooluse.sh), not instead of
# it — this is a SEPARATE PostToolUse entry, registered by
# installClaudeCode() as a second hooks.PostToolUse block.
#
# Fires after a tool completes, carrying TOOL_NAME/TOOL_INPUT/TOOL_RESPONSE
# (env or stdin — `keel hook claude-code` reads either). If the completed
# call's own args match a pending obligation's `satisfy` pattern (e.g. it
# was `npm test`) AND the outcome can be positively confirmed as a pass,
# the obligation is cleared. If success cannot be determined from the
# payload, nothing is discharged — see hook.ts's `postToolUseExitCode` for
# why an unconfirmed outcome must never be treated as a pass.
#
# Prints nothing and always exits 0 — this can never block, same
# reasoning as the Stop hook (claude-stop.sh): the tool call already ran
# and cannot be un-run.
#
# Install with: keel install --claude-code
exec keel hook claude-code
