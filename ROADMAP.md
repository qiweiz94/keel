# Roadmap

Where keel is and where it's going. Anything under **Shipped** is in the current
release and covered by tests; anything under **Planned** is not built yet.

## Shipped (v0.2.x)

**Enforcement**
- Tool-call interception for 8 hosts — see [docs/integrations.md](docs/integrations.md)
  for the per-host verification level
- One enforcement entry point (`keel hook <host>`), plus a `generic` stdin/exit-code
  contract for hosts with no bespoke adapter
- MCP server (`keel serve`, 7 tools) and a local daemon (`keel daemon`) for thin clients
- 12 rule types; 7 actions, including `prompt` approval gates and `fix` command rewriting
- Warn-once-then-block escalation, with `prompt` gates never downgraded by the dial
- Protection levels (`sprint` / `balanced` / `protect`) with per-rule `level:` floors
- Self-protection: agents cannot run keel's control commands or edit its rules
- Rego/WASM policies (`keel policy`) alongside YAML rules

**Visibility**
- `keel scan` — machine audit: unprotected hosts and risky MCP servers, ranked by severity
- `keel audit`, `keel watch`, `keel status`
- Signed, hash-chained receipts (`keel verify`, `keel receipts rotate`)
- `keel dashboard` (terminal and `--web`), human-owned by construction
- `keel retrospective` — where agents repeated themselves or skipped research

**Learning**
- `keel suggest` / `keel lessons` / `keel gather` — proposes rules from the audit
  trail, never applies them automatically
- `keel schedule` — periodic analysis via launchd/cron

**Problem-solving rules** (`stuck`, `research`, `diagnosis`) ship via
`keel rules harness` in `mode: observe` rather than in the default install, so they
accumulate a false-positive record before they ever interrupt anyone.

## Planned

**Near term**
- Promote the problem-solving rules into the default install once observe-mode data
  on real traffic justifies it
- Additional stuck detectors: oscillation (A→B→A) and semantic livelock
- Week-over-week deltas in `keel retrospective`
- Windows: vitest is currently skipped in CI (path semantics)

**Later**
- Rule catalog with severity/confidence metadata and a promotion workflow
- Team and organisation rule distribution
- Compliance mappings for common frameworks

## Non-goals

- **Replacing prompt-based guidance.** Standing requirements complement rules. keel
  does not claim prompts are useless — only that they are not enforcement.
- **Sandboxing.** keel gates tool calls; it is not a container or a syscall filter.
- **Scanning application source for vulnerabilities.** That is Semgrep/Snyk territory.
  keel governs what the *agent* does, not what your code contains.

## Known limits

See [README → Limits](README.md#limits) and [SECURITY.md](SECURITY.md). In short:
pattern rules are regex gates rather than an anti-virus, reasoning-gated rules need a
host that exposes reasoning, and in-process enforcement assumes the agent process
itself is not compromised.

## Contributing

Adding a rule type or a host adapter is documented in
[CONTRIBUTING.md](CONTRIBUTING.md). Issues and discussions are the right place to
propose roadmap changes.
