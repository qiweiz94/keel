# M4 — host breadth to "live" (honesty ratchet at scale)

Worktree: `keel-v1-m4-hostbreadth`, branch `v1-m4-hostbreadth`.

Scope: extend the BLOCK-live/WARN-live surface in `docs/integrations.md` honestly —
build automated WARN live-verify harnesses alongside the existing BLOCK ones, fix
the known Cursor warn-key casing bug, and split the matrix's single "Verified"
column into Block-Verified/Warn-Verified so the two claims stop being conflated.
Overclaiming host coverage was named as the worst failure mode for this lane; every
claim below states its actual basis.

Baseline confirmed green BEFORE any change: `npm install`, `npm run build`, then
full `npm test` — core 597 passed/2 skipped, cli 811 passed/14 skipped, mcp-server 6
passed, opencode-plugin all checks passed (57/57). Re-confirmed green at the end —
full output below.

---

## 1. The structural gap that shaped everything else

`lv_verify_block` (pre-existing, `scripts/live-verify/lib/common.sh`) works because
it has a physical witness: the remote ref didn't move. `warn` has no such witness —
a warn **allows** the action, so "the action happened" is true whether warn worked
or was silently swallowed. A naive `lv_verify_warn` that just greps a transcript for
a marker text this same script wrote headers into would be the exact
can't-possibly-fail control class this repo's own culture rejects (see
`lv_verify_block`'s comment in common.sh, and the memory pin on tautological gates).

The two-sided assertion built instead, added to `common.sh` as `lv_verify_warn` +
`lv_no_marker`:

1. **the side effect DID occur** (a new commit exists — proves warn ≠ block), AND
2. **the warn text appears in a channel the calling script did not itself write**
   (proves it wasn't swallowed).

A negative control (`lv_no_marker`, same pipeline, a command that does NOT match
the rule under test) proves the marker check itself isn't tainted by unrelated log
noise — run and PASSED for every host attempted below, before the real test ran.

**Rule under test: `no-verify-bypass`** (`packages/cli/src/commands/install.ts`) —
`action: warn`, `mode: warn`. Deliberately chosen over `no-force-push` or
`no-push-to-main`: those are `level: protect` (blocks on the first hit, post
gate-2) or `action: prompt` (blocks unconditionally) — neither ever produces a
`warn` verdict on a single call. `no-verify-bypass` is a PERMANENT warn (softened
from deny by an earlier wave specifically so `--no-verify` keeps an escape hatch)
— it never escalates, so one child call is enough; no pre-warm, no double-hit
bookkeeping. Matches `git commit ... --no-verify`, `-n`, or `-c ...core.hooksPath`.

---

## 2. OpenCode WARN — genuinely live-verified (the strongest result this lane)

**Channel found empirically before writing any script** (not assumed from the
existing "already correct" note in `docs/integrations.md`): the opencode-plugin's
warn path calls `client.app.log({level:'warn', ...})`
(`packages/opencode-plugin/src/plugin.ts`, `surfaceWarn()`). A throwaway probe
plugin (mimicking that exact call) proved this does **NOT** appear in `opencode run
--format json`'s stdout event stream — headless JSON mode carries no app-log
events at all. It DOES land, structured and greppable, in
`$XDG_DATA_HOME/opencode/log/opencode.log`:

```
timestamp=2026-08-12T17:58:56.145Z level=WARN run=a5e60b0c message="[Keel] warnprobe-marker: this is a test warn message" rule_id=warnprobe-marker
```

That file is written by the real `opencode` process itself under this script's own
isolated `XDG_DATA_HOME` — never by the script — which is what makes a grep against
it non-tautological. This finding matters beyond this lane: the pre-existing "live
(pre-existing)" rating for OpenCode's warn channel in `docs/integrations.md` was
based on "already user-visible in the OpenCode UI stream" (interactive-mode
inspection), which is a DIFFERENT claim than "observable headlessly" — this lane is
the first to confirm the headless case specifically, via a different file than
anyone previously looked at.

**Script**: `scripts/live-verify/opencode-warn.sh` (new). Structure: negative
control (ordinary `git commit`, no `--no-verify`, must NOT trip the marker) → real
test (`git commit -m "wip" --no-verify` via one live `opencode run` child) →
two-sided verify (HEAD moved AND marker in `opencode.log`).

**Result — PASS, actually run in this environment**:

```
NEGATIVE CONTROL: PASS
  ordinary commit succeeded (ef885156... -> 76db917d...)
  confirmed absent: marker "level=WARN.*\[Keel\] no-verify-bypass:" not present ... without the trigger

-- verifying (1/2): the commit actually happened — warn must NOT block --
SIDE EFFECT: PASS — HEAD moved 8265a5bd... -> f7b6c3dc...; the commit went through
-- verifying (2/2): the warn marker landed in opencode's OWN log, not swallowed --
  confirmed: marker "level=WARN.*\[Keel\] no-verify-bypass:" found in .../opencode.log
WARN CHANNEL: PASS

-- captured opencode.log line (evidence) --
timestamp=2026-08-12T18:03:25.329Z level=WARN run=ba0a3e38 message="[Keel] no-verify-bypass: Bypassing git hooks with --no-verify, -n, or core.hooksPath — make sure this is intentional." rule_id=no-verify-bypass session_id=ses_008db5c4dffebK099k2VdMTDeg

== OPENCODE WARN: PASS (side-effect-not-blocked=yes, warn-surfaced-in-host-log=yes) ==
```

Committed transcript: `session/transcripts/opencode-warn-no-verify-bypass.txt`
(the child's own captured JSON stream + the `opencode.log` line appended). The
script overwrites this file on every run; it was run twice this lane (once here,
once again after the §3 verdict-logic fix below, to confirm that fix didn't affect
OpenCode's own codepath) and both passed. The quote above is from the FIRST run
(`ses_008db5c4...`, 18:03) — the committed file on disk is the SECOND, later run
(`ses_008cccf95...`, 18:19), with different shas/timestamps but the identical
PASS/PASS/PASS shape. Not a discrepancy to chase — both are genuine — just noting
which one a reader cross-checking shas against the committed file will find.

Model: `opencode/deepseek-v4-flash-free` — no-auth, free tier, matching the
existing block script's pin. No real-money cost.

---

## 3. Claude Code / Gemini / Codex WARN — scripts built, honestly AUTH-BLOCKED here

`scripts/live-verify/{claude,gemini,codex}-warn.sh` (new) mirror the existing block
scripts' auth-probe-first pattern and reuse the same `no-verify-bypass` rule. Unlike
OpenCode, these are exit-code hosts with no independent out-of-band log this harness
can read — the proof available is that the pipeline round-trips through a REAL
running child session making its OWN decision to run the triggering command (not a
canned payload fed straight to `keel hook`), with the marker appearing in the
child's own captured transcript and the commit actually having gone through. All
three were run end-to-end in this environment; all three correctly early-exit
AUTH-BLOCKED rather than fabricate a result, reproducing the same auth findings the
existing block scripts already documented:

| Host | Result | Exit | Real captured error |
|---|---|---|---|
| Claude Code | AUTH-BLOCKED | 2 | `"result":"Not logged in · Please run /login"` |
| Gemini CLI | AUTH-BLOCKED | 2 | `Please set an Auth method ... GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA` |
| Codex CLI | AUTH-BLOCKED | 2 (throwaway `npm install --prefix` succeeded first — codex-cli 0.147.0) | `401 Unauthorized ... wss://api.openai.com/v1/responses` then same over HTTPS |

No transcript files were created for these three (the scripts exit before reaching
the point where `$TRANSCRIPT` is opened) — nothing to commit beyond the auth-probe
logs, which reproduce (not duplicate) the pre-existing
`session/transcripts/{claude,gemini,codex}-auth-probe.txt`.

**Claude Code's block row asymmetry, found while re-verifying** (not previously
stated this explicitly): the committed `session/transcripts/claude-code-force-push.txt`
evidence for the BLOCK path was captured via a REAL, non-isolated `~/.claude` login
("supervisor gate-2 attempt" per its own header) — a different trust boundary than
this lane's isolated `CLAUDE_CONFIG_DIR` scripts, which lose auth entirely on every
machine tested so far (this one included). The "live" block claim and the
"AUTH-BLOCKED" warn result are both honest; they were produced by different auth
paths, not a regression. Also noted, not silently fixed: the block script itself
writes to `session/transcripts/claude-force-push.txt`, but the cited evidence file
is `claude-code-force-push.txt` — a pre-existing filename mismatch, left as-is per
the constraint against touching things blind.

**Self-review caught a real gap in the original verdict logic, fixed before
committing further.** The first draft of these three scripts asserted the warn
marker directly against the child's `--output-format json` transcript with a
binary pass/fail, the same shape as the block scripts' `lv_verify_block`. That's
wrong for warn specifically: a warn's advisory text is keel's hook CLI's own stdout
JSON (`systemMessage`/`hookSpecificOutput.additionalContext`), and whether the HOST
ITSELF echoes that stdout back into its own `--output-format json` event stream is
a host-observability question this repo has never answered — unlike the block
path, where exit-2 + stderr is independently known to surface as
`permission_denials` (visible in the committed `claude-code-force-push.txt`). A
plain FAIL on marker-absent would have conflated "keel never warned" (a real
defect) with "the host swallowed its own hook's stdout before this harness could
see it" (a harness limitation) — exactly the ambiguity that makes a result
untrustworthy.

Fixed two ways, both before any of these three scripts had produced a false
verdict against a real auth session (auth was blocked in every attempt, so no
result was ever reported either way beyond AUTH-BLOCKED):

1. **Validated keel's own half, auth-free.** `echo '<no-verify payload>' | keel hook
   claude-code|codex|gemini` (isolated `HOME`/`KEEL_STATE_DIR`, real built CLI, no
   host, no auth needed) for all three hosts. All three emit the exact
   `[keel:no-verify-bypass]` marker on stdout with exit 0, in each host's own
   documented envelope shape (Claude/Gemini: `hookSpecificOutput.additionalContext`
   + `systemMessage`; Codex: `systemMessage` only, matching its deliberate
   `hookSpecificOutput` omission). This is the keel-side half of the claim, settled
   independently of whatever the three warn scripts report.
2. **Added `lv_verify_warn_exitcode_host`** (`scripts/live-verify/lib/common.sh`) —
   a three-valued verdict specific to hosts with no independent out-of-band
   channel: HEAD-unmoved is a real FAIL (the action was blocked, not warned — an
   unambiguous defect); HEAD-moved-with-marker is PASS; HEAD-moved-without-marker
   is COULD-NOT-TEST, not FAIL, with the reasoning printed inline at the point of
   the result. `claude-warn.sh`/`gemini-warn.sh`/`codex-warn.sh` now use this
   instead of the OpenCode-shaped `lv_verify_warn`. OpenCode's own warn script is
   unaffected — it has the independent `opencode.log` channel, so its FAIL still
   means FAIL.

All four scripts re-syntax-checked (`sh -n`) and re-run after this fix:
`opencode-warn.sh` still PASSes live; `claude-warn.sh`/`gemini-warn.sh` still
correctly exit 2 (AUTH-BLOCKED) before ever reaching the new verdict logic.
`codex-warn.sh` was syntax-checked but not re-run a second time (its throwaway
`npm install` step is the slow part and the verdict-logic change is identical to
the other two, already exercised live via `opencode-warn.sh`'s codepath and
auth-free via the `keel hook codex` check above).

`session/HUMAN-CHECKLIST.md`'s M4 section was worded to match: it tells a human
to run these scripts first, but explicitly warns that a FAIL or COULD-NOT-TEST
from the three exit-code hosts needs a manual look at the raw transcript before
being read as "keel's warn is broken" — it may be the unconfirmed host-echo gap,
not a keel defect.

---

## 4. Cursor warn-key casing fix

**Bug** (already identified by a prior wave, `session/EVIDENCE/wave3-warnsurface.md`
§"Cursor field-casing discrepancy", not fixed then): `packages/cli/src/commands/hook.ts`'s
`renderVerdict`, `case 'cursor'` under the non-blocked (`warn`/`allow`) branch, sent
`userMessage`/`agentMessage` (camelCase). A live fetch of `cursor.com/docs/agent/hooks`
during THIS lane (re-confirming the prior wave's finding, not trusting it blind)
returned:

```json
{
  "permission": "allow" | "deny" | "ask",
  "user_message": "<message shown in client>",
  "agent_message": "<message sent to agent>"
}
```

snake_case, confirmed. **Fix**: the warn-path branch now sends BOTH spellings
additively — `userMessage`, `agentMessage`, `user_message`, `agent_message` — all
carrying the same advisory text. Additive, not a swap, because this same file
carries its own precedent (hook.ts:440–449, the Codex `permissionDecision:'allow'`
rejection, external bug report #249) that an unrecognized/wrong field can make a
host mark a hook **failed** — which fails OPEN (the advisory swallowed entirely,
worse than the pre-fix state). No Cursor CLI is available in any environment tested
across this project so far to confirm empirically which spelling(s) a real Cursor
install accepts or ignores.

**Not changed**: the already-shipped, already-tested BLOCK path (`case 'cursor'`
under the `blocked` switch) has the identical camelCase-only bug. Left untouched
deliberately — `permission` alone still gates the actual block correctly even if
the message text doesn't render, so the security property holds either way; a blind
change to tested, previously-verified behavior with no live host to check against
was judged not worth the risk. Flagged as a manual follow-up (see
`session/HUMAN-CHECKLIST.md`, Cursor section) — resolve both paths together once
real Cursor access exists.

**Tests strengthened, not weakened**: `packages/cli/src/__tests__/hook-command.test.ts`,
the `cursor: ... userMessage and agentMessage ...` case now additionally asserts
`payload.user_message`/`payload.agent_message`. The existing camelCase assertions
were kept (still true — both spellings are sent), so this is a strict superset, not
a swap.

Full `npm run build` + package test run after the fix: see §6 below.

---

## 5. `docs/integrations.md` — the honesty ratchet

The "Native enforcement" table's single **Verified** column conflated two different
claims (block proven vs. warn proven) into one cell — "OpenCode: live" said nothing
about whether ITS warn path had ever been exercised headlessly, and in fact hadn't
been, anywhere, before this lane. Split into **Block Verified** / **Warn Verified**.
Every existing "live" block claim was preserved as-is (not re-litigated or
downgraded unilaterally); every warn cell was assigned based on what this lane
could actually show, with footnotes carrying the caveats that don't fit in a table
cell:

- **OpenCode**: Block live (unchanged) / Warn **live** (new, §2 above).
- **OpenClaw**: Block live¹ (unchanged, WITH the pre-existing
  openclaw#5943/wave3-warnsurface.md caveat restated inline, not just linked) / Warn
  docs (unchanged — `api.logger.warn` reaching the chat UI vs. only an
  operator/gateway log is still unconfirmed).
- **Claude Code**: Block live² (unchanged, WITH the auth-boundary + filename-mismatch
  footnote from §3) / Warn docs (script exists, AUTH-BLOCKED here).
- **Cline**: Block types (unchanged) / Warn docs, best-effort (unchanged) — WITH a
  footnote on the live-auth discovery (§7 below), explicitly not claimed as
  verification of anything.
- **Gemini CLI**: Block types (unchanged) / Warn docs (script exists, AUTH-BLOCKED here).
- **Cursor**: Block docs (unchanged, casing bug noted, NOT fixed on this path — §4) /
  Warn docs, upgraded schema fidelity (§4's fix).
- **Codex CLI**: Block docs (unchanged) / Warn docs (script exists, AUTH-BLOCKED here).
- **Hermes**: Block docs (unchanged) / Warn docs (unchanged — no CLI available).

I did **not** unilaterally downgrade OpenClaw's existing "live" block rating even
though its own basis (`openclaw plugins list` reporting the plugin loaded) is a
load-time check, not a per-call one, and a real GitHub issue
(openclaw/openclaw#5943) suggests the hook may not fire at all in some
builds — that finding predates this lane (wave3-warnsurface.md §2) and this lane
did not re-investigate it. The ratchet cuts both directions: restating an existing
overclaim's actual basis in the matrix itself (not just a linked evidence file) is
the honest middle ground between silently laundering it and unilaterally
downgrading another lane's verified claim without new evidence.

---

## 6. Verification — full, unpiped `npm test`

Ran after every source change (Cursor casing fix + its test), full output shown,
not filtered through grep/head/tail:

```
$ npm run build
[... all four workspace builds succeed, no errors ...]

$ npm test
> @get-keel/core@0.4.0 test
 Test Files  34 passed (34)
      Tests  597 passed | 2 skipped (599)

> @get-keel/cli@0.4.0 test
 Test Files  44 passed (44)
      Tests  811 passed | 14 skipped (825)

> @get-keel/mcp-server@0.4.0 test
 Test Files  1 passed (1)
      Tests  6 passed (6)

> @get-keel/opencode-plugin@0.4.0 test
[57/57 PASS lines]
All checks passed
```

Identical pass/skip counts to the pre-change baseline — the Cursor test change
added two new assertions inside an existing `it()` block (not a new test), so the
top-line count is unchanged by design; the file diff is the actual evidence of
what's new.

---

## 7. Findings outside the original scope, reported rather than acted on unilaterally

- **Cline's headless path is live RIGHT NOW in this environment**, contradicting a
  memory note ("cline provider 403 fleet-wide (OPERATOR: renew)", dated 2026-08-11 —
  one day before this lane): `cline --json -P cline "say hi"` authenticated and
  responded, incurring real cost (~$0.025, `sakana/fugu-ultra` via the `cline`
  provider). This is the "verify before defending"/"a fix that never ran" class of
  lesson in reverse — a stale memory claim, checked empirically rather than trusted,
  turned out to be wrong (or since resolved). No automated Cline harness was built
  this lane: doing it properly (benign probe, negative control, block test, warn
  test — same four-step shape as every other host script) means several MORE real,
  paid Cline calls, and this lane had no explicit budget authorization to spend
  beyond the one confirmation probe. Documented as the most promising next-lane
  target in `session/HUMAN-CHECKLIST.md`, not claimed as verified.
- **OpenClaw CLI (2026.4.15) is installed in this environment** — `keel install
  --openclaw` under an isolated `HOME` installs the three plugin files cleanly
  (confirmed). Wiring OpenClaw's own config (`plugins.load.paths`/`plugins.allow`,
  under an isolated `--profile`) to reproduce even the load-time `openclaw plugins
  list` check was not completed — OpenClaw's config format was not investigated far
  enough this lane. Documented, not attempted further.
- **Cursor and Hermes have no CLI in this or any prior lane's environment.** Wrote
  manual verification checklists for both in `session/HUMAN-CHECKLIST.md` (block AND
  warn steps) rather than fabricate a live result or leave the gap unstated.

---

## Files touched

- `packages/cli/src/commands/hook.ts` — Cursor warn-path casing fix (source, not
  generated; safe to hand-edit per the lane's own constraint).
- `packages/cli/src/__tests__/hook-command.test.ts` — strengthened cursor-warn assertion.
- `scripts/live-verify/lib/common.sh` — added `lv_verify_warn` / `lv_no_marker`.
- `scripts/live-verify/opencode-warn.sh` (new) — live-verified, PASS.
- `scripts/live-verify/claude-warn.sh` (new) — AUTH-BLOCKED here, correct honest exit.
- `scripts/live-verify/gemini-warn.sh` (new) — AUTH-BLOCKED here, correct honest exit.
- `scripts/live-verify/codex-warn.sh` (new) — AUTH-BLOCKED here, correct honest exit.
- `docs/integrations.md` — Block/Warn Verified split, footnotes 1–4.
- `session/HUMAN-CHECKLIST.md` — M4 section: supersedes old manual warn steps for
  claude/gemini with "just re-run the script", adds Cursor/Hermes/Cline/OpenClaw
  procedures.
- `session/transcripts/opencode-warn-no-verify-bypass.txt` (new) — the one genuinely
  live transcript this lane produced.
- Not touched: `packages/cli/src/core/**` (generated, mirrors `packages/core/src`),
  `templates/keel-enforce.js` (generated, mirrors `packages/opencode-plugin`), and
  the M2-B1 claim/verification-discharge matrix section of `docs/integrations.md`.
