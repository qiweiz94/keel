#!/bin/sh
# keel — Claude Code Stop hook.
#
# Fires once per assistant turn, after the model finishes, carrying
# `last_assistant_message` on stdin — the one channel that reliably exposes
# the agent's own completed output (claim-to-evidence real reach, v0.4
# Phase 1). This is observe-mode only and never blocks; it always exits 0.
#
# Install with: keel install --claude-code
exec keel hook claude-code
