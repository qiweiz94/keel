#!/bin/sh
# keel — Gemini CLI Stop hook (claim-to-evidence real reach).
#
# v1 M2-B1. Gemini's hook format is Claude-Code-shaped: `gemini hooks
# migrate --from-claude` exists specifically to convert between them —
# same citation the PreToolUse hook (gemini-pretooluse.sh) already relies
# on. This is the SAME extension applied to Claude Code's Stop shape
# (last_assistant_message on stdin), which hook.ts's own prior comment
# had flagged as documented but deliberately unwired for this host.
#
# Docs confidence only — not exercised against a live Gemini CLI session
# in this repo (gemini is tier/auth-blocked in this lane's environment,
# see session/v1/EVIDENCE/m2-b1-verify.md). `type: claim` is mode:
# observe and never blocks; this hook always exits 0.
#
# Install with: keel install --gemini
exec keel hook gemini
