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
a `level: protect` floor on any of three independent axes — action, mode, or
matching surface (see below).

**Residual on floor overrides, host-agnostic — CLOSED (mode + enforcement
surface) in v0.4's mergeguard pass.** The `mergeRules` guard in (3)
originally compared the **action field only**: an override of a floor id
that kept `action: deny` + `level: protect` but added `mode: observe`
(which suppresses interruption — `pipeline.ts`'s `effectiveAction()`
short-circuits an observe-mode match to `allow`) or replaced
`match`/`paths`/`patterns` with a pattern that never fires still
neutralized that floor. Both vectors are now closed by extending the same
dedup-loop check (`packages/core/src/enforce/rule-parser.ts`, `mergeRules`)
that already guarded the action field:

- **Mode axis** — `MODE_STRENGTH` gives `block`/undefined (2, tied — an
  absent `mode` on a floor is fully enforcing, not weaker than a rule that
  spells out `mode: block`) > `warn` (1) > `observe` (0, weakest). A
  lower-scope override of a floor may not *lower* this rank.
- **Enforcement-surface axis** — everything about a floor that affects
  *when or how it fires*, beyond action and mode, must be **byte-identical**
  between the floor and the override (`sameEnforcementSurface`, compared via
  `JSON.stringify` — which is field-order sensitive, so the same fields
  written in a different order in the override's YAML also compare unequal
  and are rejected; this fails closed, the floor stands, not a security
  gap — after stripping action/mode/level/scope and a small,
  explicit allowlist of pure catalog metadata — `message`, `rationale`,
  `remediation`, `false_positives`, `review_by`, `category`, `severity`,
  `confidence`, `maturity`). This is deliberately an **exclusion list, not
  an enumeration** of match-shaped field names: `match`/`match_prefix`/
  `match_regex`/`paths`/`patterns` are covered, but so are `exclude` and
  `operations` narrowing a filesystem floor, `except` widening a network
  floor's allowlist, `schedule` retiming a time floor, `type` swapping a
  floor's check class outright, and `priority` on the floor's OWN id —
  `pipeline.ts`'s tier-2/3 loop is first-match-wins over the full
  priority-sorted rule list, so an override of the floor's id that demotes
  its priority below an unrelated weaker rule matching the same command
  means the floor is never reached on that call at all (see the "Not
  covered" paragraph below for what this does NOT close on the priority
  axis). There is no
  principled way for `mergeRules` to tell a legitimate narrowing from an
  adversarial no-op from inside the merge function alone — it has no model
  of "the dangerous command" to test candidates against — so any change
  outside the metadata allowlist is rejected outright, not just a
  narrowing. A field added to `KeelRule` after this guard was written is
  frozen by default (the allowlist must be extended deliberately to loosen
  the guard for it), not silently exempt.
- **Combined rule**: a `level: protect` floor is overridable by a
  lower scope **only** if the override is `level: protect` AND
  same-or-stronger on action (existing `ACTION_STRENGTH` check) AND
  same-or-stronger on mode (`MODE_STRENGTH`) AND has an **identical**
  enforcement surface. Failing any one axis rejects the whole override —
  the floor already in the merged map stands untouched, with no partial
  field-level merging. Tightening (e.g. `warn` action → `deny`, or
  `mode: observe` → unset/`block`) is still honored, matching the existing
  action-tightening behavior — a floor authored under `mode: observe` to
  burn in can still be promoted to enforcing by a project or local file.

This still requires a *pre-existing* `.keel.local.yaml` (or lower-scope
`rules.yaml`); **writing** such a file is blocked on every agent path (shell
via `no-self-protection-write`, tool via `no-rules-tampering` incl. the Claude
Code `file_path` channel), so authoring the override remains a user's own-
config choice, not a one-command agent bypass — this pass closes what such an
override can *do* to a floor, not who can write one. Verified end-to-end
through the real `EnforcementPipeline` (not just `mergeRules`' return value):
a `.keel.local.yaml` cloning `no-force-push` with only `mode: observe`
changed (everything else, including `match`, byte-identical to the shipped
floor — isolating the mode axis from the surface axis), and a separate one
replacing its `match` with a pattern that never fires, both
still deny a matching `git push --force`. See
`packages/core/src/enforce/__tests__/rule-parser.test.ts` (unit-level dedup
cases) and `packages/core/src/enforce/__tests__/protect-floor-mode-match-override.test.ts`
(pipeline-level), and `session/v04/EVIDENCE/phase-3-mergeguard.md` for
before/after evidence. Original finding: `session/v04/EVIDENCE/phase-3-redteam.md` §(a).

Not covered by this pass, and worth stating precisely: the enforcement-
surface rule is deliberately blunt (identical-or-rejected, not "narrower is
fine") — a project with a genuine need for a different floor pattern, path
scope, or priority cannot express it from a lower scope at all; it has to go
through keel's shipped defaults. That is treated as the correct tradeoff for
a floor, not a gap.

**Residual on different-id priority shadowing — CLOSED in a later v0.4
pass.** A distinct residual from the same-id override guard above:
`mergeRules`' dedup loop only ever arbitrates collisions on a **matching
rule id** — it never compared a floor to a rule with a **different** id.
A lower-scope config could add a brand-new rule, under its own id, with a
higher `priority` and `action: allow` (or `warn`/`prompt`) whose `match`
happened to overlap a floor's. `pipeline.ts`'s tier-2/3 loop is
first-match-wins over the full priority-sorted list of ALL rules
regardless of id, so that new rule returned before the floor was ever
reached on a matching call — reproduced and measured, not assumed: a
`.keel.local.yaml` adding `id: my-allow, priority: 999, action: allow`
against `no-force-push`'s own `match` let `git push --force` through, and
the same shape with `action: warn` or `action: prompt` shadowed the floor
too (the vector isn't specific to `allow` — any action that returns a
verdict before the floor gets a turn defeats it).

Closed by changing the ORDERING `mergeRules` produces, not by extending
the same-id dedup loop (there is no id collision here for dedup to
arbitrate): the final sort in `mergeRules` now assigns every rule to one
of three FIXED tiers — `mode: observe` rules, then `level: protect`
floors, then everything else — evaluated in that order regardless of
declared `priority`, with `priority` breaking ties only *within* a tier.
A hierarchy with no floor AND no observe-mode rule involved sorts exactly
as before (plain priority). This specific guarantee is scoped to
`pipeline.ts`'s tier-2/3 command/filesystem/network/... loop, which is the
first-match-wins pass over this exact sorted list and the one this pass
verified end to end; the earlier `statefulRules` pass (verification/
claim/research obligations, evaluated before tier-2/3 on every call) is a
separate loop this pass did not need to reorder, since those rule types
gate on trigger/boundary state rather than an arbitrary `match` an
attacker-authored rule could point at the same command text a floor
matches.

A tiered sort, not a pairwise "floor beats the other one" comparator, is
required for this to be an actual guarantee rather than an accident of
`Array.prototype.sort`'s implementation: a pairwise comparator (tried
first) compares floor-vs-observe and observe-vs-other by priority alone,
which is intransitive whenever an observe rule's priority sits between a
floor's and a shadowing rule's — e.g. floor priority 82, shadow rule
priority 999, observe rule priority 90 gives floor < observe by priority,
observe < shadow by priority, but floor is still forced ahead of shadow
directly, which is a cycle (shadow < floor < observe < shadow). A cyclic
comparator makes the sorted output implementation-defined, not something
this document can honestly call a guarantee. The fixed-tier sort avoids
this by construction: comparing tier numbers alone is a strict total
order, so priority can never re-open a cross-tier comparison. See
`packages/core/src/enforce/__tests__/rule-parser.test.ts`'s "transitivity"
test and `protect-floor-priority-shadow.test.ts`'s end-to-end twin, both
reproducing this exact three-rule shape.

One deliberate design choice inside that tiering: a non-floor rule with
`mode: observe` sorts AHEAD of everything, floors included, rather than
behind them. `mode: observe` is checked first in `pipeline.ts`'s
`violation()`, ahead of the action switch, for every rule type — a match
is recorded and evaluation falls through to the next rule no matter what
`action` the observe rule declares; it can never return a verdict, so it
can never shadow anything regardless of where it sorts. Evaluating it
first is therefore free and guarantees it always gets to record — this is
what keeps the pre-existing regression from resurfacing
(`packages/core/src/enforce/__tests__/pipeline.test.ts`'s "observe match no
longer blinds a later real deny rule" case, which depends on an observe
rule still getting evaluated ahead of a floor on the same call, and is
strictly stronger than a mere "not disadvantaged" carve-out would have
been). Any other mode (`block`, `warn`, undefined) reaches the normal
action switch and CAN return a verdict, so it stays subject to the
floor-first tiering like any other non-floor rule — verified with a
`mode: warn`, `priority: 999`, `action: allow` different-id rule, which
is still sorted (and evaluated) after the floor despite the priority gap.

Verified end-to-end through the real `EnforcementPipeline`: a
`.keel.local.yaml`-shaped different-id rule with `priority: 999` and
`action: allow`/`warn`/`prompt` matching `git push --force` no longer lets
it through — `no-force-push` still returns `deny`/`block` as
`result.rule_id`. See
`packages/core/src/enforce/__tests__/protect-floor-priority-shadow.test.ts`
(pipeline-level) and the "a different-id rule cannot priority-shadow a
level:protect floor" describe block in
`packages/core/src/enforce/__tests__/rule-parser.test.ts` (unit-level
ordering, including the `mode: observe` exemption and its `mode: warn`
counterexample).

This closes the priority-ordering half of the different-id vector — a
new rule id can no longer pre-empt a floor by racing it on `priority`
alone. It does not, and by construction cannot, give `mergeRules` any way
to recognize that two independently-authored rule ids target "the same
dangerous command" in the first place; nothing here validates or flags an
overlapping `match` across ids. The floor-first ordering guarantee holds
regardless of what a different-id rule's `match` looks like, which is what
closes the exploitable consequence (a floor being out-run on a call it
should have caught) without requiring that harder, more speculative
detection.

The metadata allowlist itself (which fields count as
"cosmetic") is a judgment call, not a proof — `category`/`severity`/
`confidence`/`maturity` are informational tags with no read path in
`pipeline.ts` today; if a future feature starts branching enforcement
behavior on one of them, it would need to move out of the allowlist.

Four classes of evasion no regex rule closes on its own. As of M1/A2, `type:
command` rules no longer match the raw command string alone — they match
against BOTH the raw string and a bounded set of normalized surfaces built by
`packages/core/src/enforce/command-normalizer.ts` (wired in via
`commandSurfaces()` in `arg-utils.ts`, consumed only by the `type: command`
matcher in `pipeline.ts`; every other matching path — fix mutation, the
stuck-loop fingerprint, `type: env`/`stuck`/`diagnosis`/`research` — is
untouched and still keys on the raw string). This closes two of the four
classes for real, and partially closes a third; the change is purely
additive (the raw string is always surface zero, so nothing that matched
before this landed can stop matching):

1. **Intra-token quoting — CLOSED for the shipped default `type: command`
   rules.** `r"m" -rf /`, `keel di"s"able`, and `git push "--force"` now
   normalize to `rm -rf /`, `keel disable`, and `git push --force` and are
   denied by `no-destructive-commands`, `keel-control-gate`, and
   `no-force-push` respectively (verified in
   `packages/core/src/enforce/__tests__/shell-normalize-bypass.test.ts` —
   these were measured `allow` before this lane, not merely assumed).
   Mechanism: a hand-rolled POSIX-ish tokenizer strips quotes only from a
   quoted run that contains **no whitespace** (pure obfuscation); a quoted
   run that *does* contain whitespace is a real data argument in shell
   semantics and is preserved verbatim, quotes included — this is also what
   keeps a quoted argument to `echo` from being treated as a command (see
   the note on `echo "rm -rf /"` below). Residual: `${IFS}`-based
   word-splitting tricks, backslash-heavy multi-layer nesting beyond the
   tokenizer's single-pass model, and non-shell obfuscation (base64, hex
   escapes) are not decoded.
2. **Variable indirection — PARTIALLY closed.** `T=/; rm -rf $T` now
   normalizes (a single left-to-right pass resolves the inline `T=/`
   assignment and substitutes `$T`/`${T}`) and is denied. This is
   deliberately narrow: only a **literal value assigned earlier in the same
   command string** resolves. A variable set by a prior tool call, the
   agent's real process environment, or a value produced by command
   substitution (`` $(...) ``/backticks — not parsed at all) is invisible to
   this module and stays unresolved, same as before.
3. **Interpreter escape hatches — CLOSED for the shipped default `type:
   command` rules.** `sh|bash|dash|zsh|ksh -c "<cmd>"` is recursed one level
   deep and its body re-normalized through the same pipeline, so an
   *obfuscated* payload inside a shell one-liner is caught
   (`sh -c 'r"m" -rf /'` denies; a plain `sh -c "rm -rf /"` already denied
   pre-A2 via the shipped pattern's lack of a trailing anchor — not a new
   catch by itself). For non-shell interpreters — `python(2/3)? -c`,
   `node -e/--eval`, `perl -e/-E/-p` — the decoded code argument is exposed as
   an additional matching surface, and as of the M1 ruleset-followups lane a
   new floor rule, `no-destructive-interpreter-body`, targets it:
   `shutil.rmtree(...)`, `os.system(...)`/`subprocess.run/call/Popen/
   check_call/check_output(...)` running `rm -rf` (string form or an argv
   list with `rm`, a `-*r*f*` flag, and the target as their own quoted
   tokens), `os.remove(...)`, and `fs.rmSync`/`rmdirSync(...)` — each scoped
   to a **literal root (`/`) or home (`~`) target only**, mirroring
   `no-destructive-commands`' own root/home scoping so ordinary interpreter
   code (`shutil.rmtree('./build')`, `os.remove('/tmp/x')`, a `subprocess.run`
   call with an unrelated `-r`/`-f`-shaped flag and an unrelated absolute
   path, e.g. `terraform apply -refresh=true -target=/infra`) is untouched.
   `python3 -c "import shutil; shutil.rmtree('/')"` now denies (see
   `tests/rules/no-destructive-interpreter-body/`); `python3 -c "print(1)"`
   and `node -e "console.log(1)"` still allow.
4. **Symlink redirection — untouched, out of scope.** Path globs match the
   path string as written; they do not resolve symlinks. A string
   normalizer cannot see the filesystem, so this is unaffected by A2 — it
   remains a runtime-fs concern for a different mechanism, as before. (The
   `ln` command itself against a protected path is still caught by
   `no-self-protection-write`; a link planted earlier and written through
   later is not.)

One false-positive caveat that predated A2 and was closed by the M1
ruleset-followups lane: `no-destructive-commands`' `rm` alternatives had no
trailing `( |$)` after some of their path targets, so `echo "rm -rf /"`
(echoing the string, not running it) denied on the raw string alone — the
pattern didn't require what precedes the matched "rm" to be a real command
position either. The fix uses exactly the signal A2's quoting design
provides: a negative lookbehind, `(?<!["'])`, excluding an "rm" immediately
preceded by a quote character. Class 1's whitespace-preservation rule (a
whitespace-bearing quoted argument keeps its quotes verbatim on every
surface) means that adjacency is a reliable data-argument signal — `echo
"rm -rf /"`, `echo 'rm -rf /'`, `git commit -m "rm -rf /"`, and `printf
"rm -rf /"` now allow, while a real invocation never has a quote
immediately before its verb: `rm -rf /`, `sudo rm -rf /` (a plain-space
prefix, unaffected by the lookbehind), `x && rm -rf /` (the compound-split
surface starts clean at `rm`), and `sh -c "rm -rf /"` (the interpreter-body
surface exposes the DECODED, unquoted value) all still deny. See
`tests/rules/no-destructive-commands/` and
`packages/core/src/enforce/__tests__/shell-normalize-bypass.test.ts`. The
`git commit -m "rm -rf ."`/`"git push --force"` discriminator cases from
class 1 above were unaffected by this fix (they never matched at all) and
still allow.

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
  the sentinel, while allowing *reads* of those paths. Two residuals were found
  and both are now closed (see "Residual on floor overrides" and "Residual on
  different-id priority shadowing" above for the full detail): a *pre-existing*
  lower-scope config that redefines a floor rule id keeping `action: deny` +
  `level: protect` but adding `mode: observe` or a no-op `match` no longer
  neutralizes that floor (the merge guard now compares mode and enforcement
  surface, not action alone), and a lower-scope config that adds a rule under a
  brand-new, *different* id with a higher `priority` and `action: allow`/
  `warn`/`prompt` matching the same command can no longer sort ahead of the
  floor and short-circuit it either (`mergeRules` now sorts every floor ahead
  of any rule capable of returning a verdict before it, `mode: observe` rules
  excepted since they structurally cannot shadow anything). *Writing* such a
  file is blocked on both the tool and shell paths in either case, so it
  remains a user's own-config choice, not a one-command agent bypass. See
  `session/v04/EVIDENCE/phase-3-redteam.md` §(a),
  `session/EVIDENCE/wave3-secreview.md` §1.1–1.3, and
  `session/v04/EVIDENCE/a1-floorpriority.md`.
- **The agent's own process is the boundary.** In-process enforcement can be
  bypassed if the agent process itself is compromised. Git hook bypass
  (`--no-verify`, `core.hooksPath`) is blocked at the command level; see
  `docs/comparison.md` for what keel does and does not cover.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | ✅ |
