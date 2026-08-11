#!/usr/bin/env node
// Wave-3 closeout (session/PROMOTION-REPORT.md) — SYNTHETIC demonstration
// data generator for `keel retrospective`'s promotion section.
//
// This script writes nothing under ~/.keel — every path it touches is
// passed in by the caller (a throwaway temp dir) and is meant to be used
// with KEEL_TRACES_DIR + a project cwd override, never against the real
// trace store. It exists only to give the promotion report an honest,
// reproducible "here is the mechanism working" example, clearly separate
// from the real-data section of the report.
//
// Layout it produces under <outDir>:
//   home/.keel/rules.yaml        — global (unscoped) observe rules
//   project/.keel/rules.yaml     — project-scoped observe rule + default
//                                   promotion_fp_threshold (0.001, unset
//                                   here so the DEFAULT constant is what's
//                                   exercised — see rule-parser.ts)
//   traces/<date>.jsonl          — the synthetic trace stream
//
// Three rules, one of each promotion recommendation:
//   demo-loop-observer    (global, unscoped)  — 2000 evals, 1 would-block
//                                                 (0.05%) -> eligible
//   demo-noisy-observer   (global, unscoped)  — 2000 evals, 40 would-blocks
//                                                 (2%)    -> stay_observe
//   demo-scoped-observer  (project, scoped)   — 500 evals under this
//                                                 project's cwd only
//                                                 (< 1000 floor) -> insufficient_data
//
// Both TraceEntry shapes the pipeline consumes are exercised: the legacy
// single-slot rule_id/observed_action field, and the observed_matches[]
// array (see retrospective.ts's comment on why both exist).

import { mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.argv[2]
if (!outDir) {
  console.error('usage: generate-promotion-demo.mjs <outDir>')
  process.exit(1)
}

const homeDir = join(outDir, 'home')
const projectDirRaw = join(outDir, 'project')
const tracesDir = join(outDir, 'traces')
mkdirSync(join(homeDir, '.keel'), { recursive: true })
mkdirSync(join(projectDirRaw, '.keel'), { recursive: true })
mkdirSync(tracesDir, { recursive: true })
// Resolved to match what Node's process.cwd() reports at runtime — on
// macOS /tmp is a symlink to /private/tmp, so a literal '/tmp/...' string
// written into a trace's cwd field never matches computePromotionReport's
// cwd-prefix comparison against a shell that `cd`'d into the unresolved
// path. Found by running this generator once and seeing demo-scoped-
// observer report 0 evaluations instead of 500.
const projectDir = realpathSync(projectDirRaw)

const globalRules = `version: 1
rules:
  - id: demo-loop-observer
    type: command
    action: redirect
    message: "SYNTHETIC demo rule — not a real keel rule. Mirrors no-repeat-loops' shape."
    mode: observe
    match: "npm test"
  - id: demo-noisy-observer
    type: command
    action: deny
    message: "SYNTHETIC demo rule — not a real keel rule. Deliberately noisy to demonstrate stay_observe."
    mode: observe
    match: "git push"
`
writeFileSync(join(homeDir, '.keel', 'rules.yaml'), globalRules)

const projectRules = `version: 1
rules:
  - id: demo-scoped-observer
    type: command
    action: deny
    message: "SYNTHETIC demo rule — not a real keel rule. Project-scoped, to demonstrate denominator scoping + insufficient_data."
    mode: observe
    match: "rm -rf"
`
writeFileSync(join(projectDir, '.keel', 'rules.yaml'), projectRules)

const otherCwd = '/tmp/keel-promo-demo-other-project'
let t = Date.parse('2026-08-11T00:00:00.000Z')
const entries = []

function push(e) {
  t += 1000
  entries.push({ t, timestamp: new Date(t).toISOString(), hook: 'tool.execute.before', agent: 'opencode-plugin', session_id: e.session_id, tool: 'Bash', args: { command: e.command }, rule_id: e.rule_id ?? null, action: e.action ?? 'allow', cwd: e.cwd, ...(e.observed_matches ? { observed_matches: e.observed_matches } : {}), ...(e.observed_action ? { observed_action: e.observed_action } : {}) })
}

// demo-loop-observer and demo-noisy-observer are UNSCOPED (global) rules,
// so their denominator is the WHOLE tracked trace stream regardless of
// cwd (computePromotionReport uses allBefore.length for an unscoped
// rule) — every entry below, from all three rules' streams, lands in
// that denominator. They're placed on a cwd distinct from the project's
// own, specifically so the scoped-vs-unscoped denominator split (proven
// below) is unambiguous: demo-scoped-observer's count must NOT include
// these, and it doesn't.
//
// demo-loop-observer: exactly 1 would-block across the eventual 5000-row
// dataset (rate 0.02%, below the 0.1% default threshold) -> eligible.
// Uses the legacy single-slot rule_id/observed_action shape.
for (let i = 0; i < 2000; i++) {
  const isBlock = i === 999
  push({
    session_id: `demo-loop-${Math.floor(i / 20)}`,
    command: `npm test ${i}`,
    cwd: otherCwd,
    ...(isBlock ? { rule_id: 'demo-loop-observer', action: 'redirect', observed_action: 'redirect' } : {}),
  })
}

// demo-noisy-observer: 40 would-blocks across the same 5000-row dataset
// (rate 0.8%, above threshold) -> stay_observe. Uses the
// observed_matches[] array shape, so both TraceEntry shapes the pipeline
// reads are exercised in one dataset.
for (let i = 0; i < 2000; i++) {
  const isBlock = i % 50 === 0 // 40 of 2000
  push({
    session_id: `demo-noisy-${Math.floor(i / 20)}`,
    command: `git push origin main ${i}`,
    cwd: otherCwd,
    observed_matches: isBlock ? [{ rule_id: 'demo-noisy-observer', observed_action: 'deny' }] : undefined,
  })
}

// demo-scoped-observer is PROJECT-scoped (declared only in
// project/.keel/rules.yaml). 500 evals under the project's own cwd —
// below the 1000-evaluation floor at the default 0.001 threshold, so
// this alone should read insufficient_data even though the unscoped
// rules above cleared it easily on the same trace stream. Plus another
// 500 rows under a different project's cwd, which must NOT be counted
// toward this rule's (scoped) denominator — that's the scoping behaviour
// this dataset is built to demonstrate.
for (let i = 0; i < 500; i++) {
  push({ session_id: `demo-scoped-${Math.floor(i / 20)}`, command: `rm -rf /tmp/build-${i}`, cwd: projectDir })
}
for (let i = 0; i < 500; i++) {
  push({ session_id: `demo-scoped-other-${Math.floor(i / 20)}`, command: `rm -rf /tmp/build-${i}`, cwd: otherCwd })
}

entries.sort((a, b) => a.t - b.t)
const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
writeFileSync(join(tracesDir, '2026-08-11.jsonl'), lines)

console.log(`Wrote ${entries.length} synthetic trace entries to ${join(tracesDir, '2026-08-11.jsonl')}`)
console.log(`Home:    ${homeDir}`)
console.log(`Project: ${projectDir}`)
console.log(`Traces:  ${tracesDir}`)
