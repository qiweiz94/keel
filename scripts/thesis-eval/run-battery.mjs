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
//
// Default: all arms A,B (no C — C only runs when --frontier-model is
// supplied, so this never spends paid budget by accident), all tasks
// auto-discovered from tasks/*/meta.json, cheap model defaults to
// opencode/deepseek-v4-flash-free (same default run.mjs uses).

import { readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const args = { arms: ['A', 'B'], timeout: 180 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--arms') args.arms = argv[++i].split(',').map((s) => s.trim())
    else if (a === '--tasks') args.tasks = argv[++i].split(',').map((s) => s.trim())
    else if (a === '--model') args.model = argv[++i]
    else if (a === '--frontier-model') args.frontierModel = argv[++i]
    else if (a === '--timeout') args.timeout = Number(argv[++i])
    else if (a === '--out-dir') args.outDir = argv[++i]
  }
  return args
}

function discoverTasks() {
  const tasksDir = join(__dirname, 'tasks')
  return readdirSync(tasksDir).filter((f) => existsSync(join(tasksDir, f, 'meta.json'))).sort()
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const tasks = args.tasks || discoverTasks()
  console.log(`== thesis-eval battery: ${tasks.length} tasks x arms [${args.arms.join(',')}] ==`)
  console.log(`tasks: ${tasks.join(', ')}`)

  let ran = 0
  let failed = 0
  for (const task of tasks) {
    for (const arm of args.arms) {
      if (arm === 'C' && !args.frontierModel) {
        console.log(`\n-- skipping ${task} / C: no --frontier-model supplied (would no-op anyway) --`)
        continue
      }
      const runArgs = ['run.mjs', '--task', task, '--arm', arm, '--timeout', String(args.timeout)]
      if (arm === 'C') runArgs.push('--model', args.frontierModel)
      else if (args.model) runArgs.push('--model', args.model)
      if (args.outDir) runArgs.push('--out-dir', args.outDir)

      console.log(`\n-- running: node ${runArgs.join(' ')} --`)
      const res = spawnSync('node', runArgs, { cwd: __dirname, stdio: 'inherit' })
      ran++
      if (res.status !== 0) {
        failed++
        console.error(`!! run.mjs exited ${res.status} for ${task}/${arm} — continuing with the rest of the battery`)
      }
    }
  }

  console.log(`\n== battery done: ${ran} runs attempted, ${failed} non-zero exits ==`)
  console.log('Now run: node aggregate.mjs [results-dir]')
}

main()
