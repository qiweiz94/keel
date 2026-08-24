# Keel v1.0.0 — authoritative human checklist

> **UPDATE (post-audit close-all-gaps pass):** every *code-closable* AUDIT gap is
> now closed (release-blocker `bash -lc` bypass, `${IFS}` split, cross-process
> exfil warn-tier, `install --project` stub, stale Cursor/Codex copy,
> override-store test leak, nanoid audit) — see `session/v1/AUDIT.md`. What
> remains below is genuinely human-gated. Three of these now have exact,
> step-by-step runbooks:
> - **Windows CI green** → `session/v1/runbooks/windows.md` (needs a push)
> - **Per-host live-verify** → `session/v1/runbooks/per-host.md` (needs credentials)
> - **Benchmark at scale** → `session/v1/runbooks/benchmark.md` (needs budget)
>
> §0 (the `bash -lc` master-key bypass) is **RESOLVED** — no longer a blocker.

**This is the single authoritative list of everything only a human can do for
the v1.0.0 release.** It consolidates three earlier fragments, which are kept
as detailed appendices and now point here:
- `session/HUMAN-CHECKLIST.md` — the exhaustive per-host live-verification
  steps (Claude Code / Gemini / Codex / Cursor / Cline / OpenClaw / Hermes,
  block AND warn paths). Referenced from §5 below; not duplicated here.
- `scripts/demo/HUMAN-CHECKLIST.md` — the demo-GIF recording steps.
  Referenced from §6.
- `session/v1/MERGE-NOTE.md` — the release/merge context. Its human decisions
  are folded into §1, §7, §8 below.

Ordered roughly by release sequence. Nothing here was or could be done from
inside an agent session — each item needs a human, real credentials, real
machines, or a governance decision.

---

## 0. ✅ RESOLVED — the `bash -lc 'keel disable'` master-key bypass is CLOSED

**No longer a release blocker — fixed after the audit.** The M6 red-team found
that `bash -lc 'keel disable'` (also `keel uninstall` / `keel enforce`) was
allowed at every dial and turned keel off in a single agent command, defeating
`keel-control-gate`. The supervisor then landed the fix: `command-normalizer.ts`
now matches `/^-[a-z]*c$/` for shell interpreters, so a **bundled** short-flag
cluster (`-lc`, `-ic`, `-xc`) has its command body extracted and recursed exactly
like `-c`.

Verified closed: `bash -lc 'keel disable' | keel uninstall | keel enforce` all
**deny** via `keel-control-gate`; `bash -lc 'rm -rf /'` / `-ic` / `sh -lc` **deny**;
benign `bash -lc 'ls -la'` still allows; every prior floor-hold unchanged.
Guarded by `shell-normalize-bypass.test.ts` (6 new cases, in `npm test`) and by
`scripts/redteam/round2.mjs` (those probes promoted to `control-catch`, exits 0).
The sibling `bash -lc 'rm -rf /'` finding closed by the same one-line fix.

- [x] Master-key bypass fixed and regression-guarded. Nothing to decide here.
- [ ] (Optional, non-blocking) SECURITY.md still keeps the "cannot turn keel off"
      claim appropriately non-categorical — a *novel* bypass class could always
      exist. That honest hedge is intentional; keep it in any public copy.

## 1. Publish the packages to npm  (RELEASE — deliberate human action)

The tree is release-ready but **not one literal command** — publish is a
deliberate human action the automation is scoped never to perform, per
MERGE-NOTE. `npm publish --dry-run` has been run for all three publishable
packages (`@get-keel/core`, `@get-keel/cli`, `@get-keel/opencode-plugin`) and
the exact tarball contents confirmed (see §9). To actually publish:

- [ ] Confirm you are logged in to npm as a maintainer of the `@get-keel`
      scope (`npm whoami`).
- [ ] Publish in dependency order (core → cli/opencode-plugin) or use the
      repo's own `scripts/publish.sh` / `publish-if-missing.mjs`. Do a final
      `npm publish --dry-run` per package immediately before the real publish.
- [ ] Two release-pipeline bugs MERGE-NOTE found are already fixed
      (`check-tarballs.mjs`/`check-published.mjs` no longer corrupt the root
      `package.json` via `npm init --prefix`; the stray `.pyc` tarball
      contaminant is fixed at source). Re-confirm `git status` is clean after
      any dry-run before publishing (see §9).

## 2. Flip the GitHub repository public

- [ ] Change `github.com/qiweiz94/keel` visibility to public.
- [ ] Confirm the Security Advisory intake URL in `SECURITY.md`
      (`/security/advisories/new`) resolves once public.

## 3. Merge the integration branch `v0.4-thesis` to `main`

- [ ] **The integration branch is `v0.4-thesis` @ `9e469ac`** (NOT `v1-m6-audit`
      or `v1-m5-release` — those were lane branches that predate the Phase-2
      close-all-gaps work). `v0.4-thesis` carries every v1 lane AND the Phase-2
      fixes (bash-lc bypass, ${IFS}, exfil warn-tier, install --project, override
      isolation, nanoid). Merge/fast-forward it to `main` yourself. Confirm
      `packages/cli/templates/keel-enforce.js` is committed and in sync
      (`release.yml` runs `git diff --exit-code` on it — it is clean as of the
      last build).

## 4. Real-machine dogfood / burn-in

- [ ] Install the published CLI on a real dev machine (not this repo's
      worktree) and run keel against your own real agent sessions for a burn-in
      period before announcing. The test suite proves the logic; it does not
      prove the day-to-day install/upgrade/uninstall UX on a clean machine.

## 5. Configure API keys and run the live-verify harnesses per host

Auth was blocked in every environment the build lanes had. **Full step-by-step
per host lives in `session/HUMAN-CHECKLIST.md`** (isolated HOME, scratch repo,
benign-probe-before-trusting-a-block, exact commands). Summary of what needs a
human with credentials:

- [ ] **Gemini CLI** — set `GEMINI_API_KEY` (simplest; sidesteps OAuth), run
      `scripts/live-verify/gemini.sh` + `gemini-warn.sh`.
- [ ] **Codex CLI** — set `OPENAI_API_KEY`, resolve Codex's hook hash-trust
      registration (unverified end-to-end), run `scripts/live-verify/codex.sh`.
- [ ] **Cursor** — no CLI was available anywhere; needs a real Cursor install.
      Verify block AND warn, and specifically the camelCase/snake_case message
      casing fix (and whether to port it to the block path).
- [ ] **Cline** — `cline --json -P cline` authenticated in one lane (paid);
      build the `cline.sh`/`cline-warn.sh` harness and resolve the `sessionId`
      field guess.
- [ ] **OpenClaw** — config wiring is DONE (`openclaw config set
      plugins.load.paths|allow`, verified against a real installed OpenClaw
      2026.4.15; `installOpenClaw()` prints the exact commands) and the
      openclaw#5943 `before_tool_call` finding is CHECKED — the issue is
      closed, and reading the installed runtime's compiled source confirms
      the hook is wired into the tool-execution call graph (see
      `docs/integrations.md` footnote 1). Still open: run a real
      `openclaw agent` turn against a configured provider to test
      block/warn/approve end to end — nothing done so far is an exercised
      call.
- [ ] **Hermes** — docs-confidence only, untouched by the OpenClaw pass
      above; wire the plugin/daemon config and run a real agent turn to
      test block/warn/approve end to end.
- [ ] **Claude Code warn path** — the block path is live-verified; the warn
      path's marker round-trip through `--output-format json` is not.
- [ ] Re-run each `scripts/live-verify/<host>.sh` verbatim once authed — they
      pick up from the benign probe automatically.

## 6. Record the demo GIF

- [ ] Follow `scripts/demo/HUMAN-CHECKLIST.md`: run
      `scripts/demo/keel-disable-trace.sh` in a clean 100–110 col terminal,
      record with `asciinema`, convert to GIF, drop at
      `docs/media/demo-disable-trace.gif`, and link it from the README demo
      section and `docs/landing.md` (both currently link the script, not a
      recording). Sanity-check against a fresh script run first — the rule
      count has drifted before.

## 7. Confirm the `windows-latest` CI job goes green

- [ ] The full suite is wired to run on `windows-latest`
      (`.github/workflows/ci.yml`), but no Windows host or green runner exists
      yet — all M3 Windows work is macOS-unit-verified only. Confirm the job
      actually passes on a real runner.
- [x] ~~`nanoid <3.3.17` audit finding may fail the audit step~~ **FIXED**
      (Phase-2 A6): root `overrides` pins `nanoid ^3.3.17` (resolved 3.3.18);
      `npm audit` now reports 0 vulnerabilities, so the audit step is clean.
      Exact push-to-verify steps: `session/v1/runbooks/windows.md`.

## 8. Release-content decisions (from MERGE-NOTE)

- [ ] **Skim the CHANGELOG's v1.0.0 entry with fresh eyes** against
      `session/v1/EVIDENCE/*.md` — a version-bump lane is exactly the kind of
      change that gets rubber-stamped.
- [x] ~~Two stale CLI console messages (Cursor/Codex "no blocking hooks —
      advisory only")~~ **FIXED** (Phase-2 A4): corrected to match the real hook
      wiring (Cursor auto-writes a `failClosed: true` blocking hook; Codex
      installs blocking scripts that are inert until manually registered).

## 9. Clean-checkout validation was run this lane — but re-confirm before publish

Done in the M6 audit (see AUDIT.md and the commit): full `npm test` green +
`npm publish --dry-run` for all three packages. Before the REAL publish:

- [ ] Re-run `npm test` (full, unpiped) and `npm publish --dry-run` per package
      on the exact commit you will publish.
- [ ] After any dry-run, run `git status` and confirm the tree is clean (guards
      the root-`package.json`-corruption bug) and inspect the CLI tarball's
      file list for the stray `.pyc` contaminant, not just exit code 0.
- [ ] The `windows-latest` CI leg (§7) is a human step — it cannot run on the
      macOS build machine.

## 10. ✅ DONE — the `bash -lc` code fix (closed BOTH §0's blocking finding and the `rm` one)

- [x] The one `command-normalizer.ts` fix (match `/^-[a-z]*c$/` for shell
      interpreters, so bundled short flags `-lc`/`-ic`/`-xc` trigger the `-c`
      body recursion) was landed by the supervisor. It closed both the
      (former) RELEASE-BLOCKING `keel disable` bypass in §0 AND the
      `bash -lc 'rm -rf /'` wipe (same mechanism). Regression-guarded by
      `shell-normalize-bypass.test.ts` (in `npm test`) and
      `scripts/redteam/round2.mjs` (exits 0). Full detail: `session/v1/AUDIT.md` §1.
