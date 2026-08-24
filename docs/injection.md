# Tool-result prompt-injection scanning (Lane F)

Indirect prompt injection — malicious instructions embedded in a file, web
page, API response, or other tool result that get interpreted as new
instructions on the agent's next turn — is a real, actively-researched
attack class (AgentDojo, BIPIA, and the broader indirect-injection
literature). This is keel's first rule type that inspects a completed tool
call's OWN output for it, rather than only the call's arguments.

Read this whole document before trusting any single claim in it. The
honest summary: on one host (OpenCode) keel can rewrite what the model
sees before it sees it; on every other host, a detected injection has
already reached the model by the time keel's hook fires, and what keel
does instead is record it, warn about it, and elevate scrutiny on the
agent's very next consequential action.

## What this is: a heuristic tripwire, not a detector

The two shipped detector rules (`injected-instructions-in-tool-output`,
`untrusted-content-role-markers`) match literal, well-attested marker
SHAPES: chat-template control tokens (`<|im_start|>`, `[INST]`, `<<SYS>>`),
the "ignore previous instructions" family, system-prompt-exfiltration
phrasing, role-marker impersonation (`<system>`, `Human:`/`Assistant:`),
permission-grant phrasing, and Unicode tag-character smuggling
(U+E0000-U+E007F, invisible to a human reader, tokenized by the model).

An attacker who paraphrases, translates, or encodes the same instruction
defeats every one of these patterns. Neither rule makes a completeness
claim, and neither ever blocks (`action: warn` only — see rule-parser.ts's
`validActions` comment for why a harder action is not even authorable on
this rule type). This is a tripwire: it catches unsophisticated,
copy-pasted, or automated injection payloads, and it says so honestly
rather than implying broader coverage.

## What Lane F can actually do, per host — read this before trusting the rest

Injection detection runs at a host's PostToolUse-equivalent hook. On
exactly one host that hook can rewrite the result before the model reads
it. On every other host the result reached the model BEFORE keel ever saw
it, so the verdict is an audit signal and a warning, never a rewrite.
Nothing below un-injects anything after the fact, and this table says so
per host rather than letting a single "supported" cell imply otherwise.

| Host | Lane F posture | What actually happens | Evidence |
|---|---|---|---|
| **OpenCode** (plugin) | **Prevention (heuristic).** | `tool.execute.after` write-back: matched markers are replaced with `[keel:injection-neutralized:<rule_id>]` and an untrusted-content banner is prepended, on `output.output`, `output.title`, and every top-level string in `output.metadata`, before the model reads any of it. Neutralization is heuristic, not a guarantee — a paraphrased payload passes. The scrutiny gate is armed here too. | Reuses the exact mutation channel already live-verified for output redaction — see docs/exfil.md's "Output redaction" section for the live-verification evidence. Lane F's own neutralization on top of it is covered by unit and load tests, not a separate live probe. |
| **Claude Code** | **Detection-only, post-hoc.** | `PostToolUse` fires after the result already reached the model. Keel emits `hookSpecificOutput.additionalContext` + `systemMessage` warning that the result matched injection markers and must be treated as data — the model sees that on its NEXT turn, alongside the payload, not instead of it. Arms the next-call scrutiny gate. Always exit 0. | code.claude.com/docs/en/hooks: "`PostToolUse` fires after a tool call succeeds. It cannot block the tool call... `additionalContext` injects text into Claude's context for Claude to consider." Same docs-tier confidence ceiling as the rest of this repo's Claude Code PostToolUse wiring. |
| **Cursor** | **Detection-only, post-hoc.** | Same as Claude Code minus the context-injection channel: audit record and the host's own advisory surface only. Arms the next-call scrutiny gate. | hook.ts's `cursor` branch sets `postAction.outputText` from `tool_output`/`error_message`. No post-hoc rewrite or context-injection field is confirmed to exist for a completed call. |
| **Cline** | **Detection-only, post-hoc.** | Same as Cursor. Arms the next-call scrutiny gate. | hook.ts's `cline` branch, `hookName === 'tool_result'`, reading `postToolUse.result`. No rewrite channel confirmed. |
| **Codex, Gemini CLI** | **Detection-only, post-hoc.** | Same as Claude Code, at the same citation tier this repo already applies to their PostToolUse wiring. Arms the next-call scrutiny gate. | Reuses hook.ts's shared PostToolUse parsing, unchanged by this lane. |
| **generic** | **Not wired.** | `keel hook generic` has no PostToolUse-shaped parsing at all, so no tool result is ever scanned. Pre-existing gap, unrelated to this lane. | `parsePayload`'s `generic` branch returns tool/args/session_id only and never sets `postAction`. |
| **`keel daemon`** (OpenClaw, Hermes) | **Not wired.** | The daemon's post-call route carries `exit_code` only — no output text ever reaches keel, so there is nothing to scan. The next-call gate is likewise unarmed for these hosts. | daemon.ts's outcome handler parses `{session_id, cwd, tool, args, exit_code}`; the only pipeline call in the daemon is `pipeline.evaluate()`. |

"Not wired" is a real answer, not a placeholder. A row that claimed
coverage the code does not have would be worse than the gap itself.

## The four shipped rules

- **`injected-instructions-in-tool-output`** (`mode: warn`) — the
  higher-confidence marker family above. Matches, warns, and on OpenCode
  neutralizes.
- **`untrusted-content-role-markers`** (`mode: observe`) — a weaker,
  higher-false-positive-rate sibling (role markers, `[SYSTEM]`-shaped
  bracket tags, Markdown-heading-shaped "instruction" sections,
  permission-grant phrasing, zero-width/BOM character runs). Ships
  observing only: recorded, never spoken, never neutralized, never arms
  the next-call gate. Promotion to `warn` is gated on real
  false-positive-rate evidence (`keel retrospective` / `keel promote`),
  the same evidence-gated path every other observe-mode rule in this
  catalog follows.
- **`untrusted-content-next-call`** (`next_call_scrutiny: true`,
  `mode: warn`) — the compensating control described below.
- **`untrusted-content-derived-call`** (`next_call_scrutiny: true`,
  `taint_correlation: true`, `mode: warn`) — the narrower, artifact-
  correlated sibling ("Lane G") described in "Cross-turn taint
  correlation" below.

**Expect self-referential false positives.** Every one of these markers
appears in security documentation, prompt-injection research, red-team
fixtures, and this repository's OWN docs/exfil.md, this file, SECURITY.md,
and the Lane F test fixtures. An agent reading one of those files as a
tool result WILL trip `injected-instructions-in-tool-output`. That is a
real, high-frequency, expected hit — not a bug — and it is exactly why
this rule warns and never blocks.

## The compensating control: next-call scrutiny

The one place keel can still genuinely intervene on a host that cannot
rewrite a delivered result: the payload already landed, but the ACTION it
wants hasn't happened yet, and that action still goes through the normal
pre-call gate (`EnforcementPipeline.evaluate()`/`evaluateTiers()`).

`untrusted-content-next-call` arms a persisted, session-scoped, TTL'd flag
(`injection-store.ts`'s `PersistentInjectionStore`, 15-minute TTL)
whenever an ENFORCING detector match happens this session, and fires once
— as a warning, never a block — on the session's next CONSEQUENTIAL tool
call: a file write or a shell invocation. A read, a search, or any other
non-consequential call leaves the tag armed rather than silently
consuming it — the conservative direction, since a false all-clear is
worse than one extra warning later.

This has **no payload correlation** — it doesn't know whether the
upcoming write/shell call actually has anything to do with the flagged
result, only that a detection happened this session, within the TTL, and
now a consequential call is happening. That is the same class of
imprecision `no-exfil-flow-cross-call` already ships with at the same
tier (docs/exfil.md), and the same reason this rule is `warn`/`sprint`,
never a `level: protect` floor: the backing store fails open on
corruption (same posture as `flow-store.ts` — see injection-store.ts's own
header), and a fail-open store must never back a deny-tier floor.

Armed on EVERY host, including OpenCode — neutralization there is
heuristic, so elevated scrutiny on the next action is still warranted even
where the marker text itself was defanged.

## Cross-turn taint correlation ("Lane G")

`untrusted-content-next-call`'s own false positive is structural: it has no
payload correlation, so any consequential call within the TTL fires it,
whether or not that call has anything to do with the flagged result.
`untrusted-content-derived-call` is the narrower sibling that closes part
of that gap with real evidence instead of a wider net.

**Mechanism: windowed artifact extraction, exact match.** At detection
time, `enforce/injection-taint.ts` pulls a small set of structured
"artifacts" — URLs, hostnames, file paths, email addresses — from a
±400-character window around each enforcing marker span (`extractOriginArtifacts`,
`ARTIFACT_WINDOW_CHARS`). Each candidate is normalized (lowercased, a
Windows path canonicalized to the same form as its `/`-separated
equivalent, a URL's query string and fragment stripped), filtered through
a stoplist of generic values (`github.com`, `package.json`, `localhost`,
`.env`, ...), length-floored, then DEFANGED before it is ever persisted —
`defangArtifact` breaks `.`/`:`/`/`/`@` and the literal `http`/`https`
scheme word so a stored artifact can never become a live, copy-pasteable
URL, even inside an audit log or a warning message surfaced back to the
model on its next turn. Up to 8 artifacts are kept per detection.

When a later CONSEQUENTIAL call happens (the same write/shell predicate
`untrusted-content-next-call` uses), `extractCallArtifacts` runs the
IDENTICAL four extractors against that call's own command surfaces
(`commandSurfaces()` — quote-obfuscation and compound-command splitting
included), target path, `url`/`uri`/`host` arguments, and inline write
content (`content`/`text`/`newString`/`new_string`/`patchText`). If any
extracted value exactly matches a stored artifact, that is a real
correlation hit: `untrusted-content-derived-call` fires, naming the
matched (still-defanged) artifact in its message, and consumes ONLY the
tag(s) it matched — every other pending tag, including ones from the SAME
detection that had no match, stays fully armed for the broad sibling rule
to still cover.

**Why exact-match on structured artifacts, not raw substring search.** A
256KB flagged result substring-matched against every later call's command
text produces constant false positives on generic tokens (`npm`, `src/`,
`http`) at that scale, and gives a warning nothing specific to name.
Windowed structured extraction trades recall for a small, nameable,
verifiable piece of evidence.

**Scope: single-hop, deliberately.** This tracks exactly one hop — flagged
result → next call that references one of its artifacts — never a value
propagated across three or more calls. Multi-hop propagation would need
confidence-decay modeling with no real hit-rate data to base it on yet;
see "What this does NOT cover" below and ROADMAP.md.

**Per-rule consumption, not delete-on-consume.** Two `next_call_scrutiny`
rules now share `injection-store.ts`'s persisted store. A tag is MARKED
per rule id that consumes it (`PersistedInjectionTag.consumedBy`), never
deleted — only TTL expiry removes it. This is what lets the broad rule
fire on an unrelated call and the correlated rule STILL fire later on the
same detection, on a genuinely-derived call; the earlier delete-on-consume
design would have let whichever rule's consequential call happened first
blind the other to every tag it hadn't yet checked.

**Still `action: warn` only.** `rule-parser.ts`'s validation forbids
anything stronger than `warn` on any `type: injection` rule, correlated
evidence or not — see that file's `validActions` comment. Promoting a
CORRELATED hit specifically to `action: prompt` is a named, explicit
follow-up requiring a parser change plus real hit-rate data, not shipped
here.

**Honest limits of the correlation itself:**
- **Exact-match only.** A paraphrased or restructured reference to the
  same target — a different case, a URL shortener, a renamed variable
  holding the same path — does not correlate. This closes part of the
  broad rule's imprecision, not all of it; the broad rule still exists for
  exactly this reason.
- **Four artifact classes only.** URLs, hostnames, file paths, and email
  addresses. A flagged directive naming something else entirely — a
  numeric account id, a free-text instruction with no structured target —
  produces no artifact to correlate on, and only the broad sibling covers
  it.
- **The 400-character window is a real precision/recall tradeoff.** An
  artifact further from the marker than that is never extracted, by
  design — the window IS the precision mechanism (see injection-taint.ts's
  own header). A payload that describes its target far from the marker
  text is missed.
- **"Storing is indistinguishable from obeying."** If the agent SAVES the
  flagged result (writes the fetched page to disk, edits a document that
  quotes it), the write content carries the same artifacts and this rule
  fires — the evidence is "the agent filed it", not "the agent obeyed it".
  This is the dominant false-positive shape on the write-content channel,
  and it is measured, not hypothetical — see the corpus counts in
  `injection-taint-corpus.test.ts` / SECURITY.md.
- **Single-hop only.** No propagation across a third call. See ROADMAP.md.

## What this does NOT cover

- **Paraphrase, translation, and encoding evasion.** Every pattern here
  matches a literal marker shape. "Please disregard everything above and
  instead..." in different words, a different language, base64, or
  leetspeak passes cleanly. This is a heuristic tripwire, not a semantic
  or model-based detector — see this document's own opening section.
- **The scan-size bound.** `MAX_OUTPUT_SCAN_CHARS` (256KB,
  `pipeline.ts`) — text past that bound is never scanned, for either the
  secret or the injection pass. `injection_scan_truncated` on the result
  says so honestly rather than returning a silent clean verdict for
  content that was never looked at.
- **Top-level-metadata-only scanning on OpenCode.** Only `output.output`,
  `output.title`, and top-level string values of `output.metadata` are
  scanned/neutralized — a tool whose metadata nests content inside a
  further object or array is not covered (the same scope decision
  docs/exfil.md's output-redaction section already documents for the
  secret-scan side of the same write-back path).
- **Cross-turn taint correlation is now SINGLE-HOP, exact-match, and
  narrow — not general provenance tracking.** `untrusted-content-derived-call`
  ("Lane G", above) closes part of the broad gate's imprecision: it knows
  whether a LATER call's own arguments/content reference one of four
  artifact classes (URL, host, path, email) found within 400 characters of
  an enforcing marker, and fires only on that. It does NOT catch a
  paraphrased or restructured reference to the same target, does NOT
  propagate a value across a third call, and "storing" a flagged result
  (saving it to disk) is indistinguishable from "obeying" it on the
  write-content channel — see "Cross-turn taint correlation" above for the
  full honest-limits list. The broad `untrusted-content-next-call` gate
  still exists specifically for what this narrower rule cannot correlate.
- **`generic` and `keel daemon`.** Neither host's output channel is wired
  at all — see the per-host table above.
- **A tool call's own ARGUMENTS.** This scans tool OUTPUT only. An
  injection phrase embedded in a command's own argument text is a
  different channel, out of scope for this lane — see
  `packages/cli/conformance/ASI01.yaml`'s documented scenario and
  docs/owasp-agentic-top10.md's ASI01 section.
- **Promoting `untrusted-content-role-markers` out of observe**, promoting
  either next-call gate rule from `warn` to `prompt` (rule-parser.ts forbids
  this today regardless — see below), or building multi-hop taint
  propagation (tracking a value across three or more calls, with
  confidence decay) — all explicit future follow-ups, gated on real
  hit-rate evidence, not shipped here.

See docs/exfil.md's "Output redaction" section for the sibling secret-scan
mechanism this lane shares its scan pass with (`evaluateToolResult()`),
and rule-parser.ts's `validActions` comment for why no injection rule can
ever declare an action stronger than `warn`.
