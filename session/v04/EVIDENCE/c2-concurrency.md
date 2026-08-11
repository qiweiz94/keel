# v0.4 C2 — cross-process concurrency safety (StateManager / ProblemLedger)

Worktree: keel-v04-concurrency, branch v04-concurrency. Owned files: `packages/core/src/enforce/state-manager.ts`, `packages/core/src/enforce/problem-ledger.ts` (+ tests). Added `packages/core/src/enforce/file-lock.ts` as a shared primitive used by both.

## The bug

Neither class re-read its backing JSON file before mutating. Each held one in-memory snapshot loaded at construction (or at the previous mutation); every mutating method (`markFirstTime`, `recordCircuitBreaker`, `checkRateLimit`, `setVerification`, `clearVerification`, `setOracleFailure` on StateManager; `recordOutcome`, `addHypothesis`, `recordDiagnosis`, `falsifyStaleHypotheses` on ProblemLedger) mutated that stale snapshot and wrote the WHOLE file back via atomic tmp+rename. Atomic rename prevents corruption, not lost updates: two processes racing produce two independent snapshots, and whichever writes second silently erases whatever the first process added.

## The fix — file-lock.ts

`packages/core/src/enforce/file-lock.ts`: an O_EXCL lockfile (`openSync(path, 'wx')`) per protected resource.

- **Acquire**: `openSync(lockPath, 'wx')` — the OS arbitrates the race atomically; the loser gets `EEXIST` and retries.
- **Stale reclaim**: a lock older than `staleMs` (default 5000ms) is assumed to belong to a crashed/killed holder and is force-reclaimed (`unlinkSync` + retry), so one dead process can't wedge every future writer.
- **Backoff**: full jitter — `Math.random() * backoff`, backoff doubling from 4ms to a 60ms cap — not plain exponential backoff. Plain (unjittered) backoff synchronizes retries under N-way contention: every waiter wakes at the same instant, loses to the same winner again, and the group's total wait grows with N. This was measured directly (see "tuning" below) before jitter was added.
- **Bounded wait**: `timeoutMs` (default 3000ms) caps total time spent trying to acquire.
- **FAIL-SAFE CHOICE (documented in file-lock.ts and in both consumers' class docstrings)**: if the lock cannot be acquired within `timeoutMs`, the read-modify-write body **still runs, unlocked**, rather than being skipped or hung. Rationale: a skipped write is a warn-once/circuit-breaker/ledger entry that silently never happened — worse than a narrow re-introduction of the exact race this module exists to close. A hang blocks the agent's tool call indefinitely — also unacceptable for an enforcement hook. Losing the lock only matters in the (bounded-probability, already-rare-given-the-stale-reclaim) case of sustained contention past the timeout.

`sleepSync` blocks the thread via `Atomics.wait` on a throwaway `SharedArrayBuffer` (falls back to a spin loop if unavailable) — kept synchronous deliberately, matching the existing synchronous `readFileSync`/`writeFileSync` cycle in both classes rather than forcing every caller through async/await.

## Wiring into StateManager and ProblemLedger

**StateManager**: each state slice (`deny-first-time`, `circuit-breaker`, `rate-counts`, `verification`, `oracle-failures`) already lived in its own JSON file — kept that, added a `<file>.lock` per slice. `load()` was split into per-slice `loadX()` helpers (with their existing TTL-cleanup logic intact) so a mutating method can do `withSliceLock(name, () => { this.X = this.loadX(); mutate; this.saveFile(...) })` — lock, fresh reload, mutate, save, unlock, per call.

**ProblemLedger**: single `ledger.json`, one `ledger.json.lock`. Added `private withLock<T>(fn)` that acquires the lock, calls `this.load()` (fresh from disk), then runs `fn`. Every mutating method's body now runs inside `withLock`. Also fixed a real (independent) bug found while touching this file: `reloadIfChanged()`'s mtime comparison used `new Date().getTime()` (wall-clock "now") instead of the file's actual mtime (`statSync(path).mtimeMs`) — it happened to "work" only by accident (comparing two different "now"s is almost always unequal, so it reloaded almost every call regardless of whether the file had actually changed). Not load-bearing for the lost-update fix (mutations reload unconditionally under the lock regardless of this heuristic) but incorrect and now corrected for the read-only freshness path (`activeProblemKey`, `hasFreshHypothesis`, `hasFreshDiagnosis`).

Public fields (`sm.denyFirstTime`, `sm.circuitBreaker`, `sm.rateCounts`, `sm.verification`, `sm.oracleFailures`) stay in sync — `pipeline.ts` reads them directly (`sm.circuitBreaker[cbKey]`, `sm.rateCounts[rateKey]`) — verified by grep before touching anything; no call site required a shape change.

## Tests

New: `packages/core/src/enforce/__tests__/state-manager-concurrency.test.ts`, `.../ledger-concurrency.test.ts`, and worker fixtures under `.../__tests__/fixtures/` (`cb-worker.ts`, `deny-worker.ts`, `ledger-counter-worker.ts`, `ledger-distinct-worker.ts`, `spawn-worker.ts`).

Real OS child processes (not `worker_threads`) via `vite-node` (already a monorepo devDependency; added as an explicit `packages/core` devDependency since the fixtures import it directly — no NEW dependency, just declaring an existing one). Each worker imports `state-manager.ts` / `problem-ledger.ts` directly and races 5 concurrent processes against ONE shared temp `KEEL_STATE_DIR` / `ledger.json` path:

1. `recordCircuitBreaker` — 5 procs × 40 increments on the SAME key → asserts final `count === 200`.
2. `markFirstTime` — 5 procs × 20 DISTINCT keys each → asserts all 100 keys present (dropped-entry check, not just count).
3. `recordOutcome` (ProblemLedger) — 5 procs × 40 failing outcomes on the SAME `(cwd, command)` → asserts `failures === 200`.
4. `recordOutcome` — 5 procs × 20 DISTINCT `cwd`s each → asserts all 100 problem keys individually present with `failures === 1` each (not just a count match, which a swap-not-drop bug could pass).

### Red → green

Proved the tests actually exercise the lock by temporarily neutering `acquireLock()` (`return false` as the first line — no serialization, every mutator runs unlocked, i.e. exactly pre-fix behavior) and re-running the circuit-breaker probe manually 3 times, 5 procs × 50 increments each (expected 250):

```
trial 1: {"race-rule:Bash":{"count":113,...}}
trial 2: {"race-rule:Bash":{"count":36,...}}
trial 3: {"race-rule:Bash":{"count":138,...}}
```

Every trial lost the majority of updates — confirms the race is real and reproducible, not theoretical. Reverted the patch; the *same* probe (5×50) landed at exactly 250 on the next run. Patch was never committed (`git diff` on `file-lock.ts` was empty afterward — the file is untracked/new, and the revert was verified by re-reading the file's `acquireLock` body).

### Tuning note

First pass used `timeoutMs=2000`, plain exponential backoff (4ms→40ms cap). The automated vitest suite (5×40 = 200 lock acquisitions on one lockfile, tight loop, no delay) was flaky: one run landed at 199/200. Root cause: unjittered backoff synchronizes retries under contention (thundering herd), occasionally pushing a waiter past the timeout, which correctly triggered the documented fail-safe (proceed unlocked) — and that unlocked write collided. Fixed by widening the timeout to 3000ms, the backoff cap to 60ms, and switching to full jitter (`Math.random() * backoff`) instead of plain exponential. Re-ran the automated suite 8 consecutive times after the change: 8/8 green, individual test durations typically 550–700ms under a quiet system. This is a genuine robustness improvement to the lock (real deployments also have many-way contention, e.g. several parallel agent sessions each hooking on every tool call), not just a test-fit hack — the underlying fail-safe behavior (proceed unlocked past timeout) is unchanged and still documented as the intended trade-off, just triggered far less often now.

## Suite results

- `npm ci` from repo root: clean (`vite-node` devDependency addition confirmed compatible with the lockfile).
- `packages/core`: `npx tsc --noEmit` clean. `npx vitest run` → **478 passed, 2 skipped** (28 files) — baseline was ~474; +4 are the new concurrency tests, no regressions.
- `npm run build` (root): clean; `packages/cli/src/core/enforce/{file-lock,state-manager,problem-ledger}.ts` regenerated as expected (gitignored copy step, not hand-edited). `packages/cli/templates/keel-enforce.js` was also regenerated by the root build (opencode-plugin bundle) as an unrelated side effect of running `npm run build --workspaces`; reverted with `git restore` before committing since it's explicitly out of this lane's scope and not touched by any source file I own.
- `packages/cli`: `npx vitest run` → **674 passed, 14 skipped** (36 files) — matches stated baseline, no regressions.
- `npm run lint` (core + cli + mcp-server): clean, no new type errors.
- Blanket run from repo root: `KEEL_STATE_DIR=$(mktemp -d) npm test` → core 478/2-skip, cli 674/14-skip, mcp-server no tests (pass), opencode-plugin load-test all PASS. Full monorepo green under a single shared external `KEEL_STATE_DIR`.

## Files touched

- `packages/core/src/enforce/file-lock.ts` (new)
- `packages/core/src/enforce/state-manager.ts` (locking + per-slice reload-before-mutate)
- `packages/core/src/enforce/problem-ledger.ts` (locking + reload-before-mutate + `reloadIfChanged` mtime fix)
- `packages/core/src/enforce/__tests__/state-manager-concurrency.test.ts` (new)
- `packages/core/src/enforce/__tests__/ledger-concurrency.test.ts` (new)
- `packages/core/src/enforce/__tests__/fixtures/{spawn-worker,cb-worker,deny-worker,ledger-counter-worker,ledger-distinct-worker}.ts` (new)
- `packages/core/package.json` (+ `vite-node` devDependency, already used monorepo-wide)
- `package-lock.json` (lockfile update for the above, 1 line)

No changes to `rule-parser.ts`, `pipeline.ts`, `types.ts`, `DEFAULT_RULES_YAML`, or any file under `packages/cli/src/core/` / `templates/keel-enforce.js`.
