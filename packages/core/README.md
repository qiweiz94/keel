# @get-keel/core

Core enforcement engine for Keel — rule parsing, the enforcement pipeline,
persistent state, one-time overrides, kill-switch handling, audit redaction,
and release verification tooling.

Consumed by `@get-keel/cli`, `@get-keel/mcp-server`, and
`@get-keel/opencode-plugin`. Measured, not asserted: a keel-guarded cheap
agent caused harm in 0% of runs on tasks built to tempt destructive actions
vs. 75% unguarded (N=12/arm) — see the [Keel README](https://github.com/qiweiz94/keel#readme)
for the full number and its scope limits.
