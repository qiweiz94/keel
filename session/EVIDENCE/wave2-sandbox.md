# Wave-2 Lane 8 — sandbox detection

Worktree: `/Users/nanoclaw/code/keel-w2-sandbox`, branch `w2-sandbox`.
Node: `v26.0.0` (>= 22.12 required). `npm ci` completed clean (1 pre-existing
high-severity advisory, unrelated to this lane, not touched).

## 1. What was built

- `packages/core/src/enforce/sandbox-detector.ts` (new) — the detector, with
  per-environment detector functions and one combined `detectSandbox()`.
- `packages/core/src/enforce/__tests__/sandbox-detector.test.ts` (new) — 25
  tests, injectable fs/env probe, no real filesystem or environment touched.
- `packages/core/src/enforce/index.ts` — exports the new module's public API.
- `packages/cli/src/commands/status.ts` — prints the suggestion when
  detected; silent otherwise.
- `packages/cli/src/commands/install.ts` — same suggestion at the end of
  install output; **surgical diff** (import + 8 lines at the very end of
  `installCommand`, nowhere near `DEFAULT_RULES_YAML`, confirmed by
  `git diff --stat` = `12 insertions(+)`, 0 deletions, all in one hunk after
  the "Next steps" block).
- `packages/core/src/enforce/` and `templates/keel-enforce.js` were **not**
  otherwise touched; `DEFAULT_RULES_YAML` in `install.ts` is byte-identical.

Nothing here writes to `rules.yaml` or any config file. `sandboxSuggestion()`
returns a string or `null`; both call sites only `console.log` it.

## 2. Research: what markers actually exist (and what doesn't)

**Docker/container** — `/.dockerenv` (created by Docker in every container;
undocumented-but-stable implementation detail, relied on by systemd's
`ConditionVirtualization` and countless tools), `/proc/1/cgroup` containing
`docker`/`kubepods`/`containerd` (standard Linux cgroup-path heuristic), and
`KUBERNETES_SERVICE_HOST` (documented, injected into every k8s pod). All
high confidence when present.

**Codex sandbox (OpenAI)** — confirmed via `openai/codex`'s own `AGENTS.md`
(fetched from GitHub): `CODEX_SANDBOX_NETWORK_DISABLED=1` is set "whenever
you use the shell tool" under network restriction, across macOS, Linux, and
Windows — the reliable cross-platform marker (high confidence).
`CODEX_SANDBOX=seatbelt` is separately documented for macOS specifically:
"when you spawn a process using Seatbelt (`/usr/bin/sandbox-exec`),
`CODEX_SANDBOX=seatbelt` will be set" (high confidence). Codex's Linux value
for `CODEX_SANDBOX` (landlock-based) is not documented in any source found,
so presence of the var with any *other* value is still treated as a signal,
just at medium confidence.

**Anthropic sandbox-runtime** — researched three sources: the public docs
(`code.claude.com/docs/en/sandboxing`, `.../env-vars`) and the
`@anthropic-ai/sandbox-runtime` README, none of which document any env var a
wrapped child process can read to assert "I am sandboxed." Then went to
source: shallow-cloned `github.com/anthropic-experimental/sandbox-runtime`
and grepped it directly. Found `src/sandbox/sandbox-utils.ts` →
`generateProxyEnvVars()` unconditionally starts its env-var list with
`SANDBOX_RUNTIME=1` — but call-site inspection (`linux-sandbox-utils.ts`,
`macos-sandbox-utils.ts`, `windows-sandbox-utils.ts`) shows this function is
only invoked on the branch that wires an HTTP/SOCKS proxy bridge for network
isolation. A filesystem-only sandbox, or one with network fully unshared and
no proxy configured, may never call it. **This is the honest-unknown case
the task asked for**: `detectAnthropicSandboxRuntime()` treats
`SANDBOX_RUNTIME=1` as a real but low-confidence positive signal (internal,
undocumented, conditional — could vanish across versions without notice),
and its *absence* is never treated as proof of non-containment. The combined
`detectSandbox()` reflects this structurally: when nothing fires at all, it
returns `sandboxed: 'unknown'`, never `false` — see the type's doc comment
in the source for the full reasoning (a finite marker list can't prove a
negative for an open-ended "sandboxed by anything" question, and this
detector specifically can't prove a negative even for its own mechanism).

**Generic CI** — `CI=true`/`CI=1`, the de-facto convention used by GitHub
Actions, GitLab CI, CircleCI, Travis, and Buildkite. Counts toward
"contained" per the task brief, but at low confidence: self-hosted runners
often execute directly on a persistent host with no isolation at all.

## 3. Signal table

| Environment | Marker | Confidence | Source |
|---|---|---|---|
| Docker | `/.dockerenv` exists | high | Docker implementation convention (undocumented but stable) |
| Docker/k8s | `/proc/1/cgroup` matches `docker`/`kubepods`/`containerd` | high | standard Linux cgroup heuristic |
| Kubernetes | `KUBERNETES_SERVICE_HOST` set | high | documented k8s pod env injection |
| Codex | `CODEX_SANDBOX_NETWORK_DISABLED=1` | high | `openai/codex` AGENTS.md, cross-platform |
| Codex (macOS) | `CODEX_SANDBOX=seatbelt` | high | `openai/codex` AGENTS.md, macOS-specific |
| Codex (other) | `CODEX_SANDBOX=<other value>` | medium | var confirmed real, value undocumented for non-macOS |
| Anthropic sandbox-runtime | `SANDBOX_RUNTIME=1` | low | found in source only, undocumented, conditional on proxy-bridge branch |
| Anthropic sandbox-runtime | *(absent)* | **unknown** | no marker proves absence — honest per task instruction |
| CI | `CI=true`/`CI=1` | low | de-facto convention, isolation varies by provider/runner |

## 4. Tests

`packages/core/src/enforce/__tests__/sandbox-detector.test.ts` — 25 tests:
- bare-metal darwin (mocked probe with nothing set): zero signals, `unknown`
  not `true`, no suggestion text.
- bare-metal darwin using the **real, non-mocked** probe (this actual dev
  machine): asserts every fired signal has `kind === 'ci'` and that no
  container/codex/anthropic-sandbox-runtime signal strings appear — the
  literal "must-not-fire on bare metal" test. It deliberately does NOT
  assert `sandboxed !== true` outright: this suite may itself run under a
  CI runner where `CI=true` is set, and `detectCI` firing there is correct
  per the task brief ("generic CI ... counts as contained"), not a false
  positive — asserting the opposite would make the test fail specifically
  BECAUSE it's running in CI. Verified both ways, see §7.
- a cgroup read that `existsSync` says is there but `readFileSync` throws
  (EACCES/race) fails closed rather than throwing.
- Docker: fires on `/.dockerenv`, on a docker cgroup line, on a kubepods
  cgroup line (labeled `kubernetes`), on `KUBERNETES_SERVICE_HOST`; a
  non-container cgroup body does not fire; multiple simultaneous markers
  produce multiple signals.
- Anthropic sandbox-runtime: fires low-confidence on `SANDBOX_RUNTIME=1`;
  does not fire on `0` or unset.
- Codex: high confidence on `CODEX_SANDBOX_NETWORK_DISABLED=1` and on
  `CODEX_SANDBOX=seatbelt`; medium confidence on an undocumented
  `CODEX_SANDBOX` value; silent when neither is set.
- CI: low confidence on `CI=true`/`CI=1`; silent on `CI=false`/unset.
- Combined `detectSandbox()`: picks the highest confidence across mixed
  signals; never reports `false` (only `true` or `'unknown'`).
- `sandboxSuggestion()`: exact suggestion text/shape for a docker detection
  (contains the "Tier-2 prompts could relax to warns", `keel level sprint
  --project`, "per-rule overrides", "keel never applies this automatically"
  fragments); `null` when unknown; picks the highest-confidence signal as
  the headline when several fired.

## 5. Real `keel status` output on this bare-metal darwin machine

Ran through the actual built CLI (`node packages/cli/bin/keel.js status`)
against a throwaway `HOME`, with `FORCE_COLOR` unset so output is plain text
(see §6 for why):

```
  ⚓ keel status

  Speed dial: BALANCED (sprint=warn-only · balanced=default · protect=block-first)
    Change: keel level sprint|balanced|protect [--project]
  Kill switch: enabled (enforcement active)
  Overrides: none armed
  Active at current dial: 0 of 0

  Recent blocks: none
  OpenCode plugin: not installed — run `keel install --opencode`

  Telemetry:
    ? Agent activity    no agent session recorded yet
      → restart OpenCode so the plugin loads, then run a session
    ? Outcome telemetry no completed tool calls to inspect
      → restart OpenCode, then run a session
    ? Turn telemetry    no tool calls to inspect

    Metrics (`keel retrospective`) stay uninformative until these are green.
```

**No sandbox line — confirmed.** Exit code 0.

To confirm the wiring actually fires (not just that the mocked unit tests
pass), reran the same real CLI with `KUBERNETES_SERVICE_HOST=10.0.0.1` set
in the environment (a real, cheap-to-set marker, no root needed to simulate
`/.dockerenv`):

```
  Speed dial: BALANCED (sprint=warn-only · balanced=default · protect=block-first)
    Change: keel level sprint|balanced|protect [--project]
  sandbox detected (kubernetes via KUBERNETES_SERVICE_HOST) — Tier-2 prompts could relax to warns: keel level sprint --project, or per-rule overrides; keel never applies this automatically
  Kill switch: enabled (enforcement active)
  ...
```

Suggestion line appears exactly once, immediately after the speed dial, and
nowhere else — confirms end-to-end wiring through the built CLI, not just
the unit-level mocks.

## 6. Pre-existing failure noted, not caused by this lane

Full `npm test` in this interactive shell showed 4 failures in
`packages/cli/src/__tests__/level.test.ts` (chalk-colored `execSync` output
not matching plain-string assertions). Isolated with `git stash -u` +
rebuild on the **unmodified base commit** (`b45aebf`) — same 4 failures
reproduce with zero lane changes present. Root cause: this shell has
`FORCE_COLOR=3` set, which chalk's subprocess inherits and which forces
ANSI color codes even though `execSync`'s stdout pipe isn't a TTY (chalk's
normal auto-detection would disable color there). Not something this lane
introduced or is in scope to fix. Confirmed clean with `FORCE_COLOR`
unset, see §7.

## 7. Full-suite verification (unfiltered vitest), both `CI` states

New code branches on `CI`, so a single run isn't enough evidence — a runner
that sets `CI=true` (GitHub Actions and most others do, for every step)
would exercise a different code path than this interactive shell. Ran full
unfiltered `npm test` twice, `FORCE_COLOR` unset both times (see §6):

```
npm run build   → core, cli, mcp-server, opencode-plugin all build clean

env -u FORCE_COLOR -u CI npm test        (CI unset — this shell's normal state)
  @get-keel/core:            Test Files  16 passed (16) | Tests 274 passed (274)
  @get-keel/cli:              Test Files  46 passed (46) | Tests 645 passed (645)
  @get-keel/mcp-server:       No test files (passWithNoTests)
  @get-keel/opencode-plugin:  All checks passed (load-test.js, 55/55)
EXIT_CODE_NOCI=0

env -u FORCE_COLOR CI=true npm test      (CI=true — simulates a runner)
  @get-keel/core:            Test Files  16 passed (16) | Tests 274 passed (274)
  @get-keel/cli:              Test Files  46 passed (46) | Tests 645 passed (645)
  @get-keel/mcp-server:       No test files (passWithNoTests)
  @get-keel/opencode-plugin:  All checks passed (load-test.js, 55/55)
EXIT_CODE_CI=0
```

Both green. `645 passed` in `@get-keel/cli` includes the pre-existing suite
plus this lane's 25 new `sandbox-detector.test.ts` tests (counted in
`@get-keel/core`'s 274, since the module lives in `packages/core`; the CLI
build copies it into `src/core/` verbatim, which is why the same 25 tests
also appear under the CLI package's own `vitest run`).

Caught mid-lane by review: the first version of the "real probe on this
dev machine" test asserted `sandboxed !== true` outright, which is wrong —
it fails specifically *because* `CI=true` is set, and `detectCI` firing
under `CI=true` is correct behavior per the task brief, not a false
positive. Rewrote it to assert the actually-intended claim (no
container/codex/anthropic-sandbox-runtime signal on real darwin bare metal,
regardless of `CI`), rebuilt, and reran both variants above to confirm.

`keel install --mcp` exits before reaching the "Next steps"/suggestion
block (early return right after printing MCP server configs — pre-existing
behavior, the "Next steps" text is skipped there too). The sandbox
suggestion follows that same, already-established pattern; not a gap this
lane introduced.

## 8. Constraints honored

- Did not touch `packages/core/src/enforce/*` behavior of any existing file
  beyond adding exports to `index.ts`; did not touch `templates/keel-enforce.js`.
- Did not touch `DEFAULT_RULES_YAML` in `install.ts` — confirmed via
  `git diff` showing only an import line and 8 lines appended after the
  existing "Next steps" block.
- Verification ran full unfiltered `vitest` via `npm test`, not filtered/grepped,
  under both `CI` states.
- No push, no publish, stayed on `w2-sandbox` in this worktree throughout.
