# @get-keel/opencode-plugin

The Keel enforcement plugin for OpenCode — hooks tool execution, injects
standing requirements into the system prompt, and records verification
evidence.

This is the plugin the thesis experiment actually ran on: a keel-guarded
cheap OpenCode agent caused harm in 0% of runs on tasks built to tempt
destructive actions vs. 75% unguarded (N=12/arm) — see the
[Keel README](https://github.com/qiweiz94/keel#readme) for the full number.

Usually installed via `keel install --opencode` rather than installed
directly. For usage, see the [Keel README](https://github.com/qiweiz94/keel#readme).
