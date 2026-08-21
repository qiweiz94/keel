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

## The three shipped rules

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
- **No cross-turn provenance / taint tracking.** The next-call gate knows
  "a detection happened this session, recently" — it does not track WHICH
  value came from WHICH tool result, or follow that value across
  transformations. A real taint-tracking system ("Lane G") is future work;
  `PersistedInjectionTag`'s shape (`injection-store.ts`) is deliberately a
  superset of `PersistedFlowTag`'s so that future lane can extend the same
  store without a migration, but nothing here implements it.
- **`generic` and `keel daemon`.** Neither host's output channel is wired
  at all — see the per-host table above.
- **A tool call's own ARGUMENTS.** This scans tool OUTPUT only. An
  injection phrase embedded in a command's own argument text is a
  different channel, out of scope for this lane — see
  `packages/cli/conformance/ASI01.yaml`'s documented scenario and
  docs/owasp-agentic-top10.md's ASI01 section.
- **Promoting `untrusted-content-role-markers` out of observe**, or the
  next-call gate from `warn` to `prompt` — both are explicit future
  follow-ups, gated on real hit-rate evidence, not shipped here.

See docs/exfil.md's "Output redaction" section for the sibling secret-scan
mechanism this lane shares its scan pass with (`evaluateToolResult()`),
and rule-parser.ts's `validActions` comment for why no injection rule can
ever declare an action stronger than `warn`.
