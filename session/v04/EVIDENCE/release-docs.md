# v0.4 release-docs lane — evidence + claim verification

Worktree: `keel-v04-releasedocs`, branch `v04-releasedocs`. Scope per binding
constraints: README.md, CHANGELOG.md, workspace `package.json` version fields,
`docs/*.md` (except `integrations.md`), `session/v04/EXPERIMENT.md` intro. No
enforcement source, rule YAML, or pipeline touched — confirmed by `git diff --stat`
below.

## MERGE + RELEASE — manual steps (NOT run by this lane)

This lane never runs `npm publish`, never pushes, never merges to `main`. What a
human runs, once satisfied, from a clean checkout of the integration branch that
contains this lane's commits plus every other `v04-*` lane's work merged in (this
worktree only contains `v04-releasedocs`'s own history on top of whatever `HEAD` was
when the worktree was created — check `git log --oneline main..HEAD` first to see
what's actually ahead before merging):

```bash
git checkout main && git pull
git merge --no-ff v04-releasedocs        # or the final integration branch, per whatever
                                          # merge order the other v04-* lanes settle on
npm ci && npm run build && npm run lint && npm test   # must be green — see below
git tag v0.4.0
git push origin main --tags
npm publish --workspace packages/core --access public
npm publish --workspace packages/cli --access public
npm publish --workspace packages/opencode-plugin --access public
# packages/mcp-server is package.json `"private": true` and marked DEPRECATED
# in its own description — intentionally never published, do not publish it.
```

GitHub release notes = the `## 0.4.0` section of `CHANGELOG.md`, pasted as-is.

## Claim → source verification

| Claim (as written in README/CHANGELOG/tiers.md) | Verified against | Result |
|---|---|---|
| `keel --version` reports 0.4.0 after the bump | `node packages/cli/dist/index.js --version` after `npm run build` | `0.4.0` |
| `keel install` ships 43 default rules | `grep -c '^  - id:'` over `DEFAULT_RULES_YAML` in `packages/cli/src/commands/install.ts`; cross-checked live via `keel status` → `Rules (global): 43 rules` | 43, exact |
| 12 rules ship `level: protect` (Tier 1 floors) | `grep -c '^ *level: protect *$'` over the same extracted YAML; live via `keel level protect` → `keel level sprint` dial-diff printing `12 \`level: protect\` floor(s) unchanged: ...` naming all 12 ids including `no-self-protection-write` | 12, exact — was 11 before v0.4 added `no-self-protection-write` as a floor |
| 9 rules ship `mode: observe` (Tier 3) | `grep -c '^ *mode: observe *$'` (exact field match, not prose mentioning "mode: observe" inside a rule's `rationale:` string, which inflates a loose grep to 14) | 9, exact — matches ROADMAP.md's independent "9 rules total" for problem-solving rules |
| Tier 2 = 43 − 12 − 9 = 22 rules | arithmetic + direct table row count in `docs/tiers.md` | 22, exact |
| `Active at current dial: 42 of 43` (sprint, one Tier-3 rule with `level: balanced` deactivates) | live: `keel install --project` → `keel level protect` → `keel level sprint` → `keel status` in an isolated `HOME` | `42 of 43`, exact — was `41 of 42` pre-bump |
| `keel serve` exposes 7 MCP tools (`keel_check`, `keel_audit`, `keel_requirements`, `keel_research`, `keel_fetch`, `keel_search_cache`, `keel_hypothesis`) | `grep "name: '"` over `packages/cli/src/mcp/server.ts` (the file `serve.ts` actually dynamically imports) AND live: piped `tools/list` JSON-RPC into `keel serve`, read back all 7 names | 7, exact. Note: `packages/mcp-server` (a separate, `private`/deprecated package) implements only 2 of the 7 — not what README/`keel serve` refers to; not corrected here, out of this lane's ownership and not a claim this lane makes |
| Supported hosts table (8 hosts, install flags, block mechanism, Verified column) | Byte-compared against `docs/integrations.md`'s "Native enforcement" table (owned by another lane) | Matches exactly, no change needed |
| Experiment headline: guarded 0% harm vs unguarded 75% harm, N=12 harm-eliciting tasks; full battery N=10/arm guarded 0%/100% vs unguarded 20%/70% | `session/v04/EXPERIMENT.md` §"Result (N=10 per arm)" and §"Strengthening results (appended)" | Matches exactly as given in the task brief |
| `session/v04/EXPERIMENT.md` intro already reconciled to the N=12 result, no "small-N" contradiction | `grep -in "small.n"` over the file — no hits; intro explicitly says "the decisive result is the harm-eliciting-task repetition (N=12/arm) ... Read the confidence limits" | Already consistent (fixed upstream in commit `930c2fa`, before this lane started) — no edit made |
| SECURITY.md catch-rate table: `no-rules-tampering` 88%, `no-self-protection-write` 93% | Read `SECURITY.md` directly (not owned/edited by this lane, read-only verification) | Matches exactly |
| npm-published versions before this bump were 0.2.2 (cli) / 0.1.9 (core) / 0.1.9 (opencode-plugin), NOT "0.3.x" as the task brief assumed | `npm view @get-keel/cli version`, `npm view @get-keel/core version`, `npm view @get-keel/opencode-plugin version` — all three match the pre-bump local `package.json` values exactly; no `v0.3.0` git tag exists (`git tag` tops out at `v0.2.2`) | The task brief's "current version is 0.3.x" does not match measured reality. All the work described as "v0.3" and "v0.4" in commit messages/session docs was never released as an intermediate version — it lands in this single 0.4.0 bump from the last real release, 0.2.2. Flagging this rather than silently going along with the wrong premise. |
| `@get-keel/mcp-server` is not on the npm registry | `npm view @get-keel/mcp-server version` → 404 | Confirmed; matches its own `package.json` (`"private": true`, description prefixed `(DEPRECATED — use 'keel serve' instead)`). README's Trust section already correctly omits it — no fix needed there. |
| Full suite green after the version bump | `npm run build`, `npm run lint`, `npm test` from repo root, post-bump | build clean; lint clean (`tsc --noEmit` × 3 packages); tests: core 30/30 files (496 passed, 2 skipped), cli 36/36 files (674 passed, 14 skipped), mcp-server no tests (pass), opencode-plugin all PASS |
| Lockfile stays valid after the dependency-range edits (`@get-keel/core` `^0.1.9`→`^0.4.0` in cli and mcp-server) | `npm ci` from repo root after `npm install` regenerated `package-lock.json` | exit 0, clean install, no lockfile↔package.json disagreement |
| `npm run test:publish-check` (root script, run by `.github/workflows/ci.yml` on every PR — not part of `npm test`) still passes after the bump | ran it directly; also read `scripts/check-published.mjs` and `scripts/check-published.test.mjs` | Exit 0. This script is a **self-contained mocked test** of retry/fail-closed logic (PATH-shimmed fake `npm`), not a real registry lookup — it doesn't depend on 0.4.0 actually being published. The real registry check (`scripts/check-published.mjs` run un-mocked) only runs post-publish inside `.github/workflows/release.yml`'s `release` job, after the `npm publish` steps — confirmed by reading that file. Running it directly, un-mocked, right now correctly fails (`E404`, since 0.4.0 isn't published yet) — that failure is expected and by design, not a defect this bump introduced. |

## Not touched, flagged for the owning lane instead of silently fixed

- `ROADMAP.md` (repo root, not under `docs/`, not in this lane's ownership list) still
  says "Shipped (v0.2.x)" and lists "a rule catalog ... and a promotion workflow"
  under **Planned → Later**, even though `keel promote` and the tiered catalog
  shipped in this release. Left alone — out of scope for this lane.
- `SECURITY.md` (not owned by this lane) has an internal inconsistency pre-dating
  this pass: its "Keel controls are user-owned" section (around the `no-rules-tampering`
  paragraph) still describes the mode/match floor-override gap as an open residual
  ("closing the mode/match axes is a pending `mergeRules` engine change"), while its
  own "Measured bypass resistance" section higher up documents that exact gap as
  **CLOSED** in v0.4 (`860b60e`/`248bbbe`/`7f4493a`). Read-only per binding
  constraints — flagged here rather than edited.
- `SECURITY.md`'s "Supported Versions" table still reads `0.2.x ✅` only. This lane
  is bumping every workspace package to 0.4.0 — before this release ships, whoever
  owns `SECURITY.md` needs to add `0.4.x` (and decide whether `0.2.x` still gets
  security fixes). Shipping 0.4.0 with a policy that only names `0.2.x` as supported
  is a real gap, not cosmetic — flagged, not fixed, since `SECURITY.md` is outside
  this lane's ownership.
- README's "Rule types:" line lists 18 of the 21 actual `RuleType` values (missing
  `mcp`, `inheritance`, `meta`) — not fixed, because the sentence doesn't assert a
  count or claim exhaustiveness ("Rule types: X, Y, Z, plus the problem-solving types
  below"), so it isn't a false quantified claim, just an incomplete illustrative list.
  Noted for whoever next touches that line.

## Files changed by this lane

```
CHANGELOG.md                          new ## 0.4.0 section
README.md                             43-rule / 12-floor counts; new "Measured, not asserted" section
docs/tiers.md                         42→43, 11→12, added no-self-protection-write row,
                                       fixed two live-captured CLI output quotes
package.json                          0.1.0 → 0.4.0
packages/core/package.json            0.1.9 → 0.4.0
packages/cli/package.json             0.2.2 → 0.4.0; @get-keel/core dep ^0.1.9 → ^0.4.0
packages/mcp-server/package.json      0.1.2 → 0.4.0; @get-keel/core dep ^0.1.4 → ^0.4.0
packages/opencode-plugin/package.json 0.1.9 → 0.4.0
package-lock.json                     regenerated by `npm install` after the bumps (8 lines)
session/v04/EXPERIMENT.md             read-only verification, no edit needed (already reconciled)
```

No changes to `packages/*/src/enforce/`, any rule YAML, `pipeline.ts`, or
`docs/integrations.md`.
