# Wave 2 · Lane 3 — Claim-to-evidence detector (the session's core thesis)

Worktree: `/Users/nanoclaw/code/keel-w2-claim`, branch `w2-claim`.

## 0. Environment

```
$ node --version
v26.0.0
$ git branch --show-current
w2-claim
$ git status
On branch w2-claim
nothing to commit, working tree clean
$ npm ci
(clean install, no output)
```

## 1. Reading first — what already exists

Read before writing anything: `packages/core/src/enforce/verification.ts`,
`sequencer.ts`, `context-manager.ts`, `types.ts`'s verification-obligation
fields, `pipeline.ts`'s stateful-rule loop, and the repo's own
`.keel/rules.yaml`:

```yaml
- id: claim-must-have-evidence
  type: command
  match: "(done|fixed|complete|working)"
  action: deny
  unless_reasoning: "test.*pass|verified|confirmed.*output|evidence"
  message: "Don't claim completion without evidence. Include test output or verification steps."
```

Two things wrong with it, both structural, not typos:

1. **It's a `type: command` rule, so `match` runs against `commandString(input)`
   — the COMMAND text, not the agent's claim.** Any Bash call whose command
   happens to contain "done", "fixed", "complete", or "working" as a bare
   substring fires: `npm run build:fixed-assets`, `git log --grep=fixed`,
   a `mkdir working-dir`. This is bare-keyword matching against the wrong
   surface entirely, not "position-aware."
2. **`unless_reasoning` is the escape hatch, but `input.reasoning` is
   usually absent** (see §2), so the escape hatch almost never engages —
   the rule is *effectively* "deny any command containing these four
   words," full stop.

This is the FP surface item 1's "position-aware, not bare keywords"
requirement is written against. The principled version below matches a
claim-SHAPED clause (subject + linking verb, or a clause-leading
past-participle) in extracted TEXT, not a keyword substring in a command
string.

## 2. Channel survey — what hosts actually deliver (read before designing)

`EnforceInput.reasoning` (types.ts:211, "agent's chain-of-thought, if
available") is the field designed to carry the claim text. Traced every
host wired into `keel hook <host>`
(`packages/cli/src/commands/hook.ts:parsePayload`, lines 55–101):

| Host | Payload shape | Carries `reasoning`? |
|---|---|---|
| claude-code | `{tool_name, tool_input}` from `TOOL_NAME`/`TOOL_INPUT` env vars | No |
| gemini | same as claude-code (documented equivalence) | No |
| codex | same as claude-code | No |
| cline | `{preToolUse: {toolName, parameters}}` | No |
| cursor | `{command}` or `{tool_name, tool_input}` | No |
| generic | `{tool, args}` | No (caller-defined; could add it, nothing does today) |

None of the five real hosts' PreToolUse-shaped payloads carry a free-text
field — they are all "which tool, what arguments," because that is what a
pre-tool-use hook fundamentally observes. `packages/opencode-plugin/src/plugin.ts:339`
does forward `hookInput?.reasoning` conditionally:

```ts
...(hookInput?.reasoning ? { reasoning: String(hookInput.reasoning) } : {}),
```

but OpenCode's documented `tool.execute.before(input, output)` shape is
`input: {sessionID, callID, tool}` / `output: {args}` — no chain-of-thought
field. This line is defensive/speculative, almost certainly always
`undefined` in production today. `packages/cli/src/commands/evaluate.ts`
and `reasoning.ts` DO wire a `--reasoning <text>` CLI flag through to
`EnforceInput.reasoning` — that is a real, working channel, but it is
manual/opt-in (`keel check --analyze-reasoning`), not something any host's
automatic hook populates.

**Conclusion, stated plainly for the proposal's `confidence: low`:**
`reasoning` is the tested-but-currently-unwired channel. The channel that
IS reliably populated through every host today is **whatever natural-
language text the agent writes into a command it runs itself** — a commit
message, a PR title/body, an issue comment. `git commit -m "..."` reaches
keel through the exact same `args.command` string every host already
delivers for command matching. `claim.ts`'s `extractCommandMessages` is
therefore the PRIMARY production surface, not a fallback; `reasoning` is
scanned first in code (so the day a host wires it up nothing needs to
change) but is exercised by tests only, not by any host's live traffic
today. This is the single most important design fact and it drives the
proposal's `confidence: low` (not medium) and one of its `false_positives`
entries.

## 3. Design: new `claim` rule type, reusing `verification`'s state machine

**Decision: a new `RuleType: 'claim'`, not an extension of `verification`'s
semantics** — but its trigger/satisfy/pending bookkeeping is 100% REUSED
from `VerificationTracker`, not reimplemented. Justification:

- The state shape is identical to what `type: verification` already
  tracks: an edit ARMS an obligation (`trigger`), a passing test/build
  command DISCHARGES it (`satisfy`), and it expires after
  `verification_window_seconds`. Building a second, parallel tracker for
  the exact same shape would violate the task's explicit "reuse; do not
  build a parallel framework" instruction and would double the places a
  future bug fix (like §6's match-surface repair) has to land.
- What genuinely differs is only what happens WHILE an obligation is
  pending: `type: verification` gates a BOUNDARY tool call (commit/push,
  via `rule.boundaries`); `type: claim` gates the agent's own TEXT
  asserting the obligation is already met. That is a different trigger
  for the SAME state, which is exactly what a new type name should
  express — folding it into `verification` would have meant overloading
  `boundaries` with a second, unrelated meaning or adding a text-detection
  branch that only some `verification` rules use.

Mechanically (see `verification.ts`'s new `isObligationRule()` helper and
`pipeline.ts`'s new `if (rule.type === 'claim' && ...)` branch):

- `observeTrigger`, `markSatisfied`, `isPending` in `VerificationTracker`
  now accept `rule.type === 'verification' || rule.type === 'claim'`
  (previously verification-only). `boundary()` is untouched — claim rules
  never declare `boundaries`, and nothing gates it by type today (it just
  needs `rule.boundaries` to be truthy, which a claim rule's YAML won't
  have).
- `pipeline.ts`'s stateful-rule loop (runs on every `evaluate()` call,
  before the Tier-1 cache) gained a `claim` branch, sibling to the
  existing `verification` boundary branch: `if (rule.type === 'claim' &&
  verificationTracker.isPending(rule, input)) { const claim =
  detectClaim(input); if (claim) return this.violation(...) }`.
- `statefulRules` filter, the `observeTrigger` call site (second loop),
  and `markVerificationSatisfied` (called by the host after a zero exit —
  see `plugin.ts:565`) all broadened from `'verification'` to
  `'verification' || 'claim'`.
- `rule-parser.ts`'s `validTypes` and the trigger/satisfy-required
  validation block both broadened the same way.

**Known consequence of full reuse, stated in the rule's own message
semantics, not glossed over:** because `markSatisfied` is only ever called
by the host after a ZERO exit code (mirrors `plugin.ts:565`'s `if (exit
=== 0) pipeline.markVerificationSatisfied(...)`), a FAILED test run and NO
test run at all are the SAME pending state. The claim rule cannot and does
not try to distinguish "never ran" from "ran and failed" — both mean "no
evidence of a passing run since the edit," which is what fires. Proven by
`claim.test.ts`'s two MUST-FIRE cases and the explicit test
`"the rule cannot distinguish 'never ran' from 'ran and failed'"`.

**Overlap with the shipped `source-change-requires-test` verification
rule:** both can fire on the same trajectory (an edit, then a commit while
pending) — the verification rule warns on the commit BOUNDARY itself, the
claim rule (if the commit message contains claim-shaped text) fires on the
TEXT. A catalog shipping both will sometimes double-report on the same
commit. They check genuinely different things (a tool-shape boundary vs.
a false-success text assertion) so this is not a duplicate rule, but a
reviewer adopting both should expect the overlap.

## 4. The claim grammar (`packages/core/src/enforce/claim.ts`)

Position-aware, not bare keywords. Six named regex shapes
(`CLAIM_PATTERNS`), not a keyword list — `tests-pass`, `build-pass`,
`verification-noun`, `linking-verb` (subject + is/are/was/now +
completion word), `clause-leading` (a past-participle claim word leading
a clause: "Fixed and passing."), `verified-explicit`. The word set is
task's `done/fixed/tested/passing/verified/complete` plus
`working/resolved/ready` as reasonable synonyms.

Exclusions (position-awareness, task item 1's explicit requirement):

- fenced code blocks, inline code spans, URLs, and path-shaped tokens are
  stripped before scanning — `\btests?\b` would otherwise match the
  substring inside `src/all-tests-pass/report.ts` or a URL slug.
- quoted spans inside free-form `reasoning` text are stripped (reported
  speech — an error message, a log line, a user's words — is not the
  agent's own claim). This is deliberately NOT applied to
  `extractCommandMessages`'s output: there the quotes are shell syntax
  bounding the argument, not reported speech, so the content inside is
  exactly what gets scanned.
- a hedge/negation word anywhere in the utterance (`wip`, `todo`,
  `partial`, `not run`, `in progress`, `should now be`, ...) suppresses
  the whole utterance.

`git commit -m "fix: typo"` (the binding-constraints example) needs no
special-case: `\bfixed\b` requires the literal characters `f-i-x-e-d`,
which `fix:` never contains — position-awareness falls out of the grammar
itself, not an added carve-out.

**Known misses, documented honestly (not fixed this wave):**

- no coreference/clause-scoping beyond a single sentence-ish boundary —
  "I fixed the OTHER bug, this one's still broken" can still fire on
  "fixed."
- no sarcasm or negation-at-a-distance beyond the hedge word list.
- only four message-carrying flags recognized (`-m`/`--message`/`--body`/
  `--title`); a `--body-file` payload or a heredoc commit message is
  invisible to this grammar.
- English only.
- a claim VERIFIED IN AN EARLIER window that has since expired
  (`verification_window_seconds`, default 300s) reads as unverified even
  though it genuinely wasn't — the window is a freshness proxy, not a
  certificate that no verification ever happened. Listed as a
  `false_positives` entry in the proposal.

## 5. Window semantics

`verification_window_seconds` (shared field name with `type: verification`
— same tracker, same window) bounds how long an armed obligation stays
pending; default 300s if unset. Proven both directions in
`claim.test.ts`'s "window semantics" describe block with `vi.useFakeTimers`:
a claim inside the window fires, a claim after the window does not (the
obligation is simply gone by then — "no obligation tracked" is neither a
fire nor a pass on the merits, and the test's comment says so explicitly).

**"Last N tool calls" was in the task's window description
("window: last N tool calls / M seconds, configurable") and was
deliberately NOT implemented.** `VerificationState` (state-manager.ts) is
`{createdAt, generation}` — no call counter. Adding one would need either
a `StateManager` schema extension plus a persisted write on EVERY tool
call while ANY obligation is pending (not just on edits/satisfies), or an
in-memory-only counter that silently stops working in exactly the
process-per-call hosts this wave's persistence requirement exists for. A
call-count window that only works in the host that doesn't need it is
worse than no window at all — shipped the time window only, documented
here rather than half-implemented.

## 6. Assigned cleanups

### (a) `verification.ts` matcher.pattern raw-JSON haystack

Fixed additively in `matches()` (the `matcher.pattern` branch): the real
command text (`commandString(input)`) is now tried alongside the existing
`JSON.stringify(args)` haystack — `||`, not a replacement, so nothing that
matched before stops matching; an anchored pattern that could only ever
match the command text now can too. Same repair pattern as
`pipeline.ts`'s existing rate/diagnosis fix (match-surface.test.ts's file
header explains the JSON-escaping and end-anchor classes of breakage).

**Mid-task supervisor update, addressed:** the sequence lane confirmed the
same raw-JSON-haystack class exists in `boundary()` too (the
commit/push-boundary matcher, not just the trigger/satisfy matcher).
Fixed the same way — `commandString(input)` tried additively alongside the
existing `JSON.stringify(stripContentArgs(args))` haystack, before the
existing MCP-shaped word-matching fallback (untouched). Three new tests
appended to `match-surface.test.ts` (not rewritten — the file's own
`no-destructive-commands`/`rate`/`diagnosis` suites are unchanged): an
end-anchored boundary pattern that was previously unreachable through a
quoted command, a regression guard that the existing unanchored/unquoted
case still matches via the JSON surface, and a must-allow case.

Also added `'verification'` to `RuleCategory` (types.ts) and
`validCategories` (rule-parser.ts) — the task's proposal spec explicitly
asks for `category: verification`, and the shipped enum had no entry that
fit (`discipline`/`workflow` were the closest, neither precise). Per the
supervisor's mid-task note, this is the IDENTICAL single-token addition
another lane made independently on its own branch — same spelling, same
two files — so the two branches should merge without conflict.

### (b) Traces dir — `KEEL_TRACES_DIR`

`AuditLog`'s constructor (`audit.ts`) and the opencode plugin's `TRACES_DIR`
constant (`plugin.ts`) both always resolved to real `~/.keel/traces` with
no override, confirmed both by grep and by `session/DECISIONS.md`'s own
Wave-1 gap note ("traces dir (plugin TRACES_DIR + AuditLog default) has no
env override ... Assign both when Wave 2/3 lanes are cut") and by
`audit.test.ts`'s own pre-existing comment ("AuditLog's constructor does
not consult KEEL_STATE_DIR").

Fixed with a NEW env var, `KEEL_TRACES_DIR`, mirroring `state-manager.ts:21`'s
`KEEL_STATE_DIR || real-home` shape — but **read inside the constructor**,
not as a module-level `const` like `state-manager.ts:21` does. Verified
empirically (two throwaway probe test files, `zzprobe.test.ts` /
`zzprobe2.test.ts`, deleted after use — see the incident note below) that a
module-level `const` computed from `process.env.X` is fixed at whatever
value the env var held when the module was FIRST imported: a static
`import { StateManager } from '../state-manager.js'` at the top of a test
file evaluates BEFORE any of that file's own top-level code (including a
`process.env.KEEL_STATE_DIR = tmpDir` line placed after the import, or
inside a `describe()` body — both run only once the import graph has
already resolved). The probe that statically imported `StateManager`
before setting the env var wrote to REAL `~/.keel/state` despite the
assignment; the probe using a dynamic `await import()` after setting the
env var did not. `AuditLog`'s fix reads `process.env.KEEL_TRACES_DIR`
per-construction instead, which is correct regardless of import order —
a deliberate, documented deviation from the literal state-manager.ts
pattern, not a copy of its fragility. `plugin.ts`'s `TRACES_DIR` stays a
module-level const (unchanged shape) since nothing imports the plugin
module more than once per real process and its own `scripts/load-test.js`
already documents needing to set `HOME` before importing for the same
reason.

Two new tests in `audit.test.ts` prove the override and that an explicit
`logDir` argument still wins.

**Incident, disclosed:** while empirically probing the above, a throwaway
test wrote one real key (`probe-rule-2`) into this machine's actual
`~/.keel/state/deny-first-time.json`. Removed immediately after
discovery, leaving the file's two genuine pre-existing entries
(`b-warn`, `demo-deny`) untouched — verified with a targeted read/write
that only deleted the injected key, not the whole file.

### (c) Pipeline's default `overrideStore`

`EnforcementPipeline`'s constructor defaults to `new FileRuleOverrideStore()`
whenever no `overrideStore` is supplied (`pipeline.ts:77`), and every
deny/prompt verdict calls `.consume()` unconditionally — confirmed this
touches real `~/.keel/overrides.json` + lock file in
`verification.test.ts` today (it reaches `deny` verdicts, e.g. "push
origin main," without stubbing `overrideStore`, unlike `match-surface.test.ts`
and `fixture-harness.test.ts`, which both explicitly stub it).

Fixed with `KEEL_OVERRIDES_DIR`, read inside `FileRuleOverrideStore`'s
constructor (default parameter expressions are evaluated per-call in JS,
so this one was never subject to the module-load-timing hazard above).
**Deliberately a separate env var from `KEEL_STATE_DIR`**, not a reuse of
it — `keel allow` (the real writer, `packages/cli/src/commands/allow.ts`)
hardcodes `join(homedir(), '.keel', 'overrides.json')` directly (it
doesn't even go through `FileRuleOverrideStore` to write) and is UNCHANGED
this wave. Reusing `KEEL_STATE_DIR` for the reader would have silently
split reader and writer onto different files the moment any host or test
set `KEEL_STATE_DIR` for its own isolation — the override feature would
appear to work (no error) while quietly never finding what `keel allow`
wrote. `allow.ts` was judged out of this lane's ownership (not a claim/
verification file, and a pre-existing single-purpose CLI command) and
left untouched; noted here rather than silently expanded into.

Two new tests in `overrides.test.ts`: the env var redirects the DEFAULT
construction site, and an explicit `home` argument still wins when the
env var is unset (existing callers' behavior unchanged).

**Same residual class as `session/DECISIONS.md`'s standing
`KEEL_STATE_DIR` ruling, flagged here rather than silently introduced
twice:** `KEEL_TRACES_DIR` and `KEEL_OVERRIDES_DIR` are both
"an env var an agent's own shell could set to redirect keel's state" —
the identical bypass shape the supervisor already ruled on for
`KEEL_STATE_DIR` (KEEP, because subprocess test isolation genuinely needs
it, with the residual risk deferred to Wave-2's Tier-1 KEEL_* env-mutation
scope and Phase-6's red team). Same reasoning applies here and is not
re-litigated; both new vars should fall under the same Tier-1/Phase-6
coverage rather than being treated as a new, unreviewed surface.

## 7. Test results

```
$ cd packages/core && npx vitest run
 Test Files  16 passed (16)
      Tests  278 passed (278)

$ npm run build --workspaces
(all four packages build clean; templates/keel-enforce.js regenerated)

$ cd packages/cli && npx vitest run
 Test Files  1 failed | 45 passed (46)
      Tests  4 failed | 645 passed (649)
```

The 4 CLI failures are `level.test.ts`'s ANSI/chalk-escape assertions
(`toContain('global level: balanced → sprint')` against a colorized
string). Confirmed pre-existing and unrelated to this lane: `git stash`
back to the base commit (`b45aebf`) and re-running the same file
reproduces the identical 4 failures verbatim, with no changes from this
branch applied. Also independently documented twice already in
`session/DECISIONS.md` (Wave-1 lanes 1 and 3, both flagged the same 4
failures on the base commit).

```
$ npm run lint     # tsc --noEmit across core/cli/mcp-server
(clean, no output)

$ node packages/opencode-plugin/scripts/load-test.js
All checks passed   (37/37, including "dist matches canonical template")
```

`claim.test.ts` (22 tests) covers: grammar unit tests (10), synthetic
trajectories through the real pipeline in `mode: observe` matching the
shipped proposal exactly — asserting `observed_action`, not `action`,
since `action` is `'allow'` in both the fire and no-fire cases and would
pass vacuously otherwise (2 must-fire, 5 must-not-fire, each annotated
with which SINGLE mechanism it exercises so no case is suppressed by two
independent paths at once — satisfied-obligation / hedge / trigger-scope /
grammar-precision / quote-stripping), window semantics (2), the shipped
proposal file's own validity and end-to-end behavior (2), and cross-
process persistence via a shared fake `StateManager` across separate
`EnforcementPipeline` instances, the same pattern `pipeline.test.ts`'s
"shares rate-limit and first-warning state between pipeline instances"
test already established (2).

## 8. Proposal

`session/proposals/claim-without-evidence.yaml` — rule id
`claim-without-evidence`, `type: claim`, `mode: observe`, `action: warn`,
`category: verification`, `severity: high`, `confidence: low`,
`maturity: incubating`, full `rationale`/`remediation`/`false_positives`/
`review_by`. Not wired into either `DEFAULT_RULES_YAML` (single-owner
files, per `session/DECISIONS.md`'s Tier-3 convention: capability lanes
ship the snippet, the supervisor pastes it in at the Wave-2 gate). The
exact snippet is loaded and validated by `claim.test.ts`'s
"session/proposals/claim-without-evidence.yaml" describe block, including
running it through the real pipeline end to end — not just YAML-valid,
provably behaves as designed.

## 9. Files changed / added

- New: `packages/core/src/enforce/claim.ts` (grammar + `detectClaim`),
  `packages/core/src/enforce/__tests__/claim.test.ts` (22 tests),
  `session/proposals/claim-without-evidence.yaml`, this file.
- Modified: `types.ts` (`claim` RuleType, `verification` RuleCategory,
  field comment), `rule-parser.ts` (`claim` validation), `pipeline.ts`
  (claim branch + broadened type guards), `verification.ts`
  (`isObligationRule`, matcher.pattern + boundary() additive fix),
  `audit.ts` (`KEEL_TRACES_DIR`), `overrides.ts` (`KEEL_OVERRIDES_DIR`),
  `plugin.ts` (`KEEL_TRACES_DIR`), `index.ts`/`keel-core.ts` (barrel
  exports), `match-surface.test.ts` (+3 boundary tests, appended),
  `audit.test.ts` (+2), `overrides.test.ts` (+2).
- Generated (build output, not hand-edited): `packages/cli/src/core/**`
  (rm'd + re-copied by the build script), `packages/cli/templates/keel-enforce.js`
  (regenerated from `plugin.ts` via `npm run build`).
