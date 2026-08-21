#!/bin/sh
# keel — Cline TaskComplete hook (claim-to-evidence real reach).
#
# v1 M2-C1. `~/.cline/hooks/TaskComplete` is a REAL, confirmed hook file
# name — read from the installed `cline` npm CLI's own
# `node_modules/@cline/core` (HookConfigFileName.TaskComplete maps to the
# `agent_end` runtime event, confirmed both in its `.d.ts` and in the
# compiled bundle's `afterRun` hook wiring: it fires with
# `turn:{outputText, status}` when a run finishes with status
# "completed"). `outputText` is the agent's own final generated text —
# this is Cline's Stop-equivalent claim-channel text, closing
# docs/integrations.md's prior "NO CHANNEL CONFIRMED" cell for Cline.
#
# `type: claim` is mode: observe and never blocks; this hook always
# exits 0.
#
# Install with: keel install --cline
exec keel hook cline
