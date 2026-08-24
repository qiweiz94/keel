import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { resolveHome } from '../core/home.js'
import { killSupervisedRuns, DEFAULT_KILL_GRACE_MS, type KillResult } from './run-kill.js'
import type { RunStateEntry } from './run-state.js'

// Same resolveHome()-based resolution as disable.ts's disableFilePath() —
// the exact HOME-vs-KEEL_HOME split-brain bug fixed there (a bare
// process.env.HOME would silently miss a KEEL_HOME-redirected install)
// applies identically to the halt sentinel, so this MUST go through
// resolveHome(), never process.env.HOME directly.
function haltFilePath(): string {
  return join(resolveHome(), '.keel', 'HALTED')
}

/**
 * Write the halt sentinel. Split out of haltCommand() so a future rule
 * type (a session-runaway trip, a token/dollar budget rule) can trigger a
 * halt programmatically from wherever it lives, without duplicating the
 * write. NOT currently called from packages/core/src/enforce/pipeline.ts —
 * core cannot import from this CLI package (the build direction is
 * cli -> core, via the cpSync('../core/src', './src/core') step in this
 * package's build script; the reverse import would break both the
 * build and the opencode-plugin esbuild bundle). Wiring a rule-triggered
 * halt is a separate change with its own blast radius (a false positive on
 * an unbuilt rule would latch deny-everything until a human runs `keel
 * resume`) and is deliberately left out of this change.
 *
 * Idempotent: calling this while already halted just overwrites the
 * sentinel with the new reason/timestamp — it never errors, and it never
 * un-halts as a side effect of being called again.
 */
export function haltSession(reason: string): void {
  const haltDir = join(resolveHome(), '.keel')
  if (!existsSync(haltDir)) {
    mkdirSync(haltDir, { recursive: true })
  }
  const state = {
    halted_at: new Date().toISOString(),
    reason: reason || 'Manual halt',
    // Deliberately false, and deliberately the only shape this field ever
    // takes — see haltCommand()'s own comment for why a halt must never
    // carry a TTL or restart-clears-it escape hatch the way `keel disable`
    // does.
    auto_clear_on_restart: false,
  }
  writeFileSync(haltFilePath(), JSON.stringify(state, null, 2))
}

function describeEntry(entry: RunStateEntry): string {
  const cmd = entry.command.join(' ')
  return `pid ${entry.pid} (${cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd})`
}

/** Render one kill outcome as a human-facing line. Exported for testing. */
export function describeKillOutcome(result: KillResult): string {
  const { pid, entry, outcome } = result
  const label = entry ? describeEntry(entry) : `pid ${pid}`
  switch (outcome.kind) {
    case 'not-tracked':
      return `  ✗ ${label}: not a tracked \`keel run\` process — nothing to kill.`
    case 'unverified':
      return `  ✗ ${label}: entry is still unverified (its process identity was never confirmed) — refusing to signal it.`
    case 'refused-pgid-0-or-1':
      return `  ✗ ${label}: REFUSED — recorded process-group id is 0 or 1, which is never a legitimate supervised group. Entry marked stale; investigate before trusting keel run again.`
    case 'refused-own-pgid':
      return `  ✗ ${label}: REFUSED — this is keel's OWN process group. Will never self-signal.`
    case 'refused-own-pgid-unknown':
      return `  ✗ ${label}: REFUSED — could not determine keel's own process-group id, so self-signaling cannot be ruled out. Fix your \`ps\` availability and retry.`
    case 'already-dead':
      return `  · ${label}: process was already gone. Tracking entry cleared.`
    case 'not-ours':
      return `  ✗ ${label}: a process exists at this pid but is not one keel can signal (permission denied) — refusing rather than guessing whether it's the same process.`
    case 'start-time-mismatch':
      return `  ✗ ${label}: REFUSED — the process at this pid no longer matches what \`keel run\` recorded (start time/identity differs). The pid was almost certainly reused by a DIFFERENT process. Entry marked stale.`
    case 'killed':
      return `  ✓ ${label}: killed (${outcome.via}).`
    case 'kill-unconfirmed':
      return `  ! ${label}: SIGKILL sent but the process could not be confirmed dead (zombie or uninterruptible sleep?). Tracking entry LEFT IN PLACE — retry \`keel halt --kill\`.`
  }
}

/**
 * The inverse of `keel disable` — an industrial e-stop, not a rule match.
 * Once tripped, EVERY subsequent tool call is denied (not allowed, like
 * `keel disable`'s kill switch) until a human runs `keel resume`.
 *
 * Deliberately carries NO --until/expires_at: `keel disable`'s whole point
 * is to turn keel off, so a timer that quietly re-arms it later is fine.
 * A halt's whole point is the opposite — "even keel's own controls should
 * not un-stick this" — so letting it silently lapse on a timer would
 * defeat the one property that makes it different from a rule that can be
 * out-waited or rephrased around. This is a latch/lockdown, not a second
 * kill switch: `keel disable` is already documented as "the kill switch"
 * elsewhere in this codebase (pipeline.ts, status.ts, dashboard.ts) with
 * the OPPOSITE polarity (it ALLOWS everything) — reusing that name for
 * halt would read as the same control with two behaviors.
 *
 * `--kill` additionally reaches for a `keel run`-supervised process — see
 * run-kill.ts's own header for why every ambiguity in that path resolves
 * to REFUSING to signal, never to proceeding. The sentinel write above
 * always happens first and unconditionally, exactly as before `--kill`
 * existed: a failed/refused kill must never suppress the lockdown latch
 * itself.
 */
export async function haltCommand(options: {
  reason?: string
  kill?: boolean
  killPid?: number | string
  killAll?: boolean
  killGrace?: number | string
}) {
  const reason = options.reason || 'Manual halt'
  haltSession(reason)

  console.log(chalk.bgRed.white.bold('\n  \u{1F6D1} Keel HALTED'))
  console.log(chalk.red.bold('  Every tool call is now DENIED until a human clears this.'))
  console.log()
  console.log(chalk.dim(`  Reason: ${reason}`))
  console.log(chalk.dim('  This does not auto-clear on restart and does not expire.'))
  console.log()
  console.log(chalk.cyan('  Clear with:'))
  console.log(chalk.white('    keel resume'))
  console.log()

  if (options.kill) {
    let graceMs = DEFAULT_KILL_GRACE_MS
    if (options.killGrace !== undefined && options.killGrace !== '') {
      const seconds = typeof options.killGrace === 'number' ? options.killGrace : parseInt(String(options.killGrace), 10)
      if (!Number.isInteger(seconds) || seconds <= 0) {
        console.log(chalk.red(`  Invalid --kill-grace: "${options.killGrace}". Use a positive number of seconds.`))
        process.exitCode = 1
        return
      }
      graceMs = seconds * 1000
    }

    let pid: number | undefined
    if (options.killPid !== undefined && options.killPid !== '') {
      const parsed = typeof options.killPid === 'number' ? options.killPid : parseInt(String(options.killPid), 10)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        console.log(chalk.red(`  Invalid --kill-pid: "${options.killPid}". Use a positive pid.`))
        process.exitCode = 1
        return
      }
      pid = parsed
    }

    console.log(chalk.bold('  Looking for a keel run-supervised process to kill...'))
    const { results, ambiguous } = await killSupervisedRuns({ pid, all: options.killAll, graceMs })

    if (ambiguous) {
      console.log(chalk.yellow(`  Multiple supervised runs are tracked (${ambiguous.length}) — refusing to guess which one you mean:`))
      for (const entry of ambiguous) console.log(chalk.dim(`    • ${describeEntry(entry)}`))
      console.log(chalk.cyan('  Re-run with --kill-pid <pid> for one, or --kill-all for every tracked run.'))
      process.exitCode = 1
      return
    }

    if (results.length === 0) {
      console.log(chalk.dim('  No keel run-supervised process is currently tracked — sentinel-only halt.'))
      return
    }

    for (const result of results) console.log(describeKillOutcome(result))
    console.log()
  }
}

/**
 * Clear a halt. Only a human running this in their own terminal can do
 * this — keel-control-gate blocks an agent from running `keel resume`
 * itself, the same way it already blocks `keel disable`.
 */
export async function resumeCommand() {
  if (!existsSync(haltFilePath())) {
    console.log(chalk.green('\n  ✓ Keel is not halted\n'))
    return
  }

  rmSync(haltFilePath())
  console.log(chalk.green('\n  ✓ Keel resumed\n'))
  console.log(chalk.dim('  Enforcement continues normally.\n'))
}

/**
 * Check if Keel is currently halted (used by the CLI paths — `keel
 * status`/`keel dashboard`/`keel enable`).
 *
 * The fail-closed posture here is the OPPOSITE polarity of disable.ts's
 * isDisabled(): isDisabled() fails closed by treating a corrupt DISABLED
 * sentinel as "not disabled" (return false — enforcement stays ON,
 * because "closed" for a kill switch that ALLOWS everything means falling
 * back to normal enforcement). isHalted() fails closed by treating a
 * corrupt HALTED sentinel as "still halted" (return true — every call
 * keeps denying), because "closed" for a latch that DENIES everything
 * means the denial stays in force. Getting this backwards — returning
 * false on a corrupt file — would let one damaged byte silently turn the
 * strictest control back into a pass-through, exactly the security bug
 * halt exists to be immune to.
 *
 * Reads the file directly instead of existsSync()-then-readFileSync(): a
 * bare existsSync() swallows EACCES/ELOOP the same way it swallows ENOENT,
 * so "cannot determine whether the sentinel is there" and "confirmed
 * absent" would both read as "not halted" — a permissions glitch would
 * silently defeat the latch. Only a confirmed ENOENT means genuinely not
 * halted; every other read failure (including a corrupt/unparseable body)
 * fails closed.
 */
export function isHalted(): boolean {
  let raw: string
  try {
    raw = readFileSync(haltFilePath(), 'utf-8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    return true
  }
  try {
    JSON.parse(raw)
  } catch {
    // Corrupt body — still halted; there is no expires_at to consult that
    // could legitimately clear it, so parseability was never load-bearing
    // for the verdict, only for surfacing `reason` to a human.
    return true
  }
  return true
}

/**
 * The reason string from the halt sentinel, for display (`keel
 * status`/`keel dashboard`) and for the enforcement-side deny message.
 * Never throws; a missing or corrupt sentinel resolves to a safe default
 * rather than propagating a parse error into a caller that expects a
 * clean string.
 */
export function haltReason(): string {
  let raw: string
  try {
    raw = readFileSync(haltFilePath(), 'utf-8')
  } catch (err) {
    // A genuinely absent sentinel is not corrupt — it is just not halted.
    // Callers are expected to gate on isHalted() first, but this must not
    // mislabel a clean "not halted" state as "corrupt sentinel" for a
    // caller that doesn't.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    return 'unknown (corrupt sentinel)'
  }
  try {
    const state = JSON.parse(raw)
    if (state && typeof state.reason === 'string' && state.reason) return state.reason
    return 'Manual halt'
  } catch {
    return 'unknown (corrupt sentinel)'
  }
}
