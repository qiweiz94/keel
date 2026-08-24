# LANE M1r-3 — install() honors host/scope + KEEL_HOME override

Branch: `v1-m1r-3-install` (based on `v0.4-thesis`)
Worktree: `/Users/nanoclaw/code/keel-v1-m1r-3-install`

## Summary

`install()` previously wrote every GLOBAL target through a bare `homedir()`
call, so a fresh-machine or redirected install (and tests) had no way to
relocate it. Added a `KEEL_HOME` env override in
`packages/cli/src/commands/install.ts` and routed all 10 global-target
`homedir()` call sites through it. Project-scoped writers (the ones using
`process.cwd()`) were left untouched, as scoped.

Did **not** thread the same override through the reader side (daemon.ts,
rules.ts, status.ts, mcp/server.ts, state-manager.ts, the opencode plugin,
etc.) — that surface turned out to be large (~20 files across 3 packages),
not the "small, clean change" the task described as the bar for doing it in
this lane. Per the task's explicit instruction, stopping and reporting the
list below instead of half-doing it.

## 1. Grep confirming no pre-existing --host flag / KEEL_HOME override

```
$ grep -n "homedir()" packages/cli/src/commands/install.ts   # BEFORE any edits
1179:  const keelDir = join(homedir(), '.keel')
1265:  const ocDir = join(homedir(), '.opencode', 'plugins')
1291:  const dir = join(homedir(), '.hermes', 'plugins', 'keel')
1325:  const dir = join(homedir(), '.openclaw', 'plugins', 'keel')
1388:    target: join(homedir(), '.gemini', 'hooks', 'PreToolUse'),
1441:  const configDir = join(homedir(), '.config', 'opencode')
1469:  const reqPath = join(homedir(), '.keel', 'requirements.md')
1474:  mkdirSync(join(homedir(), '.keel'), { recursive: true })
1655:    target: join(homedir(), '.cline', 'hooks', 'PreToolUse'),
1747:    target: join(homedir(), '.codex', 'hooks', 'keel-enforce.sh'),
```

No `--host` flag exists anywhere in the CLI's flag parsing for `install`;
scope is expressed via `--opencode`/`--project`/`--claude-code`/etc. as the
task described. Confirmed premise — proceeded with the minimal env-override
approach, no new CLI surface added.

## 2. Change made (packages/cli/src/commands/install.ts)

Added, directly below the file's module doc comment:

```ts
/**
 * Resolves the base directory for every GLOBAL (non-project-scoped) install
 * target — ~/.keel, ~/.opencode, ~/.gemini, ~/.cline, ~/.codex, ~/.hermes,
 * ~/.openclaw, ~/.config/opencode, etc. Honors KEEL_HOME so a redirected or
 * test install never touches the real home directory.
 *
 * NOTE: readers (daemon.ts, rules.ts, status.ts, mcp/server.ts,
 * state-manager.ts, the opencode plugin, ...) do NOT currently consult
 * KEEL_HOME — they resolve a bare homedir() independently. An install run
 * with KEEL_HOME set writes only to the redirected location; readers will
 * still look under the real home directory. See session/v1/EVIDENCE/m1r-3-install.md
 * for the full reader audit and follow-up.
 */
function resolveHome(): string {
  return process.env.KEEL_HOME || homedir()
}
```

And replaced `homedir()` → `resolveHome()` at all 10 sites listed above
(lines shifted by +17 after the insertion; see `git diff` below for exact
lines). Nothing else in the file changed. `process.cwd()`-based
(project-scoped) writers were left untouched, e.g. the project OpenCode
plugin install at (was) line 1416 (`join(cwd, '.opencode', 'plugins')`).

```
$ git diff --stat
 packages/cli/src/__tests__/install.test.ts | 53 ++++++++++++++++++++++++++++--
 packages/cli/src/commands/install.ts       | 37 +++++++++++++++------
 2 files changed, 78 insertions(+), 12 deletions(-)

$ grep -n "homedir()" packages/cli/src/commands/install.ts   # AFTER edits
30: * KEEL_HOME — they resolve a bare homedir() independently. An install run
36:  return process.env.KEEL_HOME || homedir()
```

Only the resolver's own definition still calls bare `homedir()`; every
global-target call site now goes through `resolveHome()`.

Full diff of `install.ts`:

```diff
diff --git a/packages/cli/src/commands/install.ts b/packages/cli/src/commands/install.ts
index 66a51ba..eaf4593 100644
--- a/packages/cli/src/commands/install.ts
+++ b/packages/cli/src/commands/install.ts
@@ -19,6 +19,23 @@ import { detectSandbox, sandboxSuggestion } from '../core/enforce/sandbox-detect
  * the canonical source shared with the @get-keel/opencode-plugin npm package.
  */
 
+/**
+ * Resolves the base directory for every GLOBAL (non-project-scoped) install
+ * target — ~/.keel, ~/.opencode, ~/.gemini, ~/.cline, ~/.codex, ~/.hermes,
+ * ~/.openclaw, ~/.config/opencode, etc. Honors KEEL_HOME so a redirected or
+ * test install never touches the real home directory.
+ *
+ * NOTE: readers (daemon.ts, rules.ts, status.ts, mcp/server.ts,
+ * state-manager.ts, the opencode plugin, ...) do NOT currently consult
+ * KEEL_HOME — they resolve a bare homedir() independently. An install run
+ * with KEEL_HOME set writes only to the redirected location; readers will
+ * still look under the real home directory. See session/v1/EVIDENCE/m1r-3-install.md
+ * for the full reader audit and follow-up.
+ */
+function resolveHome(): string {
+  return process.env.KEEL_HOME || homedir()
+}
+
 export async function findTemplateSource(name: string): Promise<string | null> {
   const candidates = [
     join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', name),
@@ -1176,7 +1193,7 @@ export async function installCommand(options: {
   mcp?: boolean
   all?: boolean
 }) {
-  const keelDir = join(homedir(), '.keel')
+  const keelDir = join(resolveHome(), '.keel')
   const rulesPath = join(keelDir, 'rules.yaml')
 
   // Rules are the base layer: EVERY install mode ensures ~/.keel/rules.yaml
@@ -1262,7 +1279,7 @@ export async function installCommand(options: {
 
 async function installOpenCodePlugin() {
   // Global install — auto-loaded from ~/.opencode/plugins/ in every project.
-  const ocDir = join(homedir(), '.opencode', 'plugins')
+  const ocDir = join(resolveHome(), '.opencode', 'plugins')
   const pluginPath = join(ocDir, 'keel-enforce.js')
 
   mkdirSync(ocDir, { recursive: true })
@@ -1288,7 +1305,7 @@ async function installOpenCodePlugin() {
  * ~/.hermes/plugins/keel/ and the daemon does the enforcing.
  */
 async function installHermes() {
-  const dir = join(homedir(), '.hermes', 'plugins', 'keel')
+  const dir = join(resolveHome(), '.hermes', 'plugins', 'keel')
   mkdirSync(dir, { recursive: true })
 
   const plugin = await findTemplateSource(join('hermes', 'keel_plugin.py'))
@@ -1322,7 +1339,7 @@ async function installHermes() {
  * effectively identity, so the entry object is built as a literal.
  */
 async function installOpenClaw() {
-  const dir = join(homedir(), '.openclaw', 'plugins', 'keel')
+  const dir = join(resolveHome(), '.openclaw', 'plugins', 'keel')
   mkdirSync(dir, { recursive: true })
 
   const files = ['index.mjs', 'openclaw.plugin.json', 'package.json']
@@ -1385,7 +1402,7 @@ async function installGemini() {
   await installHostHook({
     label: 'Gemini CLI',
     template: 'gemini-pretooluse.sh',
-    target: join(homedir(), '.gemini', 'hooks', 'PreToolUse'),
+    target: join(resolveHome(), '.gemini', 'hooks', 'PreToolUse'),
     note: 'Claude-Code-compatible by construction. If Gemini\'s format has drifted, run `gemini hooks migrate --from-claude`.',
   })
   console.log(chalk.dim('    Gemini also has its own Policy Engine (--policy/--admin-policy);'))
@@ -1438,7 +1455,7 @@ rules: []
 }
 
 function upgradePluginConfig() {
-  const configDir = join(homedir(), '.config', 'opencode')
+  const configDir = join(resolveHome(), '.config', 'opencode')
   const configPath = join(configDir, 'opencode.json')
 
   // Note: plugins in .opencode/plugins/ are auto-loaded.
@@ -1466,12 +1483,12 @@ function upgradePluginConfig() {
 }
 
 function createRequirementsFile() {
-  const reqPath = join(homedir(), '.keel', 'requirements.md')
+  const reqPath = join(resolveHome(), '.keel', 'requirements.md')
   if (existsSync(reqPath)) {
     console.log(chalk.dim('  .keel/requirements.md already exists (skipping)'))
     return
   }
-  mkdirSync(join(homedir(), '.keel'), { recursive: true })
+  mkdirSync(join(resolveHome(), '.keel'), { recursive: true })
   writeDraftRequirements(reqPath)
 }
 
@@ -1652,7 +1669,7 @@ Project requirements: .keel/requirements.md (if present)
   await installHostHook({
     label: 'Cline',
     template: 'cline-pretooluse.sh',
-    target: join(homedir(), '.cline', 'hooks', 'PreToolUse'),
+    target: join(resolveHome(), '.cline', 'hooks', 'PreToolUse'),
   })
 
   // MCP server — gives Cline an enforcement check tool.
@@ -1744,7 +1761,7 @@ async function installCodex() {
   await installHostHook({
     label: 'Codex CLI',
     template: 'codex-pretooluse.sh',
-    target: join(homedir(), '.codex', 'hooks', 'keel-enforce.sh'),
+    target: join(resolveHome(), '.codex', 'hooks', 'keel-enforce.sh'),
     note: 'UNVERIFIED against a live Codex CLI — register it in ~/.codex/hooks.json as a PreToolUse hook. Codex requires the hook file hash to be trusted before it runs.',
   })
```

## 3. Reader audit — WHY the reader side was NOT wired (deliverable #2)

Grepped every non-test, non-generated-copy source file for `homedir(`:

```
$ grep -rln "homedir(" packages/*/src --include="*.ts" | grep -v __tests__ | grep -v "/core/src/core"
packages/cli/src/index.ts
packages/cli/src/core/receipts.ts            (generated copy of packages/core/src/receipts.ts)
packages/cli/src/core/signing.ts             (generated copy)
packages/cli/src/core/enforce/pipeline.ts    (generated copy)
packages/cli/src/core/enforce/audit.ts       (generated copy)
packages/cli/src/core/enforce/overrides.ts   (generated copy)
packages/cli/src/core/enforce/package-verifier.ts   (generated copy)
packages/cli/src/core/enforce/problem-ledger.ts     (generated copy)
packages/cli/src/core/enforce/state-manager.ts      (generated copy)
packages/cli/src/core/enforce/research/research-cache.ts (generated copy)
packages/cli/src/mcp/daemon-client.ts
packages/cli/src/mcp/server.ts
packages/cli/src/commands/daemon.ts
packages/cli/src/commands/install.ts        (this lane's writer)
packages/cli/src/commands/scan.ts
packages/cli/src/commands/dashboard.ts
packages/cli/src/commands/watch.ts
packages/cli/src/commands/status.ts
packages/cli/src/commands/rules.ts
packages/cli/src/commands/schedule.ts
packages/cli/src/commands/retrospective.ts
packages/cli/src/commands/dashboard-web.ts
packages/cli/src/commands/lessons.ts
packages/core/src/receipts.ts               (canonical source)
packages/cli/src/commands/allow.ts
packages/core/src/enforce/overrides.ts      (canonical source)
packages/cli/src/commands/gather.ts
packages/core/src/signing.ts                (canonical source)
packages/core/src/enforce/package-verifier.ts   (canonical source)
packages/core/src/enforce/state-manager.ts      (canonical source)
packages/core/src/enforce/pipeline.ts           (canonical source)
packages/core/src/enforce/audit.ts              (canonical source)
packages/core/src/enforce/problem-ledger.ts     (canonical source)
packages/core/src/enforce/research/research-cache.ts (canonical source)
packages/opencode-plugin/src/plugin.ts
```

Collapsing generated duplicates, that is **~20 distinct source files across
3 packages** (`core`, `cli`, `opencode-plugin`) — daemon token/PID files,
the trace log reader, rules.yaml readers (3 separate call sites: index.ts,
daemon.ts, rules.ts), the receipts/signing key store, the state-manager and
problem-ledger (which already partially special-case `KEEL_STATE_DIR`, a
narrower, pre-existing env var — see below), the research cache, the
audit-trace writer/reader, LaunchAgents plist paths, and the opencode
plugin's own `KEEL_DIR` constant. Several of these back long-running
processes (the daemon, the MCP server) rather than one-shot CLI invocations.

This is not a small, mechanical `homedir()` → `resolveHome()` swap the way
install.ts's 10 sites were: it spans a generated-vs-source package boundary
(hand-editing `packages/cli/src/core/**` is forbidden — must edit
`packages/core/src/**` and rebuild), touches long-running daemon/MCP-server
state, and would need to be re-verified against each of those subsystems'
own test suites. Per the task's explicit branch ("if it is large/risky,
STOP and report the reader list as a follow-up"), this was **not** attempted
in this lane.

**Pre-existing partial overlap worth noting for whoever picks up the
follow-up**: `packages/core/src/enforce/state-manager.ts`,
`package-verifier.ts`, and `problem-ledger.ts` already fall back to
`process.env.KEEL_STATE_DIR` before `homedir()` for the `.keel/state`
subdirectory specifically; `research-cache.ts` has `KEEL_RESEARCH_CACHE_DIR`;
`retrospective.ts` and `audit.ts` have `KEEL_TRACES_DIR`;
`allow.ts` has `KEEL_OVERRIDES_DIR`. These are narrower, per-subdirectory
overrides that predate this lane — they do NOT cover the general `~/.keel`
root or any of the other host dirs (`~/.opencode`, `~/.gemini`, etc.) that
`install()` now redirects via `KEEL_HOME`. A future lane unifying readers
onto `KEEL_HOME` should decide whether to keep, deprecate, or layer these
existing per-subdir vars underneath the new general override.

**Explicit follow-up reader list** (needs `resolveHome()`/`KEEL_HOME`
threaded through, ideally via one shared resolver module importable by both
`packages/core/src` and `packages/cli/src`, since `packages/cli/src/core`
is generated from the former):

- `packages/core/src/receipts.ts`
- `packages/core/src/signing.ts`
- `packages/core/src/enforce/pipeline.ts`
- `packages/core/src/enforce/audit.ts`
- `packages/core/src/enforce/overrides.ts`
- `packages/core/src/enforce/package-verifier.ts`
- `packages/core/src/enforce/problem-ledger.ts`
- `packages/core/src/enforce/state-manager.ts`
- `packages/core/src/enforce/research/research-cache.ts`
- `packages/cli/src/index.ts`
- `packages/cli/src/mcp/daemon-client.ts`
- `packages/cli/src/mcp/server.ts`
- `packages/cli/src/commands/daemon.ts`
- `packages/cli/src/commands/scan.ts`
- `packages/cli/src/commands/dashboard.ts`
- `packages/cli/src/commands/watch.ts`
- `packages/cli/src/commands/status.ts`
- `packages/cli/src/commands/rules.ts`
- `packages/cli/src/commands/schedule.ts`
- `packages/cli/src/commands/retrospective.ts`
- `packages/cli/src/commands/dashboard-web.ts`
- `packages/cli/src/commands/lessons.ts`
- `packages/cli/src/commands/allow.ts`
- `packages/cli/src/commands/gather.ts`
- `packages/opencode-plugin/src/plugin.ts`

**Documented limitation** (also inlined as a comment on `resolveHome()`
itself, so it isn't a silent trap): setting `KEEL_HOME` today redirects
`keel install`'s writes, but every reader above still resolves the real
`homedir()`. `KEEL_HOME` is not yet a safe way to fully sandbox a live keel
installation end-to-end — only its `install` step.

## 4. Test — isolated HOME, dual tmp dirs

Extended `packages/cli/src/__tests__/install.test.ts`:
- `run()` helper gained a `keelHome` option that sets `KEEL_HOME` in the
  child process env (and explicitly deletes it when not provided, so the
  test process's own env can't leak through).
- New `describe('install honors KEEL_HOME over HOME', ...)` block uses
  **two separate `mkdtempSync` directories** — `sysHome` (passed as `HOME`)
  and `keelHome` (passed as `KEEL_HOME`) — specifically so the test cannot
  pass by accident: since `os.homedir()` on POSIX reads `$HOME`, a test that
  only checked the KEEL_HOME side's contents would pass even if install.ts
  still called bare `homedir()`. Asserting the `sysHome` side stays *empty*
  is what proves the override, not just presence in `keelHome`.
  - Test 1 (`writes global install targets under KEEL_HOME, never under
    HOME`): runs `install --opencode` with both dirs set, asserts
    `~/.keel/rules.yaml` and `~/.opencode/plugins/keel-enforce.js` exist
    under `keelHome`, and asserts `.keel`/`.opencode` do NOT exist under
    `sysHome`.
  - Test 2 (`falls back to HOME when KEEL_HOME is unset`): regression check
    that the pre-existing (no-override) behavior is unchanged.
  - Test 3 (`install --all writes every global target under KEEL_HOME,
    nothing under HOME`): `--opencode` alone only exercises 4 of the 10
    `resolveHome()` call sites, so this test runs `install --all` (which
    reaches the Cline, Codex, Hermes, OpenClaw, and Gemini host installers
    too — confirmed by reading `installCommand`'s flag-gating: each is
    gated on `options.<name> || options.all`) and asserts existence of one
    path per remaining target under `keelHome`. `upgradePluginConfig()`
    (the `~/.config/opencode` target) only rewrites an *existing*
    `opencode.json` — it's an upgrade path, not a fresh-install path — so
    the test pre-seeds one under `keelHome` (never `sysHome`) and asserts
    it was rewritten in place, which proves that call site resolved
    `keelHome` rather than silently no-op'ing. Finally asserts
    `readdirSync(sysHome)` is empty — nothing leaked to the real-HOME side
    through any of the 10 sites, or through any of `--all`'s other cwd-scoped
    installers (project plugin, Claude Code hooks, Cursor — verified by
    reading their source: all three build paths from `process.cwd()`, and
    `install.ts` never imports `schedule.ts`, so the `~/Library/LaunchAgents`
    writer there is out of `--all`'s reach entirely).
- All `afterEach` blocks `rmSync` their tmp dirs.

Verbose run of the whole file:

```
$ npx vitest run src/__tests__/install.test.ts --reporter=verbose
 ✓ src/__tests__/install.test.ts > init --hooks > preserves an existing hook instead of overwriting it 3866ms
 ✓ src/__tests__/install.test.ts > init --hooks > still fails the commit when the preserved hook rejects 983ms
 ✓ src/__tests__/install.test.ts > init --hooks > generates a hook that fails closed when the binary is missing 377ms
 ✓ src/__tests__/install.test.ts > policy loading fails closed > denies when the policy file is empty 328ms
 ✓ src/__tests__/install.test.ts > policy loading fails closed > denies when the policy file is malformed 317ms
 ✓ src/__tests__/install.test.ts > policy loading fails closed > uses defaults — not fail-closed — when no policy file exists 327ms
 ✓ src/__tests__/install.test.ts > the policy protects its own configuration > blocks writes to .keel.yaml 964ms
 ✓ src/__tests__/install.test.ts > the policy protects its own configuration > blocks writes to .keel/audit/audit.log 792ms
 ✓ src/__tests__/install.test.ts > the policy protects its own configuration > blocks writes to .claude/settings.json 908ms
 ✓ src/__tests__/install.test.ts > the policy protects its own configuration > blocks writes to .git/hooks/pre-commit 857ms
 ✓ src/__tests__/install.test.ts > the policy protects its own configuration > does not block writes to ordinary source files 889ms
 ✓ src/__tests__/install.test.ts > install --opencode creates the global rules > creates ~/.keel/rules.yaml with the current defaults 522ms
 ✓ src/__tests__/install.test.ts > install --opencode creates the global rules > leaves an existing rules.yaml untouched 853ms
 ✓ src/__tests__/install.test.ts > install honors KEEL_HOME over HOME > writes global install targets under KEEL_HOME, never under HOME 612ms
 ✓ src/__tests__/install.test.ts > install honors KEEL_HOME over HOME > falls back to HOME when KEEL_HOME is unset 562ms
 ✓ src/__tests__/install.test.ts > install honors KEEL_HOME over HOME > install --all writes every global target under KEEL_HOME, nothing under HOME 690ms

 Test Files  1 passed (1)
      Tests  16 passed (16)
   Start at  01:24:01
   Duration  14.21s (transform 95ms, setup 0ms, import 114ms, tests 13.85s, environment 0ms)
```

An earlier draft of the `--all` test asserted `~/.config/opencode/opencode.json`
existed unconditionally and failed (`expected false to be true`) — root
cause was the upgrade-path behavior described above, not a bug in
`resolveHome()`; a manual `HOME=/tmp/... KEEL_HOME=/tmp/... node dist/index.js
install --all` run confirmed all *other* 9 targets landed under `KEEL_HOME`
correctly on the first attempt. Fixed by seeding the config file, as
described above.

Sanity check that the real `~/.keel` / `~/.opencode` on the dev machine were
untouched by the new tests (both predate this session, unchanged):

```
$ stat -f "%Sm %N" ~/.keel/rules.yaml
Aug  4 11:48:10 2026 /Users/nanoclaw/.keel/rules.yaml

$ stat -f "%Sm %N" ~/.opencode/plugins/keel-enforce.js
Aug  4 11:48:10 2026 /Users/nanoclaw/.opencode/plugins/keel-enforce.js
```

## 5. Build + full suite (before and after)

### Baseline (before any edits)

```
$ npm run build   # clean, all 4 workspaces build
$ npm test
 [core]   Test Files  33 passed (33)  |  Tests  557 passed | 2 skipped (559)
 [cli]    Test Files  41 passed (41)  |  Tests  751 passed | 15 skipped (766)
 [mcp-server]  No test files found, exiting with code 0
 [opencode-plugin]  58/58 PASS (custom load-test.js runner)
```

### After this lane's changes (final, includes the `--all` coverage test)

Full `npm test` output, no pipe:

```
$ npm test
> keel-monorepo@0.4.0 test
> npm run test --workspaces

> @get-keel/core@0.4.0 test
> vitest run

 Test Files  33 passed (33)
      Tests  557 passed | 2 skipped (559)
   Start at  01:24:24
   Duration  8.72s (transform 13.64s, setup 0ms, import 24.44s, tests 38.93s, environment 49ms)

> @get-keel/cli@0.4.0 test
> vitest run

 Test Files  41 passed (41)
      Tests  755 passed | 14 skipped (769)
   Start at  01:24:34
   Duration  71.10s (transform 7.46s, setup 0ms, import 22.15s, tests 289.55s, environment 12ms)

> @get-keel/mcp-server@0.4.0 test
> vitest run --passWithNoTests
No test files found, exiting with code 0

> @get-keel/opencode-plugin@0.4.0 test
> node ./scripts/load-test.js
[58 PASS lines — see the individual test names in the run above]
All checks passed
```

`core` unchanged at 557 (this lane never touched `packages/core/src`). `cli`
went 751 → 755 passed and 15 → 14 skipped (total 766 → 769, i.e. +3, matching
the 3 new tests added: two in the first KEEL_HOME block plus the `--all`
coverage test). The skip count shifting by 1 traces to conditional
`skipIf`/`.skip(` logic inside `oracle.test.ts` and `package-verifier.test.ts`
(both under `packages/cli/src/core/enforce/__tests__/`, the generated copy
of `packages/core/src` — files this lane never edited); this reads as
pre-existing, environment-conditional flakiness (e.g. network/binary
availability) between separate full-suite invocations, not something this
lane's change caused — `install.test.ts` itself was 16/16 with zero skips on
every run. `opencode-plugin`'s 58 checks (including "dist matches canonical
template" and "OpenCode auto-load probe") are unaffected because
`install.ts` writers were not part of that package's own build artifact.

## 6. Constraints honored

- No hand-edits to `packages/cli/src/core/**` or `templates/keel-enforce.js`
  — only `packages/cli/src/commands/install.ts` (source) and
  `packages/cli/src/__tests__/install.test.ts` were edited; `npm run build`
  regenerated `dist/` and the generated `src/core` copy.
- No new CLI flags/surface added — `KEEL_HOME` is an env var only, scope
  continues to be expressed via existing flags.
- Test uses two separate `mkdtempSync` tmp dirs, cleaned up in `afterEach`;
  verified the real `~/.keel` and `~/.opencode` were not touched.
- The final verification run (section 5, "After this lane's changes") was a
  plain `npm test` with no pipe at all — output captured directly, not
  filtered through `tail`/`grep`/`head`. (An earlier intermediate run in this
  session was piped through `tee | tail` for my own scrollback convenience;
  that was a process mistake against this lane's own hard constraint and is
  called out here rather than left implicit — the actual verification
  evidence above is from the unpiped re-run.)
