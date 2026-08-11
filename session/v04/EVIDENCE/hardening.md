# v0.4 M1 — hardening follow-ups (unless-regex validation + onRulesError wiring)

Two correctness/UX gaps flagged by the fail-closed audit
(`session/v04/EVIDENCE/a3-failclosed.md`, "Core findings flagged for the
supervisor" #1 and #3), both left unfixed there because they touch files
outside that lane's scope (`rule-parser.ts`/`pipeline.ts` and
`enforce.ts`). Node v26.0.0, worktree `keel-v04-hardening`, branch
`v04-hardening`.

## Fix 1 — validate `unless[].regex` at load time

**File:** `packages/core/src/enforce/rule-parser.ts`, `validateRules()`'s
pattern-validity loop (was lines 184–196, now 184–197).

**Gap:** the loop compiled every sibling pattern field (`match`,
`match_regex`, `unless_reasoning`, `steps[].pattern`, `trigger.pattern`,
`satisfy.pattern`, `boundaries[].pattern`) with a `try { new RegExp(...) }
catch` at load time, but never touched `rule.unless[].regex`
(`KeelRule.unless?: { regex?: string }[]`, `types.ts:211-212/478` — no
`prefix` field exists on `unless`, so there is nothing else to add there).
`pipeline.ts:631` constructs `new RegExp(u.regex, 'i')` for that field with
no try/catch of its own — a rule with an invalid `unless[].regex` used to
load successfully and only throw once a call reached a command matching
`rule.match`.

**Fix (additive, one line):**

```ts
for (const pattern of [
  rule.match,
  rule.match_regex,
  rule.unless_reasoning,
  ...(rule.unless || []).map(u => u.regex),   // <-- added
  ...(rule.steps || []).map(step => step.pattern),
  rule.trigger?.pattern,
  rule.satisfy?.pattern,
  ...Object.values(rule.boundaries || {}).map(boundary => boundary.pattern),
]) {
  if (typeof pattern === 'string' && pattern) {
    try { new RegExp(pattern) } catch { errors.push(`Rule "${rule.id}" contains invalid regex: ${pattern}`) }
  }
}
```

Reuses the exact same compile-and-collect path every sibling field already
goes through, so the error message shape (`Rule "<id>" contains invalid
regex: <pattern>`, naming the rule id) is identical to the existing ones —
no new error format introduced.

**Tests:** `packages/core/src/enforce/__tests__/rule-parser.test.ts`, two
new cases next to the existing verification-regex test:

- `'rejects a command rule with an uncompilable unless[].regex'` — a
  `type: command` rule with `unless: [{ regex: "(unclosed" }]`;
  `validateRules()` returns `'Rule "bad-unless" contains invalid regex:
  (unclosed'`.
- `'accepts a command rule with a valid unless[].regex'` — same shape with
  `unless: [{ regex: "--dry-run" }]`; no `invalid regex` entry.

**Downstream consequence (found, not introduced):**
`packages/cli/src/__tests__/fail-closed.test.ts`'s describe block "(c) an
exception thrown mid-evaluation" was written specifically against the
pre-fix gap — its own header comment cited this exact validation hole as
the reason a broken `unless[].regex` reached evaluation instead of being
rejected at load. With the gap closed, that scenario is now case (b) (load-
time rejection): the whole rules file is rejected before any command is
evaluated, so a *non-matching* command now also gets blocked instead of
sailing through (`ls -la` used to return exit 0 there — now exit 2, same
"Keel could not evaluate" message as every other load-time rejection).
Updated in place: block retitled `'(c) formerly an exception thrown
mid-evaluation, now closed at load time'`, its comment rewritten to explain
the fix, and its first test's expectation flipped from `toBe(0)` to
`toBe(2)` with a `'Keel could not evaluate'` stderr assertion. The second
test in that block (matching command still blocks, same stderr shape) and
the `cline` test needed no changes — the externally observed verdict is
identical whether the throw happens at load or at eval, since `hook.ts`'s
catch around `initEnforce` + `evaluateToolCall` treats both the same way.
This is a **strictly stronger** fail-closed posture, not a regression: the
audit's own finding says this explicitly ("not itself a fail-open bug...
but the catalog of validated regex fields should include it").

## Fix 2 — wire `onRulesError`

**File:** `packages/cli/src/commands/enforce.ts`, `initEnforce()`'s
`EnforcementPipeline` construction (~line 91–101).

**Gap:** `pipeline.ts`'s `checkRuleVersion()` (~line 182–211) already does
the right thing on a mid-session rules.yaml edit that fails to validate —
keeps enforcing the last-known-good hierarchy, leaves the hash unchanged so
the reload (and the error) is retried on the next call, and calls
`this.config.onRulesError?.(errors)` to say so. Both other pipeline
constructors already wire it:

- `packages/cli/src/commands/daemon.ts:161-163` — `console.error('[keel
  daemon] rules error (...): ...')`
- `packages/opencode-plugin/src/plugin.ts:1286-1289` — `logError(
  'invalid-rules-reload-kept-last-known-good', errors)`

`packages/cli/src/commands/enforce.ts`'s `initEnforce()` — used by `keel
hook` (fresh process per call, so this path is genuinely unreachable there,
per the audit's own finding #3), `keel test`, `keel allow`, and any other
caller that keeps one pipeline alive across multiple `evaluateToolCall`
calls in the same process — never passed `onRulesError` at all. The failure
was correctly absorbed and silently swallowed: no stderr, no log, nothing
distinguishing "still enforcing the old rules" from "the new rules are
live."

**Fix (additive):**

```ts
reloadRules: () => {
  const next = loadRuleHierarchy(dir)
  currentLevel = next.project?.config.level || next.global?.config.level || currentLevel
  return next
},
onRulesError: (errors) => {
  console.error(`[keel] rules reload failed — keeping last-known-good rules: ${errors.join('; ')}`)
},
```

Printed to stderr, same channel/shape as `daemon.ts`'s existing wiring.
Fail-safe behavior is unchanged — last-known-good still stays in force;
only the visibility changed.

**Tests:** new file
`packages/cli/src/__tests__/rules-error-surface.test.ts`, isolated via a
temp `HOME`/`KEEL_STATE_DIR` (never the real `~/.keel`) and a temp project
dir, `console.error` mocked with `vi.spyOn`:

- `'surfaces validation errors on stderr when a mid-session reload is
  invalid, and keeps enforcing the last-known-good rule'` — `initEnforce`
  + one `evaluateToolCall` establishes the pipeline's baseline hash (rule
  uses `level: protect` so it block-firsts, no warm-up call needed);
  `console.error` not yet called. The rules file is then overwritten with
  `'version: 1\nrules: [broken\n'` and a second `evaluateToolCall` fires —
  asserts the *previous* rule still denies (last-known-good held) AND
  `console.error` was called with a message containing `'rules reload
  failed'`.
- `'does not call onRulesError when a mid-session reload is valid'` — same
  shape, but the second write adds a second valid rule; asserts the new
  rule fires (`deny`) and `console.error` was never called.

## Blast radius of the stricter validator (fix 1)

Grepped every shipped `unless:` block for a `regex:` entry outside the new
test fixtures, and compiled each one directly with `node -e "new
RegExp(...)"`:

- `packages/cli/src/commands/install.ts:411` / `packages/opencode-plugin/
  src/plugin.ts:405` — `cicd-and-infra`'s `--context[= ](docker-
  desktop|minikube|...)(?![A-Za-z])` — compiles.
- `packages/cli/src/commands/install.ts:690` / `packages/opencode-plugin/
  src/plugin.ts:684` — the format-choice rule's `git config|npm config|...
  |--yes` — compiles.
- `packages/core/src/policy-engine.ts:728` — `'git push
  --force-with-lease'` — compiles.

All three pass. The only broken `unless[].regex` in the tree is the
deliberate `(unclosed` fixture (this lane's two new `rule-parser.test.ts`
cases and the pre-existing `fail-closed.test.ts` case, updated above) — the
stricter validator does not newly reject anything shipped.

## `keel validate` confirmed end to end (fix 1's stated goal)

Ran the real built CLI against a scratch project with the `(unclosed`
fixture rule:

```
$ keel validate   # cwd = scratch project with the bad unless[].regex
  ⚠ Rule "bad-unless-e2e" contains invalid regex: (unclosed
exit=1
```

`packages/cli/src/commands/validate.ts:47` calls `validateRules()`
directly (`const issues = [...(parsed?.errors || []),
...validateRules(parsed?.rules || [])]`), so `keel validate` — and load,
via the identical check in `initEnforce()` — both reject the rule up
front, exactly as asked.

## Flagged for the supervisor (found while tracing fix 1, NOT fixed here — out of scope)

**`patterns[].regex` (content rules, `type: content`) has the SAME
load-time validation gap `unless[].regex` had — but with an opposite,
quieter failure mode.** `KeelRule.patterns?: ({ regex?: string; prefix?:
string })[]` (`types.ts:108`) is never in `validateRules()`'s
pattern-validity loop — confirmed by grep, not just absence of memory: the
task prompt that spawned this lane asserted `patterns[].regex` already
gets load-time validation "same as match," which is not accurate for the
tree as it stands. Where an uncompilable `unless[].regex` used to throw
loudly at eval time (fail-closed, now fixed to fail at load instead),
`pipeline.ts:914` reads a content rule's `pattern.regex` through
`this.matchesRulePattern()`, whose implementation
(`pipeline.ts:1327`) is `try { return new RegExp(pattern, 'i').test(value)
} catch { return false }` — an uncompilable regex there is swallowed and
the pattern **silently never matches**. A `type: content` rule with a
typo'd `patterns[].regex` loads cleanly, looks armed in `keel validate`,
and quietly never fires — the fail-OPEN, silent counterpart to the
fail-closed, loud gap fix 1 closed. Not fixed in this lane: it is a
distinct field on a distinct rule type, widens the blast radius to every
shipped `type: content` rule (would need the same three-way check this
lane just ran on `unless`), and the task scoped this lane to `unless[].regex`
specifically. Suggested fix: add `...(rule.patterns ||
[]).map(p => p.regex)` to the same pattern-validity loop in
`rule-parser.ts` (now at line ~184-193, right where the `unless` line just
landed), then re-run the same shipped-ruleset blast-radius check done above
for `unless` before landing it.

## Verification

```
npm run build   # all four workspaces, clean — confirms packages/cli/src/core
                 # (copied from packages/core/src at build time, never
                 # hand-edited) and templates/keel-enforce.js (built from
                 # opencode-plugin/src/plugin.ts, also untouched) both
                 # regenerate cleanly from the fix.

packages/core: 556 passed | 2 skipped   (558 collected)
  baseline ~554 + 2 new rule-parser.test.ts cases, 0 failures, 0 regressions.

packages/cli:  740 passed | 14 skipped  (754 collected)
  baseline ~738 + 2 new rules-error-surface.test.ts cases + fail-closed.test.ts's
  updated (not new) case, 0 failures, 0 regressions.
```

One transient failure surfaced on the very first full-suite CLI run:
`perf-budget.test.ts`'s p99 hot-path case (unrelated to either fix — no
core hot-path code touched) failed once at 135ms under a 50ms budget while
the machine was simultaneously running `npm run build` across four
workspaces; re-run in isolation (`npx vitest run
src/__tests__/perf-budget.test.ts`) passed cleanly in 526ms. Documented
here rather than silently re-run-until-green: this is the exact flake
`a3-failclosed.md`'s own Verification section already called out
("`perf-budget.test.ts`'s p99 case is self-skip-guarded on machine load...
flips pass/skip independent of anything touched here"), reproduced again,
not a regression introduced by this lane. The full suite re-run (this
report's numbers above) was captured with the machine otherwise idle.

## Files touched

- `packages/core/src/enforce/rule-parser.ts` — fix 1 (1 line added)
- `packages/core/src/enforce/__tests__/rule-parser.test.ts` — 2 new tests
- `packages/cli/src/commands/enforce.ts` — fix 2 (`onRulesError` wired)
- `packages/cli/src/__tests__/rules-error-surface.test.ts` — new file, 2 tests
- `packages/cli/src/__tests__/fail-closed.test.ts` — describe block "(c)"
  updated to reflect fix 1's downstream effect (1 assertion flipped,
  comments rewritten, no new test added/removed)
- `session/v04/EVIDENCE/hardening.md` — this file

Not touched: `packages/cli/src/core/` (generated), `templates/keel-enforce.js`
(generated) — both confirmed regenerated correctly by `npm run build` above.
`packages/core/src/enforce/pipeline.ts` was read (to confirm the exact
`onRulesError` call site and the `unless[].regex` throw site) but not
edited — both fixes were additive at the validation/wiring layer, no
pipeline behavior changed.
