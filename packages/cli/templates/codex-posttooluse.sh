#!/bin/sh
# keel — Codex CLI PostToolUse hook (claim-to-evidence discharge).
#
# v1 M2-B1. Same "converged on the same hookSpecificOutput-shaped hook
# contract" citation codex-pretooluse.sh already relies on. Discharges a
# pending verification/claim obligation when the completed call's own
# outcome can be positively confirmed as a pass — see hook.ts's
# `postToolUseExitCode` for why an unconfirmed outcome is never treated
# as one. Docs confidence only — not exercised live in this repo; see
# codex-pretooluse.sh / installCodex()'s own "UNVERIFIED against a live
# Codex CLI" caveat, which applies here too.
#
# Always exits 0 — a completed tool call cannot be un-run, so this can
# never block.
#
# Install with: keel install --codex
exec keel hook codex
