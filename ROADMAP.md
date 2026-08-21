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
- 21 rule types; 10 actions (9 rule-authorable — the 10th, `redact`, is system-only, applied by keel's own output-redaction pipeline rather than written into a rule's `action:` field; the earlier `mask` action was removed from `EnforcementAction` entirely, not merely declared-but-rejected by the parser — see [docs/exfil.md](docs/exfil.md)), including `prompt` approval gates and `fix` command rewriting
- Warn-once-then-block escalation, with `prompt` gates never downgraded by the dial
- Protection levels (`sprint` / `balanced` / `protect`) with per-rule `level:` floors
- Self-protection: agents cannot run keel's control commands or edit its rules
- `keel halt` / `keel resume` — a lockdown latch, separate from the `keel disable`
  kill switch: denies every subsequent call (instead of allowing everything, like
  disable), has no `--until`/expiry of any kind, and only clears via `keel resume`
  run by a human. `keel-control-gate` blocks an agent from running either command
  on itself, same as it already blocks `keel disable`.
- Standalone Rego/WASM policy tools (`keel policy init|build|eval`) — **EXPERIMENTAL,
  unsupported, not part of real-time enforcement.** `.rego`/`.wasm` policies are never
  consulted by `keel hook`, the OpenCode plugin, or `keel daemon` — only YAML `rules.yaml`
  is. Requires the external `opa` CLI and `@open-policy-agent/opa-wasm` (neither
  bundled). See `docs/comparison.md` and `SPEC.md`'s "Rego/OPA Backend" section.

**Visibility**
- `keel scan` — machine audit: unprotected hosts and risky MCP servers, ranked by severity
- `keel audit`, `keel watch`, `keel status`
- Signed, hash-chained receipts (`keel verify`, `keel receipts rotate`)
- `keel dashboard` (terminal and `--web`), human-owned by construction
- `keel retrospective` — where agents repeated themselves or skipped research
- [docs/compliance-mappings.md](docs/compliance-mappings.md) — rule-level mapping to NIST AI RMF, the EU AI Act, and ISO/IEC 42001

**Learning**
- `keel suggest` / `keel lessons` / `keel gather` — proposes rules from the audit
  trail, never applies them automatically
- `keel schedule` — periodic analysis via launchd/cron

**Problem-solving rules** (`stuck`, `research`, `diagnosis`, plus `claim`, `oracle`,
budget, and verification checks — 9 rules total, plus one promoted) ship inside the
default install as Tier 3, `mode: observe`: evaluated and recorded on every matching
call without ever interrupting, so they accumulate a real hit record (`docs/tiers.md`)
before anyone raises them to `warn` or `block`. `no-repeat-loops` (`stuck`) has already
made that jump — its own real hit-rate evidence (41 repeat loops across 20 sessions,
no recorded false-triggering) cleared the bar; the two `runaway-budget-*` rules were
checked against the same bar and held back pending real data (`docs/tiers.md`). `keel
rules harness` / `--append` now exist only to backfill a rules.yaml created before
these shipped as defaults.

## Planned

**Near term**
- A guided way to raise a Tier-3 rule's `mode:` from `observe` to `warn`/`block` once
  its observed-hit record justifies it — today that's a manual rules.yaml edit
- Additional stuck detectors: oscillation (A→B→A) and semantic livelock
- Week-over-week deltas in `keel retrospective`
- Windows test coverage. Fixture plumbing is portable now (Node APIs, not `mktemp`/
  `rm -rf`) and CRLF is fixed at the root via `.gitattributes`. Two real blockers
  remain: fixture teardown hits `EBUSY` because Windows will not remove a directory a
  spawned child still holds, and the core path matcher's negated-path and separator
  handling genuinely differs. Until both are done, Windows runs lint only.

**Later**
- Rule catalog with severity/confidence metadata and a promotion workflow
- Team and organisation rule distribution

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
