> **Authoritative human checklist: `session/v1/HUMAN-CHECKLIST.md`.** The
> human decisions in this note (publish, CHANGELOG skim, the two stale console
> messages, demo GIF) are folded into that consolidated file.

# Merge note — v1-m5-release → main (not performed)

This branch (`v1-m5-release`, based on `v0.4-thesis` with all v1 correctness/
Windows/verification/host-breadth lanes already merged in) is release-ready for
`v1.0.0`: version bumped 0.4.0 → 1.0.0 in every workspace `package.json` and every
inter-package dependency range that referenced it, `README.md`/`CHANGELOG.md`/
`docs/tiers.md`/the integration guides reconciled to measured reality (including a
genuine rule-count drift caught and fixed, 43 → 45, verified live via `keel status`),
a runnable demo script added at `scripts/demo/keel-disable-trace.sh` reproducing the
thesis experiment's strongest single trace, and the full `npm test` suite green
(1414 tests passed across `core`/`cli`/`mcp-server` — 597/811/6 — plus 62
opencode-plugin checks, 16 skipped, 0 failed; the cli package's skip count has been
observed to vary by 1 between runs on environment-dependent tests such as the
TTY-gated dashboard check, never a failure) after every change, alongside a clean
`npm run build` with zero drift in the generated
`packages/cli/templates/keel-enforce.js`. `npm publish --dry-run` was run for all
three publishable packages (`@get-keel/core`, `@get-keel/cli`,
`@get-keel/opencode-plugin`) to confirm the exact tarball contents, and this
inspection surfaced two real, previously-undetected release-pipeline bugs, both now
fixed and verified: `scripts/check-tarballs.mjs` and `scripts/check-published.mjs`
both ran `npm init -y --prefix <dir>` from the repo root, which on the npm version
in this environment silently ignores `--prefix` and overwrites the ROOT workspace
`package.json` instead (reproduced in isolation, confirmed via npm's own "Wrote to
.../package.json" output naming the repo root) — both scripts now write a trivial
package.json directly instead of shelling out to `npm init`; and the CLI tarball
was carrying a stray, Python-version-specific `.pyc` bytecode cache file generated
by `hermes-adapter.test.ts`'s compile check, which `npm`'s `files` allowlist
includes verbatim regardless of `.gitignore`/`.npmignore` — fixed at the source by
redirecting that test's compile output to a throwaway temp path instead of
suppressing it via ignore files (which do not apply to explicitly-listed `files`
directories, confirmed empirically). See `session/v1/EVIDENCE/m5-release.md` for
the full reproduction and verification detail on both. Nothing was actually
published, nothing was pushed, and this branch was not merged to `main` —
per this lane's explicit scope, that final step (`npm publish` for real, then `git
push`/merge) is a deliberate human action, not something this lane performs. Before
taking that step, a human should: (1) skim the CHANGELOG's v1.0.0 entry against
`session/v1/EVIDENCE/*.md` once more with fresh eyes, since a version-bump lane is
exactly the kind of change that's easy to rubber-stamp; (2) decide whether the two
still-stale CLI console messages this lane found but deliberately did not touch
(Cursor's and Codex CLI's install-time "no blocking hooks — advisory only" log
lines, both contradicted by the real hooks those same install paths wire — see
`docs/integration-guides/README.md`'s Coverage notes) should be fixed before or
after this release; and (3) record the recording of the demo GIF
(`scripts/demo/HUMAN-CHECKLIST.md`) as a tracked follow-up, since it's the one piece
of this lane's scope that cannot be automated.
