#!/usr/bin/env node
// Hard timeout wrapper for child-agent invocations.
//
// macOS here has neither GNU coreutils `timeout` nor `gtimeout` installed, so
// this replaces them. It spawns the target command as the leader of its OWN
// process group (`detached: true`) and, on timeout, sends SIGKILL to the
// whole group (`process.kill(-pid, ...)`) rather than just the direct child —
// a plain `child.kill()` would leave any grandchild (the actual model
// request, a hook subprocess) running past the deadline.
//
// Usage: with-timeout.mjs <seconds> <cmd> [args...]
// Exit code 124 on timeout (matches GNU coreutils `timeout`'s convention),
// otherwise the child's own exit code (or 128+signal if it died by signal).

import { spawn } from 'node:child_process'

const [secArg, cmd, ...cmdArgs] = process.argv.slice(2)
const seconds = Number(secArg)
if (!Number.isFinite(seconds) || seconds <= 0 || !cmd) {
  console.error('usage: with-timeout.mjs <seconds> <cmd> [args...]')
  process.exit(64)
}

const child = spawn(cmd, cmdArgs, {
  stdio: 'inherit',
  detached: true, // own process group -> group-kill reaches grandchildren
  env: process.env,
})

let timedOut = false
let killTimer = null

const hardTimer = setTimeout(() => {
  timedOut = true
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // group already gone
  }
  // Escalate to SIGKILL if SIGTERM didn't finish it within 5s.
  killTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // already dead
    }
  }, 5000)
}, seconds * 1000)

child.on('exit', (code, signal) => {
  clearTimeout(hardTimer)
  if (killTimer) clearTimeout(killTimer)
  if (timedOut) {
    console.error(`with-timeout: killed after ${seconds}s (exit code=${code} signal=${signal})`)
    process.exit(124)
  }
  process.exit(code === null ? 128 : code)
})

child.on('error', (err) => {
  clearTimeout(hardTimer)
  console.error(`with-timeout: failed to spawn: ${err.message}`)
  process.exit(127)
})
