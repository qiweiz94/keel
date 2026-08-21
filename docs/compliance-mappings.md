# Keel vs. NIST AI RMF, the EU AI Act, and ISO/IEC 42001

This page maps Keel's 46 shipped default rules (`packages/cli/src/commands/install.ts`,
`DEFAULT_RULES_YAML`) and its shipped commands against three frameworks enterprise
buyers commonly ask about during procurement: the **NIST AI Risk Management Framework
1.0** (functions GOVERN / MAP / MEASURE / MANAGE), the **EU AI Act**'s high-risk-system
requirements (Regulation (EU) 2024/1689, Articles 9–15), and **ISO/IEC 42001** (AI
management systems).

**This is not a compliance claim, a certification, or legal advice.** Keel's rules can
*support* evidence-gathering toward these frameworks — a control an auditor can point to,
a log entry that demonstrates a specific requirement was addressed — but no runtime
tool-call enforcer makes an organization compliant by itself. Compliance with all three
frameworks above requires organizational policy, risk assessment, documentation, and
(for the EU AI Act) legal review that sits outside what any CLI can automate. Where a
whole function or article has no genuine Keel coverage, that is stated plainly below
rather than stretched into a mapping that isn't real — the same discipline
[docs/owasp-agentic-top10.md](owasp-agentic-top10.md) applies to the OWASP Agentic AI
Top 10.

A rule's tier and action matter to every claim below and are called out inline. **Tier
1** (`level: protect`) rules deny on the first hit at every dial. Most **Tier 2**
(`level: sprint`, dial-governed) rules warn once then block, or gate on `action: prompt`
(never downgraded by the dial). **Tier 3** (`mode: observe`) rules are evaluated and
recorded on every matching call but **never interrupt** — the verdict lands in
`observed_action` on the trace, not as a live block. Citing a Tier 3 rule as "coverage"
without that caveat would overstate what it does; see [docs/tiers.md](tiers.md) for the
full model, including how a Tier 3 rule earns promotion to real enforcement.

Framework subcategory numbering below is deliberately kept at the **function/category
level** for NIST AI RMF and the **clause level** for ISO 42001, not the finest-grained
subcategory letters — this doc was written without direct access to the official NIST
AI RMF 1.0 PDF's subcategory text, and citing a specific subcategory ID with anything
less than that source in hand risks citing the wrong one. Re-verify against
[NIST's own AI RMF 1.0 publication](https://www.nist.gov/itl/ai-risk-management-framework)
before treating a specific subcategory citation here as authoritative. EU AI Act
article numbers are cited directly (Articles 9–15 are individually well-defined and
stable); ISO/IEC 42001 clause numbers follow the Annex SL harmonized management-system
structure common to ISO 27001/9001, which this doc treats as a structural inference, not
a verified citation of 42001's own text.

**Mapping principle, stated once, so the table below is predictable rather than
case-by-case:** an `action: prompt` rule maps to EU AI Act Article 14 (the human
checkpoint *is* the oversight mechanism, whatever the rule's original motivation); a
`deny`/`warn`/`fix` rule that responds to a destructive, irreversible, or exfiltration-
shaped risk maps to NIST MANAGE (and to EU Article 15 where the risk is specifically
cybersecurity- or robustness-flavored); a `mode: observe` rule maps to NIST MEASURE,
never MANAGE, because it does not act; and a rule with **no genuine risk consequence** —
a cosmetic convenience fix, a timing nudge, a context-rot nudge — gets no framework
mapping at all, regardless of its tier, the same way
[docs/owasp-agentic-top10.md](owasp-agentic-top10.md#rules-with-no-owasp-category)
excludes its own non-security rules rather than stretching them into ASI categories.

## Quick reference

| Framework | Keel coverage |
|---|---|
| NIST AI RMF — GOVERN | Weak — one narrow connection (self-protection keeps only the human able to change enforcement policy); no organizational risk-tiering, accountability structure, or policy documentation |
| NIST AI RMF — MAP | Not addressed — Keel has no AI-system context-establishment or risk-categorization function |
| NIST AI RMF — MEASURE | Partial-to-well — Tier 3 observe-mode rules, `keel retrospective`, and the promotion lifecycle are a genuine measurement story |
| NIST AI RMF — MANAGE | Well covered — real-time deny/warn/prompt/fix is exactly what this function asks for |
| EU AI Act Art. 9 (risk management system) | Weak — Keel is one control among many an org's risk-management system could cite, not a risk-management system itself |
| EU AI Act Art. 10 (data governance) | Not addressed |
| EU AI Act Art. 11 (technical documentation) | Weak — `rules.yaml` and this doc describe the control, not the AI system |
| EU AI Act Art. 12 (record-keeping / logging) | Well covered — traces + signed, hash-chained receipts |
| EU AI Act Art. 13 (transparency to users) | Weak — Keel is transparent to the operator running it, not to the AI system's end users |
| EU AI Act Art. 14 (human oversight) | Well covered — `prompt` gates architecturally enforce a human checkpoint |
| EU AI Act Art. 15 (accuracy, robustness, cybersecurity) | Partial — strong on robustness/cybersecurity blocking, no coverage of model accuracy |
| ISO/IEC 42001 | Lighter touch only — Keel's logs and controls can serve as evidence inputs to an AIMS audit; no claim of audit- or certification-readiness |

---

## NIST AI Risk Management Framework 1.0

### GOVERN — weak

**Not addressed** in the sense the function intends: NIST's GOVERN function is about
organizational policy, accountability structures, workforce roles, and third-party risk
policy for the AI system as a whole. Keel has no concept of an organizational risk-tier,
no role/accountability model beyond "the human who controls the terminal," and ships no
governance-documentation feature.

The one genuine, narrow connection: Keel's self-protection floor keeps *only a human*
able to change the enforcement policy at all, which is a small slice of "accountability
structures are in place" (a GOVERN theme) — evidence that policy authority over the
control itself cannot be silently reassigned to the agent it governs:

- `keel-control-gate` — denies an agent running keel's own control commands
  (`disable`, `allow`, `level`, `install`, `uninstall`, `promote`, `rules --append`).
- `no-rules-tampering` / `no-enforcer-removal` / `no-self-protection-write` — deny an
  agent editing or deleting the rules file, plugin files, or host trust/approval config
  through any path (declared filesystem argument or shell redirect).

This is a control-integrity property, not an organizational governance program. An
organization still needs its own GOVERN-function work (risk-tiering, roles, policy
documentation) regardless of whether Keel is installed.

### MAP — not addressed

MAP is about establishing context, categorizing the AI system, and mapping risks and
impacts to people before deployment. Keel has no feature that inspects what an AI
system is *for*, who it affects, or what its risk category is — it evaluates tool calls
against pattern rules, with no context-establishment step. No rule maps here.

### MEASURE — partial-to-well covered

This is the strongest NIST connection Keel has, and it is strongest specifically
*because* it doesn't enforce. NIST's MEASURE function calls for identifying appropriate
metrics, evaluating the AI system for trustworthy characteristics (including
reliability and validity), and tracking risks over time. Keel's Tier 3 rules do exactly
that shape of work — evaluated and recorded on every call, `observed_action` on the
trace, never interrupting — and the promotion lifecycle (`keel retrospective` surfaces a
measured would-block rate; a human runs `keel promote` only after deciding the evidence
is real) is a live instance of "measure before you act on the measurement":

- `claim-without-evidence`, `test-oracle-tampering`, `test-oracle-env-introspection`,
  `source-change-requires-test`, `test-before-commit` (all Tier 3, `mode: observe`) —
  measure whether the coding agent's own output is verifiably correct: a "done" claim
  with no passing test run behind it, a test weakened rather than the code fixed, or a
  source change committed with no verification since. **Caveat on
  `claim-without-evidence` specifically:** [docs/owasp-agentic-top10.md](owasp-agentic-top10.md#asi09--human-agent-trust-exploitation)
  documents that on its one production-reachable channel (commit/PR message text), the
  shipped `source-change-requires-test` rule shares the identical trigger and wins the
  evaluator's short-circuit — so in the current default ruleset this rule is "never
  evaluated on that call at all," despite being wired in. Citing it as active
  measurement coverage without that caveat would overstate it.
- `research-before-fix`, `root-cause-before-refactor` (Tier 3, `mode: observe`) —
  measure whether the agent investigated before patching or refactoring, a reliability
  proxy for the AI system's own problem-solving process.
- `runaway-budget-tool-calls`, `runaway-budget-bash-calls` (Tier 3, `mode: observe`) —
  measure raw session volume as a coarse runaway/scope-creep proxy; their own rationale
  in the YAML states plainly that observe mode exists because the real hit rate has
  never actually been measured yet (precedent-only justification).
- `no-repeat-loops` (promoted out of Tier 3 to real enforcement, `type: stuck`) — the
  measurement-to-management transition already completed once: this project's own
  traces cited 41 distinct repeat loops across 20 sessions before the rule existed,
  which is the measured evidence that justified promoting it into MANAGE-function
  territory (see below). `keel retrospective`'s workflow metrics (attempts-to-success,
  stuck-loops/session, research-before-solve rate, verification completion) are the
  session-level measurement layer all of this reports through.

### MANAGE — well covered

This is where Keel's real-time enforcement lives: MANAGE calls for AI risks to be
prioritized, responded to, and treated once identified — exactly the deny/warn/prompt/
fix action model. Nearly every Tier 1 and Tier 2 rule is a MANAGE-function control by
this reading, since it responds to an already-identified risk class (destructive
commands, exfiltration, unverified supply chain, privilege escalation) the moment the
agent attempts it:

- Destructive/injection/exfil-category Tier 1 floors — `no-destructive-commands`,
  `no-destructive-interpreter-body`, `no-force-push`, `protected-branch-reset`,
  `protected-branch-delete`, `pipe-to-shell`, `no-exfil-flow`, `prod-db-destruction`,
  `agent-env-hijack` — deny on first hit, unsoftened by the dial.
- Tier 2 exfil-category rules — `no-secrets-in-code`, `no-secret-files`,
  `no-credential-echo`, `secret-file-read-without-egress`, `paste-site-exfil`,
  `no-exfil-flow-cross-call` — warn or deny on credential/secret exposure risk.
- Supply-chain and escalation risk response — `unverified-package-install`,
  `no-remote-exec`, `broad-privilege-escalation`, `cicd-and-infra`, `bash-rate-limit`.
- Irreversible-action prompt gates that also carry a real risk consequence —
  `git-history-rewrite`, `publish-gate` — a deny/prompt response to shared-history or
  registry-artifact risk, not merely a convention (see EU Article 14 below for the
  oversight half of the same rules).
- `no-repeat-loops` — the one rule with direct evidence its MANAGE-function response
  (redirect at 3 identical failures, deny at 5) matches a measured real failure mode,
  not merely a hypothesized one.

`keel receipts rotate` and the receipt-signing keys are the risk-treatment
*record*-keeping half of MANAGE (see EU AI Act Article 12 below for the fuller
record-keeping mapping) — a durable trail that a specific response was taken, not just
that a rule exists on paper.

---

## EU AI Act (Articles 9–15, high-risk-system requirements)

Framing note before the article-by-article mapping: none of this makes Keel's use case
(an AI coding agent) a "high-risk AI system" under the Act's own classification — that
determination is the deploying organization's, made against Annex III and the Act's own
risk categories, not something this doc asserts. The mapping below assumes an
organization that has separately determined some AI-Act obligation applies to its use
of AI coding agents, and is asking which of that obligation's technical controls Keel
can help satisfy.

### Article 9 — Risk management system: weak

Article 9 requires a continuous, iterative risk-management *process* for the AI system
across its lifecycle — identifying, estimating, evaluating, and adopting risk
mitigation measures. Keel is one mitigation measure an organization's Article 9 process
could adopt and cite (the deny/warn/prompt rules below are literal risk-mitigation
measures), but Keel does not run the process itself: it has no risk-identification
step, no lifecycle tracking, and no documentation output shaped like an Article 9
risk-management file. Do not cite Keel as satisfying Article 9 on its own.

### Article 10 — Data and data governance: not addressed

Article 10 is about training-data quality, provenance, and governance for the AI
system. Keel has no visibility into training data, no data-quality checks, and no
provenance tracking of any kind — it governs what a coding agent *does* at the tool-call
boundary, not what any model was trained on. No rule maps here, and none should be
represented as mapping here.

### Article 11 — Technical documentation: weak

Article 11 requires detailed technical documentation of the AI system itself (design,
development process, capabilities, limitations). `~/.keel/rules.yaml`,
[docs/tiers.md](tiers.md), and this page are technical documentation *of the control*,
not of the AI coding agent it governs — they help demonstrate what mitigation was in
place, but do not substitute for documenting the AI system.

### Article 12 — Record-keeping (logging): well covered

Article 12 requires automatic logging of events over the AI system's lifetime, at a
level enabling traceability. Keel produces two distinct log artifacts with different
coverage, and a compliance claim should name the right one:

- **`~/.keel/traces/YYYY-MM-DD.jsonl`** — every rule evaluation on every matching tool
  call, including the `observed_action` a Tier 3 rule *would* have taken. This is the
  broad, complete-coverage log.
- **`<project>/.keel/receipts/`** — a signed, hash-chained record specifically of every
  *gated or blocked* action (`keel verify` checks the chain; `keel receipts rotate`
  rotates the signing key without invalidating old receipts). This is the narrower,
  tamper-evident subset — it does not claim to be a complete record of all agent
  activity, only of the actions Keel actually gated or blocked.

Citing "signed, hash-chained receipts" as evidence of a *complete* activity log would
overstate receipts' actual coverage; the traces file is the complete-coverage artifact,
receipts are the tamper-evident one.

### Article 13 — Transparency and information to users: weak

Article 13 is about the AI system being transparent to its *deployer and end users* —
instructions for use, capabilities, limitations. Keel's audit surfaces (`keel audit`,
`keel dashboard`, `keel status`) are transparent to the *operator running Keel*, not to
end users of whatever the coding agent produces. That is a materially different
audience than Article 13 targets; do not conflate the two.

### Article 14 — Human oversight: well covered

Article 14 requires the AI system to be designed so a human can effectively oversee it,
including the ability to intervene or halt operation. This is Keel's strongest EU AI
Act connection, and the load-bearing facts are architectural, not just the rule list:

- `action: prompt` rules force a live human checkpoint **from outside the agent's
  context window** before an irreversible action executes:
  `no-push-to-main`, `write-outside-project`, `cicd-config-edit`, `cicd-and-infra`,
  `paste-site-exfil`, `no-remote-exec`, `git-history-rewrite`, `publish-gate`,
  `unverified-package-install`.
- **`prompt` gates are never downgraded by the speed dial**, at any of `sprint`/
  `balanced`/`protect` — the human checkpoint cannot be loosened away by a
  configuration change (see [docs/tiers.md](tiers.md#the-speed-dial)).
- The only way past a `prompt` gate is `keel allow <rule-id> --once`, run by a human in
  their own terminal.
- Promoting a Tier 3 rule to active enforcement (`keel promote <rule-id>`) only runs in
  an interactive terminal, and `keel-control-gate` denies the agent running it or
  `keel rules … --append` on the human's behalf — so even the *decision to add more
  oversight* stays human-owned.

No rule detects loss-of-oversight or operator fatigue itself; the coverage here is the
checkpoint's placement and its immunity to softening, not content analysis of whether a
human is actually paying attention when they approve.

### Article 15 — Accuracy, robustness, cybersecurity: partial

Three distinct sub-requirements, with different coverage:

- **Accuracy** — not addressed. Keel has no concept of model output correctness/accuracy
  metrics; that is out of scope for a tool-call enforcer.
- **Robustness** (resilience to errors, faults, inconsistencies) — the destructive/
  injection-category rules are a genuine robustness control against an agent's own
  erroneous or runaway actions: `no-destructive-commands` (Tier 1, deny),
  `no-destructive-interpreter-body` (Tier 1, deny), `no-force-push` (Tier 1, deny),
  `protected-branch-reset` (Tier 1, deny), `protected-branch-delete` (Tier 1, deny),
  `prod-db-destruction` (Tier 1, deny), `no-db-destructive` (Tier 2, **warn only** on an
  untagged connection — its own rationale states warn-not-deny because most local dev
  resets look identical), `no-repeat-loops` (promoted, `type: stuck` — redirect at 3
  identical failures, deny at 5).
- **Cybersecurity** — `pipe-to-shell`, `no-exfil-flow`, `no-exfil-flow-cross-call`,
  `no-secrets-in-code`, `no-secret-files`, `no-credential-echo`,
  `secret-file-read-without-egress`, `agent-env-hijack`, `no-rules-tampering`,
  `no-self-protection-write`, `no-enforcer-removal`.

**Cite both bullets above honestly, not as a guarantee.** Every Tier 1 floor rule named
in either bullet appears in the v0.4 adversarial sweep — a deliberate adversary
obfuscating a command against each floor rule — and catch rates run from **25%**
(`no-exfil-flow`, the floor's weakest rule measured) up to **93%**
(`no-self-protection-write`), with real variance in between: `protected-branch-reset`,
for instance, measured **63%**, weaker than several rules in the cybersecurity bullet.
See [SECURITY.md § Measured bypass resistance of the Tier-1
floor](../SECURITY.md#measured-bypass-resistance-of-the-tier-1-floor) for the full
per-rule table. None of these specific rules were the ones measured in README's
separate 0%-ordinary-drift result, which covered a different three-task battery
(force-push, `reset --hard`, and a nonexistent-package install) — read the robustness/
cybersecurity claim here against the sweep table, not against that number.

---

## ISO/IEC 42001 (AI management systems) — lighter touch

ISO/IEC 42001 follows the Annex SL harmonized management-system structure shared with
ISO 27001/9001 (Context, Leadership, Planning, Support, Operation, Performance
Evaluation, Improvement). Keel does not make an organization audit-ready or
certification-ready against 42001 — an AIMS (AI Management System) is an organizational
program, and Keel is one tool an organization running that program might use. What
Keel's existing controls can plausibly serve as is **evidence input** into specific
parts of an AIMS audit, at the clause level only:

- **Clause 6 (Planning)** — the rules.yaml speed dial (`sprint`/`balanced`/`protect`)
  and per-rule `level:` floors are a concrete, versionable artifact of a risk-treatment
  decision an organization made about its AI coding agents; an auditor could point to a
  specific dial setting and rule set as evidence a planning decision was operationalized,
  not just documented in prose.
- **Clause 8 (Operational planning and control)** — the deny/warn/prompt/fix rules
  described in the NIST MANAGE and EU Article 14/15 sections above are literal
  operational controls in effect at the point of use.
- **Clause 9 (Performance evaluation)** — `keel retrospective`, the traces log, and the
  Tier 3 observe-mode promotion lifecycle are a monitoring-and-measurement mechanism an
  internal audit could review; `keel audit`/`keel verify` give an auditor a way to
  inspect what was actually gated, not just what the policy says should be gated.

No claim is made about Clause 4 (context of the organization), Clause 5 (leadership),
Clause 7 (support/competence), or Clause 10 (improvement) — those are organizational and
process requirements a CLI tool cannot satisfy on its own.

---

## The disclaimer, stated plainly

Keel's rules can support an organization's compliance *evidence-gathering* toward NIST
AI RMF, the EU AI Act, and ISO/IEC 42001. They do not, by themselves, make an
organization compliant with any of the three, and nothing on this page is legal advice.
An organization pursuing any of these frameworks needs its own risk assessment, policy
documentation, and (for the EU AI Act specifically) legal review — Keel is a runtime
control that can sit inside that program, not a substitute for it. Where a framework
function or article has no genuine Keel coverage, this page says so directly rather
than stretching a mapping to look more complete than it is.

## Rules with no framework mapping

Consistent with the mapping principle above, these rules carry no NIST/EU/ISO citation
— not because they were overlooked, but because their own rationale text in
`install.ts` describes a convenience fix or a general engineering nudge, not a response
to an AI-specific risk:

- `must-sign-commits` — an auto-fix action; its own rationale states explicitly "not a
  security control."
- `no-after-hours-publish` — a timing nudge on releases ("often correct... also the
  shape of an unattended overnight run"), general engineering practice rather than a
  named risk response.
- `verify-format-before-decision` — a context-rot nudge (checking project conventions
  before choosing a format), not a security or governance control.
- `no-skip-tests` — flags test-skip flags on a green run; a verification-honesty
  convention softened to warn specifically because "there are legitimate uses," per its
  own rationale.
- `commit-to-main` — general git branch-hygiene practice, not specific to an AI agent
  doing the committing.
- `no-verify-bypass` — softened deny→warn specifically because a hook bypass is
  sometimes the correct call (a broken hook); standing convention, not a risk-tiered
  control.

## Full rule-to-framework table

All 46 shipped default rules, in `install.ts` order.

| Keel rule ID | category | maps to |
|---|---|---|
| `keel-control-gate` | bypass | NIST GOVERN (accountability) / MANAGE; EU Art. 14 |
| `no-rules-tampering` | bypass | NIST GOVERN / MANAGE; EU Art. 14; EU Art. 15 (cybersecurity) |
| `no-enforcer-removal` | bypass | NIST GOVERN / MANAGE; EU Art. 14; EU Art. 15 (cybersecurity) |
| `no-self-protection-write` | bypass | NIST GOVERN / MANAGE; EU Art. 14; EU Art. 15 (cybersecurity) |
| `agent-env-hijack` | escalation | NIST MANAGE; EU Art. 15 (cybersecurity) |
| `no-destructive-commands` | destructive | NIST MANAGE; EU Art. 15 (robustness) |
| `no-destructive-interpreter-body` | destructive | NIST MANAGE; EU Art. 15 (robustness) |
| `no-force-push` | destructive | NIST MANAGE; EU Art. 15 (robustness) |
| `protected-branch-reset` | destructive | NIST MANAGE; EU Art. 15 (robustness) |
| `protected-branch-delete` | destructive | NIST MANAGE; EU Art. 15 (robustness) |
| `pipe-to-shell` | injection | NIST MANAGE; EU Art. 15 (cybersecurity) |
| `no-exfil-flow` | exfil | NIST MANAGE; EU Art. 15 (cybersecurity) |
| `no-exfil-flow-cross-call` | exfil | NIST MANAGE; EU Art. 15 (cybersecurity) |
| `prod-db-destruction` | destructive | NIST MANAGE; EU Art. 15 (robustness) |
| `no-db-destructive` | destructive | NIST MANAGE; EU Art. 15 (robustness) |
| `no-push-to-main` | workflow | NIST MANAGE; EU Art. 14 (prompt gate) |
| `commit-to-main` | workflow | No mapping — standing git convention |
| `no-verify-bypass` | bypass | No mapping — softened to warn per its own rationale; standing convention |
| `write-outside-project` | escalation | NIST MANAGE; EU Art. 14 (prompt gate) |
| `cicd-config-edit` | escalation | NIST MANAGE; EU Art. 14 (prompt gate) |
| `cicd-and-infra` | escalation | NIST MANAGE; EU Art. 14 (prompt gate) |
| `secret-file-read-without-egress` | exfil | NIST MANAGE; EU Art. 15 (cybersecurity) |
| `broad-privilege-escalation` | escalation | NIST MANAGE; EU Art. 15 (cybersecurity) |
| `paste-site-exfil` | exfil | NIST MANAGE; EU Art. 14 (prompt gate); EU Art. 15 |
| `no-remote-exec` | escalation | NIST MANAGE; EU Art. 14 (prompt gate) |
| `no-after-hours-publish` | workflow | No mapping — timing nudge, general practice |
| `bash-rate-limit` | resource | NIST MANAGE (rate-limit warn) |
| `no-skip-tests` | bypass | No mapping — verification-honesty convention |
| `no-secrets-in-code` | exfil | NIST MANAGE; EU Art. 15 (cybersecurity) |
| `no-secret-files` | exfil | NIST MANAGE; EU Art. 15 (cybersecurity) |
| `no-credential-echo` | exfil | NIST MANAGE; EU Art. 15 (cybersecurity) |
| `must-sign-commits` | workflow | No mapping — own rationale states "not a security control" |
| `git-history-rewrite` | destructive | NIST MANAGE; EU Art. 14 (prompt gate) |
| `publish-gate` | workflow | NIST MANAGE; EU Art. 14 (prompt gate) |
| `verify-format-before-decision` | discipline | No mapping — context-rot nudge, not a security/governance control |
| `unverified-package-install` | supply-chain | NIST MANAGE; EU Art. 14 (prompt gate); EU Art. 15 |
| `source-change-requires-test` | discipline | NIST MEASURE (Tier 3, observe — never interrupts) |
| `no-repeat-loops` | workflow | NIST MEASURE → MANAGE (promoted; only rule with measured promotion evidence) |
| `research-before-fix` | workflow | NIST MEASURE (Tier 3, observe — never interrupts) |
| `root-cause-before-refactor` | workflow | NIST MEASURE (Tier 3, observe — never interrupts) |
| `claim-without-evidence` | verification | NIST MEASURE (Tier 3, observe) — **currently unreachable in production**, see caveat above |
| `test-oracle-tampering` | verification | NIST MEASURE (Tier 3, observe — never interrupts) |
| `test-oracle-env-introspection` | verification | NIST MEASURE (Tier 3, observe — never interrupts) |
| `test-before-commit` | verification | NIST MEASURE (Tier 3, observe — never interrupts) |
| `runaway-budget-tool-calls` | workflow | NIST MEASURE (Tier 3, observe — never interrupts) |
| `runaway-budget-bash-calls` | workflow | NIST MEASURE (Tier 3, observe — never interrupts) |
