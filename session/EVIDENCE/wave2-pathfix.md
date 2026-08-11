# Wave-2 pathfix lane — glob-matching repair

Worktree: `/Users/nanoclaw/code/keel-w2-pathfix`, branch `w2-pathfix`.
Node: `v26.0.0` (>= 22.12 required). `npm ci` completed clean (1 pre-existing
high-severity npm audit advisory, unrelated to this lane, not touched).

## 1. Reproducing the bug first (before touching any source)

Read `packages/core/src/enforce/pipeline.ts`'s private `pathMatches` (lines
841-855 pre-fix), called from the filesystem-rule branch at lines 375-386
(`rule.paths.some(p => ... this.pathMatches(resolvedPath, p))` /
`rule.exclude.some(p => this.pathMatches(resolvedPath, p))`).

Extracted the exact function body into a throwaway script
(`/tmp/test-pathmatches.mjs`) and ran it directly against the shipped
patterns before writing any test, to pin down the exact mechanism:

```
$ node /tmp/test-pathmatches.mjs
**/.env* vs /repo/.env.local => {"regex":"^.*/\\.env*$","result":false}
**/.env* vs /repo/.env.txt => {"regex":"^.*/\\.env*$","result":false}
**/.env* vs /repo/env.txt => {"regex":"^.*/\\.env*$","result":false}
**/id_rsa* vs /repo/id_rsa.pub => {"regex":"^.*/id_rsa*$","result":false}
**/id_rsa* vs /repo/id_rsa => {"regex":"^.*/id_rsa*$","result":true}
**/*.pem vs /repo/foo.pem => {"regex":"^.*/*\\.pem$","result":true}
**/*.pem vs /repo/foo.pemx => {"regex":"^.*/*\\.pem$","result":false}
**/*.log vs /repo/src/deep/x.log => {"regex":"^.*/*\\.log$","result":true}
**/*.log vs /repo/src/x.ts => {"regex":"^.*/*\\.log$","result":false}
```

This confirms the reported symptoms (`.env.local` and `id_rsa.pub` fail to
match) and also shows *why* `**/*.pem` and `**/*.log` happened to keep
"working" in the existing test suite — coincidentally, not correctly (§2).

## 2. The exact semantic bug

`pathMatches`'s `**`-branch built its regex in two passes:

```js
part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*')
```

Pass 1 escapes regex-special characters — but its character class
`[.+?^${}()|[\]\\]` **does not include `*`**. Pass 2 then looks for a
literal `\*` (escaped-star) sequence to turn into `[^/]*` — but since pass 1
never escapes `*`, no `\*` sequence is ever produced for a normal glob
pattern, so pass 2 never fires for any real input.

The bare `*` glob wildcard therefore survives into the final regex as a
**raw, unescaped regex quantifier** applied to whatever character precedes
it — not as "match any run of non-`/` characters here". Concretely:

- `**/.env*` compiled to `^.*/\.env*$`. The trailing `*` quantifies the "v"
  in "env" (zero-or-more "v"), not "anything after .env". `.env.local`
  needs literal end-of-string right after "en"+optional "v"s — no match.
- `**/id_rsa*` compiled to `^.*/id_rsa*$`. The `*` quantifies the "a" in
  "rsa" (zero-or-more "a"). `id_rsa` matches (one "a" satisfies `a*`) but
  `id_rsa.pub` does not (there's a literal `.pub` after where the regex
  demands end-of-string).
- `**/*.pem` compiled to `^.*/*\.pem$` — here the bare `*` immediately
  follows the literal `/`, so it quantifies the `/` (zero-or-more slashes)
  instead of "any filename chars". This one happens to still match `.pem`
  suffixes correctly only because the preceding `.*` (from the `**` split)
  already greedily absorbs everything up to the last `/`; it isn't correct
  glob semantics, it's a coincidence of where the misplaced `*` landed.
  `**/*.log` behaves identically, which is why the pre-existing test
  "matches multi-segment globs with `**`" (`pipeline.test.ts:401`) passed
  despite the underlying regex being wrong.

## 3. Sweep of every shipped filesystem-rule glob

Read `DEFAULT_RULES_YAML` in `packages/cli/src/commands/install.ts`
(read-only, not modified) end to end. Exactly two `type: filesystem` rules
exist:

- `no-rules-tampering` (line 58): `**/.keel/rules.yaml`,
  `**/.keel.local.yaml`, `**/.config/keel/rules.yaml`, `**/.keel/DISABLED`,
  `**/.opencode/plugins/**`, `**/.keel/plugins/**`. **None of these contain
  a bare `*`** (only `**`), so none hit this bug. Verified by hand-tracing
  the split/regex for each and confirming no change in behavior before vs.
  after the fix.
- `no-secret-files` (line 192): `**/.env*`, `**/.npmrc`,
  `**/.git-credentials`, `**/.netrc`, `**/.pgpass`, `**/*.pem`, `**/*.pfx`,
  `**/*.p12`, `**/.ssh/**`, `**/id_rsa*`, `**/id_ed25519*`, with
  `exclude: **/.env.example`, `**/.env.sample`, `**/.env.test`. **Every
  glob with a bare `*`** (`.env*`, `*.pem`, `*.pfx`, `*.p12`, `id_rsa*`,
  `id_ed25519*`) is affected by this bug to some degree (silently broken
  for `.env*`/`id_rsa*`/`id_ed25519*`; only accidentally-correct for
  `*.pem`/`*.pfx`/`*.p12`). This is the only rule that needed sweeping.

Also checked: `no-exfil-flow` (`type: flow`, line 236) uses `sources:` with
the same-looking globs (`**/.env*`, `**/.ssh/**`, `**/*.pem`,
`**/.git-credentials`), but flow-type rules are matched by a **separate,
independent** `pathMatches` implementation in `flow-tracker.ts` (line 168),
not the one in `pipeline.ts`. That implementation converts every `*`
directly to `.*` in a single pass (`pattern.replace(/[.+^${}()|[\]\\]/g,
'\\$&').replace(/\*/g, '.*')`) — a much looser (segment-crossing) glob, but
it does not have this two-pass escape-ordering bug, and it was not reported
broken. Out of scope per the task brief ("the private pathMatches function
in pipeline.ts, used by every filesystem-type rule"); left untouched.

### 3.1 Same-bug-class sweep beyond DEFAULT_RULES_YAML

Grepped the whole repo (excluding the generated `packages/cli/src/core/`
mirror and `packages/cli/templates/keel-enforce.js`) for every other
path/glob-matching surface, not just the word "glob":

- `packages/opencode-plugin/src/plugin.ts` — does **not** define its own
  `pathMatches`. It imports `EnforcementPipeline` straight from
  `../../core/src/keel-core.js` (confirmed by reading the top of the file),
  so this lane's fix reaches the plugin automatically through
  `npm run build` (verified §6/§7 — `dist/index.js` and
  `packages/cli/templates/keel-enforce.js` both regenerated and contain the
  fixed regex construction). No separate instance to fix.
- `packages/core/src/policy-engine.ts` (the legacy `ToolCallEvent`-based
  engine, line 508, `globToRegexBody`) has its **own** independent glob
  compiler. Read it end to end: it already uses the correct single-pass
  shape —
  `pattern.replace(/\*\*|\*|\?|[.+^${}()|[\]\\]/g, token => ...)` — and its
  own doc comment (lines 499-506) describes fixing the *same class* of bug
  previously ("escaped `.` LAST, after doublestar had already been
  expanded... a rule such as `config/**/secrets.yaml` protected none of the
  files the author believed it covered"). This corroborates that the fix
  applied here (§2) matches the codebase's own established pattern for
  correct glob compilation, and confirms policy-engine.ts needs no change.
- `packages/core/src/enforce/flow-tracker.ts` (line 168) — covered in §3
  above (different, already-working idiom; not this bug; out of scope).
- `packages/core/src/enforce/verification.ts` and `sequencer.ts` — grepped
  for `glob`/`pathMatches`: zero hits. `trigger.pattern` /
  `trigger.paths` (used by `source-change-requires-test`) are matched as
  plain regex via `matchesRulePattern`, not globs — confirmed by reading
  `DEFAULT_RULES_YAML`'s `pattern: "(src/|package[.]json)"` field, which is
  regex syntax, not glob syntax. No glob compiler there.

No other broken instance found. The bug was isolated to
`pipeline.ts`'s `pathMatches`.

**`?` wildcard decision:** no shipped rule in `DEFAULT_RULES_YAML` (either
copy — see below) uses `?`. `pathMatches`'s escape class included `?`
before this fix and still does after it, so `?` is treated as a literal
character, not a single-char wildcard — unchanged behavior, a deliberate
minimal-diff choice. (For comparison, `policy-engine.ts`'s independent
compiler does map `?` to `[^/]` — the two engines are not required to
agree, and nothing in this repo depends on `?` wildcard semantics in
`pathMatches`.)

**Two-copy check (install.ts vs. plugin.ts):** `DEFAULT_RULES_YAML` is
shipped in two places — `packages/cli/src/commands/install.ts` (installs
`~/.keel/rules.yaml`) and `packages/opencode-plugin/src/plugin.ts`
(in-session enforcement default). `packages/cli/src/__tests__/drift.test.ts`
guards these two staying in sync, but only compares each rule's `id`,
`match`, and `action` fields (`ruleTable()`, drift.test.ts:41-43) —
filesystem-type rules have no `match` field, so `paths`/`exclude` drift
between the two copies is **not** covered by that test. Wrote a one-off
script (`parseRulesContent` on both files, diffing `paths`/`exclude` per
filesystem-type rule id) to check directly rather than assume:

```
$ node /tmp/compare-fs-rules.mjs
no-rules-tampering MATCH {"installPaths":[...6 entries...],"pluginPaths":[...same 6...]}
no-secret-files MATCH {"installPaths":[...11 entries...],"pluginPaths":[...same 11...],
  "installExclude":["**/.env.example","**/.env.sample","**/.env.test"],
  "pluginExclude":["**/.env.example","**/.env.sample","**/.env.test"]}
```

Both filesystem rules are byte-for-byte identical between the two copies
today — the fix and the fixture additions apply equally to both. Flagging
the `drift.test.ts` gap (paths/exclude unguarded) for the supervisor as an
assign, not fixing it here — it is a rule-copy-sync invariant, not this
lane's glob-matching bug, and matches the precedent Wave-1 lane-1 set for
flagging same-class-but-out-of-scope surfaces rather than absorbing them.

## 4. Before/after matching table (every shipped bare-`*` glob)

All paths below tested through the real `EnforcementPipeline.evaluate()`
(public surface — `pathMatches` is private), not the extracted-function
throwaway. "Before" column reproduced via the throwaway script in §1 (same
regex construction as the pre-fix source); "after" column is the actual
fixed pipeline, exercised by
`packages/core/src/enforce/__tests__/glob-matching.test.ts` (§5) and
`tests/rules/no-secret-files/{must-block,must-allow}.yaml` (§6).

| Pattern | Path | Before | After | Correct? |
|---|---|---|---|---|
| `**/.env*` | `.env.local` | no match | match | yes — real credential file |
| `**/.env*` | `.env.production` | no match | match | yes — real credential file |
| `**/.env*` | `.env.txt` | no match | match | yes — starts with `.env` |
| `**/.env*` | `env.txt` (no dot) | no match | no match | yes — correctly never matched |
| `**/.env*` | `.env.example` (excluded) | matches base glob, carved out by `exclude` | same | yes — exclude list still works |
| `**/id_rsa*` | `id_rsa.pub` | no match | match | yes — real public-key file |
| `**/id_rsa*` | `id_rsa` | match (coincidence) | match | yes |
| `**/id_rsa*` | `id_rsa_backup` | no match | match | yes |
| `**/id_ed25519*` | `id_ed25519.pub` | no match | match | yes |
| `**/*.pem` | `foo.pem` | match (coincidence) | match | yes |
| `**/*.pem` | `foo.pemx` | no match | no match | yes — extension must match exactly |
| `**/*.pem` | `nested/dir/foo.pem` | match (coincidence) | match | yes |
| `**/*.pfx` | `cert.pfx` | match (coincidence) | match | yes |
| `**/*.p12` | `cert.p12` | match (coincidence) | match | yes |
| `**/*.log` (test-only, not shipped) | `src/deep/x.log` | match (coincidence) | match | yes |
| `**/.ssh/**` | `.ssh/id_rsa`, nested `.ssh/known_hosts` | match (no bare `*`, unaffected) | match | yes |
| `**/.keel/rules.yaml` etc. (no-rules-tampering, no bare `*`) | — | unaffected by bug | unaffected | yes |

"Correct?" also covers a check the old code could never pass even by
accident: a literal `.` in a pattern must mean a literal dot, not "any
character". Verified `Xenv.local` does NOT match `**/.env*` before or after
(the escape class always included `.`) — this stayed correct throughout and
is asserted in the new test suite as a non-regression guard on the fix
itself (the new single-pass escape logic still escapes `.` correctly).

## 5. Failing-tests-first: `packages/core/src/enforce/__tests__/glob-matching.test.ts`

Ran against the pre-fix pipeline.ts to prove these were genuinely red:

```
$ npx vitest run packages/core/src/enforce/__tests__/glob-matching.test.ts
 ❯ ... (13 tests | 4 failed) 25ms
     × matches .env.local against **/.env*
     × matches .env.production against **/.env*
     × matches id_rsa.pub against **/id_rsa*
     × matches id_ed25519.pub against **/id_ed25519*
 Tests  4 failed | 9 passed (13)
```

The 9 that already passed pre-fix are exactly the "coincidentally correct"
cases from §2/§4 (`.pem`, `.pfx`, `.p12`, must-NOT-match cases, and
previously-shipped `**/*.log` / `**/.ssh/**` behavior) — proving the test
file isolates the actual defect rather than testing something already
fine.

After the fix (`packages/core/src/enforce/pipeline.ts`, single-pass
escape+substitute — see diff in §7):

```
$ npx vitest run packages/core/src/enforce/__tests__/glob-matching.test.ts packages/core/src/enforce/__tests__/pipeline.test.ts
 Test Files  2 passed (2)
      Tests  57 passed (57)
```

All 13 new tests pass, and all 44 pre-existing `pipeline.test.ts` tests
(including the `**`-glob and exclude tests already in that file) still
pass — no regression on the legacy prefix/`.includes()` matching path for
patterns without `**` (untouched, out of scope: no default rule combines a
bare `*` with a `**`-free pattern except the `paths: ["*"]` /
`exclude: ["/tmp/*"]` test fixtures in `pipeline.test.ts`, both of which
still pass).

## 6. Fixture sweep: `tests/rules/no-secret-files/{must-block,must-allow}.yaml` and `tests/rules/no-rules-tampering/must-block.yaml`

`no-secret-files` must-block: added `.env.local`, `.env.production`,
`id_rsa.pub`, `id_ed25519.pub`, a nested `certs/nested/server.pem`,
`client.pfx`, `client.p12`, a write into `.ssh/config`, and — closing the
"every shipped filesystem rule" ask completely, not just the paths this
bug touched — `.npmrc`, `.git-credentials`, `.netrc`, `.pgpass` (these four
have no bare `*` in their glob and are unaffected by the bug, but had zero
fixture coverage before this lane).

`no-secret-files` must-allow: added `.env.sample` and `.env.test` (both
were already in the rule's `exclude` list in `DEFAULT_RULES_YAML` but had
no fixture coverage before this lane — only `.env.example` did), plus two
must-NOT-overmatch cases: `env.txt` (no leading dot) and `foo.pemx`
(extension must match exactly, not as a prefix).

`no-rules-tampering` must-block: added `.keel.local.yaml` and a file two
segments below `.opencode/plugins/` (`nested/dir/x.js`) — this rule's globs
have no bare `*` and are unaffected by the bug (§3.1), but had no fixture
proving the `**`-crosses-segments join logic still works after this
lane's rewrite of the same code path, and the "every shipped filesystem
rule" instruction covers it.

Ran the fixture harness (`packages/cli/src/__tests__/fixture-harness.test.ts`,
which loads `DEFAULT_RULES_YAML` straight from `install.ts` and runs every
`tests/rules/*/must-{block,allow}.yaml` case through the real pipeline) —
required `npm run build` first per the binding constraint (core must be
built before `@get-keel/core` resolves for the cli workspace):

```
$ npm run build
  dist/keel-core.mjs  98.9kb
  ⚡ Done in 5ms
  dist/index.js  296.9kb
  ⚡ Done in 10ms

$ npx vitest run packages/cli/src/__tests__/fixture-harness.test.ts
 Test Files  1 passed (1)
      Tests  71 passed (71)
```

(Wave-1's fixture harness landed at 53 cases across 22 rules. This lane
added 18 total: 12 no-secret-files cases — 8 must-block
[`.env.local`, `.env.production`, `id_rsa.pub`, `id_ed25519.pub`,
nested `.pem`, `.pfx`, `.p12`, `.ssh/config`] + 4 must-allow
[`.env.sample`, `.env.test`, `env.txt`, `foo.pemx`] — plus 4 more
no-secret-files must-block cases [`.npmrc`, `.git-credentials`, `.netrc`,
`.pgpass`] and 2 no-rules-tampering must-block cases
[`.keel.local.yaml`, nested `.opencode/plugins/`]. 53 + 18 = 71.)

## 7. Files changed

- `packages/core/src/enforce/pipeline.ts` — `pathMatches`'s `**`-branch
  regex construction: replaced the two-pass "escape everything, then try
  to convert an already-escaped `\*`" (which never fired for `*`) with a
  single pass that converts a literal `*` directly to `[^/]*` and
  backslash-escapes every other regex-special character. The legacy
  prefix/`.includes()` branch for patterns without `**` is untouched.
- `packages/core/src/enforce/__tests__/glob-matching.test.ts` — new file,
  13 tests: 4 reproduce the reported bug exactly (`.env.local`,
  `.env.production`, `id_rsa.pub`, `id_ed25519.pub`), plus must-NOT-match
  cases (`env.txt`, `foo.pemx`, `*` not crossing a `/` segment boundary,
  `.` not matching "any character"), the `exclude` list still carving out
  `.env.example`/`.env.sample`/`.env.test`, and two non-regression guards
  on previously-passing `**/*.log` and `**/.ssh/**` behavior.
- `tests/rules/no-secret-files/must-block.yaml` — 12 new cases (listed §6).
- `tests/rules/no-secret-files/must-allow.yaml` — 4 new cases (listed §6).
- `tests/rules/no-rules-tampering/must-block.yaml` — 2 new cases (listed §6).
- `packages/cli/src/core/` and `packages/cli/templates/keel-enforce.js` —
  regenerated by `npm run build` (per binding constraint, never hand-edited).
- `DEFAULT_RULES_YAML` in `install.ts` / `install.ts` itself — read-only,
  not modified, per binding constraint.
- Not modified, checked read-only: `packages/opencode-plugin/src/plugin.ts`
  (its `DEFAULT_RULES_YAML` copy verified identical to install.ts's for
  both filesystem rules — §3.1), `packages/core/src/policy-engine.ts`
  (already-correct independent glob compiler — §3.1),
  `packages/cli/src/__tests__/drift.test.ts` (gap flagged, not fixed —
  §3.1).

## 8. Full suite results (unfiltered `vitest run`, no grep/head/tail filtering the runs themselves)

Core (`packages/core`):

```
$ npx vitest run
 Test Files  16 passed (16)
      Tests  262 passed (262)
```

CLI (`packages/cli`), after the fixture additions in §6:

```
$ npx vitest run
 Test Files  1 failed | 45 passed (46)
      Tests  4 failed | 647 passed (651)
```

The 1 failing file is `src/__tests__/level.test.ts`, all 4 failures are
ANSI/`FORCE_COLOR`-environment string-match failures on `keel level` /
`keel status` stdout (e.g. expecting the plain-text substring
`'project level: balanced → protect'` but receiving the same content
wrapped in ANSI SGR escape codes) — the pre-existing, known, not-mine
failures called out in the task brief. Confirmed none of the 4 failures
mention `no-secret-files`, `no-rules-tampering`, `pathMatches`, or
`glob-matching` (`grep -c` over the captured output: 0 matches). No other
test file failed.

## 9. Open item for the supervisor (not fixed in this lane — out of scope)

`packages/cli/src/__tests__/drift.test.ts`'s `install.ts` vs. `plugin.ts`
sync guard does not compare `paths`/`exclude` on filesystem-type rules
(only `id`/`match`/`action` — see §3.1). Both filesystem rules are
verified identical today between the two copies, but nothing stops them
drifting apart in a future edit to just one file. Assign to whichever lane
owns rule-copy-sync / drift-test hardening.
