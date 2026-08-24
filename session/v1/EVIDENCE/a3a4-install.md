# A3/A4 — project install enforces; Cursor/Codex install copy corrected

Branch `v1p2-a3a4-install`, based on the latest `v0.4-thesis`.
Implementer lane, working exclusively in
`/Users/nanoclaw/code/keel-v1p2-a3a4-install`.

## Baseline (before any change)

`npm install && npm run build && npm test` — green before touching
anything:

```
core:            Test Files 34 passed (34) / Tests 603 passed | 2 skipped (605)
cli:              Test Files 47 passed (47) / Tests 833 passed | 14 skipped (847)
mcp-server:      Test Files 1 passed (1)  / Tests 6 passed (6)
opencode-plugin: 63/63 (load-test.js) — "All checks passed"
```

## A3 — `keel install --project` wrote an empty, non-enforcing ruleset

### What was read first

`packages/cli/src/commands/install.ts`, `installProjectPlugin()`
(~line 1442). The existing comment explained why the project
`.keel/rules.yaml` stub was `rules: []`: an earlier version wrote
`rules:` followed only by comment lines, which YAML-parses to
`rules: null` — `parseRulesContent` rejects that as "Rules must be an
array" and `initEnforce` throws on it, breaking `keel evaluate`/`keel hook
<host>` on every tool call. `rules: []` was the fix for *that* crash, at
the cost of leaving the project ruleset intentionally empty.

Traced why an empty project file might still be "fine": `loadRuleHierarchy`
(`packages/core/src/enforce/rule-parser.ts:366`) reads a `global` tier from
`resolveHome()/.keel/rules.yaml` in addition to the `project` tier from
`<cwd>/.keel/rules.yaml`, and `mergeRules` (same file, ~line 592) merges
both into one evaluation, with project rules taking precedence over global
for the same rule id. `installCommand` (`install.ts:1184`) also
unconditionally bootstraps `~/.keel/rules.yaml` with the real
`DEFAULT_RULES_YAML` at the top of *every* install invocation, regardless
of which flags are passed — so on the machine that just ran
`keel install --project`, the global tier is real and non-empty, and the
project's empty stub is "just" the pass-through layer.

That is true on the *installing* machine. It stops being true the moment
`.keel/rules.yaml` — which lives inside the project directory, i.e. exactly
the kind of file a team commits to git alongside `.opencode/plugins/
keel-enforce.js` — reaches a machine that never ran a *global* `keel
install` itself: a teammate's fresh clone, a CI runner, any host that loads
project rules without that separate step. On that machine `hierarchy.global`
is empty and the project's `rules: []` stub is the *only* tier — zero
enforcement, with a green "✓ Created .keel/rules.yaml" having printed on
the original install. Confirmed empirically before changing anything (see
`install-project-rules.test.ts`'s mutation-tested pre-fix run below) —
`keel evaluate` on `rm -rf /` against a bare/no-global-rules HOME returned
`{"action":"allow", ...}`.

### The fix

`installProjectPlugin()` now writes `DEFAULT_RULES_YAML` (the same exported
constant `installCommand` uses for the global tier) instead of the
`rules: []` stub, unmodified — reused, not edited, per the hard constraint
against hand-editing the ruleset outside the two-file drift-guarded change
process. Because `DEFAULT_RULES_YAML`'s `rules:` key always has real list
items under it, the original `rules: null` parse crash this stub was built
to avoid does not apply to it either — no regression of the bug the
`rules: []` fix was for.

The layering intent is preserved and now documented at the write site:
`mergeRules` still merges project over global by rule id (project always
wins ties), so on a machine where both tiers exist they simply agree;
identical ids are edited independently by design if someone wants to
diverge them. What changes is that the project's own copy is no longer a
silent dependency on a *different* install having happened somewhere else
first.

```diff
- writeFileSync(rulesFile, `# Project-specific Keel rules
- # Enforced alongside global rules in ~/.keel/rules.yaml.
- # Project rules override global rules for the same rule id.
- # Add project-specific rules here — see ~/.keel/rules.yaml for examples.
- version: 1
- rules: []
- `, 'utf-8')
+ writeFileSync(rulesFile, DEFAULT_RULES_YAML, 'utf-8')
```

(plus an added console note: "Same defaults as ~/.keel/rules.yaml — edit
either; project wins on shared rule ids.")

### Verification — isolated HOME, `--project`, `rm -rf /` denies

New test file `packages/cli/src/__tests__/install-project-rules.test.ts`,
run against the real built `dist/index.js` as a subprocess, HOME **and**
KEEL_HOME both pointed at scratch tmp directories the real `~/.keel` never
sees:

```
$ TMPHOME=$(mktemp -d) TMPPROJ=$(mktemp -d)
$ cd "$TMPPROJ"
$ HOME="$TMPHOME" KEEL_HOME="$TMPHOME" node .../dist/index.js install --project
  ✓ Created ~/.keel/rules.yaml
  ✓ Ensured ~/.keel/traces/ exists
  ✓ Installed plugin to .../.opencode/plugins/keel-enforce.js
  ✓ Created .../.keel/rules.yaml
    Same defaults as ~/.keel/rules.yaml — edit either; project wins on shared rule ids.
  ...
$ HOME="$TMPHOME" KEEL_HOME="$TMPHOME" node .../dist/index.js evaluate \
    --tool Bash --args '{"command":"rm -rf /"}' --cwd "$TMPPROJ"
{"action":"deny","rule_id":"no-destructive-commands","rule_name":"no-destructive-commands",
 "message":"Destructive commands (including fork bombs) are blocked.",...}
exit=1
```

The added test file goes further than the literal ask and proves the
*project ruleset alone* is enforcing — not just "enforcement happened
somewhere in the merged hierarchy" (which the empty-stub version would
already have passed, since the global bootstrap always ran too):

1. `writes a non-empty project rules.yaml` — asserts the written file does
   not contain the `rules: []` stub.
2. `the project rules.yaml parses to real enforcing rules, including the
   protect-floor destructive-command rule` — parses the file with
   `parseRulesContent` and asserts `no-destructive-commands` is present.
3. `keel evaluate denies a destructive command with BOTH global and project
   tiers present` — the literal ask: isolated HOME+KEEL_HOME, `--project`
   install, `rm -rf /` → `deny`.
4. `keel evaluate STILL denies with the project ruleset alone — no global
   ~/.keel/rules.yaml on this machine at all` — a **second**, fresh,
   never-installed-into HOME/KEEL_HOME pair (simulating the teammate/CI
   clone scenario above) with `--cwd` pointed at the already-installed
   project directory. This is the test that actually distinguishes the fix
   from the pre-fix state.

**Mutation check (proves the test catches the bug, not just documents the
fix):** stashed the `install.ts` change, rebuilt, reran this test file
against the pre-fix `rules: []` stub:

```
 ❯ writes a non-empty project rules.yaml — FAIL (content was `rules: []`)
 ❯ the project rules.yaml parses to real enforcing rules... — FAIL (0 rules)
 ❯ keel evaluate STILL denies with the project ruleset alone... — FAIL
     evaluate result: {"action":"allow","rule_id":null,...}: expected 'allow' to be 'deny'
   1 passed (the "both tiers present" test — passes either way, since the
     global bootstrap alone was already sufficient pre-fix; this is exactly
     why test 4 above is the one that matters)
```

Then unstashed, rebuilt, reran — all 4 pass (see full suite output below).
Real `~/.keel/rules.yaml` mtime confirmed unchanged across this entire
session (`Aug 4 11:48:10 2026`, pre-dating today's work) — every command
used explicit `HOME`/`KEEL_HOME` env overrides or scratch tmp directories,
never the ambient environment.

Existing regression test `install-all.test.ts`'s
`"writes a project rules.yaml that actually parses (not \`rules: null\`)"`
still passes unchanged (it only asserts the file parses to a valid array,
not that it's empty) — its comment was updated to point at the new test
file and note the empty-but-valid stub was itself the A3 gap, not just a
historical parse crash.

## A4 — stale "no blocking hooks" copy on Cursor and Codex installers

### What was read first

`installHostHook()` (`install.ts:1395`) — the shared helper both
`installCursor()` and `installCodex()` use to copy a real hook script to
disk and `chmod 755` it; its own doc comment says this is "the enforcement
layer," replacing installers that used to print prose and enforce nothing.

`installCursor()` (`install.ts:1768`):
- Installs `cursor-beforeshellexecution.sh` → `.cursor/hooks/keel-enforce.sh`.
- If `.cursor/hooks.json` does not already exist, **writes it itself**,
  wiring `beforeShellExecution` and `beforeMCPExecution` to that script
  with `failClosed: true` — a crash in the hook denies, not silently
  allows. If `hooks.json` already exists, prints a yellow warning telling
  the user to add the wiring themselves.
- The per-hook note already correctly says "UNVERIFIED against a live
  Cursor — contract taken from docs, not installed types."
- The final summary line, unconditionally: `"Note: Cursor has no blocking
  hooks — these are advisory rules."` — directly contradicts the
  `failClosed: true` wiring two lines above it.

`installCodex()` (`install.ts:1823`):
- Installs three real hook scripts to `~/.codex/hooks/`: `keel-enforce.sh`
  (PreToolUse), `keel-verify.sh` (PostToolUse), `keel-claim.sh` (Stop).
  Confirmed via `packages/cli/templates/codex-pretooluse.sh`: `exec keel
  hook codex`, which (traced in `packages/cli/src/commands/hook.ts:506-514)
  returns `{ blocked: true, exitCode: 2, ... }` on deny — Codex's own
  documented contract ("any OTHER non-zero means the hook failed", so the
  code has to be exactly 2). This is a real blocking mechanism, not prose.
- Each hook's own note says "register it in ~/.codex/hooks.json as a
  <Event> hook" — `keel install --codex` does **not** write that file
  itself (unlike Cursor); there is no other Codex-specific code anywhere
  in `install.ts` that touches `hooks.json`. Confirmed by grep.
- Also writes/appends a `## Keel standing requirements` section to
  `AGENTS.md` — this part genuinely is prose-only, always active,
  independent of hook registration.
- The final summary line: `"Note: Codex CLI has no blocking hooks — these
  are advisory instructions."` — wrong in the opposite direction from
  Cursor's: it implies the *entire* Codex install is prose, when real
  blocking hook scripts are installed; the accurate gap is that Codex
  requires a **manual** registration step before those scripts run at all.

### The fix

Cursor (`install.ts`, end of `installCursor()`):

```diff
- console.log(chalk.dim('  Note: Cursor has no blocking hooks — these are advisory rules.'))
+ console.log(chalk.dim('  Note: the hook above is BLOCKING (failClosed) once wired into .cursor/hooks.json — not advisory.'))
+ console.log(chalk.dim('    Contract taken from Cursor\'s docs, UNVERIFIED against a live Cursor install.'))
+ console.log(chalk.dim('    keel.mdc above is a separate, always-active advisory layer alongside it.'))
```

Worded as "once wired into .cursor/hooks.json" (not "is wired") because the
wiring is conditional in the code just above it — auto-written when
`hooks.json` didn't already exist, manual-add-yourself otherwise — so the
note is accurate in both branches rather than overclaiming the auto-write
case.

Codex (`install.ts`, end of `installCodex()`):

```diff
- console.log(chalk.dim('  Note: Codex CLI has no blocking hooks — these are advisory instructions.'))
+ console.log(chalk.dim('  Note: the keel-enforce.sh/keel-verify.sh/keel-claim.sh hooks above are BLOCKING'))
+ console.log(chalk.dim('    (exit 2 stops the call — same contract as Claude Code/Gemini), but Codex'))
+ console.log(chalk.dim('    only runs a hook once you register it yourself in ~/.codex/hooks.json'))
+ console.log(chalk.dim('    (PreToolUse/PostToolUse/Stop — see the UNVERIFIED note per hook above);'))
+ console.log(chalk.dim('    until then, this AGENTS.md section is the only layer actually active.'))
```

This does not overclaim in the other direction either: it doesn't say
Codex enforcement is live out of the box (it isn't, until the user edits
`hooks.json`), and it doesn't drop the existing "UNVERIFIED against a live
Codex CLI" caveat already printed per-hook by `installHostHook`.

### Verification

No test asserted the old string literals (`grep -rln "no blocking hooks"`
across `__tests__/` and `commands/` returned nothing), so nothing broke.
Manually re-ran `keel install --cursor` and `keel install --codex` in an
isolated project/HOME and confirmed the printed notes now match the code
just verified above: `.cursor/hooks.json` gets `failClosed: true` entries
written when absent; `~/.codex/hooks/*.sh` are installed but
`~/.codex/hooks.json` is never touched by keel.

## Full suite after both fixes (final run)

```
core:            Test Files 34 passed (34) / Tests 603 passed | 2 skipped (605)
cli:              Test Files 48 passed (48) / Tests 837 passed | 14 skipped (851)
mcp-server:      Test Files 1 passed (1)  / Tests 6 passed (6)
opencode-plugin: 63/63 (load-test.js) — "All checks passed"
```

(cli went from 833→837 tests / 47→48 files: the 4 new tests in
`install-project-rules.test.ts`. No other test file's assertion count
changed; `install-all.test.ts` kept the same 8 tests, comment-only edit.)

## Constraints honored

- `packages/cli/src/core/**` and `templates/keel-enforce.js` — not
  hand-edited (both are build outputs; `npm run build` regenerated them
  from `packages/core/src` and `packages/opencode-plugin/src/plugin.ts`
  respectively, as always).
- `DEFAULT_RULES_YAML` itself — not edited. A3 reuses the existing exported
  constant verbatim; no two-file drift-guarded change was needed.
  `drift.test.ts` (which regex-matches the *assignment* `DEFAULT_RULES_YAML
  = \`...\`` in `install.ts` and `plugin.ts`) still passes unchanged.
- Real `~/.keel` — never touched; every verification command used explicit
  `HOME`/`KEEL_HOME` overrides or scratch tmp directories. Confirmed via
  `~/.keel/rules.yaml` mtime (`Aug 4 11:48:10 2026`, unchanged across this
  session).
- No test weakened; the new test was proven to catch the A3 bug via a
  stash/rebuild/rerun mutation check against the pre-fix code before being
  finalized against the fix.
