# Roadmap

Where keel is and where it's going. Anything under **Shipped** is built and
covered by tests; anything under **Planned** is not built yet.

## Shipped

**Enforcement**
- Tool-call interception for 8 hosts — see [docs/integrations.md](docs/integrations.md)
  for the per-host verification level
- One enforcement entry point (`keel hook <host>`), plus a `generic` stdin/exit-code
  contract for hosts with no bespoke adapter
- MCP server (`keel serve`, 7 tools) and a local daemon (`keel daemon`) for thin clients
- 24 rule types; 10 actions (9 rule-authorable — the 10th, `redact`, is system-only, applied by keel's own output-redaction pipeline rather than written into a rule's `action:` field; the earlier `mask` action was removed from `EnforcementAction` entirely, not merely declared-but-rejected by the parser — see [docs/exfil.md](docs/exfil.md)), including `prompt` approval gates and `fix` command rewriting. `type: injection`'s `action` is further restricted to `warn` only, for the same "only actually reaches the model on one host" reason `redact` is system-only — see [docs/injection.md](docs/injection.md).
- Warn-once-then-block escalation, with `prompt` gates never downgraded by the dial
- Protection levels (`sprint` / `balanced` / `protect`) with per-rule `level:` floors
- `extends:` rule composition — any `rules.yaml` (or `CLAUDE.md`/`AGENTS.md`
  frontmatter) may declare `extends: <path>` or a list, resolved relative to the
  declaring file and merged before that file's own rules. A within-tier axis,
  resolved entirely ahead of the four-tier global/user/project/local merge. An
  extends override that would WEAKEN an inherited `level: protect` floor is refused
  at load time with a loud error naming the rule id — stricter than `mergeRules`'
  silent keep-the-stronger-floor behavior for cross-scope overrides — and composes
  with the fail-closed last-known-good reload path, so such an edit never takes
  effect. See `packages/core/src/enforce/rule-parser.ts`.
- Agent-scoped rule matching via `agents:` — a rule may declare `agents: [claude-code, opencode, ...]`
  to apply only to specific hosts; a rule with no `agents:` field applies everywhere,
  unchanged. This is HOST identity (the string a host's own integration declares
  itself as), not a true multi-agent-fleet identity concept — no host today emits a
  distinct identity per agent instance, and this field does not pretend otherwise.
  See `packages/core/src/enforce/rule-parser.ts` and `docs/custom-rules.md`.
- Self-protection: agents cannot run keel's control commands or edit its rules
- `keel halt` / `keel resume` — a lockdown latch, separate from the `keel disable`
  kill switch: denies every subsequent call (instead of allowing everything, like
  disable), has no `--until`/expiry of any kind, and only clears via `keel resume`
  run by a human. `keel-control-gate` blocks an agent from running either command
  on itself, same as it already blocks `keel disable`.
  `keel run <command...>` supervises a detached agent process so `keel halt --kill`
  can terminate a call that is ALREADY EXECUTING (Tier B), not only deny the next
  one (Tier A); every ambiguous identity/liveness case resolves to REFUSING to
  signal — the opposite fail-safe direction from the rest of this codebase,
  because a wrong-target kill has no safe default. `keel run` is deliberately NOT
  on the control gate's blocked-verb list: it starts something new rather than
  turning enforcement off, and an agent already has an ungated path to the same
  risk via plain shell detach syntax.
- Supply-chain checks on `unverified-package-install`, across npm, PyPI, crates.io,
  and Go modules — a four-tier decision ladder rather than a single resolve-check:
  a static, zero-network known-hallucination registry (exact match → deny, the
  slopsquatting case a plain resolves-check waves through once an attacker has
  actually registered the invented name); `not_found`/`unverified`/first-publish
  age gate (→ prompt); and a Levenshtein near-miss check against a shipped
  popular-package list (→ warn only, a similarity heuristic with real
  false-positive risk, deliberately priced below every exact-match tier). Ambient
  registry config (`.npmrc`, `pip.conf`, `.cargo/config.toml`, `GOPRIVATE`) is read
  offline before any deny, so a team's own private index does not produce
  first-try false denies, with a dependency-confusion warn for the inverse shape.
  **The 53 hallucinated-package names shipped today are structurally-valid
  PLACEHOLDERS, not the real research data** — the mechanism works; a human with
  access to the source research still needs to populate it. See
  `packages/core/src/enforce/package-verifier.ts`,
  `known-hallucinated-packages.ts`, `popular-packages.ts`,
  `ambient-registry-config.ts`.
- `type: session`'s first real handler: a composite runaway-loop trip
  (`session-runaway-trip`) across five session-scoped dimensions — wall-clock
  duration, cumulative tool-call count, cumulative Bash-call count, distinct-file-write
  churn, and consecutive-failure count — escalating `warn → prompt → halt`. Volume-only
  dimensions are structurally barred (`validateRules`) from escalating past `prompt`;
  only a repeated-FAILURE streak (reset on any success) may trip `keel halt`'s lockdown
  latch. Ships `mode: observe` — unlike `no-repeat-loops`, this rule has no measured
  hit-rate evidence yet, so it starts exactly where `no-repeat-loops` itself started.
  See `packages/core/src/enforce/session-tracker.ts`/`session-store.ts` and
  `docs/tiers.md`.
- `type: budget` — real LLM token/dollar spend limits, read from a host's own local
  transcript/session record (a Claude Code JSONL transcript's usage fields; an
  OpenCode session row's own `cost`/token columns) rather than a network proxy.
  Distinct from the pre-existing call-VOLUME `runaway-budget-*` (`type: rate`) rules.
  Two-phase enforcement (measure at Stop/PostToolUse, persist a flag, deny on the
  NEXT PreToolUse call) because Claude Code's Stop hook cannot block. Ships as the
  default `session-spend-limit` rule, `mode: observe`, pending real-traffic burn-in
  of its Claude Code model-string normalization — see `docs/tiers.md` and
  `docs/integrations.md`.
- `type: oscillation` — a short repeating CYCLE of >= 2 DIFFERENT recent
  command fingerprints (A→B→A→B, or A→B→C→A→B→C) within a session's small
  rolling window (default: last 8 calls), the sibling of `no-repeat-loops`
  (`type: stuck`) that catches an agent oscillating between two or three
  failing commands/edits instead of retrying one — a real stuck pattern that
  looks like "activity" but goes nowhere. Complementary, not redundant: the
  two never double-count the same evidence (an exact single-command repeat
  never satisfies oscillation's distinct-fingerprint requirement, and vice
  versa). Defaults to `require_failure: true`, mirroring `no-repeat-loops`'
  own discriminator — a legitimate TDD red-green-refactor loop (edit test,
  edit code, edit test, edit code — literally period-2 alternation) is
  excluded by construction because each step succeeds. Known gap, left
  undone rather than force-fit: an agent oscillating between edits that each
  individually SUCCEED (e.g. reverting a file to a prior state) needs a
  content-state signal no tracker in this codebase feeds today. Ships as the
  default `command-oscillation` rule, `mode: observe`, with zero measured
  hit-rate evidence — see `docs/tiers.md` and
  `packages/core/src/enforce/oscillation-tracker.ts`/`oscillation-store.ts`.
- `type: injection` — tool-result prompt-injection scanning: a DETECTOR
  (`patterns`, matched against a completed tool call's OWN output text) and
  a GATE (`next_call_scrutiny: true`, arming a persisted, session-scoped,
  TTL'd warning on the session's next write/shell call — the compensating
  control for every host except OpenCode, where a detected injection has
  already reached the model before keel's hook can act on it). A heuristic
  tripwire over literal marker shapes (chat-template control tokens,
  "ignore previous instructions", role-marker impersonation, Unicode
  tag-character smuggling), not a detector with a completeness claim — a
  paraphrased or encoded payload still passes. `action` is restricted to
  `warn` for every rule of this type. Ships four default rules:
  `injected-instructions-in-tool-output` (warn),
  `untrusted-content-role-markers` (`mode: observe`, weaker-confidence
  sibling), `untrusted-content-next-call` (the broad, payload-blind gate),
  and `untrusted-content-derived-call` (`taint_correlation: true` — "Lane
  G", the narrower gate that fires only when a later call's own arguments
  or content reference a URL/host/path/email found within 400 characters
  of an enforcing marker in an earlier flagged result; single-hop,
  exact-match, both gate rules sharing one persisted store via per-rule
  mark-not-delete consumption so neither blinds the other). See
  [docs/injection.md](docs/injection.md) for the full per-host honesty
  table and `packages/core/src/enforce/injection-scan.ts`/
  `injection-store.ts`/`injection-taint.ts`.
- Standalone Rego/WASM policy tools (`keel policy init|build|eval`) — **EXPERIMENTAL,
  unsupported, not part of real-time enforcement.** `.rego`/`.wasm` policies are never
  consulted by `keel hook`, the OpenCode plugin, or `keel daemon` — only YAML `rules.yaml`
  is. Requires the external `opa` CLI and `@open-policy-agent/opa-wasm` (neither
  bundled). See `docs/comparison.md` and `SPEC.md`'s "Rego/OPA Backend" section.

**Visibility**
- `keel scan` — machine audit: unprotected hosts and risky MCP servers, ranked by
  severity. MCP config checks cover unsafe startup commands (`sudo`, destructive
  `rm -rf`, pipe-to-shell, via the shared command normalizer's deobfuscation),
  dangerous URL schemes, SSRF-shaped URLs, and plaintext credentials in
  `env`/`headers` (`--json` drops raw values so the check cannot leak what it
  found). Token passthrough, confused deputy, and session hijacking are out of
  scope by construction — they depend on a server's runtime behavior, not on
  anything visible in a client config file.
- `keel audit`, `keel watch`, `keel status`
- Signed, hash-chained receipts (`keel verify`, `keel receipts rotate`)
- `keel dashboard` (terminal and `--web`), human-owned by construction
- `keel retrospective` — where agents repeated themselves or skipped research
- `keel promote <rule-id>` — evidence-gated promotion out of `mode: observe`. Reads
  `KeelConfig.promotion_fp_threshold` (`types.ts`) and reuses `keel retrospective`'s
  own `computePromotionReport` (`retrospective.ts`) to refuse the edit — file
  untouched, exit 1 — when a rule hasn't seen enough traffic (`insufficient_data`)
  or its measured would-block rate hasn't cleared the threshold (`stay_observe`),
  pointing at `keel retrospective` either way. `--force` overrides, with a distinct
  "may not be ready" warning. Known gap, left deliberate: the `warn → block` rung
  has no gate, because `mode: warn` is real enforcement rather than
  shadow-recorded, so there is no measured signal to check — that rung remains a
  judgment call informed by `keel report`.
- `keel conformance` — runs the shipped OWASP Agentic Top 10 scenario suite
  (`packages/cli/conformance/ASI01–ASI10.yaml`) through the real enforcement
  pipeline against your OWN loaded rules, making `docs/owasp-agentic-top10.md`'s
  prose claims checkable. Distinguishes a genuinely absent rule (informational)
  from a rule that is present but did not fire as the defaults promise (a real
  gap). `--json`, and an opt-in `--ci` gate that a "not-covered" scenario never
  fails.
- [docs/compliance-mappings.md](docs/compliance-mappings.md) — rule-level mapping to NIST AI RMF, the EU AI Act, and ISO/IEC 42001

**Learning**
- `keel suggest` / `keel lessons` / `keel gather` — proposes rules from the audit
  trail, never applies them automatically
- `keel schedule` — periodic analysis via launchd/cron

**Problem-solving rules** (`stuck`, `research`, `diagnosis`, plus `claim`, `oracle`,
budget, `session`, `oscillation`, and verification checks — 12 rules total, plus one
promoted) ship inside the default install as Tier 3, `mode: observe`: evaluated and
recorded on every matching call without ever interrupting, so they accumulate a real
hit record (`docs/tiers.md`) before anyone raises them to `warn` or `block`.
`no-repeat-loops` (`stuck`) has already made that jump — its own real hit-rate evidence
(41 repeat loops across 20 sessions, no recorded false-triggering) cleared the bar; the
two `runaway-budget-*` rate rules, the `type: budget` `session-spend-limit` rule, and
the newer `type: oscillation` `command-oscillation` rule were checked against the same
bar and held back pending real data (`docs/tiers.md`).
`keel rules harness` / `--append` now exist only to backfill a rules.yaml created
before these shipped as defaults. An eleventh Tier-3 rule, `session-runaway-trip`
(`type: session`), covers a different signal — session-scoped volume plus a
consecutive-failure streak, not command-fingerprint repetition or missing research —
see the bullet above and `docs/tiers.md`. A twelfth, `command-oscillation`
(`type: oscillation`), covers a third: a repeating SEQUENCE of different fingerprints,
not one fingerprint repeated and not session-wide volume — see the `type: oscillation`
bullet above.

## Planned

**Near term**
- Semantic livelock detection ("not really making progress" without literal
  command repetition or oscillation, e.g. rewriting the same logic slightly
  differently each time without converging) — assessed, not pursued: Keel's
  actual signal set (command fingerprints + exit codes, no visibility into
  WHAT a command does) has no notion of semantic convergence, and a real
  "no net progress" detector needs content-state hashing no tracker in this
  codebase feeds today. Forcing a weak proxy (e.g. treating any non-exact,
  non-cyclical activity as "not converging") would be indistinguishable from
  normal work and was rejected rather than shipped. The other half of this
  item, oscillation (A→B→A), is built — see the `type: oscillation` bullet
  under Shipped above.
- Cross-turn taint tracking for injected content ("Lane G") —
  SINGLE-HOP correlation shipped (`untrusted-content-derived-call`, above):
  a later call whose own arguments/content reference an artifact found
  within 400 characters of an enforcing marker now gets a narrower,
  correlated warning instead of only the broad session-wide one.
  **Remaining, explicitly NOT shipped:**
  - **Multi-hop propagation** — following a value across three or more
    calls (flagged result → call A → call B), rather than exactly one hop.
    Needs confidence-decay modeling with no real hit-rate data to base it
    on yet. `PersistedInjectionTag.id` (`injection-store.ts`) is the one
    accommodation already shipped toward this — a stable per-tag identity
    a future multi-hop lane could chain from — deliberately without a
    `derivedFrom`/`hops` field, which would be speculative infrastructure
    for a feature not yet built.
  - **Promoting a correlated hit to `action: prompt`** — rule-parser.ts
    forbids anything stronger than `warn` on any `type: injection` rule
    today; this needs a parser change plus real hit-rate data first.
  Also still planned, same evidence-gated path as every other observe-mode
  promotion: `untrusted-content-role-markers` out of `mode: observe` —
  see [docs/injection.md](docs/injection.md).
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
