import { spawn } from 'node:child_process'
import chalk from 'chalk'
import { getProcessIdentity, writeProvisionalEntry, upgradeEntry, removeEntryIfMatches, readRunStateEntry } from './run-state.js'

const IDENTITY_RETRY_ATTEMPTS = 15
const IDENTITY_RETRY_DELAY_MS = 20

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `keel run <agent-cmd...>` — supervises an agent process so `keel halt
 * --kill` can reach a command that is already executing, not just calls
 * that go through a keel hook (the gap `keel halt`'s own header comment
 * names as its known limitation).
 *
 * POSIX only. `detached: true` makes the child the leader of a brand-new
 * process group (so `process.kill(-pid, signal)` can later reach the whole
 * group, not just the immediate child) — this is a POSIX process-group
 * semantic Node exposes directly on Linux/macOS; there is no Windows
 * equivalent without native job-object bindings this codebase does not
 * ship, and this repo's own Windows CI only runs lint (nothing here could
 * be verified there). On win32 this degrades to a plain, unsupervised
 * spawn — the agent still runs, `keel halt --kill` will simply have
 * nothing to find — rather than refusing to run at all.
 *
 * KNOWN LIMITATION, not fixed here: `detached: true` puts the child in a
 * background process group relative to the CONTROLLING TERMINAL, even
 * though it inherits the terminal's stdio (`stdio: 'inherit'`). On POSIX,
 * a background-group process that tries to READ from the terminal receives
 * SIGTTIN and stops — Node cannot call `tcsetpgrp()` to hand the terminal
 * to the child's group, so an interactive agent that reads stdin (a
 * password prompt, a "press y to continue", an actual chat REPL) can hang
 * the moment it tries. This could not be verified in this sandboxed
 * environment (no interactive TTY, and the task's own constraints forbid
 * spawning a real long-running/interactive process to check). Piping
 * stdin through the parent (`stdio: ['pipe', 'inherit', 'inherit']` +
 * manually forwarding `process.stdin`) would dodge SIGTTIN but makes
 * `isatty(0)` false inside the child, which changes some agents' own
 * behavior (many CLIs branch on TTY detection) — an equally real trade,
 * not a strict improvement. Flagged here rather than silently guessed at;
 * see this change's report for the same note.
 */
export async function runCommand(agentCmd: string[]): Promise<void> {
  if (process.platform === 'win32') {
    console.log(chalk.yellow('  keel run: process supervision (keel halt --kill) is POSIX-only in this release.'))
    console.log(chalk.dim('  Running the agent command normally, without supervision.'))
    const child = spawn(agentCmd[0], agentCmd.slice(1), { stdio: 'inherit' })
    const code = await new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 1))
      child.on('error', (err) => {
        console.error(chalk.red(`  keel run: failed to start "${agentCmd[0]}": ${err.message}`))
        resolve(1)
      })
    })
    process.exitCode = code
    return
  }

  const child = spawn(agentCmd[0], agentCmd.slice(1), {
    detached: true,
    stdio: 'inherit',
  })

  let pid: number | undefined
  let recordedStartedAt: string | null = null

  // Gate the state-file write on the 'spawn' event (exec confirmed
  // succeeded), not the synchronous return of spawn() — a fork-succeeded/
  // exec-failed process still gets a pid from Node before 'error' fires,
  // and recording that pid would let a later `keel halt --kill` try to
  // verify a process that was never really the agent.
  const spawned = new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true))
    child.once('error', (err) => {
      console.error(chalk.red(`  keel run: failed to start "${agentCmd[0]}": ${err.message}`))
      resolve(false)
    })
  })

  if (!(await spawned)) {
    process.exitCode = 1
    return
  }

  pid = child.pid
  if (pid === undefined) {
    console.error(chalk.red(`  keel run: spawned but no pid was assigned for "${agentCmd[0]}"`))
    process.exitCode = 1
    return
  }

  // Detached on POSIX makes the child the leader of its own new process
  // group, so its pgid is always its own pid — this is an OS guarantee for
  // a `detached: true` spawn, not something worth an extra `ps` round trip
  // to confirm.
  const pgid = pid

  // Provisional entry first (pid/pgid/command known, identity not yet
  // read) — `keel halt --kill` refuses to signal anything still marked
  // `unverified`, so a kill attempt that lands in the tiny window between
  // spawn and the identity read below simply does nothing rather than
  // trusting an unconfirmed pid.
  writeProvisionalEntry(pid, pgid, agentCmd)
  recordedStartedAt = readRunStateEntry(pid)?.started_at ?? null

  let identity = null
  for (let i = 0; i < IDENTITY_RETRY_ATTEMPTS; i++) {
    identity = getProcessIdentity(pid)
    if (identity) break
    await sleep(IDENTITY_RETRY_DELAY_MS)
  }

  if (identity) {
    upgradeEntry(pid, identity)
  } else {
    console.error(chalk.yellow(`  keel run: could not read process identity for pid ${pid} — 'keel halt --kill' will not be able to verify (and therefore will refuse to target) this run.`))
  }

  // Ctrl-C in the controlling terminal reaches `keel run` (the foreground
  // process) but NOT the detached child's own group — forward it
  // ourselves, or a user's Ctrl-C only kills the supervisor and orphans
  // the still-running supervised agent, exactly the failure this feature
  // exists to prevent.
  const forward = (signal: NodeJS.Signals) => {
    try { process.kill(-pgid, signal) } catch { /* already gone */ }
  }
  const onSigint = () => forward('SIGINT')
  const onSigterm = () => forward('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  const exitCode = await new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve(code !== null ? code : (signal ? 1 : 0))
    })
    child.on('error', (err) => {
      console.error(chalk.red(`  keel run: agent process error: ${err.message}`))
      resolve(1)
    })
  })

  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)

  // Guarded removal: only clears THIS entry (matched by pid + the
  // started_at this run itself wrote), never a different pid's entry —
  // concurrent `keel run` processes each own their own key.
  if (recordedStartedAt) removeEntryIfMatches(pid, recordedStartedAt)

  process.exitCode = exitCode
}
