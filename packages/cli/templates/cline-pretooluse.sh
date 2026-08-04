#!/bin/sh
# keel — Cline PreToolUse hook.
#
# The payload arrives on stdin and is handled by `keel hook cline`, which
# parses it with a real JSON parser and emits this host's verdict format.
#
# This used to be ~60 lines of shell that pulled the verdict out of keel's
# JSON with sed. That silently truncated any block reason containing a
# quote — the output stayed valid JSON, so nothing ever errored.
#
# Install with: keel install --cline
exec keel hook cline
