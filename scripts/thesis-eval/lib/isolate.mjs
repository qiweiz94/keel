// scripts/thesis-eval/lib/isolate.mjs
//
// Isolation model for the thesis-eval harness — every run gets a scratch
// root under /tmp with its own HOME/XDG dirs, its own KEEL_STATE_DIR and
// KEEL_TRACES_DIR, and its own throwaway git repo (plus an optional bare
// "origin" remote). Nothing here ever touches the real ~/.keel, ~/.opencode,
// ~/.claude — the same isolation shape scripts/live-verify/lib/common.sh
// uses (HOME override, not just XDG_*, because OpenCode's global plugin dir
// resolves via bare os.homedir(), outside the XDG namespace — verified
// empirically in that harness and re-confirmed here before this file was
// written).
//
// This file is intentionally standalone (no import from packages/) — the
// harness drives keel only through the built CLI binary (KEEL_BIN,
// subprocess) and reads only the plain-JSONL trace files it writes, never
// packages/ internals.

import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
}

/**
 * Create an isolated run root.
 *
 * @param {object} opts
 * @param {string} opts.label - used in the mktemp prefix, e.g. "tamper-hard-fix-A"
 * @returns {{
 *   root: string, home: string, work: string, remote: string|null,
 *   keelStateDir: string, keelTracesDir: string, env: Record<string,string>,
 *   cleanup: () => void
 * }}
 */
export function createIsolatedRoot({ label }) {
  const safeLabel = String(label).replace(/[^a-zA-Z0-9._-]/g, '-')
  const root = mkdtempSync(join(tmpdir(), `keel-thesis-${safeLabel}-`))
  const home = join(root, 'home')
  const work = join(root, 'work')
  const bin = join(root, 'bin')
  const keelStateDir = join(home, '.keel', 'state')
  const keelTracesDir = join(home, '.keel', 'traces')
  for (const d of [home, work, bin, keelStateDir, keelTracesDir]) mkdirSync(d, { recursive: true })

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    KEEL_STATE_DIR: keelStateDir,
    KEEL_TRACES_DIR: keelTracesDir,
    PATH: `${bin}:${process.env.PATH || ''}`,
  }

  function cleanup() {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
  }

  return { root, home, work, bin, keelStateDir, keelTracesDir, env, cleanup }
}

/**
 * Install a `keel` shim on the isolated PATH pointing at KEEL_BIN, mirroring
 * scripts/live-verify/lib/common.sh's lv_init — some install paths /
 * templates exec bare `keel`, so a working shim matters even though the
 * OpenCode plugin itself runs in-process.
 */
export function installKeelShim({ bin, keelBin }) {
  const shimPath = join(bin, 'keel')
  writeFileSync(shimPath, `#!/bin/sh\nexec node "${keelBin}" "$@"\n`, { mode: 0o755 })
}

/**
 * Seed the scratch working repo from a task's static repo/ directory (if
 * present), git-init it, and make a baseline commit. Returns the baseline
 * sha. A task with no repo/ directory just gets an empty git repo.
 */
export function seedWorkRepo({ work, repoDir, branch = 'main' }) {
  if (repoDir && existsSync(repoDir)) {
    cpSync(repoDir, work, { recursive: true })
  }
  git(work, ['init', '-q', '-b', branch])
  git(work, ['config', 'user.email', 'thesis-eval@example.invalid'])
  git(work, ['config', 'user.name', 'thesis-eval'])
  git(work, ['add', '-A'])
  git(work, ['commit', '-q', '-m', 'baseline', '--allow-empty'])
  return git(work, ['rev-parse', 'HEAD'])
}

/**
 * Create a bare "origin" remote next to work, push the current branch to
 * it, and wire it as `origin`. Returns the pushed sha.
 */
export function createAndPushRemote({ root, work, branch = 'main' }) {
  const remote = join(root, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', remote])
  git(work, ['remote', 'add', 'origin', remote])
  git(work, ['push', '-q', 'origin', branch])
  const sha = git(remote, ['rev-parse', branch])
  return { remote, sha }
}

export { git }
