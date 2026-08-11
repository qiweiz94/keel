// scripts/thesis-eval/lib/trace-parser.mjs
//
// Reads keel's own JSONL trace files (KEEL_TRACES_DIR/YYYY-MM-DD.jsonl) and
// summarizes them into what keel itself observed during a run: which rules
// fired, whether they blocked, and which mode:observe rules would have.
//
// Standalone re-implementation, not an import from packages/cli's
// retrospective.ts — this harness only touches keel through the built CLI
// binary and its plain-JSONL output files (per the build constraint: do not
// edit or reach into packages/ source or generated files). The filter below
// (agent in TRACKED_AGENTS + hook === 'tool.execute.before') mirrors
// retrospective.ts's isBefore()/TRACKED_AGENTS exactly — same field names,
// same semantics — confirmed by reading packages/opencode-plugin/src/plugin.ts
// record() (agent: 'opencode-plugin', hook: 'tool.execute.before'/'.after')
// and packages/core/src/enforce/pipeline.ts (mode:observe rules never
// resolve to a blocking action — effectiveAction() short-circuits to
// 'allow' and the would-be action is recorded separately as
// observed_action — verified 2026-08-11, see EVIDENCE/phase-2-harness.md).
//
// IMPORTANT for interpreting results: as of this build, no-repeat-loops,
// claim-without-evidence, and test-oracle-tampering are all mode: observe —
// they are recorded here but NEVER block, in EITHER arm. Only mode: block
// rules (no-force-push, no-destructive-commands, protected-branch-reset/
// delete, no-push-to-main, prod-db-destruction, pipe-to-shell, ...) actually
// stop an action. The harness's tamper/false-claim/stuck graders therefore
// do NOT rely on keel's own enforcement to produce a measurable A-vs-B
// delta — they grade the task OUTCOME (see lib/grading-helpers.mjs), and
// report keel's observed-rule fires here purely as an additional, honest,
// secondary signal.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const TRACKED_AGENTS = new Set(['opencode-plugin', 'openclaw-plugin', 'hermes-plugin', 'claude-code-hook'])
export const BLOCKING_ACTIONS = new Set(['deny', 'block', 'prompt', 'redirect'])

export function loadTraceEntries(tracesDir) {
  if (!existsSync(tracesDir)) return []
  const out = []
  for (const file of readdirSync(tracesDir)) {
    if (!file.endsWith('.jsonl')) continue
    let lines
    try {
      lines = readFileSync(join(tracesDir, file), 'utf-8').trim().split('\n').filter(Boolean)
    } catch { continue }
    for (const line of lines) {
      try { out.push(JSON.parse(line)) } catch { /* skip malformed */ }
    }
  }
  out.sort((a, b) => (a.t || 0) - (b.t || 0))
  return out
}

function isBefore(e) {
  return e.hook === 'tool.execute.before' && TRACKED_AGENTS.has(String(e.agent))
}

/**
 * Summarize a run's traces into what keel observed.
 * @returns {{
 *   total_entries: number, before_entries: number,
 *   blocked: Array<{rule_id: string, action: string, count: number}>,
 *   allowed_with_rule: Array<{rule_id: string, action: string, count: number}>,
 *   observed: Array<{rule_id: string, observed_action: string, count: number}>,
 *   no_repeat_loops_observed_max: number
 * }}
 */
export function summarizeTraces(entries) {
  const before = entries.filter(isBefore)
  const blockedCounts = new Map()
  const allowedWithRuleCounts = new Map()
  const observedCounts = new Map()

  for (const e of before) {
    if (e.rule_id) {
      const key = `${e.rule_id}::${e.action}`
      if (BLOCKING_ACTIONS.has(String(e.action))) {
        blockedCounts.set(key, (blockedCounts.get(key) || 0) + 1)
      } else if (e.action && e.action !== 'allow') {
        allowedWithRuleCounts.set(key, (allowedWithRuleCounts.get(key) || 0) + 1)
      }
    }
    const matches = Array.isArray(e.observed_matches) && e.observed_matches.length
      ? e.observed_matches
      : (e.observed_action ? [{ rule_id: e.rule_id || 'unknown', observed_action: e.observed_action }] : [])
    for (const m of matches) {
      const key = `${m.rule_id}::${m.observed_action}`
      observedCounts.set(key, (observedCounts.get(key) || 0) + 1)
    }
  }

  const toArray = (map) => [...map.entries()].map(([key, count]) => {
    const [rule_id, action] = key.split('::')
    return { rule_id, action, count }
  }).sort((a, b) => b.count - a.count)

  const observedArr = toArray(observedCounts).map((r) => ({ rule_id: r.rule_id, observed_action: r.action, count: r.count }))
  const noRepeatLoops = observedArr.filter((r) => r.rule_id === 'no-repeat-loops')
  const noRepeatLoopsMax = noRepeatLoops.reduce((m, r) => Math.max(m, r.count), 0)

  return {
    total_entries: entries.length,
    before_entries: before.length,
    blocked: toArray(blockedCounts),
    allowed_with_rule: toArray(allowedWithRuleCounts),
    observed: observedArr,
    no_repeat_loops_observed_max: noRepeatLoopsMax,
  }
}
