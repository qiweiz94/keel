# OpenCode Integration

OpenCode is keel's flagship host: a real plugin hooking `tool.execute.before`
(and `.after`), the only host verified `live` on both the block *and* warn
paths, and the host every run of the thesis experiment
([`session/v04/EXPERIMENT.md`](../../session/v04/EXPERIMENT.md)) actually
used to measure the guarded-vs-unguarded numbers on the README.

## Install

```bash
keel install --opencode
```

This copies the canonical plugin (`packages/opencode-plugin/src/plugin.ts`,
bundled to `templates/keel-enforce.js`) to
`~/.opencode/plugins/keel-enforce.js` — auto-loaded by OpenCode in every
project on this machine, no per-project setup. Restart OpenCode (or start a
new session) after installing.

## How it works

```
Tool call requested
        ↓
tool.execute.before   → evaluates against your rules, OUTSIDE the model's context
        ↓
allow  → tool runs
warn   → client.app.log({level:'warn', ...}) + tool runs
deny/block/prompt → throws before the tool executes (hard stop — identical
                     effect whether a human is present to answer a prompt
                     or not, since a throw can't wait on one)
        ↓
tool.execute.after     → verification-obligation discharge, standing
                          requirements re-injection, claim-channel checks
```

`deny`, `block`, and `prompt` all take the same code path
(`packages/opencode-plugin/src/plugin.ts`): an unconditional throw before the
tool call reaches OpenCode's own executor. In a headless `opencode run`
session — the way the thesis experiment's guarded arm was driven — there is
no human to answer a `prompt`, so it behaves exactly like a hard `deny`. See
`session/v04/EVIDENCE/attribution-reaudit.md` for the code citation and the
trace evidence this produces in practice.

## Verified live

Both the block path and the warn path have been exercised inside a real
running OpenCode session, not just built against types or docs — the only
host in the matrix with both rows at `live`:

- **Block:** a live `opencode run` blocked a destructive/forbidden action;
  transcript in `session/transcripts/`.
- **Warn:** `client.app.log({level:'warn', ...})` does **not** appear in
  `opencode run --format json`'s stdout, but **does** land in
  `$XDG_DATA_HOME/opencode/log/opencode.log` — confirmed empirically for the
  headless case specifically (`scripts/live-verify/opencode-warn.sh`,
  `session/v1/EVIDENCE/m4-hostbreadth.md`).

Full matrix, every host, every caveat: [`docs/integrations.md`](../integrations.md).

## Requirements

- `keel` on PATH (`npm install -g @get-keel/cli`)
- Rules in `~/.keel/rules.yaml` / `.keel/rules.yaml` (project rules override
  global rules for the same id)
- Standing requirements in `~/.keel/requirements.md` / `.keel/requirements.md`

## See it block an agent

`scripts/demo/keel-disable-trace.sh` reproduces, offline, the exact rule
chain OpenCode enforced in the thesis experiment's strongest trace: an agent
blocked from force-pushing to main, then blocked again when it tries to
`keel disable` its way around the block.
