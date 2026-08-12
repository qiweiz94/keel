# A2-IFS — close the `${IFS}` word-split bypass (AUDIT §4)

Branch `v1p2-a2-ifs`, repo `/Users/nanoclaw/code/keel-v1p2-a2-ifs`.
Baseline confirmed green before any change: `npm install && npm run build && npm test`
— core 603 passed/2 skipped, cli (which copies `packages/core/src` into
`packages/cli/src/core` and runs the same suite) 833 passed/14 skipped,
mcp-server 6 passed, opencode-plugin 63/63 checks passed. No genuine
failures anywhere in the full output (the `Keel blocked this action`/`keel:
failing closed` lines are the enforcement suite's own test fixtures
exercising deny paths, not test failures).

## The gap

`rm${IFS}-rf${IFS}/` (and unbraced `$IFS`) was **allowed** before this fix.
Under a real shell, `IFS` is the built-in variable controlling
word-splitting, so `${IFS}` expands to the field separator (default
space/tab/newline) and the command runs as `rm -rf /`. The A2 normalizer's
`expandVars` (`packages/core/src/enforce/command-normalizer.ts`) only
resolves variables from an inline `NAME=value` assignment it sees in the
same raw string — nothing in `rm${IFS}-rf${IFS}/` ever assigns `IFS`, so
the dict lookup missed and `${IFS}`/`$IFS` were left as literal
uninterpreted text on every surface, never becoming the substring `rm -rf
/` that `no-destructive-commands` hunts for. Disclosed as a known residual
in `SECURITY.md` (class 1) and `session/v1/AUDIT.md` §4, reconfirmed by
the M6 red-team round (`scripts/redteam/round2.mjs`, `kind:
'bypass-attempt'`, note "IFS word-split (DISCLOSED miss)").

## The fix

One seed value added to the bounded `expandVars` dict in
`packages/core/src/enforce/command-normalizer.ts`:

```ts
/**
 * Known-default seed for `expandVars`'s dict — NOT real env access (see
 * module doc §3). IFS is the one shell built-in whose value this module
 * needs to know without ever seeing a prior assignment: it governs
 * word-splitting itself, so `${IFS}`/`$IFS` is used purely to re-join a
 * command's own tokens (`rm${IFS}-rf${IFS}/`), not to read anything about
 * the agent's environment. A single space is the shell's own POSIX
 * default for IFS and is sufficient for this purpose.
 */
const BUILTIN_VAR_DEFAULTS: Record<string, string> = { IFS: ' ' }
```

...and, in `normalizeCommand`, the previously-empty per-call dict is
seeded from it:

```ts
const dict: Record<string, string> = { ...BUILTIN_VAR_DEFAULTS }
```

That is the entire code change. It is purely additive to the existing
"bounded literal dict" design documented in the module's own header
(section 3): `IFS` is just one more entry an in-command `NAME=value`
assignment can still override (e.g. an explicit `IFS=x; ...` in the
command string overwrites the seeded default exactly like any other
variable, via the existing `dict[name] = val` assignment logic) — no real
process-environment access was added, no new dependency, no change to the
tokenizer, the compound-splitter, or the interpreter-body recursion. The
module doc (section 3) and the "what stays open" list were both updated to
describe the seed and drop `${IFS}` from the residual list.

## Verification — `keel evaluate` through the real built CLI

All runs used a scratch `HOME`/`KEEL_STATE_DIR` under the session
scratchpad; real `~/.keel` was never touched.

```
$ HOME=$SCRATCH_HOME node packages/cli/bin/keel.js install
  ✓ Created ~/.keel/rules.yaml
  ✓ Ensured ~/.keel/traces/ exists

$ HOME=$SCRATCH_HOME KEEL_STATE_DIR=$SCRATCH_STATE node packages/cli/bin/keel.js \
    evaluate --tool bash --args '{"command":"rm${IFS}-rf${IFS}/"}' --level protect
{"action":"deny","rule_id":"no-destructive-commands","rule_name":"no-destructive-commands",
 "message":"Destructive commands (including fork bombs) are blocked.", ..., "tier":2}

$ HOME=$SCRATCH_HOME KEEL_STATE_DIR=$SCRATCH_STATE2 node packages/cli/bin/keel.js \
    evaluate --tool bash --args '{"command":"rm$IFS-rf$IFS/"}' --level protect
{"action":"deny","rule_id":"no-destructive-commands", ...}
```

Both the braced `${IFS}` and unbraced `$IFS` forms now **deny** via
`no-destructive-commands` at `--level protect`. The unbraced form works
for free — `VAR_RE` (`/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g`)
already matched both shapes; only the dict was missing the entry, so no
residual is left open on that axis.

**No new false positive** — a literal `${IFS}` inside a whitespace-bearing
quoted argument (real shell semantics: single/double-quoted data, not a
word-split site) is still preserved verbatim, not expanded, per the
existing quote-preservation rule (module doc section 1):

```
$ ... evaluate --tool bash --args '{"command":"echo \"the value of IFS is ${IFS}\""}' --level protect
{"action":"allow", ...}

$ ... evaluate --tool bash --args '{"command":"ls${IFS}-la"}' --level protect
{"action":"allow", ...}
```

## Tests

`packages/core/src/enforce/__tests__/shell-normalize-bypass.test.ts` — new
`describe('class 3 — IFS word-split (GENUINELY NEW catch, AUDIT §4)')`
block, 3 cases, run through the real `EnforcementPipeline` against the
shipped `DEFAULT_RULES_YAML` (same discipline as every other case in this
file, not a hand-written test-only rule):

1. `rm${IFS}-rf${IFS}/` denies via `no-destructive-commands` (braced).
2. `rm$IFS-rf$IFS/` denies via `no-destructive-commands` (unbraced).
3. `echo "the value of IFS is ${IFS}"` stays `allow` (must-not-fire /
   benign quoted-data check — a literal `${IFS}` in quoted data is not
   expanded).

Full `npm test` output shown (not piped through grep/head/tail):
core 606 passed/2 skipped (+3 tests vs the 603/2 baseline, exactly the 3
new cases — no other test count moved), cli 833 passed/14 skipped
(unchanged from baseline — confirmed by reading `packages/cli/vitest.config.ts`,
not inferred: it explicitly excludes `src/core/**` from discovery, because
the build step copies `packages/core/src` wholesale into `src/core` to
bundle into the CLI, and an unexcluded copy would silently re-collect and
re-run all of core's `__tests__` a second time, interleaved with the CLI's
own HOME/KEEL_STATE_DIR-mutating tests — a documented cross-file isolation
hazard the config comment itself explains), mcp-server 6 passed,
opencode-plugin 63/63 checks passed. Zero regressions.

## Red-team regression guard

`scripts/redteam/round2.mjs`'s `rm${IFS}-rf${IFS}/` probe was promoted
from `kind: 'bypass-attempt'` (a disclosed miss, informational only — its
outcome never affects the script's exit code) to `kind: 'control-catch'`
(a documented catch; if it ever stops denying, the script's exit code
flips to 1). A sibling `rm$IFS-rf$IFS/` (unbraced) `control-catch` probe
was added alongside it. The three still-open variants found during
adversarial self-check (`rm"${IFS}"-rf"${IFS}"/`, `rm'${IFS}'-rf'${IFS}'/`,
`rm${IFS:0:1}-rf${IFS:0:1}/`) were added too, but as `kind: 'bypass-attempt'`
— informational, non-blocking — since they are not yet closed and
promoting them would make the script fail on ground truth.

Ran `node scripts/redteam/round2.mjs > round2-output.log 2>&1; echo $?`
(never piped the verifying run through grep/head/tail — full transcript
below):

```
group                  kind             action   rule_id                        command
--------------------------------------------------------------------------------------------------------------------------------------------
...
destructive-commands   control-catch    deny     no-destructive-commands        rm -rf /
destructive-commands   control-catch    deny     no-destructive-commands        r"m" -rf /
destructive-commands   control-catch    deny     no-destructive-commands        rm${IFS}-rf${IFS}/
destructive-commands   control-catch    deny     no-destructive-commands        rm$IFS-rf$IFS/
destructive-commands   bypass-attempt   allow    -                              rm"${IFS}"-rf"${IFS}"/
destructive-commands   bypass-attempt   allow    -                              rm'${IFS}'-rf'${IFS}'/
destructive-commands   bypass-attempt   allow    -                              rm${IFS:0:1}-rf${IFS:0:1}/
...

--- FINDINGS ---

All documented control catches still deny (no floor regression).

Bypass attempts that were NOT caught (allow/warn/prompt):
   ...
   [allow] rm"${IFS}"-rf"${IFS}"/  — IFS word-split, DOUBLE-quoted — DISCLOSED residual: ...
   [allow] rm'${IFS}'-rf'${IFS}'/  — IFS word-split, SINGLE-quoted — DISCLOSED residual, same cause ...
   [allow] rm${IFS:0:1}-rf${IFS:0:1}/  — IFS with a parameter-expansion modifier — DISCLOSED residual: ...

REAL EXIT CODE: 0
```

Exits 0. The two closed variants (`${IFS}`, `$IFS`) now sit alongside
`rm -rf /` and `r"m" -rf /` as permanent regression guards; the three open
variants are recorded as visible, honest, non-blocking findings rather
than silently absent from the corpus.

## Residual — honest accounting (corrected after adversarial self-check)

The bare-word forms (`${IFS}`, `$IFS`, unquoted, no modifier) close cleanly
through the existing `VAR_RE`/`expandVars` machinery with a single
dict-seed entry. **Two narrower `${IFS}` shapes were probed and remain
open — measured, not assumed:**

1. **Quote-wrapped:** `rm"${IFS}"-rf"${IFS}"/` and
   `rm'${IFS}'-rf'${IFS}'/` — both **allow**. Cause: `renderToken`'s
   whitespace-free-quoted branch (`else if (seg.quoted)`, used for pure
   obfuscation like `r"m"`) strips the quotes but never calls
   `expandVars` — only the unquoted branch does. A real shell *does*
   expand `"$IFS"` (double quotes) though not `'$IFS'` (single quotes), so
   the double-quoted variant is a live evasion of the same class this fix
   closes for the unquoted form. Closing it would mean expanding inside
   double-quoted whitespace-free segments specifically — a real design
   change to the quote-handling branch, not a dict seed, with its own
   false-positive surface to verify. Out of scope for this "minimal,
   bounded" brief; left open deliberately.
2. **Parameter-expansion modifier:** `rm${IFS:0:1}-rf${IFS:0:1}/` —
   **allows**. Cause: `VAR_RE`
   (`/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g`)
   requires `}` immediately after the bare variable name, so `${IFS:0:1}`,
   `${IFS%x}`, `${IFS:-x}` never match the regex at all and are never
   looked up — same limitation applies to every other variable this module
   expands (`${T:0:1}` wouldn't resolve either), not IFS-specific.

Both verified via the same scratch-`HOME` `keel evaluate --level protect`
method as above (all three return `{"action":"allow", ...}`), and both
added as new `kind: 'bypass-attempt'` (informational, non-blocking) probes
in `scripts/redteam/round2.mjs` for future visibility — not promoted to
`control-catch` since they are not yet closed. `SECURITY.md` (both the
class-1 residual note and the M6-audit finding line) and
`session/v1/AUDIT.md` §4 were corrected to say "PARTIALLY RESOLVED" with
this exact breakdown, replacing an earlier draft of this evidence file and
those docs that incorrectly claimed the residual was fully closed — caught
by an adversarial self-check before commit, not by a test failure.

The module's other pre-existing, unrelated residuals (command substitution
`$(...)`/backticks, arithmetic expansion, subshell grouping,
backslash-heavy multi-layer nesting beyond the tokenizer's single pass,
non-shell obfuscation like base64/hex) are unchanged by this lane.

## Docs updated (repo's own convention for closing a disclosed audit
## finding — see the `bash -lc` precedent in this same lane)

- `packages/core/src/enforce/command-normalizer.ts` — module doc §3 and the
  `BUILTIN_VAR_DEFAULTS` seed comment.
- `SECURITY.md` — class-1 residual note (narrowed from "`${IFS}` open" to
  "bare-word closed, quote-wrapped + modifier forms still open") and the
  M6-audit finding line, both marked "FOUND then PARTIALLY FIXED" with the
  exact breakdown, matching the existing `bash -lc` FOUND-then-FIXED
  annotation style already used elsewhere in this file.
- `session/v1/AUDIT.md` §4 — `⚠️ PARTIALLY RESOLVED (post-audit fix,
  A2-IFS lane)` blockquote added above the original finding text, which is
  preserved unchanged below it as the historical record (same pattern as
  §1's `bash -lc` resolution, adapted to an honest partial-closure verdict
  rather than a full one).

## Files touched

- `packages/core/src/enforce/command-normalizer.ts` (source; rebuilt via
  `npm run build` — `packages/cli/src/core/**` and
  `packages/cli/templates/keel-enforce.js` regenerated, never hand-edited)
- `packages/core/src/enforce/__tests__/shell-normalize-bypass.test.ts`
- `scripts/redteam/round2.mjs`
- `SECURITY.md`
- `session/v1/AUDIT.md`
- `session/v1/EVIDENCE/a2-ifs.md` (this file)

`DEFAULT_RULES_YAML` was not touched — this lane did not need a new or
changed rule, only closing a normalizer gap in front of the existing
`no-destructive-commands` rule, so `drift.test.ts`'s two-file guard was
never implicated.
