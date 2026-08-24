#!/usr/bin/env node
// scripts/thesis-eval/run-battery.mjs
//
// Convenience wrapper the supervisor runs to execute the FULL task battery
// across arms, SERIALLY (this consumes API/compute budget — like
// scripts/live-verify/*.sh, it is not meant to run unattended in parallel).
// It does nothing run.mjs doesn't already do — it just loops tasks x arms
// and shells out to run.mjs once per (task, arm), so a single run's failure
// doesn't abort the rest of the battery.
//
// Usage:
//   node run-battery.mjs --arms A,B [--tasks task1,task2,...] [--model <cheap-model>]
//   node run-battery.mjs --arms A,B,C --frontier-model opencode-go/grok-4.5
//   node run-battery.mjs --arms A,B --reps 4          # real denominators: N reps per (task,arm)
//   node run-battery.mjs --arms A,B,C --frontier-model <model> --reps 4 --dry-run
//
// Default: all arms A,B (no C — C only runs when --frontier-model is
// supplied, so this never spends paid budget by accident), all tasks
// auto-discovered from tasks/*/meta.json, cheap model defaults to
// opencode/deepseek-v4-flash-free (same default run.mjs uses), --reps 1.
//
// Cost cap (M2-B2, item 3): a --frontier-model NOT ending in "-free" also
// needs --allow-paid (or KEEL_BENCH_ALLOW_PAID=1) here, same as run.mjs —
// this wrapper is just a loop over run.mjs, so it inherits run.mjs's own
// refusal rather than re-implementing it, but ALSO enforces its own
// --max-paid-runs ceiling (default 3) so a large --reps value can't turn a
// single explicit opt-in into an unbounded paid batch: once that many arm-C
// runs with a non-free model have executed, the rest of arm C is skipped
// (not run) for the remainder of the battery, with the skip logged.
//
// --reps N: run each (task, arm) pair N times instead of once, so
// aggregate.mjs reports a real "k of N*reps" denominator instead of N=1 per
// cell. Each rep is just another call to run.mjs — it already timestamps
// every result file uniquely, so reps never collide or overwrite each
// other; no new file-naming scheme was needed here.
//
// --dry-run: print the exact run.mjs command matrix (arms x tasks x reps)
// WITHOUT executing anything — this is how a frontier arm's wiring is
// verified (task spec: "not run by you") without spending a cent: e.g.
//   node run-battery.mjs --arms A,B,C --frontier-model opencode-go/grok-4.5 --reps 4 --dry-run
// prints every command the supervisor's real run would execute.

import { readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const args = { arms: ['A', 'B'], timeout: 180, reps: 1, dryRun: false, maxPaidRuns: 3, allowPaid: process.env.KEEL_BENCH_ALLOW_PAID === '1' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--arms') args.arms = argv[++i].split(',').map((s) => s.trim())
    else if (a === '--tasks') args.tasks = argv[++i].split(',').map((s) => s.trim())
    else if (a === '--model') args.model = argv[++i]
    else if (a === '--frontier-model') args.frontierModel = argv[++i]
    else if (a === '--timeout') args.timeout = Number(argv[++i])
    else if (a === '--out-dir') args.outDir = argv[++i]
    else if (a === '--reps') args.reps = Number(argv[++i])
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--allow-paid') args.allowPaid = true
    else if (a === '--max-paid-runs') args.maxPaidRuns = Number(argv[++i])
  }
  if (!Number.isInteger(args.reps) || args.reps < 1) {
    console.error(`--reps must be a positive integer, got: ${args.reps}`)
    process.exit(1)
  }
  if (!Number.isInteger(args.maxPaidRuns) || args.maxPaidRuns < 0) {
    console.error(`--max-paid-runs must be a non-negative integer, got: ${args.maxPaidRuns}`)
    process.exit(1)
  }
  return args
}

function isFreeModel(model) {
  return /-free$/i.test(String(model || ''))
}

function discoverTasks() {
  const tasksDir = join(__dirname, 'tasks')
  return readdirSync(tasksDir).filter((f) => existsSync(join(tasksDir, f, 'meta.json'))).sort()
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const tasks = args.tasks || discoverTasks()
  const totalCells = tasks.length * args.arms.length * args.reps
  console.log(`== thesis-eval battery${args.dryRun ? ' (DRY RUN — nothing will execute)' : ''}: ${tasks.length} tasks x arms [${args.arms.join(',')}] x ${args.reps} rep(s) = up to ${totalCells} runs ==`)
  console.log(`tasks: ${tasks.join(', ')}`)

  const frontierIsPaid = args.frontierModel && !isFreeModel(args.frontierModel)
  if (frontierIsPaid) {
    console.log(`-- frontier model "${args.frontierModel}" does not end in "-free": paid-run cap active at ${args.maxPaidRuns} run(s) this battery${args.allowPaid ? ' (--allow-paid set)' : ' (--allow-paid NOT set — run.mjs will refuse every one of these; pass --allow-paid to actually spend)'} --`)
  }

  let ran = 0
  let failed = 0
  let paidRunsIssued = 0
  for (const task of tasks) {
    for (const arm of args.arms) {
      if (arm === 'C' && !args.frontierModel) {
        console.log(`\n-- skipping ${task} / C: no --frontier-model supplied (would no-op anyway) --`)
        continue
      }
      for (let rep = 1; rep <= args.reps; rep++) {
        const repTag = args.reps > 1 ? ` [rep ${rep}/${args.reps}]` : ''

        // Cost cap (M2-B2, item 3): this ceiling is enforced by the
        // BATTERY wrapper's own run counter, on top of (not instead of)
        // run.mjs's own per-invocation refusal — so a large --reps value
        // against a real paid frontier model can't turn one --allow-paid
        // opt-in into an unbounded bill. Applies during --dry-run too, so
        // the printed command list honestly shows what would be skipped.
        if (arm === 'C' && frontierIsPaid && paidRunsIssued >= args.maxPaidRuns) {
          console.log(`-- skipping ${task} / C${repTag}: --max-paid-runs (${args.maxPaidRuns}) reached — no further paid arm-C runs this battery --`)
          continue
        }

        const runArgs = ['run.mjs', '--task', task, '--arm', arm, '--timeout', String(args.timeout)]
        if (arm === 'C') {
          runArgs.push('--model', args.frontierModel)
          if (args.allowPaid) runArgs.push('--allow-paid')
        } else if (args.model) runArgs.push('--model', args.model)
        if (args.outDir) runArgs.push('--out-dir', args.outDir)

        if (args.dryRun) {
          console.log(`-- would run${repTag}: node ${runArgs.join(' ')} --`)
          if (arm === 'C' && frontierIsPaid) paidRunsIssued++
          continue
        }

        console.log(`\n-- running${repTag}: node ${runArgs.join(' ')} --`)
        const res = spawnSync('node', runArgs, { cwd: __dirname, stdio: 'inherit' })
        ran++
        if (arm === 'C' && frontierIsPaid) paidRunsIssued++
        if (res.status !== 0) {
          failed++
          console.error(`!! run.mjs exited ${res.status} for ${task}/${arm}${repTag} — continuing with the rest of the battery`)
        }
      }
    }
  }

  if (args.dryRun) {
    console.log(`\n== dry run done: ${totalCells} commands would execute (0 actually run) ==`)
    return
  }
  console.log(`\n== battery done: ${ran} runs attempted, ${failed} non-zero exits ==`)
  console.log('Now run: node aggregate.mjs [results-dir]')
}

main()
