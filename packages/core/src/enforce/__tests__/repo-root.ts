import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Locate the monorepo root from an arbitrary starting directory by walking
 * upward until `session/proposals` is found.
 *
 * Why not a fixed `../../../../..` count: packages/cli's build step copies
 * the ENTIRE packages/core/src tree (including __tests__) into
 * packages/cli/src/core (see packages/cli/package.json's build script), so
 * every test file under enforce/__tests__/ runs TWICE at two different
 * depths from the repo root — once from packages/core/src/enforce/__tests__
 * and once from packages/cli/src/core/enforce/__tests__ (one level deeper).
 * A hardcoded relative path is correct for exactly one of those two
 * locations and silently ENOENTs in the other (see session/EVIDENCE/
 * wave2-seq.md). Walking up to a known marker works from both.
 */
export function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'session', 'proposals'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`could not locate repo root (session/proposals marker) starting from ${startDir}`)
}
