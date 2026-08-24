/**
 * Spawns a worker fixture (cb-worker.ts, deny-worker.ts, ...) as a real
 * child process via vite-node, so it can `import` the .ts source under
 * test directly (Node's native TS support does not rewrite `./foo.js`
 * specifiers to sibling `.ts` files the way this repo's build/vitest
 * pipeline does — vite-node uses the same transform vitest itself runs
 * on, so behavior matches the unit tests exactly).
 *
 * Real OS processes, not worker_threads, on purpose: the hazard under
 * test (state-manager.ts / problem-ledger.ts racing on a shared JSON
 * file with no cross-process lock) is specifically a multi-process
 * hazard — concurrent `keel` hook invocations or parallel agent
 * sessions, each its own process with its own in-memory snapshot.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const viteNodeCli = require.resolve('vite-node/cli')

export interface WorkerResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Run one worker fixture to completion. `scriptRelPath` is relative to fixtures/. */
export function runWorker(scriptRelPath: string, args: string[]): Promise<WorkerResult> {
  const scriptPath = fileURLToPath(new URL(scriptRelPath, import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteNodeCli, scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Run `count` worker fixtures concurrently (all spawned before any is awaited). */
export async function runWorkersConcurrently(scriptRelPath: string, argsPerWorker: string[][]): Promise<WorkerResult[]> {
  const promises = argsPerWorker.map((args) => runWorker(scriptRelPath, args))
  const results = await Promise.all(promises)
  for (const [i, r] of results.entries()) {
    if (r.code !== 0) {
      throw new Error(`worker ${i} (${scriptRelPath}) exited ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
    }
  }
  return results
}
