# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Keel, please report it privately.

**Do not report security vulnerabilities through public GitHub issues or discussions.**

Instead, open a GitHub Security Advisory at:
https://github.com/qiweiz94/keel/security/advisories/new

You should receive a response within 48 hours. If not, please follow up.

## Scope

Security vulnerabilities include:
- Bypass of policy enforcement mechanisms
- Unauthorized access to protected files
- Injection attacks through the MCP server
- Disclosure of secrets audit log
- **Commit of the Ed25519 receipt signing key** — keys live in machine scope
  (`~/.keel/receipt-key.json`, `~/.keel/signing-key.json`, mode 0600), never
  in the project tree; `keel install --project` writes `.keel/.gitignore`
  covering `receipts/`, `audit/`, and key files. Rotate with `keel receipts
  rotate` (archives old keys to `~/.keel/receipts-archive/`; archived keys
  still verify old receipts). Verification never generates keys — a missing
  key is reported as a diagnostic, not forged.

## Enforcement limits

Pattern rules are regex matching over command strings, file contents, and
reasoning text. They are a gate, not an anti-virus engine:

- **Obfuscation can defeat regex matching.** A determined agent can evade
  command patterns through alias definitions, `env`-prefixed invocations,
  shell glob expansion, hex/escape encodings, or indirect exec through other
  tools — same as any regex-based gate. Mitigations: rules should also match
  the common encodings they care about, and sensitive operations should be
  gated by rule `action: prompt` (human approval) rather than pattern-matching
  alone. **Measured, not asserted** — see the table below.

### Measured bypass resistance of the Tier-1 floor

An adversarial sweep (260 probes, each through the real CLI with a fresh
state directory; method and raw verdicts in
`session/EVIDENCE/wave3-secreview.md`) deliberately tried to evade each
`level: protect` floor rule. These are catch rates against *deliberate
obfuscation*, not against ordinary use: a rule at 58% still blocks the
plain-spelled command it names, every time, on the first hit, at every dial.
Probes that are supposed to be allowed are excluded from the denominators.

| floor rule | probes | caught |
|---|---|---|
| no-destructive-commands | 48 | 73% |
| no-force-push | 13 | 92% |
| protected-branch-reset | 8 | 63% |
| protected-branch-delete | 9 | 89% |
| pipe-to-shell | 19 | 58% |
| keel-control-gate | 12 | 92% |
| no-enforcer-removal | 12 | 33% |
| agent-env-hijack | 12 | 67% |
| prod-db-destruction | 12 | 75% |
| no-rules-tampering | 25 | 52% (0% on Claude Code — see below) |
| no-exfil-flow | 4 | 25% |

**Known gap, host-specific and open:** `filesystem`-type rules —
`no-rules-tampering`, `no-secret-files`, `write-outside-project`,
`cicd-config-edit` — match on the path ARGUMENT of a tool call, resolved by
`argPath()` in `packages/core/src/enforce/arg-utils.ts`. That resolver does
not read the `file_path` key, which is the key Claude Code (and Gemini CLI,
which shares the payload format) sends for Write/Edit/MultiEdit. On those
hosts these rules currently do not fire at all. Command-type rules —
including every other floor — are unaffected on every host. Track this
before relying on file-path protection under Claude Code.

Four classes of evasion that **no regex rule closes**, and that you should
assume an adversarial agent can use:

1. **Intra-token quoting** — `r"m" -rf /` and `keel di"s"able` execute
   normally and match no literal-token pattern.
2. **Variable indirection** — `T=/; rm -rf $T`. A static pattern cannot
   resolve a runtime value.
3. **Interpreter escape hatches** — `python3 -c "…"`, `node -e "…"`,
   `sh -c "$(base64 -d <<< …)"` reach any file or endpoint with no gated verb
   present in the command at all.
4. **Symlink redirection** — path globs match the path string as written;
   they do not resolve symlinks, so a link planted by an earlier allowed
   command redirects a write past every glob.

Keel is a gate against the mistakes and the drift, not a sandbox against a
determined adversary. For adversarial containment, run the agent in an
OS-level sandbox and use keel's `action: prompt` gates on top.
- **`unless_reasoning` / reasoning checks require reasoning text.** The
  OpenCode plugin has no access to the model's private chain-of-thought, so
  reasoning-based `unless` and anomaly rules run only when the integration
  provides reasoning text (`keel enforce` with Claude Code's extended thinking,
  or the `input.reasoning` field). They cannot be relied on as a hard control
  in agents that hide reasoning.
- **Malformed rules fail closed.** A rule that fails to parse or validate is
  rejected at load time; the last-known-good rule set stays in force (never a
  silent fail-open). `keel validate` reports invalid rules before they reach
  the enforcement path.
- **Keel controls are user-owned.** The default rules hard-deny agents from
  running `keel disable|allow|level|enforce|install|uninstall`
  (`keel-control-gate`), from modifying keel's rules, state, or plugin files
  (`no-rules-tampering`), and from deleting enforcement files
  (`no-enforcer-removal`). A compromised agent cannot turn keel off, approve
  its own overrides, or rewrite its own rules — only the user can, in their
  own terminal. These are `level: protect` floors, active at every dial
  (verified across all nine combinations of rules-file level × requested
  level). **Three known limits on that claim, all open:** (a)
  `no-rules-tampering` does not fire at all on Claude Code / Gemini CLI —
  see the `file_path` gap under "Measured bypass resistance" above; (b) it is
  a `filesystem` rule, so on every host it sees a tool call's path argument
  and not a shell command's redirect target — writes to the protected paths
  through Bash are not blocked today; (c) creating the kill-switch sentinel
  (`~/.keel/DISABLED`) through a shell is not blocked, though deleting keel's
  files is. See `session/EVIDENCE/wave3-secreview.md` §1.1–1.3.
- **The agent's own process is the boundary.** In-process enforcement can be
  bypassed if the agent process itself is compromised. Git hook bypass
  (`--no-verify`, `core.hooksPath`) is blocked at the command level; see
  `docs/comparison.md` for what keel does and does not cover.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | ✅ |
