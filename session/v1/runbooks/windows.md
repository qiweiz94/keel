# Runbook — verify Windows (the one push-gated step)

**Status:** Windows support is *logic-complete + unit-covered on macOS + CI-configured*, but
**runtime-unverified** because macOS cannot run Windows and no Windows machine was in the build
loop. Confirming it means letting the `windows-latest` CI job run — which requires **pushing the
branch to GitHub** (your outward call; nothing has been pushed).

## What's already done (no action needed)
- `.github/workflows/ci.yml` runs the **full `npm test`** on a `os: [ubuntu, macos, windows-latest]`
  matrix (not lint-only) + `npm audit --audit-level=moderate`.
- The `nanoid` advisory that would have failed the audit step is fixed (root `overrides`, 0 vulns).
- Path semantics (separator / drive-letter / UNC / NTFS case) go through
  `packages/core/src/enforce/path-normalize.ts`, unit-tested with an explicit `win32` flavor.
- EBUSY teardown is handled (`file-lock.ts` retries unlink; `rmSafe()` across fixtures).
- CRLF handled via `.gitattributes` (eol=lf).

## The step (yours)
1. Push the branch: `git push -u origin v0.4-thesis` (or your release branch). This is outward —
   it puts the code on GitHub. If you'd rather not push `v0.4-thesis`, push a throwaway branch
   just to run CI.
2. Open the repo's **Actions** tab → the `CI` workflow run for that push → the **windows-latest**
   job.
3. **Green = Windows runtime-verified.** If it fails, the failure is the real Windows signal —
   capture it and we fix forward (the unit tests can't catch a Windows-only runtime issue).

## Known honest gap (documented, not a failure)
- `test:publish-check` is **deliberately skipped on windows-latest** (`if: matrix.os != 'windows-latest'`,
  ci.yml:67). It relies on a POSIX `#!/bin/bash` npm shim with no Windows equivalent; a real fix
  needs a Windows-native package-manager shim story, out of this pass's scope. A green windows job
  therefore verifies the enforcement engine on Windows, **not** the npm-shim publish path.

## Definition of "Windows verified"
The `windows-latest` job of a real CI run is green on `npm test` + `npx vitest run packages/cli` +
`npm run lint`. Then update `docs/integrations.md` / AUDIT to move Windows from
"runtime-unverified" to "CI-green on <run URL>".
