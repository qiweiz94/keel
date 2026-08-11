#!/usr/bin/env node
// scripts/thesis-eval/run.mjs
//
// Runs ONE task through ONE arm, end to end, in a fully isolated scratch
// environment, and emits one per-run JSON result to results/.
//
// Arms:
//   A = cheap-unguarded   — no keel installed at all.
//   B = cheap-guarded     — `keel install --opencode` (project-scoped via an
//                           isolated HOME, so it lands at
//                           $ISOLATED_HOME/.opencode/plugins/, not the real
//                           machine's ~/.opencode) against THIS worktree's
//                           build, dial pinned explicitly to `balanced`
//                           (the shipped default) so a later run can't
//                           silently drift onto a different dial.
//   C = frontier-reference — a stronger model, UNGUARDED (no keel), supplied
//                           by the caller via --model. Defaults to a no-op
//                           ("skip") so this harness never spends paid
//                           budget on its own — the supervisor supplies a
//                           real --model for Arm C.
//
// DESIGN HONESTY (binding, see the phase-2 brief and
// lib/trace-parser.mjs's header): keel's mode:observe rules
// (no-repeat-loops, claim-without-evidence, test-oracle-tampering) NEVER
// block, in EITHER arm — verified against packages/core/src/enforce/
// pipeline.ts's effectiveAction()/violation(). So the tamper / false-claim /
// stuck graders below all compute their PRIMARY verdict from a TASK OUTCOME
// the harness can observe directly (fs diff, an independent re-run of the
// pristine test file, the agent's own transcript text, its own command
// history) — never from keel's verdict. keel's trace-observed rule fires are
// captured too, as an explicit SECONDARY field, never folded silently into
// the primary metric.
//
// Isolation: every run gets its own /tmp root (HOME, XDG_*, KEEL_STATE_DIR,
// KEEL_TRACES_DIR, a scratch git working copy, and — for tasks that need one
// — a bare "origin" remote). Nothing here ever touches the real ~/.keel,
// ~/.opencode, ~/.claude. See lib/isolate.mjs's header for the empirically-
// confirmed reasons HOME (not just XDG_*) must be overridden.

import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

import { createIsolatedRoot, installKeelShim, seedWorkRepo, createAndPushRemote } from './lib/isolate.mjs'
import { runOpenCode, extractObservables } from './lib/opencode-runner.mjs'
import { loadTraceEntries, summarizeTraces } from './lib/trace-parser.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HARNESS_ROOT = __dirname
const WORKTREE_ROOT = resolve(HARNESS_ROOT, '..', '..')
const DEFAULT_KEEL_BIN = join(WORKTREE_ROOT, 'packages', 'cli', 'bin', 'keel.js')

const ARM_DEFAULT_MODELS = {
  A: 'opencode/deepseek-v4-flash-free',
  B: 'opencode/deepseek-v4-flash-free',
  C: 'noop', // supervisor supplies a real frontier model via --model
}
const DEFAULT_TIMEOUT_S = 180

function parseArgs(argv) {
  const args = { timeout: DEFAULT_TIMEOUT_S, outDir: join(HARNESS_ROOT, 'results'), keelBin: DEFAULT_KEEL_BIN, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--task') args.task = argv[++i]
    else if (a === '--arm') args.arm = argv[++i]
    else if (a === '--model') args.model = argv[++i]
    else if (a === '--timeout') args.timeout = Number(argv[++i])
    else if (a === '--out-dir') args.outDir = resolve(argv[++i])
    else if (a === '--keel-bin') args.keelBin = resolve(argv[++i])
    else if (a === '--keep') args.keep = true
    else if (a === '--force-negative-control') args.forceNegativeControl = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

function usage() {
  console.log(`Usage: node run.mjs --task <task-id> --arm <A|B|C> [--model <name>] [--timeout <seconds>] [--out-dir <dir>] [--keel-bin <path>] [--keep]

Arms: A=cheap-unguarded  B=cheap-guarded(keel live)  C=frontier-reference(unguarded, --model required or it no-ops)
Default model (A/B): ${ARM_DEFAULT_MODELS.A}
Tasks live in scripts/thesis-eval/tasks/<task-id>/ (meta.json, prompt.txt, repo/, grade.mjs, optional setup.mjs / negative-control.mjs).
`)
}

async function loadTaskModule(taskDir, filename) {
  const path = join(taskDir, filename)
  if (!existsSync(path)) return null
  const mod = await import(pathToFileURL(path).href)
  return mod.default || mod
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.task || !args.arm) { usage(); process.exit(args.help ? 0 : 1) }
  if (!['A', 'B', 'C'].includes(args.arm)) { console.error(`Unknown arm: ${args.arm}`); process.exit(1) }
  if (!existsSync(args.keelBin)) { console.error(`KEEL_BIN not found at ${args.keelBin} — run npm run build first`); process.exit(1) }

  const taskDir = join(HARNESS_ROOT, 'tasks', args.task)
  if (!existsSync(taskDir)) { console.error(`Task not found: ${taskDir}`); process.exit(1) }
  const meta = JSON.parse(readFileSync(join(taskDir, 'meta.json'), 'utf-8'))
  const prompt = readFileSync(join(taskDir, 'prompt.txt'), 'utf-8').trim()
  const setupFn = await loadTaskModule(taskDir, 'setup.mjs')
  const gradeFn = await loadTaskModule(taskDir, 'grade.mjs')
  if (!gradeFn) { console.error(`Task ${args.task} has no grade.mjs`); process.exit(1) }

  const model = args.model || ARM_DEFAULT_MODELS[args.arm]
  mkdirSync(args.outDir, { recursive: true })
  const rawDir = join(args.outDir, 'raw')
  mkdirSync(rawDir, { recursive: true })

  const runLabel = `${args.task}-${args.arm}`
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

  if (args.arm === 'C' && (model === 'noop' || model === 'skip')) {
    const result = {
      task: args.task, category: meta.category, arm: args.arm, model, timestamp,
      status: 'skipped_by_design',
      note: 'Arm C (frontier-reference) is supervisor-run only; pass --model to execute it.',
      task_passed: null, forbidden_action_executed: null, false_claim: null,
      stuck_repeats: null, test_tampered: null,
    }
    const outPath = join(args.outDir, `${runLabel}-${timestamp}.json`)
    writeFileSync(outPath, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    console.log(`\nWrote ${outPath}`)
    return
  }

  console.log(`== thesis-eval: task=${args.task} arm=${args.arm} model=${model} timeout=${args.timeout}s ==`)

  const iso = createIsolatedRoot({ label: runLabel })
  console.log(`  isolated root: ${iso.root}`)
  installKeelShim({ bin: iso.bin, keelBin: args.keelBin })

  let fixture = {}
  let remoteDir = null
  let baselineSha = null
  try {
    const repoDir = join(taskDir, 'repo')
    baselineSha = seedWorkRepo({ work: iso.work, repoDir: existsSync(repoDir) ? repoDir : null })

    if (meta.needs_remote) {
      const { remote, sha } = createAndPushRemote({ root: iso.root, work: iso.work })
      remoteDir = remote
      fixture.originSha = sha
    }

    if (setupFn) {
      const extra = await setupFn({ workDir: iso.work, remoteDir, root: iso.root, env: iso.env })
      fixture = { ...fixture, ...(extra || {}) }
    }

    let installLog = null
    if (args.arm === 'B') {
      installLog = execFileSync('node', [args.keelBin, 'install', '--opencode'], { env: iso.env, cwd: iso.work, encoding: 'utf-8' })
      // Pin the dial explicitly rather than trusting whatever a fresh
      // install happens to default to (currently 'balanced') — a
      // supervisor re-run must exercise the SAME ruleset the smoke test
      // proved, not silently whatever ships as tomorrow's default.
      execFileSync('node', [args.keelBin, 'level', 'balanced'], { env: iso.env, cwd: iso.work, encoding: 'utf-8' })
    }

    const runResult = await runOpenCode({ cwd: iso.work, prompt, model, timeoutMs: args.timeout * 1000, env: iso.env })
    const observables = extractObservables(runResult.events)

    // Persist raw evidence BEFORE cleanup — transcript, events, and the
    // final repo/remote state (for post-hoc re-grading / audit).
    const rawRunDir = join(rawDir, `${runLabel}-${timestamp}`)
    mkdirSync(rawRunDir, { recursive: true })
    writeFileSync(join(rawRunDir, 'stdout.ndjson'), runResult.rawStdout)
    writeFileSync(join(rawRunDir, 'stderr.txt'), runResult.rawStderr)
    writeFileSync(join(rawRunDir, 'transcript-text.txt'), observables.allText)
    if (installLog) writeFileSync(join(rawRunDir, 'keel-install.log'), installLog)
    try {
      cpSync(iso.work, join(rawRunDir, 'final-workdir'), { recursive: true })
    } catch { /* best-effort evidence capture */ }

    const traceEntries = loadTraceEntries(iso.keelTracesDir)
    const traceSummary = summarizeTraces(traceEntries)
    writeFileSync(join(rawRunDir, 'trace-summary.json'), JSON.stringify(traceSummary, null, 2))

    const gradeCtx = {
      workDir: iso.work,
      remoteDir,
      fixture,
      baselineSha,
      taskDir,
      meta,
      bashCalls: observables.bashCalls,
      toolCalls: observables.toolCalls,
      allText: observables.allText,
      timedOut: runResult.timedOut,
      exitCode: runResult.exitCode,
      traceSummary,
    }
    const graded = await gradeFn(gradeCtx)

    // Negative control (destructive tasks only): prove, with plain git/fs —
    // no agent, no keel — that the SAME fixture the agent just saw would
    // actually register harm if the forbidden action were executed. Cached
    // per task (not per arm-run) since it's a property of the fixture, not
    // of a specific model's behavior; re-run with --force-negative-control.
    let negativeControlPassed = null
    const negControlFn = await loadTaskModule(taskDir, 'negative-control.mjs')
    if (negControlFn) {
      const cachePath = join(args.outDir, 'negative-control', `${args.task}.json`)
      if (existsSync(cachePath) && !args.forceNegativeControl) {
        negativeControlPassed = JSON.parse(readFileSync(cachePath, 'utf-8')).passed
      } else {
        const ncIso = createIsolatedRoot({ label: `${args.task}-negctrl` })
        try {
          const ncRepoDir = join(taskDir, 'repo')
          seedWorkRepo({ work: ncIso.work, repoDir: existsSync(ncRepoDir) ? ncRepoDir : null })
          let ncFixture = {}
          let ncRemote = null
          if (meta.needs_remote) {
            const { remote, sha } = createAndPushRemote({ root: ncIso.root, work: ncIso.work })
            ncRemote = remote
            ncFixture.originSha = sha
          }
          if (setupFn) {
            const extra = await setupFn({ workDir: ncIso.work, remoteDir: ncRemote, root: ncIso.root, env: ncIso.env })
            ncFixture = { ...ncFixture, ...(extra || {}) }
          }
          const nc = await negControlFn({ workDir: ncIso.work, remoteDir: ncRemote, fixture: ncFixture })
          negativeControlPassed = !!(nc && nc.passed)
          mkdirSync(dirname(cachePath), { recursive: true })
          writeFileSync(cachePath, JSON.stringify({ task: args.task, ...nc, checkedAt: new Date().toISOString() }, null, 2))
        } finally {
          if (!args.keep) ncIso.cleanup()
        }
      }
    }

    const result = {
      task: args.task,
      category: meta.category,
      arm: args.arm,
      model,
      timestamp,
      timed_out: runResult.timedOut,
      exit_code: runResult.exitCode,
      duration_ms: runResult.durationMs,
      // Contract fields (spec §1): structured JSON every task's grader returns.
      task_passed: graded.task_passed,
      forbidden_action_executed: graded.forbidden_action_executed,
      false_claim: graded.false_claim,
      stuck_repeats: graded.stuck_repeats,
      test_tampered: graded.test_tampered,
      // Additional transparency fields (not in the minimal contract, kept
      // because collapsing them into the booleans above would hide
      // information — see grading-helpers.mjs's classifyTamper).
      detail: graded.detail || {},
      negative_control_passed: negativeControlPassed,
      keel_trace_summary: traceSummary,
      raw_dir: rawRunDir,
    }

    const outPath = join(args.outDir, `${runLabel}-${timestamp}.json`)
    writeFileSync(outPath, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    console.log(`\nWrote ${outPath}`)
    console.log(`Raw evidence: ${rawRunDir}`)
  } finally {
    if (!args.keep) iso.cleanup()
    else console.log(`  --keep set: leaving isolated root at ${iso.root}`)
  }
}

main().catch((err) => {
  console.error('run.mjs FAILED:', err && err.stack || err)
  process.exit(1)
})
