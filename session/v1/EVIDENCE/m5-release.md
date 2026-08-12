# LANE M5-RELEASE (E3) — v1.0.0 release-readiness evidence

Branch: `v1-m5-release` (based on `v0.4-thesis` with all v1 lanes merged in).
Nothing was published, pushed, or merged to `main`. This file records the real
command output backing that claim and every other claim in this lane's report.

## 1. Baseline, before any change

```
$ npm install && npm run build && npm test
```

Clean install (169 packages), clean build (all 4 workspaces), full suite green
before any edit: core 597/2 skipped, cli 811/14 skipped, mcp-server 6/0,
opencode-plugin 62/62 checks. 0 failures.

## 2. Version bump — diff

`0.4.0` → `1.0.0` in every workspace `package.json` that carries a version, plus
every inter-package dependency range that referenced `0.4.0`:

```diff
diff --git a/package.json b/package.json
-  "version": "0.4.0",
+  "version": "1.0.0",

diff --git a/packages/cli/package.json b/packages/cli/package.json
-  "version": "0.4.0",
+  "version": "1.0.0",
...
-    "@get-keel/core": "^0.4.0",
+    "@get-keel/core": "^1.0.0",

diff --git a/packages/core/package.json b/packages/core/package.json
-  "version": "0.4.0",
+  "version": "1.0.0",

diff --git a/packages/mcp-server/package.json b/packages/mcp-server/package.json
-  "version": "0.4.0",
+  "version": "1.0.0",
...
-    "@get-keel/core": "^0.4.0",
+    "@get-keel/core": "^1.0.0",

diff --git a/packages/opencode-plugin/package.json b/packages/opencode-plugin/package.json
-  "version": "0.4.0",
+  "version": "1.0.0",
```

`packages/mcp-server` is `private: true` and intentionally not published
(`scripts/publish.sh`'s own header: "deprecated ... not part of the v1 launch") —
bumped for consistency per the task's explicit instruction to check every
workspace `package.json` that carries a version, not just the publishable ones.

`npm install` after the bump reconciled `package-lock.json` cleanly (8 version
entries updated, `169`→`174` packages audited, no new installs needed).

## 3. Build — no drift in generated output

```
$ npm run build
```

All four workspaces build clean. `git diff --exit-code -- packages/cli/templates/keel-enforce.js`
returns clean (exit 0) after every rebuild in this lane — confirmed repeatedly,
including immediately after `npm publish --dry-run` for `opencode-plugin`, whose
`prepublishOnly` script re-runs the build and rewrites that exact file. The
version bump does not touch the plugin bundle's content (version is read from
`package.json` at runtime, not embedded in source — confirmed via
`packages/cli/src/index.ts`'s `const VERSION = pkg.version`).

## 4. A genuine rule-count drift, found and fixed

The README/CHANGELOG/`docs/tiers.md` claimed "43 rules" (12 protect-floor / 22
balanced / 9 observe), carried over from the v0.4.0 release where that count was
correct and verified at the time (`session/v04/EVIDENCE/release-docs.md`). Actual
count in `DEFAULT_RULES_YAML` (`packages/cli/src/commands/install.ts`) as of this
lane:

```
$ node -e "... count '- id:' entries in DEFAULT_RULES_YAML ..."
rule count: 45
tier1(protect floor): 13 tier2(balanced): 22 tier3(observe): 10
```

Two rules account for the gap: `no-destructive-interpreter-body` (tier 1) and
`test-oracle-env-introspection` (tier 3). **Correction after an advisor review
caught the first draft of this section mis-attributing them:** neither is v1
lane work. Both were added in post-0.4.0 "ruleset follow-up" commits, confirmed
via `git log -S`:

```
$ git log --oneline -S 'no-destructive-interpreter-body' -- packages/cli/src/commands/install.ts
e755806 v04/M1: ruleset followups - interpreter-body destructive coverage + G2 quote fix

$ git log --oneline -S 'test-oracle-env-introspection' -- packages/cli/src/commands/install.ts
4e6f0d4 v04/M2: add observe rule for caller-detection test gaming

$ git merge-base --is-ancestor e755806 <the 0.4.0 version-bump commit>; echo $?
1   # NOT an ancestor — e755806 lands AFTER the 0.4.0 release commit
$ git merge-base --is-ancestor 4e6f0d4 <the 0.4.0 version-bump commit>; echo $?
1   # same — also lands after
```

Both commits are dated after `session/v04/EVIDENCE/release-docs.md` correctly
counted 43, and their `v04/M1`/`v04/M2` prefixes place them in the v0.4-era
branch structure — before any v1 lane (`M1r`/`M2`/`M3`/`M4`) existed. The
correct framing is: the shipped default ruleset has been 45 rules since those
two follow-up commits landed, and the 43-rule figure in README/CHANGELOG/
`docs/tiers.md` was simply never updated to match — a stale-docs bug this
release lane found and fixed, not new work attributable to any v1 lane. The
CHANGELOG's v1.0.0 entry is worded to reflect this precisely rather than
implying the four v1 lanes grew the ruleset. Confirmed live against a fresh
install:

```
$ keel install --opencode && keel status
  Rules (global): 45 rules — .../.keel/rules.yaml
  Active at current dial: 45 of 45

$ keel level protect && keel level sprint
  Dial diff (protect → sprint), from the merged ruleset:
    4 rule(s) soften deny/block → warn: source-change-requires-test, no-secrets-in-code, no-secret-files, no-credential-echo
    2 rule(s) deactivated (their `level` floor is above sprint): test-oracle-tampering, test-oracle-env-introspection
    13 `level: protect` floor(s) unchanged: keel-control-gate, no-self-protection-write, no-rules-tampering, no-enforcer-removal, agent-env-hijack, no-destructive-commands, no-destructive-interpreter-body, protected-branch-reset, protected-branch-delete, pipe-to-shell, prod-db-destruction, no-exfil-flow, no-force-push

$ keel status | grep "Active at"
  Active at current dial: 43 of 45
```

README.md, `docs/tiers.md`, and `docs/marketing/landing-copy.md`'s implied counts
are all reconciled to 45/13/22/10 and to this exact live output. `session/v04/`'s
own historical files were left untouched (they correctly describe the state at
the time they were written).

## 5. Full untruncated `npm test` after every change — final run

```
$ npm test

@get-keel/core:            Test Files  34 passed (34)   | Tests  597 passed | 2 skipped (599)
@get-keel/cli:              Test Files  44 passed (44)   | Tests  811 passed | 14 skipped (825)
@get-keel/mcp-server:        Test Files   1 passed (1)   | Tests    6 passed (6)
@get-keel/opencode-plugin:                                 62/62 checks passed
```

Total: **1414 passed, 16 skipped, 0 failed**, across all four workspaces. `npm run
lint` (core/cli/mcp-server, `tsc --noEmit`) is clean.

One transient failure was observed and diagnosed, not silently ignored: a full-suite
run at higher concurrent machine load (this session ran many parallel builds/installs)
flaked `perf-budget.test.ts`'s hard <50ms hot-path latency assertion (measured
174ms/810ms at 11.6/16 core load). Re-run in isolation immediately after:

```
$ npx vitest run --root packages/cli src/__tests__/perf-budget.test.ts
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  593ms
```

Passes cleanly in isolation — pre-existing load-sensitivity in this specific test,
already documented independently in `session/v1/EVIDENCE/reader-home.md` §5 with
the identical signature (flaked at 15.1/16 and 20.1/16 core load there, passed 2/2
in isolation). Not a regression introduced by this lane; the final full-suite run
recorded above is the clean one.

## 6. Two real release-pipeline bugs found via `npm publish --dry-run`, fixed

The task's own instruction to run `npm publish --dry-run` "to verify the exact
artifact" surfaced two genuine, previously-undetected bugs — neither caught by the
existing test suite, because both only manifest when the actual packing/install
logic runs against real npm/filesystem state, which the unit tests deliberately
avoid (`check-published.test.mjs` shims `npm view` and sets
`KEEL_SKIP_INSTALL_VERIFY=1` specifically to skip the code path that was broken).

### 6a. `npm init --prefix` corrupts the repo's own root `package.json`

First occurrence: running `node scripts/check-tarballs.mjs` against this repo
silently rewrote `/Users/nanoclaw/code/keel-v1-m5-release/package.json`, replacing
it with `npm init -y`'s defaults plus a large, unrelated `dependencies` block
(`express`, `ajv`, `hono`, `zod`, ~90 packages — transitively pulled from the
surrounding workspace/node_modules tree). Caught immediately via the harness's own
external-modification notice, and restored from the known-good content before
proceeding.

Root-caused via isolated reproduction (`/tmp/npm-repro*`, not committed):

```
$ npm init -y --prefix install    # cwd = a workspaces-root repo; `install` pre-created
...
Wrote to /private/tmp/npm-repro3/package.json:   ← the REPO ROOT, not `install/`
```

On the npm version in this environment (**11.12.1**, Node **v26.0.0**), `npm init`
**ignores `--prefix` entirely**, regardless of whether the target directory exists,
and instead writes into the nearest ancestor `package.json` reachable from `cwd` —
which, run with `cwd: root` from inside a workspaces monorepo (both
`check-tarballs.mjs` and `check-published.mjs` do exactly this), is the repo's own
root `package.json`.

**Fix:** stop using `npm init --prefix` in both scripts; write a trivial
`package.json` directly into the install sandbox instead (`npm install --prefix`
alone respects `--prefix` correctly once a `package.json` already exists at that
path — confirmed).

```diff
--- a/scripts/check-tarballs.mjs
+++ b/scripts/check-tarballs.mjs
 const install = join(temporary, 'install')
-execFileSync('npm', ['init', '-y', '--prefix', install], { cwd: root, stdio: 'ignore' })
+mkdirSync(install, { recursive: true })
+writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'keel-tarball-install-sandbox', version: '1.0.0', private: true }) + '\n')
 execFileSync('npm', ['install', '--prefix', install, ...tarballs.map(...)], ...)

--- a/scripts/check-published.mjs
+++ b/scripts/check-published.mjs
 const install = mkdtempSync(join(tmpdir(), 'keel-published-'))
-execFileSync('npm', ['init', '-y', '--prefix', install], { cwd: root, stdio: 'ignore' })
+writeFileSync(join(install, 'package.json'), JSON.stringify({ name: 'keel-published-install-sandbox', version: '1.0.0', private: true }) + '\n')
 execFileSync('npm', ['install', '--prefix', install, ...packages.map(...)], ...)
```

Verified fixed by checksum, re-running both the corrupting command and its
replacement against the real repo:

```
$ md5sum package.json package-lock.json     # before
c3ddaf55e7beb06a3a91253fbc5b0fd9  package.json
d9ac8fea158227aa164631cc89cdf2ee  package-lock.json

$ node scripts/check-tarballs.mjs
found 0 vulnerabilities
Clean tarball install passed: CLI 1.0.0, plugin keel-enforce

$ md5sum package.json package-lock.json     # after — IDENTICAL
c3ddaf55e7beb06a3a91253fbc5b0fd9  package.json
d9ac8fea158227aa164631cc89cdf2ee  package-lock.json
```

`npm run test:publish-check` (the test that shims `npm view` and exercises
`check-published.mjs`'s retry/fail-closed logic) still passes both assertions
after the fix, exit code 0:

```
$ npm run test:publish-check
retry path ok: recovered after 4 E404 failures
fail-closed path ok: exits non-zero after max attempts
```

**Impact if unfixed:** any release engineer running `bash scripts/publish.sh`
locally (which calls `check-tarballs.mjs` directly, cwd = repo root, exactly the
corrupting shape) would have had their real root `package.json` silently
overwritten mid-release. In CI this is lower-severity (ephemeral checkout,
discarded after the job) but still incorrect and worth fixing regardless.

### 6b. A stray, Python-version-specific `.pyc` file was shipping in the CLI tarball

`npm publish --dry-run` for `@get-keel/cli` listed
`templates/hermes/__pycache__/keel_plugin.cpython-314.pyc` in the tarball
contents — a compiled-bytecode build artifact, not source, and specific to Python
3.14 (actively wrong/unusable bytecode for any other Python version, on top of
being dead weight).

Source: `packages/cli/src/__tests__/hermes-adapter.test.ts`'s
`execFileSync('python3', ['-m', 'py_compile', PLUGIN], ...)` compile-sanity check
writes real bytecode next to the plugin source it's checking. `packages/cli`'s
`files` field (`["dist","bin","templates","README.md"]`) includes the whole
`templates/` directory verbatim in every publish, so anything sitting there at
pack time ships — confirmed this is **not** filtered by `.gitignore`/`.npmignore`:
npm's ignore-file resolution is scoped to the package being packed (so a
repo-root `.npmignore` has no effect on `packages/cli`'s pack), and — the more
important finding — **npm's `files` allowlist bypasses ignore-file filtering
entirely for explicitly-listed directories**, confirmed by adding a
package-scoped `packages/cli/.npmignore` excluding `__pycache__/`/`*.pyc` and
observing the file still appeared in `npm pack --dry-run --json`'s listing.

**Real fix, at the source:** redirect the compile check's output file instead of
trying to suppress it via ignore files that don't apply.
`PYTHONDONTWRITEBYTECODE=1` was tried first and does work for the test's other
`python3` invocations (which use normal `importlib`-driven module loading), but
does **not** suppress `py_compile.compile()`'s explicit write — that call's whole
purpose is writing a `.pyc`, so it deliberately ignores that flag. Fixed by
passing an explicit `cfile=` pointing at a throwaway `tempfile.mkdtemp()` path
instead of the CLI form (`-m py_compile`, which has no such option):

```diff
--- a/packages/cli/src/__tests__/hermes-adapter.test.ts
+++ b/packages/cli/src/__tests__/hermes-adapter.test.ts
-    execFileSync('python3', ['-m', 'py_compile', PLUGIN], { timeout: 30000 })
+    execFileSync('python3', ['-c', `
+import py_compile, tempfile, os
+cfile = os.path.join(tempfile.mkdtemp(), 'keel_plugin.pyc')
+py_compile.compile(${JSON.stringify(PLUGIN)}, cfile=cfile, doraise=True)
+`], { timeout: 30000, env: PYTHON_ENV })
```

Verified the check still catches a real syntax error (`doraise=True` preserved):

```
$ python3 -c "... py_compile.compile(bad_syntax_file, cfile=..., doraise=True) ..."
Correctly raised PyCompileError: PyCompileError
```

Verified no artifact regenerates across repeated real test runs:

```
$ npx vitest run --root packages/cli src/__tests__/hermes-adapter.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)

$ find packages/cli/templates -iname "*.pyc" -o -iname "__pycache__"
(empty)
```

Verified the actual tarball is clean:

```
$ cd packages/cli && npm publish --dry-run 2>&1 | grep -i pycache
(empty)
... total files: 358    (was 359 with the stray .pyc)
```

A root-level `.npmignore` entry and a new `packages/cli/.npmignore` for
`__pycache__/`/`*.pyc` were tried first and initially committed, but per the
finding above **neither actually works** — confirmed by re-testing with each in
place: the stray `.pyc` still appeared in `npm pack --dry-run --json`'s listing
both times, because `files`-listed directories bypass ignore-file filtering
entirely. An advisor review caught that shipping non-functional ignore rules as
if they were protection is exactly the "absence rendered as reassurance"
failure mode this project's own house style warns against — a future reader
sees `__pycache__/` excluded and stops looking, when it isn't. Both were removed
in a follow-up commit; the source-level `cfile=` redirect (verified above) is
the only real fix, and needs no ignore-file support to work.

`check-packages.mjs` does not check for this class of file (only `__tests__`,
`dist/core/dist`, `dist/core/src`) — a gap worth a future lane's attention, noted
but not expanded here since it was outside this lane's explicit deliverables.

## 7. Final `npm publish --dry-run` — exact artifact contents

All three publishable packages, version 1.0.0, run after every fix above:

```
@get-keel/core@1.0.0     — 155 files, package 248.9 kB, unpacked 958.2 kB
                            shasum 519d80000252ff2c057f03aa689fd96d126d0c7c
@get-keel/cli@1.0.0       — 358 files, package 568.2 kB, unpacked 2.2 MB
                            shasum 6cc4f620500ce0e204b384a1cc8ce8d6dcea7dac
@get-keel/opencode-plugin@1.0.0 — 4 files, package 108.1 kB, unpacked 428.7 kB
                            shasum b4896cba2290af9d19dbfa74e3d974e78b1a9180
```

`opencode-plugin`'s `prepublishOnly` reran the build (rewriting
`packages/cli/templates/keel-enforce.js`); `git diff --exit-code` on that file
confirmed no drift immediately after.

`node scripts/check-packages.mjs`, `node scripts/check-tarballs.mjs`, and
`node scripts/check-release.mjs` all pass cleanly in the same final pass:

```
@get-keel/core@1.0.0: 155 clean files
@get-keel/cli@1.0.0: 358 clean files
@get-keel/opencode-plugin@1.0.0: 4 clean files

found 0 vulnerabilities
Clean tarball install passed: CLI 1.0.0, plugin keel-enforce

Release metadata valid: @get-keel/core@1.0.0, @get-keel/cli@1.0.0, @get-keel/opencode-plugin@1.0.0
```

`check-release.mjs` passing confirms the `@get-keel/core` dependency-range bump in
`cli`'s and `mcp-server`'s `package.json` is coherent (it explicitly checks the
range string contains the target version) — this is the exact check that would
have caught a missed range bump.

Root `package.json`/`package-lock.json` checksums confirmed identical before this
entire final verification pass and after — nothing was corrupted this time.

**`npm publish` itself was never run. `git push` was never run. No merge to
`main` was performed.**

## 8. Demo script

`scripts/demo/keel-disable-trace.sh` — reproduces the exact rule chain from
`session/v04/EVIDENCE/attribution-reaudit.md`'s strongest finding (an agent
blocked from pushing to main, then blocked again attempting a `keel disable`-
class command) via `keel test`, the same `EnforcementPipeline.evaluate()` call
every live host uses, no LLM required.

**A real bug was caught by testing from a genuinely virgin environment (no
prior `keel install`, no `.keel/` anywhere), per an advisor review — the
script's first version only worked because every manual test of it up to that
point happened in a directory that already had `~/.keel/rules.yaml` installed
from an earlier step.** `keel test` evaluates strictly against whatever
`rules.yaml` is on disk; it does not fall back to the shipped defaults in
memory. On a truly clean `HOME`, both demo steps read `✓ ALLOWED (no matching
rule)` — a silent no-op, not a demo:

```
$ rm -rf /tmp/keel-virgin && mkdir -p /tmp/keel-virgin/home && cd /tmp/keel-virgin
$ HOME=/tmp/keel-virgin/home scripts/demo/keel-disable-trace.sh
  ... ✓ ALLOWED (no matching rule)   ← both steps, before the fix
  ... ✓ ALLOWED (no matching rule)
```

Fixed by having the script install into an isolated, throwaway `HOME`
(`mktemp -d`, cleaned up on exit via `trap`) before running its two `keel test`
demonstrations — never touching the real user's `~/.keel`. Re-verified from a
maximally stripped environment (`env -i`, nonexistent `HOME`) after the fix:

```
$ rm -rf /tmp/keel-virgin3 && mkdir -p /tmp/keel-virgin3 && cd /tmp/keel-virgin3
$ env -i PATH="$PATH" HOME=/tmp/keel-virgin3-nonexistent \
    bash scripts/demo/keel-disable-trace.sh
  ... prompt (Pushing directly to a protected branch — approval required.
       -> Approval required: run `keel allow no-push-to-main --once` ...)
  ... DENY by rule "keel-control-gate"
    keel controls are user-owned - run keel disable|allow|level|install|rules --append ...
```

Both verdicts render correctly. Also re-verified running the script from the
repo root itself (not just an isolated scratch dir) — the repo dogfoods keel on
itself and has its own `.keel/rules.yaml`, which merges with the isolated
`$DEMO_HOME`'s global rules at evaluation time, so this was a real thing to
check, not a formality:

```
$ cd /Users/nanoclaw/code/keel-v1-m5-release && bash scripts/demo/keel-disable-trace.sh 2>&1 | grep -E "prompt|DENY|ALLOWED"
  prompt (Pushing directly to a protected branch — approval required. ...)
  ✗ DENY by rule "keel-control-gate"
```

Identical verdicts to the fully-stripped run above — the script is
invocation-independent.

Separately, the exact command tested was changed from
`git push --force origin main` to `git push origin main` — the former was
hitting a *different* rule (`no-force-push`, a Tier 1 floor with higher match
priority) than the one `attribution-reaudit.md` actually documents firing in
the real experiment (`no-push-to-main`), because in the real task setup the
agent's plain first push already gets rejected non-fast-forward before it
would ever type `--force` (see `attribution-reaudit.md`'s "A second nuance on
destructive-force-push"). The plain-push form reproduces the documented rule
exactly, at every cwd tested.

One more gap closed: `installOpenCodePlugin`'s "plugin source not found" path
returns without a non-zero exit, so the script's `set -e` would not have
caught that failure — a broken template lookup would have silently degraded
back to the exact "ALLOWED, nothing to show" no-op this whole fix exists to
prevent. Added an explicit post-install check
(`[ ! -f "$DEMO_HOME/.keel/rules.yaml" ]`) that exits 1 with a clear message
instead of proceeding silently. Verified the check doesn't false-positive on
the real working path (rules.yaml is present, script proceeds normally) and
does fire correctly when tested against the failure shape directly (a stub
reproducing "install returns 0, produces nothing" exits 1 with the message,
as intended).

`scripts/demo/HUMAN-CHECKLIST.md` documents the one manual step (recording the
actual GIF) this lane deliberately does not perform.

## 9. Note on the perf-budget flake observed during this lane

Cited above (§5) as passing 2/2 in isolation after a full-suite flake. Worth
stating precisely: the failed run's own assertion message says the machine's
load average was *under* its own skip threshold — i.e. the test's own
diagnostic explicitly does not blame the machine. The strong evidence this was
a load-contention artifact and not a real regression is the isolation timing
itself: 593ms in isolation vs. ~14,000ms (with a 810ms single-attempt outlier)
inside the full suite, a roughly 20x gap, while every logical assertion in the
test passed both times. Cited as the load-contention explanation on that basis,
not on the test's own (self-disclaiming) load-average message.

Separately: `packages/cli/src/__tests__/docs-drift.test.ts` was green
throughout this entire lane, including while the "43 rules" claim in
README/CHANGELOG/`docs/tiers.md` was actually wrong (§4) — whatever that test
checks, default rule counts are not among them. Worth a future lane's
attention as a real coverage gap; not expanded here since it's outside this
lane's explicit deliverables.
