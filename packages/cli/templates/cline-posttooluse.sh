#!/bin/sh
# keel — Cline PostToolUse hook (claim-to-evidence discharge).
#
# v1 M2-C1. `~/.cline/hooks/PostToolUse` is a REAL, confirmed hook file
# name — read from the installed `cline` npm CLI's own
# `node_modules/@cline/core` (HookConfigFileName.PostToolUse maps to the
# `tool_result` runtime event, confirmed both in its `.d.ts` and in the
# compiled bundle's `afterTool` hook wiring). Discharges a pending
# verification/claim obligation when the completed call's own outcome can
# be positively confirmed as a pass, and scans the tool's own output text
# for secret-shaped content — see hook.ts's cline PostToolUse branch
# comment for exactly what is and is not confirmed here (Cline's own
# `success` field does not confirm shell exit status, so this never
# discharges `type: verification` on that alone).
#
# Always exits 0 — a completed tool call cannot be un-run, so this can
# never block.
#
# Install with: keel install --cline
exec keel hook cline
