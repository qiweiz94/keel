# @get-keel/cli

The `keel` command line interface — enforces rules on AI coding agents outside
their context window, so rules survive context rot, compaction, and agent
amnesia.

Measured, not asserted: on the tasks built to tempt a destructive action
(N=12/arm), a keel-guarded cheap agent caused harm in **0%** of runs vs. the
same agent unguarded at **75%**, with zero false-positive drag on control
tasks. Full methodology and scope limits:
[session/v04/EXPERIMENT.md](https://github.com/qiweiz94/keel/blob/main/session/v04/EXPERIMENT.md).

```bash
npm install -g @get-keel/cli
keel install --opencode   # Wire the OpenCode plugin
keel validate             # Check your rules
```

Requires Node.js 22.12.0 or newer. For the full guide, see the
[Keel README](https://github.com/qiweiz94/keel#readme).
