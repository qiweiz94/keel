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
`session/v04/EVIDENCE/phase-3-redteam.md`, re-run against the v0.4-hardened
floors) deliberately tried to evade each `level: protect` floor rule. These are
catch rates against *deliberate obfuscation*, not against ordinary use: a rule
at 58% still blocks the plain-spelled command it names, every time, on the first
hit, at every dial. Probes that are supposed to be allowed are excluded from the
denominators. The Δ column is the change from the v0.3 sweep
(`session/EVIDENCE/wave3-secreview.md`).

| floor rule | probes | v0.3 | v0.4 | Δ |
|---|---|---|---|---|
| no-destructive-commands | 48 | 73% | 77% | +4 (`--no-preserve-root` closed) |
| no-force-push | 13 | 92% | 92% | 0 |
| protected-branch-reset | 8 | 63% | 63% | 0 |
| protected-branch-delete | 9 | 89% | 89% | 0 |
| pipe-to-shell | 19 | 58% | 58% | 0 |
| keel-control-gate | 12 | 92% | 92% | 0 |
| no-enforcer-removal | 12 | 33% | 75% | +42 (shell writes now caught by `no-self-protection-write`; this rule's own regex unchanged) |
| no-self-protection-write | 14 | — | 93% | new Tier-1 floor |
| agent-env-hijack | 12 | 67% | 75% | +8 (`> .mcp.json` caught by `no-self-protection-write`) |
| prod-db-destruction | 12 | 75% | 75% | 0 |
| no-rules-tampering | 25 | 52% | 88% | +36 (`file_path` fix: Claude Code 0/8 → 8/8) |
| no-exfil-flow | 4 | 25% | 25% | 0 |

(`no-enforcer-removal` keeps n=12 for a like-for-like delta with v0.3; that
denominator includes one borderline probe, `npm uninstall -g`, which removes the
global CLI rather than disarming the project enforcer — excluding it reads
9/11 = 82%.)

The v0.4 hardening landed three fixes, each verified adversarially in
`session/v04/EVIDENCE/phase-3-redteam.md`: (1) `argPath()` now reads `file_path`
/ `notebook_path`, so `filesystem` floors (`no-rules-tampering`,
`no-secret-files`, `write-outside-project`, `cicd-config-edit`) fire on Claude
Code / Gemini CLI — 8/8 blocking where v0.3 was 0/8; (2) a new Tier-1 floor
`no-self-protection-write` blocks shell writes (`>`, `tee`, `cp`, `mv`,
`sed -i`, `python3 -c`, `node -e`, `ln`, `git config core.hooksPath`) to keel's
files, the host's trust/approval config, and git hooks, while allowing *reads*
of those paths; (3) `mergeRules` refuses a lower-scope config that would *weaken*
a `level: protect` floor's action.

**Residual on floor overrides, host-agnostic and open:** the `mergeRules` guard
in (3) compares the **action field only**. An override of a floor id that keeps
`action: deny` + `level: protect` but adds `mode: observe` (which suppresses
interruption) or replaces `match` with a pattern that never fires still
neutralizes that floor. This requires a *pre-existing* `.keel.local.yaml` (or
lower-scope `rules.yaml`); **writing** such a file is blocked on every agent path
(shell via `no-self-protection-write`, tool via `no-rules-tampering` incl. the
Claude Code `file_path` channel), so it is a user's own-config choice, not a
one-command agent bypass. But floors are non-overridable only on the *action*
axis; the *mode* and *match* axes are not yet closed (an engine change to
`mergeRules`). See `session/v04/EVIDENCE/phase-3-redteam.md` §(a).

Four classes of evasion that **no regex rule closes**, and that you should
assume an adversarial agent can use:

1. **Intra-token quoting** — `r"m" -rf /` and `keel di"s"able` execute
   normally and match no literal-token pattern.
2. **Variable indirection** — `T=/; rm -rf $T`. A static pattern cannot
   resolve a runtime value.
3. **Interpreter escape hatches** — *half-closed* in v0.4:
   `no-self-protection-write` now catches `python3 -c "…"`, `node -e "…"`,
   `perl -e/-p "…"` when the body names one of keel's own protected paths. But
   an interpreter one-liner that reaches any *other* file or endpoint —
   `python3 -c "import shutil; shutil.rmtree('/')"`, `sh -c "$(base64 -d <<< …)"`
   — still carries no gated verb in the command at all, and is not matched.
4. **Symlink redirection** — path globs match the path string as written;
   they do not resolve symlinks, so a link planted by an earlier allowed
   command redirects a write past every glob. (The `ln` command itself against a
   protected path is now caught by `no-self-protection-write`; a link planted
   earlier and written through later is not.)

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
  level). The v0.3 security review found three gaps here; all three were closed
  in v0.4: (a) `no-rules-tampering` did not fire on Claude Code / Gemini CLI
  because `argPath()` did not read the `file_path` (snake_case) key those hosts
  send — fixed (the key is now read; a write to `.claude/settings.json` via
  `file_path` denies with exit 2, verified live, 8/8 self-protection paths);
  (b)+(c) `filesystem` rules only see a tool call's path argument, not a shell
  redirect target, so Bash writes to protected paths — including creating the
  `~/.keel/DISABLED` kill-switch — slipped through; closed by a new Tier-1
  floor rule `no-self-protection-write` (`type: command`) that blocks shell
  writes (`>`, `tee`, `cp`, `mv`, `sed -i`, `python3 -c`, `node -e`, `ln`,
  `git config core.hooksPath`, …) targeting keel's files,
  `.claude/settings.json`, `.mcp.json`, `.vscode` autoApprove, git hooks, and
  the sentinel, while allowing *reads* of those paths. One residual remains open
  and is documented not fixed: a *pre-existing* lower-scope config
  (`.keel.local.yaml` or a scoped `rules.yaml`) that redefines a floor rule id
  keeping `action: deny` + `level: protect` but adding `mode: observe`, or a
  no-op `match`, still neutralizes that floor — the merge guard checks the
  action field only. *Writing* such a file is blocked on both the tool and shell
  paths, so it is a user's own-config choice, not a one-command agent bypass,
  but closing the mode/match axes is a pending `mergeRules` engine change. See
  `session/v04/EVIDENCE/phase-3-redteam.md` §(a) and
  `session/EVIDENCE/wave3-secreview.md` §1.1–1.3.
- **The agent's own process is the boundary.** In-process enforcement can be
  bypassed if the agent process itself is compromised. Git hook bypass
  (`--no-verify`, `core.hooksPath`) is blocked at the command level; see
  `docs/comparison.md` for what keel does and does not cover.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | ✅ |
