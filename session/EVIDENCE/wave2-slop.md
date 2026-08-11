# Wave 2 / Lane 2 — slopsquatting install gate

Worktree: `/Users/nanoclaw/code/keel-w2-slop`, branch `w2-slop`.

## 0. Environment

```
$ node --version
v26.0.0
$ git branch --show-current
w2-slop
$ npm ci
added 169 packages, and audited 174 packages in 1s
```

## 1. Module design

New module: `packages/core/src/enforce/package-verifier.ts`. Two-stage,
matching the pipeline's lazy-evaluation requirement:

1. **`extractPackageInstalls(command)`** — pure, synchronous, regex/
   tokenizer only. A `QUICK_PREFILTER` regex (`/\b(npm|pnpm|yarn|bun)\b/`)
   rejects the vast majority of commands before any tokenizing happens —
   this is what makes "only commands matching an install pattern pay any
   cost" literally true, not just true in the common case.
2. **`checkPackages` / `decidePackageAction`** — the network-touching half,
   called by the pipeline only when step 1 found at least one candidate.
   `checkPackages` shares ONE total time budget (2000ms, hardcoded in the
   pipeline call, not rule-configurable) across every package in a
   compound command; `decidePackageAction` is a pure function over the
   resulting `PackageCheckResult[]`, independently testable with no I/O.

Wired into the pipeline as `type: package`:
- `packages/core/src/types.ts` — added `'package'` to `RuleType`, an
  `age_days?: number` field, and `'supply-chain'` to `RuleCategory` (the
  task's required catalog category did not exist in the current enum).
- `packages/core/src/enforce/rule-parser.ts` — added `'package'` to
  `validTypes` and `'supply-chain'` to `validCategories`; added an
  `age_days` range check (must be a non-negative finite number if
  present). No `match`/`paths`/etc. required — detection is automatic.
- `packages/core/src/enforce/pipeline.ts` — new dispatch block in the
  Tier 2/3 rule loop (same tier as `network`), threaded exactly like the
  existing `network`/`stuck`/`diagnosis` blocks: `evaluate()` was already
  `async`, so the network call is a plain `await` inside the existing
  `for (const rule of rules)` loop.
- `packages/core/src/enforce/index.ts` — exported the new module's public
  surface (`PackageVerifierCache`, `extractPackageInstalls`,
  `checkPackages`, `decidePackageAction`, `evaluateInstallCommand`,
  `defaultRegistryBaseUrl`, `CACHE_TTL_MS`, and the associated types).

## 2. Extraction coverage

`extractPackageInstalls` covers, per `packages/core/src/enforce/__tests__/
package-verifier.test.ts`'s `extractPackageInstalls` suite (13 tests):

| Form | Handling |
|---|---|
| `npm install <pkg>`, `npm i <pkg>` | extracted |
| `pnpm add <pkg>`, `yarn add <pkg>`, `bun add <pkg>` | extracted |
| `<pkg>@1.2.3` (versioned) | name + version split |
| `@scope/pkg`, `@scope/pkg@1.2.3` (scoped) | name + version split on the SECOND `@` |
| multiple packages in one call | each extracted, order preserved |
| flags anywhere (`-g`, `--save-dev`, ...) | ignored |
| `./local`, `../local`, `/abs`, `~/x` | ignored (local path) |
| `file:...` | ignored |
| `git+...`, `git:...`, `github:...` | ignored |
| bare `user/repo` (GitHub shorthand) | ignored |
| `https://.../pkg.tgz`, `*.tar.gz`, `*.tar` | ignored |
| `pkg@workspace:*`, `link:`, `file:` as a version | ignored |
| bare `npm install`, `npm ci`, `pnpm install`, `yarn`, `yarn install` | nothing extracted (reads from lockfile/package.json) |
| `cd x && npm install y`, `; `, `\|\|` | compound commands split, install found |
| `sudo npm install x`, `CI=true npm install x` | prefix stripped, still extracted |
| `git commit -m "add lodash"`, `ls -la`, `""` | nothing (quick prefilter) |

**Documented false-negative, not fixed**: `bash -c "npm install evil-pkg"`
— the tokenizer treats the quoted string as one opaque token; a real shell
parse would be needed to unwrap it. Asserted explicitly in the test suite
(`known false-negative, documented`) so a future accidental fix is noticed
as a change, not silently assumed.

## 3. Semantics table (binding, from the lane brief's amendment)

| Registry verdict | `decidePackageAction` reason | Pipeline action | Configurable? |
|---|---|---|---|
| Package doesn't exist (unscoped 404) | `not_found` | forced `deny`, `skipFirstWarning=true` (blocks on the FIRST hit, not warn-then-block) | no — deterministic, unfulfillable regardless of intent |
| Timeout / network error / response too large / budget exhausted | `unverified` | forced `prompt`, message contains the literal substring `unverified — registry unreachable` | no — never deny on a network failure |
| Scoped name (`@scope/pkg`) 404s | `unverified`, reason `scoped_not_public` | forced `prompt`, distinct wording ("likely a private/org-scoped package") | no — a public 404 is not proof a private-registry package doesn't exist |
| Exists, published < `age_days` ago (default 30) | `age_gate` | the rule's own declared `action` (default `prompt` in the shipped proposal) | **yes** — this is the configurable axis |
| Exists, older than `age_days`, or `time.created` absent from the registry doc | `ok` | `allow` | — |

Priority across a multi-package command: `not_found` > `unverified` >
`age_gate` > `ok` — a single hallucinated name in a batch install denies
the whole command regardless of what else is in it.

**Fails-open edge case, worth stating explicitly**: if a registry response
omits `time.created` (malformed doc, or a registry that doesn't populate
it), `checkPackageExistence` returns `verdict: 'exists'` with `ageDays`
undefined — the age gate cannot fire without an age, so this silently
allows. Safe direction (never a wrong deny), documented in
`package-verifier.ts`'s `checkPackageExistence` inline comment.

## 4. Caching

Disk-backed, `KEEL_STATE_DIR`-respecting (read at CALL time via a function,
not a module-level constant captured at import — the same class of bug
already found and fixed in Wave 1 for `state-manager.ts`'s `STATE_DIR`,
avoided here from the start), atomic tmp+rename writes matching
`state-manager.ts`'s pattern. `PackageVerifierCache` at
`KEEL_STATE_DIR/package-verifier.json`.

**Deliberate deviation from a flat 24h TTL** (documented in
`package-verifier.ts`'s `CACHE_TTL_MS` comment, flagged here for the
gate): `exists` caches 24h (matches the brief), but `not_found` caches
only 1h and `unverified` only 5min. A flat 24h `not_found` cache would
freeze the pre-registration state — a name that didn't exist at 9am but
was legitimately published at 10am would still read as denied at 5pm. A
flat 24h `unverified` cache would turn one network blip into a day of
unnecessary prompts for an otherwise-legitimate install (MEMORY.md's
"Controls that lie" pattern — a cached failure state that outlives the
failure). Both shorter TTLs still fully satisfy "repeat installs don't
re-query" for the actual threat case (a hallucinated name retried in a
loop).

## 5. The byte cap, and an empirical correction made while building it

`checkPackages` streams the registry response with a byte cap (overflow →
`unverified`/`too_large`, never a hang or a wrong deny) because full
packuments for popular packages are known to be multi-MB (embedded
per-version readmes). Measured directly against the real registry while
building this:

```
$ curl -s -o /dev/null -w "%{size_download} bytes, %{time_total}s\n" https://registry.npmjs.org/lodash
247652 bytes, 0.079s
$ curl -s -o /dev/null -w "%{size_download} bytes, %{time_total}s\n" https://registry.npmjs.org/express
804956 bytes, 0.137s
$ curl -s -o /dev/null -w "%{size_download} bytes, %{time_total}s\n" https://registry.npmjs.org/react
6878486 bytes, 0.334s
```

The initial cap (2MB) would have made a real `npm install react` — about
as mainstream a package as exists — prompt every single time on size
alone, purely because react's packument happens to be an outlier. Caught
via the opt-in live test (below) before shipping, not after: raised the
cap to 10MB, which covers react with headroom while the outer 2000ms
`AbortController` timeout (not the byte cap) remains the actual defense
against a slow or pathological connection. Re-verified after the change:

```
$ node -e "... checkPackages([{name:'react',...}], {registryBaseUrl: real, totalTimeoutMs: 2000}) ..."
elapsed ms: 301
{ "name": "react", "verdict": "exists", "ageDays": 5402.65..., "createdAt": "2011-10-26T17:46:21.942Z" }
```

## 6. Test results

### `packages/core` — `package-verifier.test.ts` (45 tests: 43 pass, 2 opt-in skipped by default)

```
$ npx vitest run src/enforce/__tests__/package-verifier.test.ts
 Test Files  1 passed (1)
      Tests  43 passed | 2 skipped (45)
```

Covers, per the lane brief's explicit list: nonexistent → deny;
10-day-old → prompt; 5-year-old → allow; timeout → prompt with the
unreachable message; cache hit skips the mock entirely (asserted with an
"angry mock" that throws if ever called — a broken cache wire-up fails
loud, not quiet); private-scope 404 → prompt not deny, and a matching
unscoped-404 → real deny (both directions of the private-registry
decision, not just the safe one); tiered cache TTL expiry with an
injectable clock; `KEEL_STATE_DIR` respected when constructed with no
explicit dir; shared multi-package timeout budget; full pipeline wiring
(deny with no warn-first grace period, prompt on timeout, prompt on
age-gate, allow on an old package, laziness — mock never called for a
non-install command, private-scope never hard-denies through the real
pipeline, `age_days` rule override honored); `defaultRegistryBaseUrl()`'s
three branches (explicit override, VITEST safety net, would-be production
fallback).

**A real bug was caught by this suite, not shipped**:
`PackageVerifierCache.set()`'s opportunistic prune originally called
`Date.now()` directly instead of accepting the caller's injectable clock —
harmless in production (real time always advances forward), but it broke
the TTL-tiering test immediately (a fake `now` far in the past made every
entry look infinitely old to the hardcoded prune, deleting it right after
insertion). Fixed by threading `now` through `set()` the same way `get()`
already had it; `checkPackages` now passes its own `now()` to both.

### `packages/core` — opt-in live registry test (2 tests, skipped by default)

```
$ KEEL_LIVE_REGISTRY_TEST=1 npx vitest run src/enforce/__tests__/package-verifier.test.ts -t "live npm registry"
 Test Files  1 passed (1)
      Tests  2 passed | 43 skipped (45)
```

Hits the real `registry.npmjs.org` (explicit `registryBaseUrl`, bypassing
the VITEST safety net on purpose — see §7). Confirms `react` resolves
within budget with a usable `time.created` (§5) and a definitely-fake name
404s for real. Never runs in a normal `npm test`.

### `packages/cli` — `proposal-fixture-harness.test.ts`, new (20 tests)

```
$ npx vitest run src/__tests__/proposal-fixture-harness.test.ts --reporter=verbose
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

Extension point for `session/proposals/*.yaml` rules not yet pasted into
`DEFAULT_RULES_YAML` (the existing `fixture-harness.test.ts` only ever
reads `install.ts`'s copy) — coordinate-free: it globs every file in
`session/proposals/`, so any other Wave-2 capability lane's proposal gets
the same coverage automatically, no shared-file edit needed. Loads
`tests/rules/<rule-id>/{must-block,must-allow}.yaml`, the same fixture
location and format `fixture-harness.test.ts` uses (single-step subset).

Per-case `expect_action` is required and asserted exactly on every
must-block case, rather than inferring one fixed action from the rule's
declared `action` (`fixture-harness.test.ts`'s `expectedActionFor`
assumption) — `unverified-package-install` breaks that assumption on
purpose (§3's table), so loosening the assertion to "not allow" would let
a `not_found` case silently pass while actually returning `prompt`, or
vice versa. Mock registry call count is asserted `> 0` on every
package-rule case, so a broken `fetchImpl` injection fails loud instead of
quietly resolving via the VITEST safety net.

**Also new**: a paste-safety guard (`assertPasteSafe`, run against every
`session/proposals/*.yaml` file before it's even parsed) and a "gate
simulation" describe block — see §7, both added after the advisor review
below caught a real defect this suite's standalone parse/validate could
not.

### `packages/opencode-plugin` — unchanged, still 56/56

```
$ npm run build && npm test
> node ./scripts/load-test.js
PASS  ... (56 lines) ...
All checks passed
```

Includes `dist matches canonical template` — confirms
`packages/cli/templates/keel-enforce.js` (regenerated by the build, see
§8) actually contains the new module (`grep -c "PackageVerifierCache" ...`
→ 5 references) and matches what's on disk.

### Full root `npm test`

```
$ npm test
core:            292 passed | 2 skipped (294)
cli:              46 test files passed, 1 failed (level.test.ts) | 679 passed | 4 failed | 2 skipped (685)
mcp-server:       no test files (pre-existing)
opencode-plugin:  56/56 (All checks passed)
```

**The 4 `level.test.ts` failures are pre-existing and unrelated**,
confirmed empirically, not assumed from `session/DECISIONS.md`'s note
(itself already independently confirmed by two other Wave-1 lanes via
revert):

```
$ git stash --include-untracked   # back to base commit b45aebf, none of this lane's changes present
$ cd packages/cli && npx vitest run src/__tests__/level.test.ts
 Test Files  1 failed (1)
      Tests  4 failed | 9 passed (13)
$ git stash pop   # restored
```

Same 4 failures (ANSI/chalk output not matching plain-text assertions in
`keel level`/`keel status`), same test names, on a tree with zero package-
verifier code present.

## 7. A real defect the advisor review caught, and how it was fixed

Two blockers surfaced on review, before this was considered done:

**Template-literal paste hazard.** Both `DEFAULT_RULES_YAML` constants the
supervisor pastes proposals into are backtick-delimited JS template
literals. The first draft of `session/proposals/unverified-package-install.yaml`
used backticks for markdown-style code formatting in `rationale`
(`` `huggingface-cli` ``) and backslash-escaped quotes inside YAML
double-quoted strings in `false_positives` (`\"unverified\"`). Both are
invisible to a standalone YAML parse/validate check — the file only
becomes JS source at paste time. Verified the actual break, then the fix,
by simulating the exact paste:

```
$ node -e "... new Function('const X = \`\n' + proposal + '\n\`\n' + 'return X;') ..."
SYNTAX ERROR: Unexpected identifier 'rules'      # before
PARSED OK as JS template literal, length 3160    # after removing all backticks/backslashes
```

Rewrote the proposal using single-quoted YAML strings and plain-text
wording (no embedded code-formatting punctuation), re-verified standalone
parse/validate still passes (`packages/core`'s `parseRulesContent` +
`validateRules`, zero errors), and added `assertPasteSafe()` to
`proposal-fixture-harness.test.ts` — a mechanical check (no backtick, no
backslash, no `${`) that runs against every `session/proposals/*.yaml`
file, protecting every other Tier-3 lane's proposal from the same class of
bug, not just this one.

**Gate-reasoning was argued but untested.** The claim that the *unmocked*
main harness (`fixture-harness.test.ts`, once this proposal is pasted in —
no `packageVerifierFetch` wired) degrades every must-block case to
`prompt` via `defaultRegistryBaseUrl()`'s VITEST-only closed-loopback
safety net — matching `expectedActionFor()`'s expectation for an
`action: prompt` rule — was correct but asserted only in a comment. Turned
into an actual test: the "gate simulation" describe block runs all four
`unverified-package-install` must-block fixtures with no `fetchImpl`
injected and asserts every one resolves to `prompt` in under 2.5 seconds
(proving `ECONNREFUSED` to the closed port lands in the `network_error`
branch, not a hang — relevant given this session's own memory note on
undici swallowing `ECONNREFUSED` on `err.cause`). All four pass in 1-2ms
each; contrast with the SAME fixture run through the mocked "timeout"
registry response, which correctly takes the full ~2000ms budget.

**Checked, not fixed**: `packages/opencode-plugin/scripts/load-test.js`
runs under plain `node`, so the VITEST-only safety net doesn't apply
there. Traced every `plugin.server(...)` call in that script — each one's
target directory always has `.keel/rules.yaml` pre-written before the
call, so the real self-bootstrap write-when-missing path in `plugin.ts`
(which will carry this rule after the gate paste) never actually fires
today. Added `process.env.KEEL_NPM_REGISTRY = 'http://127.0.0.1:1'`
defensively anyway, right next to the existing `HOME` isolation override,
so a future edit to that script can't accidentally start making live
registry calls. Re-ran `npm run build && npm test` for that package after:
still 56/56.

## 8. Build artifact note

`packages/cli/templates/keel-enforce.js` appears in `git status` as
modified — this is a **regenerated build artifact**
(`packages/opencode-plugin`'s build bundles `src/plugin.ts` + core via
esbuild and copies the result over that file), not a hand edit. The
binding constraint against editing it directly was honored; `npm run
build` at the repo root regenerates it, confirmed by
`opencode-plugin`'s own `dist matches canonical template` check staying
green (§6) and by grepping the regenerated file for the new symbols.

## 9. Deliverables

- `packages/core/src/enforce/package-verifier.ts` — the engine.
- `packages/core/src/enforce/__tests__/package-verifier.test.ts` — 45
  tests (43 run by default, 2 opt-in live).
- `packages/core/src/types.ts`, `rule-parser.ts`, `pipeline.ts`,
  `enforce/index.ts` — `type: package` wiring.
- `session/proposals/unverified-package-install.yaml` — the exact snippet
  for the supervisor to paste into both `DEFAULT_RULES_YAML` constants at
  the gate. Paste-safety verified (§7).
- `tests/rules/unverified-package-install/{must-block,must-allow}.yaml` —
  fixtures, loaded by both the new proposal harness and (once pasted)
  `fixture-harness.test.ts`.
- `packages/cli/src/__tests__/proposal-fixture-harness.test.ts` — the
  coordinate-free extension point, 20 tests, plus the paste-safety guard.
- `packages/opencode-plugin/scripts/load-test.js` — one defensive line
  (`KEEL_NPM_REGISTRY` override), unrelated behavior otherwise unchanged.

## Summary

Engine, rule-type wiring, tests (65 total across both packages, 63
running by default + 2 opt-in live), proposal snippet, and fixtures are
all shipped and green. Two real defects were found and fixed before
calling this done: a cache-clock bug caught by its own test (§6), and a
template-literal paste hazard in the proposal file caught by advisor
review rather than by any automated check that existed at the time
(§7) — fixed, and now mechanically guarded against recurring, for this
proposal and every other Tier-3 lane's. The only failures anywhere in the
workspace are the 4 pre-existing, unrelated `level.test.ts` ANSI-output
assertions, reverify-confirmed against the base commit in §6.
