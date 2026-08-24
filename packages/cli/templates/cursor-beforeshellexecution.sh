#!/bin/sh
# keel — Cursor hook entry point.
#
# The payload arrives on stdin and is handled by `keel hook cursor`, which
# parses it with a real JSON parser and emits this host's verdict format.
# `keel hook cursor` discriminates the event from the payload's own shape
# (Cursor's hook payloads carry no explicit event-name field) — see
# hook.ts's `cursor` case for exactly how each shape is told apart.
#
# This SAME script is registered under every Cursor hook event keel wires
# (beforeShellExecution, beforeMCPExecution — block-capable; postToolUse,
# postToolUseFailure — claim-to-evidence discharge, v1 M2-C1; and
# afterAgentResponse — the claim-channel text, v1 M2-C1), not one script
# per event — install.ts's `installCursor()` wires `.cursor/hooks.json`
# accordingly. This used to be ~60 lines of shell that pulled the verdict
# out of keel's JSON with sed. That silently truncated any block reason
# containing a quote — the output stayed valid JSON, so nothing ever
# errored.
#
# Install with: keel install --cursor
exec keel hook cursor
