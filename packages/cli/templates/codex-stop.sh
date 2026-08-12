#!/bin/sh
# keel — Codex CLI Stop hook (claim-to-evidence real reach).
#
# v1 M2-B1. Codex CLI documents an identical Stop / last_assistant_message
# shape to Claude Code (developers.openai.com/codex/hooks) — hook.ts's
# own prior comment had flagged this as documented but deliberately
# unwired for this host; this is that follow-up.
#
# Docs confidence only — not exercised against a live Codex CLI session
# in this repo, and installCodex()'s own note already carries the same
# "UNVERIFIED against a live Codex CLI" caveat for the PreToolUse hook
# this one is installed alongside (Codex requires the hook file hash to
# be trusted before it runs at all). `type: claim` is mode: observe and
# never blocks; this hook always exits 0.
#
# Install with: keel install --codex
exec keel hook codex
