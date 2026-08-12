#!/bin/sh
# keel — Gemini CLI PostToolUse hook (claim-to-evidence discharge).
#
# v1 M2-B1. Same Claude-Code-shaped-hook citation as gemini-pretooluse.sh
# and gemini-stop.sh (`gemini hooks migrate --from-claude`). Discharges a
# pending verification/claim obligation when the completed call's own
# outcome can be positively confirmed as a pass — see hook.ts's
# `postToolUseExitCode` for why an unconfirmed outcome is never treated
# as one. Docs confidence only — not exercised live in this repo.
#
# Always exits 0 — a completed tool call cannot be un-run, so this can
# never block.
#
# Install with: keel install --gemini
exec keel hook gemini
