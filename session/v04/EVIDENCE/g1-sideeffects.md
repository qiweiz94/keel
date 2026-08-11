# v0.4 G1 — side-effect safety audit (the class behind the browser-flood bug)

Lane G1, worktree `keel-v04-sideeffects`, branch `v04-sideeffects`, Node
v26.0.0. Trigger: `keel dashboard --web` opened a browser tab on every
`npm test` run because `spawn('open', url)` was gated on nothing but
`process.platform === 'darwin'`. Fixed in an earlier session
(`shouldAutoOpenBrowser()` in `dashboard-web.ts`); this lane sweeps
`packages/cli/src/commands/*.ts` for every other instance of the same
class and pins the invariant.

**Invariant:** no keel command may perform a user-environment side effect
(browser/app launch, desktop notification, unsolicited outbound network
call, write outside its documented scope, interactive-only prompt) unless
running for a real interactive user (TTY, not CI) — with an explicit
opt-in escape hatch where a command legitimately needs one for tests or a
consenting user.

## Method

Grepped all 34 files in `packages/cli/src/commands/*.ts` for
`spawn|exec|child_process|fork|open|fetch|http.request|notification|
prompt|readline|createInterface|isTTY|writeFileSync|mkdirSync`, then read
every file that matched. `hook.ts`, `pipeline.ts`, `rule-parser.ts`,
`DEFAULT_RULES_YAML`, `command-normalizer.ts` were audited (read-only) but
not edited, per the binding constraint that they're core-adjacent/
generated.

## Matrix

| Command | Side effect | Gated on interactivity? | Verdict |
|---|---|---|---|
| `dashboard-web.ts` | `spawn('open', url)` (auto-open browser); server itself needs a TTY to start | Yes — `shouldAutoOpenBrowser()` and the server-start check now both call `isInteractive()` | **Reference fix** (pre-existing this session), refactored onto the new shared gate |
| `dashboard.ts` | Interactive keypress TUI (`setRawMode`, raw stdin loop) | Was `!process.stdin.isTTY` only | **Fixed** — now `isInteractive()` (adds the CI check) |
| `promote.ts` | Mutates the user's `rules.yaml` (`mode` ladder) | Was `!process.stdin.isTTY` + `KEEL_ALLOW_NON_TTY` escape hatch | **Fixed** — now `isInteractive()` + same escape hatch |
| `rules.ts` (`harness --append`) | Mutates `~/.keel/rules.yaml` | Was `!process.stdin.isTTY` + `KEEL_ALLOW_NON_TTY` escape hatch | **Fixed** — now `isInteractive()` + same escape hatch |
| `schedule.ts` (status path) | `mkdirSync(~/.keel/logs)` fired from `logPath()`, called by the **read-only** status branch (bare `keel schedule`) | No — a getter mutated on every call, including status | **Fixed (real bug)** — `logPath()` is now pure; `ensureLogDir()` is a separate function called only from `installLaunchd()`/`cronLine()` (the actual install paths) |
| `schedule.ts` (install path) | `execFileSync(launchctl/crontab)`, writes a launchd plist / crontab entry | Requires an explicit `daily`/`weekly` positional arg, or `--remove` | Safe (opt-in via required argument, same shape as `init --hooks`) |
| `check.ts` | `execSync('git diff --cached --name-only')` | Only under explicit `--ci`; read-only git query | Safe (command-purpose, user/pipeline-invoked) |
| `init.ts` | `execSync('pre-commit --version')` (probe); `execSync(chmod +x)` on files it just wrote; installs git hooks | Hook install only under explicit `--hooks` flag | Safe (opt-in via flag; probe is read-only) |
| `gateway.ts` | Spawns the upstream MCP server (via `MCPGateway`/`mcp/gateway.ts`); reads stdin via `readline` | N/A — the spawn target and args are the `--command`/`KEEL_UPSTREAM_SERVERS` the user explicitly supplied | Safe (spawning *is* the documented purpose of `keel gateway`) |
| `serve.ts` | Starts an MCP server (stdio or `localhost:port`) | N/A | Safe (explicit purpose of `keel serve`) |
| `watch.ts` | `await new Promise(() => {})` — hangs forever tailing the audit trail | N/A | Safe — this is `tail -f`; the hang *is* the command, not an accidental side effect. Noted rather than TTY-gated because gating it would break its one legitimate CI use (a monitoring pane in a long-lived pipeline job) |
| `daemon.ts` `/v1/research` | Outbound network fetch (`fetchPage`/`webSearch`) | Fires only when an authenticated client explicitly POSTs a `query`/`url` | Safe (client-initiated, not fired by daemon startup or any other command) |
| `mcp/daemon-client.ts` `ensureDaemon()` | Auto-spawns `keel daemon` detached | Not TTY-gated — by design, this runs from an agent's non-interactive shell (`mcp/gateway.ts`, `mcp/server.ts`) | **Out of scope** — outside `commands/`, not edited; documented. Correct behavior: the daemon is core enforcement infra meant to run non-interactively |
| `hook.ts` | `readStdin()` checks `process.stdin.isTTY` to decide whether piped JSON is present | Not a side-effect gate — an input-parsing correctness check (avoids blocking on a read with nothing piped) | **Out of scope** — binding constraint excludes editing `hook.ts`; documented, no side effect found |
| `allow.ts`, `disable.ts`, `level.ts`, `lessons.ts`, `gather.ts`, `install.ts`, `template.ts`, `receipts.ts`, `retrospective.ts` (except `--write`), `harness-rules.ts`, `status.ts`, `suggest.ts`, `scan.ts`, `scan-risk.ts`, `health.ts`, `evaluate.ts`, `verify.ts`, `test.ts`, `validate.ts`, `audit.ts`, `enforce.ts` | File writes within each command's own documented scope (own config/state files); no spawn/exec/network/notification | N/A | Safe — no side effect of the audited class found |
| `retrospective.ts` (`--write`) | `mkdirSync` + `appendFileSync` under `~/.keel/retrospectives/` | Gated behind explicit `--write` flag | Safe (opt-in) |

## What was fixed

1. **New shared gate** — `packages/cli/src/commands/interactive.ts`,
   `isInteractive(): boolean { return !!process.stdin.isTTY &&
   !process.env.CI }`. Mirrors `shouldAutoOpenBrowser()`'s TTY+!CI shape.
2. **`dashboard-web.ts`** — both `shouldAutoOpenBrowser()` and the
   server-start TTY check now call `isInteractive()` instead of a private
   `process.stdin.isTTY` check.
3. **`dashboard.ts`** — the `options.once || !process.stdin.isTTY` early
   return now uses `isInteractive()`, so a TTY under `CI=1` now correctly
   falls through to the one-shot panel instead of entering the keypress
   loop.
4. **`promote.ts`, `rules.ts`** — their human-only mutation gates
   (`!process.stdin.isTTY && env.KEEL_ALLOW_NON_TTY !== '1'`) now route
   through `isInteractive()`, adding the CI check on top of the existing
   TTY check and escape hatch.
5. **`schedule.ts`** — real bug, not just a hardening: `logPath()` used to
   `mkdirSync(~/.keel/logs)` as a side effect of computing a path string,
   so a bare, read-only `keel schedule` (status display) wrote to the real
   filesystem on every invocation. Split into a pure `logPath()`/`logDir()`
   and a separate `ensureLogDir()` called only from the two install paths
   (`installLaunchd()`, `cronLine()` via `installCron()`).

## Test isolation fix (required, not scope creep)

Adding the `!CI` check to `promote.ts`'s gate meant `promote.test.ts`'s
existing TTY-mocking tests (which set `process.stdin.isTTY = true` but
never touch `process.env.CI`) would silently flip to blocked under a real
`CI=1` runner — an environment-dependent flake in exactly the direction
this audit exists to prevent. Fixed by saving/restoring `process.env.CI`
around both `describe` blocks in `promote.test.ts`, matching the pattern
`dashboard-web.test.ts` already used for the same variable.

Verified empirically: ran `packages/cli` full suite once normally and once
with `CI=1` — **752 passed both times**, no CI-only regression.

## Invariant test

`packages/cli/src/__tests__/no-side-effects.test.ts`, three layers:

1. Unit tests `isInteractive()` against all four TTY×CI combinations.
2. A source-level sweep: every file in `commands/*.ts` is scanned for
   `spawn(`, `execSync(`, `execFileSync(`, `fork(`, raw
   `process.stdin.isTTY`, `setRawMode`. Any match must be on a hardcoded
   `ALLOWLIST` with a written reason; the allowlist is also checked for
   staleness (every entry must still exist and still match). A new
   command that adds an ungated `spawn('open', ...)` fails this test by
   default.
3. Source-level assertion that `dashboard-web.ts`, `dashboard.ts`,
   `promote.ts`, `rules.ts` import and call `isInteractive()` from
   `./interactive.js` — catches the "fixed one call site, sibling still
   has a private copy of the check" failure mode.
4. A dedicated regression pair for the `schedule.ts` `logPath()` bug:
   asserts `logPath()`'s own body contains no `mkdirSync`, and that
   `ensureLogDir()` is the one function that does.

**Mutation-tested the pin itself**, per the "a control that cannot fail"
lesson: temporarily changed `isInteractive()` to `return true`
unconditionally and re-ran the suite — 3 of the 12
`no-side-effects.test.ts` tests went red (`is false with no TTY`, `is
false under CI even with a TTY`, `is false when both a TTY is absent and
CI is set`), confirming the test would actually catch a broken gate.
Reverted immediately, rebuilt, and confirmed the file matches the
pre-mutation content.

## Verify

- `npm run build` (root, all workspaces) — clean, no errors.
- `packages/core` full suite: **557 passed, 2 skipped** (matches stated
  baseline ~557).
- `packages/cli` full suite: **752 passed, 14 skipped** — run once
  normally and once with `CI=1` in the environment, identical results
  both times (baseline ~740 + 12 new tests in `no-side-effects.test.ts`).
- `templates/keel-enforce.js` unchanged by the build (`git diff --stat`
  empty for that path) — confirms no accidental edit to the generated
  artifact the binding constraints exclude.

## Files touched

- `packages/cli/src/commands/interactive.ts` — new, the shared gate.
- `packages/cli/src/commands/dashboard-web.ts` — refactored onto the
  shared gate (both the auto-open function and the server-start check).
- `packages/cli/src/commands/dashboard.ts` — TUI entry gate refactored.
- `packages/cli/src/commands/promote.ts` — mutation gate refactored.
- `packages/cli/src/commands/rules.ts` — `--append` mutation gate
  refactored.
- `packages/cli/src/commands/schedule.ts` — `logPath()`/`ensureLogDir()`
  split (real bug fix, not a gate refactor).
- `packages/cli/src/__tests__/promote.test.ts` — CI-env isolation added
  to both TTY describe blocks.
- `packages/cli/src/__tests__/no-side-effects.test.ts` — new, the pinned
  invariant.

Not touched: `pipeline.ts`, `rule-parser.ts`, `DEFAULT_RULES_YAML`,
`hook.ts`, `command-normalizer.ts`, `templates/keel-enforce.js`,
`packages/cli/src/core/`.
