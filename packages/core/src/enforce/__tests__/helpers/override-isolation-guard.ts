import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Regression guard for the override-store test-isolation leak (AUDIT §8b).
 *
 * `EnforcementPipeline` (pipeline.ts) defaults `overrideStore` to a real
 * `FileRuleOverrideStore` rooted at `resolveHome()` (KEEL_HOME > HOME >
 * homedir()) whenever a test constructs one without supplying its own —
 * and every deny/warn/redirect verdict calls `overrideStore.consume()`
 * unconditionally (pipeline.ts's deny/warn branches), which touches disk
 * (mkdir + a lock file + a full read-modify-write of overrides.json) even
 * when no override was ever armed via `keel allow`. A test file that
 * forgets to stub `overrideStore` (or isolate HOME) therefore writes to
 * the DEVELOPER'S real `~/.keel/overrides.json` on every run.
 *
 * Investigation (2026-08-12) found eight such call sites in this package's
 * suite — glob-matching.test.ts, verification.test.ts (x2), oracle.test.ts
 * (x2), level-reload.test.ts (x3), stuck.test.ts, plus audit/ledger/
 * research.test.ts which were accidentally safe only because the rules
 * they exercise never reach a deny/warn/redirect verdict today. All eight
 * were fixed with an explicit `noopOverrideStore` stub (the same pattern
 * match-surface.test.ts already used). This is the tripwire that catches
 * the NEXT test file that forgets to.
 *
 * Implemented as vitest `globalSetup`/teardown — not a per-file
 * beforeAll/afterAll — because file execution order across a suite is not
 * guaranteed, so a per-file check could pass by accident if it happened to
 * run before the offending file. globalSetup runs once, in the main
 * process, before any test file/worker starts; its returned teardown runs
 * once after the entire run finishes, wrapping every file uniformly.
 *
 * Deliberately tolerant of concurrent, unrelated processes: this repo is
 * developed across several parallel git worktrees, each running its own
 * `npm test` (and leaving `keel daemon` processes running) against the
 * SAME real `~/.keel`. A sibling lane's own leak — or a real `keel allow`
 * the developer runs by hand mid-suite — must not flip this guard. So the
 * check only fails when the file's CONTENT stops being empty (still
 * absent, or still `{}`) AND differs from what it was before this run
 * started; an mtime-only check would be flaky under that pattern (the
 * store's write-then-rename on every consume() call touches mtime even
 * when it rewrites the same empty content).
 */

function overridesFile(): string {
  return join(process.env.KEEL_HOME || process.env.HOME || homedir(), '.keel', 'overrides.json')
}

function snapshot(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return 'unreadable'
  }
}

function isEmpty(content: string | null): boolean {
  if (content === null) return true
  try {
    const parsed = JSON.parse(content)
    return parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length === 0
  } catch {
    return false
  }
}

export default async function setup() {
  const file = overridesFile()
  const before = snapshot(file)

  return async () => {
    const after = snapshot(file)
    if (after === before) return // untouched, or rewritten byte-identical
    // Content-preserving touches (a deny/warn verdict's consume() rewrites
    // `{}` back to `{}`, bumping mtime with no semantic change) are
    // tolerated when the store was already empty on both sides — this is
    // the common, non-destructive case and flagging it would be flaky
    // under concurrent sibling-worktree test runs that legitimately do
    // the same thing to the same real file. What must never happen is a
    // PRE-EXISTING real armed override (a genuine `keel allow` the
    // developer ran by hand) silently changing or disappearing because an
    // unisolated test's synthetic rule_id happened to collide with it and
    // got consumed — that is checked unconditionally, regardless of
    // whether the resulting content happens to be empty.
    if (isEmpty(before) && isEmpty(after)) return
    throw new Error(
      `override-isolation guard: real ${file} changed during this test run and is no ` +
      `longer empty (before=${JSON.stringify(before)}, after=${JSON.stringify(after)}). ` +
      `Some EnforcementPipeline construction in this suite is missing an explicit ` +
      `overrideStore stub (or HOME isolation) and defaulted to the real ` +
      `FileRuleOverrideStore — see match-surface.test.ts's noopOverrideStore for the fix.`,
    )
  }
}
