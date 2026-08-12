# Keel v1.0.0 — authoritative human checklist

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

## 0. 🚩 RELEASE-BLOCKING DECISION — `bash -lc 'keel disable'` turns keel off

**Decide this BEFORE publishing (§1).** The M6 red-team confirmed that
`bash -lc 'keel disable'` (also `keel uninstall` / `keel enforce`) is **allowed
at every dial** and turns keel off in a single agent command — defeating the
`keel-control-gate` floor whose whole purpose is keeping keel armed, and
falsifying SECURITY.md's (now-corrected) categorical "a compromised agent
cannot turn keel off" promise. Once keel is off, every other floor is moot: a
master-key bypass. Reachable in one command, no pre-existing config, at every
dial. Reproduction + regression guard: `scripts/redteam/round2.mjs`; full
detail and the exact mechanism: `session/v1/AUDIT.md` §1.

This audit lane did NOT fix it — the fix is a `command-normalizer.ts` change
(teach `interpreterFlags`/the recursion trigger to recognize bundled short
flags like `-lc`/`-ic`) whose correctness across shell flag-bundling semantics
cannot be made small-and-well-tested this late without regression risk to a
security matcher, and this lane is barred from that class of late change.

- [ ] **Decide: fix before v1.0.0, or ship with this documented and fix in
      1.0.1.** The audit's recommendation is to fix before a public launch,
      since the "you can't turn keel off" promise is a headline claim; but the
      ship/no-ship call is yours. If shipping as-is, ensure the corrected
      SECURITY.md text (self-protection section) is what goes public.
- [ ] The related `bash -lc 'rm -rf /'` finding (same mechanism) is assessed
      NOT blocking (indirect exec, disclaimed class) — the same fix closes it.

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

## 3. Merge `v1-m6-audit` / the release branch to `main`

- [ ] This audit lane never merges or pushes. Fast-forward or merge the
      audited branch to `main` yourself. Confirm `packages/cli/templates/
      keel-enforce.js` is committed and in sync (`release.yml` runs
      `git diff --exit-code` on it).

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
- [ ] **OpenClaw / Hermes** — docs-confidence only; wire the plugin/daemon
      config and run a real agent turn to test block/warn/approve end to end.
      Check the openclaw#5943 `before_tool_call` finding.
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
- [ ] A pre-existing `nanoid <3.3.17` `npm audit` finding may fail that job's
      audit step independently of any path-matcher correctness — decide
      whether to bump the dependency before or after release so a red job
      isn't misread. Details: `session/v1/EVIDENCE/m3-windows.md`.

## 8. Release-content decisions (from MERGE-NOTE)

- [ ] **Skim the CHANGELOG's v1.0.0 entry with fresh eyes** against
      `session/v1/EVIDENCE/*.md` — a version-bump lane is exactly the kind of
      change that gets rubber-stamped.
- [ ] **Two stale CLI console messages** — Cursor's and Codex CLI's
      install-time "no blocking hooks — advisory only" log lines are
      contradicted by the real hooks those install paths wire (see
      `docs/integration-guides/README.md`). Decide whether to fix before or
      after release.

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

## 10. The `bash -lc` code fix (closes BOTH §0's blocking finding and the `rm` one)

- [ ] The one `command-normalizer.ts` fix (recognize bundled interpreter short
      flags `-lc`/`-ic`/`-xc` so the `-c` body recursion fires) closes both the
      RELEASE-BLOCKING `keel disable` bypass in §0 AND the non-blocking
      `bash -lc 'rm -rf /'` wipe (same mechanism). It is the highest-leverage
      remaining hardening. This item is the engineering follow-up; §0 is the
      ship/no-ship decision. Reproduction + regression guard:
      `scripts/redteam/round2.mjs`. Full detail: `session/v1/AUDIT.md` §1.
