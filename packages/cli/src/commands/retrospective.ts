import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'
import { commandFingerprint } from '../core/enforce/command-fingerprint.js'
import type { AuditEntry } from '../core/types.js'

/**
 * `keel retrospective` — the learning loop's report.
 *
 * Computes per-session improvement metrics from the trace stream
 * (exit codes and cwd recorded by the plugin since Phase 2a make these
 * exact), groups them per project, and renders a table of
 * attempts-until-success, stuck loops, research-before-solve compliance,
 * time-to-first-search, churn, deny-repeat rate, verification completion,
 * and pivot recovery.
 *
 * Metrics definitions (see docs/problem-solving-harness.md §6).
 *
 * NOT yet implemented (deferred from Phase 3, see the decisions log):
 * week-over-week deltas, `keel postmortem`, lesson decay, lessons.json v2.
 */

export interface SessionMetrics {
  session_id: string
  project: string
  tool_calls: number
  source_edits: number
  attempts_to_success: number | null
  stuck_loops: number
  research_before_solve: boolean | null
  time_to_first_search_s: number | null
  churn_cycles: number
  deny_repeat_rate: number
  verification_completed: boolean
  pivoted_after_stuck: boolean | null
  research_calls: number
}

export interface RetrospectiveReport {
  window: { start: string; end: string }
  sessions: SessionMetrics[]
  aggregate: {
    sessions: number
    success_rate: number
    median_attempts_to_success: number | null
    stuck_loops_per_session: number
    research_before_solve_rate: number | null
    median_time_to_first_search_s: number | null
    churn_per_session: number
    deny_repeat_rate: number
    verification_completion_rate: number | null
    pivot_recovery_rate: number | null
  }
  top_problems: Array<{ signature: string; sessions: number }>
  lessons: Array<{ key: string; text: string; count: number }>
}

export interface TraceEntry {
  t?: number
  agent?: string
  session_id?: string
  tool?: string
  args?: Record<string, unknown>
  rule_id?: string | null
  action?: string
  hook?: string
  exit?: number
  cwd?: string
}

const TEST_RE = /(npm|pnpm|yarn|bun)( run)? (run )?(test|vitest|jest|pytest)|npx vitest|go test/i
const FAKE_RE = /--(help|list[a-z-]*|dry[-_]?run|version)(=|\s|$)|(^|\s)-h(\s|$)|(\|\||;)\s*(true|exit(\s+0)?|:)(\s|$)|(^|\s)\|\s*(cat|tee|head|tail|grep|true)(\s|$)/i
const RESEARCH_TOOLS = new Set(['websearch', 'webfetch', 'glob', 'keel_research'])
const EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch', 'WriteFile', 'writefile', 'write_file'])

/**
 * Verdicts that count toward a stuck cluster. keel's escalation ladder is
 * warn → redirect → deny, so `redirect` must be here: a genuine loop that
 * peaks at redirect would otherwise be invisible. Exported because
 * `lessons.ts` counts the same clusters and must not drift from this list.
 */
export const VERDICTS = ['deny', 'warn', 'redirect', 'prompt']

/** §6.1 Pattern A: a cluster is counted inside min(20 calls, 30 min). */
const STUCK_WINDOW_CALLS = 20
const STUCK_WINDOW_MS = 30 * 60 * 1000

export function loadTraceEntries(auditDir: string, since?: string): TraceEntry[] {
  if (!existsSync(auditDir)) return []
  const out: TraceEntry[] = []
  for (const file of readdirSync(auditDir)) {
    if (!file.endsWith('.jsonl')) continue
    if (since && file.replace('.jsonl', '') < since) continue
    try {
      const lines = readFileSync(join(auditDir, file), 'utf-8').trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as TraceEntry)
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => (a.t || 0) - (b.t || 0))
}

function isBefore(e: TraceEntry): boolean {
  return e.hook === 'tool.execute.before' && e.agent === 'opencode-plugin'
}

function commandOf(e: TraceEntry): string {
  const args = e.args || {}
  return String(args.command || args.cmd || '')
}

function fileOf(e: TraceEntry): string {
  return String((e.args || {}).filePath || (e.args || {}).file || '')
}

function isTestCommand(cmd: string): boolean {
  return TEST_RE.test(cmd) && !FAKE_RE.test(cmd)
}

function isResearch(e: TraceEntry): boolean {
  if (RESEARCH_TOOLS.has(String(e.tool).toLowerCase())) return true
  const cmd = commandOf(e)
  return /keel_research|keel_fetch|websearch|webfetch/i.test(cmd)
}

/** Infer the project from the session's recorded cwd (or path prefixes). */
function inferProject(entries: TraceEntry[]): string {
  const cwds = new Map<string, number>()
  const paths = new Map<string, number>()
  for (const e of entries) {
    if (e.cwd) cwds.set(e.cwd, (cwds.get(e.cwd) || 0) + 1)
    const f = fileOf(e)
    if (f.startsWith('/')) {
      const parts = f.split('/')
      const proj = parts.slice(0, Math.max(3, parts.length - 3)).join('/')
      paths.set(proj, (paths.get(proj) || 0) + 1)
    }
  }
  const best = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  return best(cwds) || best(paths) || '(unknown)'
}

function normalize(cmd: string): string {
  return commandFingerprint(cmd)
}

function isEdit(e: TraceEntry): boolean {
  return EDIT_TOOLS.has(String(e.tool).toLowerCase()) && fileOf(e) !== ''
}

function isSourceEdit(e: TraceEntry): boolean {
  return isEdit(e) && /src\//.test(fileOf(e))
}

function clusterKey(e: TraceEntry): string {
  return `${e.rule_id}:${normalize(commandOf(e))}`
}

/**
 * Peak occurrences of each `(rule_id, normalized command)` key inside a
 * sliding window of the last 20 before-hook calls AND 30 minutes
 * (§6 metric 2, §6.1 Pattern A). Counting across a whole session instead
 * would flag hours-apart retries in long sessions as a single loop.
 */
function windowedClusterCounts(before: TraceEntry[]): Map<string, number> {
  const positions = new Map<string, Array<{ i: number; t: number }>>()
  before.forEach((e, i) => {
    if (!e.rule_id || !VERDICTS.includes(String(e.action))) return
    const key = clusterKey(e)
    if (!positions.has(key)) positions.set(key, [])
    positions.get(key)!.push({ i, t: e.t || 0 })
  })
  const counts = new Map<string, number>()
  for (const [key, occ] of positions) {
    let peak = 0
    let start = 0
    for (let end = 0; end < occ.length; end++) {
      while (start < end && (occ[end].i - occ[start].i > STUCK_WINDOW_CALLS || occ[end].t - occ[start].t > STUCK_WINDOW_MS)) start++
      peak = Math.max(peak, end - start + 1)
    }
    counts.set(key, peak)
  }
  return counts
}

export function analyzeSession(entries: TraceEntry[]): SessionMetrics | null {
  const before = entries.filter(isBefore)
  const after = entries.filter((e) => e.hook === 'tool.execute.after')
  if (before.length === 0) return null
  const sessionId = before[0].session_id || 'unknown'
  const project = inferProject(entries)

  const sourceEdits = before.filter(isSourceEdit)
  const researchCalls = before.filter(isResearch)

  // Attempts-until-success: index of the first passing test minus the index
  // of the first source edit (§6 metric 1).
  //
  // The after-entry must be paired POSITIONALLY: matching by fingerprint
  // alone always returns the session's first run of that command, so a
  // fail → fail → pass sequence (exits 1,1,0) reads exit 1 forever and the
  // session is scored as never verified — exactly the recoveries this
  // metric exists to count. Entries are time-sorted by loadTraceEntries.
  let attemptsToSuccess: number | null = null
  let verificationCompleted = false
  const afterEvents = after.map((a) => ({ cmd: normalize(commandOf(a)), exit: a.exit, t: a.t || 0 }))
  const firstSourceEdit = before.findIndex(isSourceEdit)
  for (let i = 0; i < before.length; i++) {
    const e = before[i]
    if (!isTestCommand(commandOf(e))) continue
    const fp = normalize(commandOf(e))
    const paired = afterEvents.find((a) => a.cmd === fp && a.t >= (e.t || 0))
    if (paired && paired.exit === 0) {
      verificationCompleted = true
      attemptsToSuccess = i - (firstSourceEdit < 0 ? 0 : firstSourceEdit)
      break
    }
  }

  // Stuck loops: (rule_id, normalize(command)) clusters reaching 3 inside
  // the min(20 calls, 30 min) window.
  const clusters = windowedClusterCounts(before)
  const stuckKeys = new Set([...clusters.entries()].filter(([, c]) => c >= 3).map(([k]) => k))
  const stuckLoops = stuckKeys.size
  const denyRepeat = [...clusters.values()].filter((c) => c >= 2).length
  const verdictEvents = before.filter((e) => VERDICTS.includes(String(e.action))).length

  // Research before solve.
  const firstResearch = researchCalls[0]?.t
  const firstEdit = before.find(isEdit)?.t
  const researchBeforeSolve = firstResearch !== undefined && firstEdit !== undefined ? firstResearch < firstEdit : null

  // Time to first search.
  const firstT = before[0]?.t
  const timeToFirstSearch = firstResearch !== undefined && firstT !== undefined ? (firstResearch - firstT) / 1000 : null

  // Churn: same-file edit → test → edit cycles (≤ 8 calls apart).
  let churn = 0
  const editIndices = before.map((e, i) => ({ e, i })).filter(({ e }) => isEdit(e))
  for (let a = 0; a < editIndices.length - 1; a++) {
    for (let b = a + 1; b < editIndices.length; b++) {
      const ea = editIndices[a].e
      const eb = editIndices[b].e
      if (fileOf(ea) !== fileOf(eb)) continue
      if (editIndices[b].i - editIndices[a].i > 8) continue
      const between = before.slice(editIndices[a].i + 1, editIndices[b].i)
      if (between.some((x) => isTestCommand(commandOf(x)))) {
        churn++
        break
      }
    }
  }

  // Pivot recovery: among sessions with a stuck loop, did a research call
  // or a command-family change follow within 5 calls of the 2nd repeat?
  //
  // The scan must be restricted to keys that actually formed a stuck
  // cluster. Scanning every entry collides all the rule-less, command-less
  // calls (writes, reads) on the key "null:", which puts the anchor at the
  // start of the session and measures the wrong five calls — and this is
  // §6 metric 8, the headline number.
  let pivotedAfterStuck: boolean | null = null
  if (stuckLoops > 0) {
    let secondRepeatAt = -1
    const seen = new Map<string, number>()
    for (let i = 0; i < before.length; i++) {
      const e = before[i]
      if (!e.rule_id || !VERDICTS.includes(String(e.action))) continue
      const key = clusterKey(e)
      if (!stuckKeys.has(key)) continue
      const n = (seen.get(key) || 0) + 1
      seen.set(key, n)
      if (n === 2) { secondRepeatAt = i; break }
    }
    if (secondRepeatAt >= 0) {
      const window = before.slice(secondRepeatAt + 1, secondRepeatAt + 6)
      pivotedAfterStuck = window.some(isResearch)
        || (() => {
          const fam = (c: string) => c.trim().split(/\s+/)[0] || ''
          const beforeFam = fam(commandOf(before[secondRepeatAt]))
          return window.some((w) => fam(commandOf(w)) !== beforeFam)
        })()
    }
  }

  return {
    session_id: sessionId,
    project,
    tool_calls: before.length,
    source_edits: sourceEdits.length,
    attempts_to_success: attemptsToSuccess,
    stuck_loops: stuckLoops,
    research_before_solve: researchBeforeSolve,
    time_to_first_search_s: timeToFirstSearch,
    churn_cycles: churn,
    deny_repeat_rate: verdictEvents > 0 ? denyRepeat / verdictEvents : 0,
    verification_completed: verificationCompleted,
    pivoted_after_stuck: pivotedAfterStuck,
    research_calls: researchCalls.length,
  }
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Aggregate a set of session metrics. Split out so a project-scoped report
 * re-aggregates over its own sessions: filtering `report.sessions` after the
 * fact would leave the all-projects numbers on screen (and in `--write`).
 */
export function computeAggregate(sessions: SessionMetrics[]): RetrospectiveReport['aggregate'] {
  const withSuccess = sessions.filter((s) => s.attempts_to_success !== null)
  const withEdits = sessions.filter((s) => s.source_edits > 0)
  const stuckSessions = sessions.filter((s) => s.stuck_loops > 0)
  const researchKnown = sessions.filter((s) => s.research_before_solve !== null)
  return {
    sessions: sessions.length,
    success_rate: sessions.length > 0 ? withSuccess.length / sessions.length : 0,
    median_attempts_to_success: median(withSuccess.map((s) => s.attempts_to_success as number)),
    stuck_loops_per_session: sessions.length > 0 ? sessions.reduce((a, s) => a + s.stuck_loops, 0) / sessions.length : 0,
    research_before_solve_rate: researchKnown.length > 0 ? researchKnown.filter((s) => s.research_before_solve === true).length / researchKnown.length : null,
    median_time_to_first_search_s: median(sessions.map((s) => s.time_to_first_search_s).filter((x): x is number => x !== null)),
    churn_per_session: sessions.length > 0 ? sessions.reduce((a, s) => a + s.churn_cycles, 0) / sessions.length : 0,
    deny_repeat_rate: sessions.length > 0 ? sessions.reduce((a, s) => a + s.deny_repeat_rate, 0) / sessions.length : 0,
    verification_completion_rate: withEdits.length > 0 ? withEdits.filter((s) => s.verification_completed).length / withEdits.length : null,
    pivot_recovery_rate: stuckSessions.length > 0 ? stuckSessions.filter((s) => s.pivoted_after_stuck === true).length / stuckSessions.length : null,
  }
}

/** Problem signatures + the workflow lessons `keel gather` folds into requirements.md. */
export function computeLessons(sessions: SessionMetrics[]): Pick<RetrospectiveReport, 'top_problems' | 'lessons'> {
  const topProblems = new Map<string, number>()
  for (const s of sessions) {
    const signature = s.stuck_loops > 0 ? 'stuck-loop' : s.churn_cycles > 0 ? 'churn' : 'general'
    topProblems.set(signature, (topProblems.get(signature) || 0) + 1)
  }
  const lessons: Array<{ key: string; text: string; count: number }> = []
  const stuckCount = sessions.filter((s) => s.stuck_loops > 0).length
  if (stuckCount > 0) lessons.push({ key: 'stuck-loop', text: 'Do not retry an identical blocked command: read the rule message and change approach instead.', count: stuckCount })
  const noResearchCount = sessions.filter((s) => s.research_before_solve === false).length
  if (noResearchCount > 0) lessons.push({ key: 'no-research-before-solve', text: 'Research before editing: sessions that searched first resolved in fewer attempts.', count: noResearchCount })
  const noPivotCount = sessions.filter((s) => s.stuck_loops > 0 && s.pivoted_after_stuck === false).length
  if (noPivotCount > 0) lessons.push({ key: 'no-pivot', text: 'Switch approach after 2 failed attempts; sessions that never pivoted stayed stuck.', count: noPivotCount })
  return {
    top_problems: [...topProblems.entries()].sort((a, b) => b[1] - a[1]).map(([signature, sessionsCount]) => ({ signature, sessions: sessionsCount })),
    lessons,
  }
}

export function buildReport(entries: TraceEntry[], since?: string, project?: string): RetrospectiveReport {
  const bySession = new Map<string, TraceEntry[]>()
  for (const e of entries) {
    if (!isBefore(e)) continue
    const key = e.session_id || 'unknown'
    if (!bySession.has(key)) bySession.set(key, [])
    bySession.get(key)!.push(e)
  }
  const afterBySession = new Map<string, TraceEntry[]>()
  for (const e of entries) {
    if (e.hook !== 'tool.execute.after') continue
    const key = e.session_id || 'unknown'
    if (!afterBySession.has(key)) afterBySession.set(key, [])
    afterBySession.get(key)!.push(e)
  }
  let sessions: SessionMetrics[] = []
  for (const [key, befores] of bySession) {
    const merged = [...befores, ...(afterBySession.get(key) || [])].sort((a, b) => (a.t || 0) - (b.t || 0))
    const m = analyzeSession(merged)
    if (m) sessions.push(m)
  }
  // Scope BEFORE aggregating, so a project report never shows another
  // project's numbers.
  if (project) sessions = sessions.filter((s) => s.project.includes(project))
  sessions.sort((a, b) => b.tool_calls - a.tool_calls)

  return {
    window: { start: since || 'earliest', end: new Date().toISOString().slice(0, 10) },
    sessions,
    aggregate: computeAggregate(sessions),
    ...computeLessons(sessions),
  }
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`
}

function num(v: number | null, digits = 1): string {
  return v === null ? '—' : v.toFixed(digits)
}

export async function retrospectiveCommand(options: { since?: string; project?: string; json?: boolean; write?: boolean } = {}) {
  const auditDir = join(homedir(), '.keel', 'traces')
  const entries = loadTraceEntries(auditDir, options.since)
  const filtered = buildReport(entries, options.since, options.project)

  if (options.json) {
    console.log(JSON.stringify(filtered, null, 2))
    return
  }

  const a = filtered.aggregate
  console.log(chalk.bold.cyan('\n  ⚓ keel retrospective'))
  console.log(chalk.dim(`  ${filtered.window.start} → ${filtered.window.end}`))
  console.log()
  console.log(`  Sessions analyzed: ${chalk.white(String(filtered.sessions.length))}   (success ${chalk.green(String(Math.round(a.success_rate * filtered.sessions.length)))})`)
  console.log()
  const rows: Array<[string, string]> = [
    ['attempts-to-success (median)', num(a.median_attempts_to_success)],
    ['stuck-loops / session', a.stuck_loops_per_session.toFixed(2)],
    ['research-before-solve', pct(a.research_before_solve_rate)],
    ['time-to-first-search (median s)', num(a.median_time_to_first_search_s)],
    ['churn cycles / session', a.churn_per_session.toFixed(2)],
    ['deny-repeat rate', pct(a.deny_repeat_rate)],
    ['verification completion', pct(a.verification_completion_rate)],
    ['pivot recovery (stuck sessions)', pct(a.pivot_recovery_rate)],
  ]
  for (const [label, value] of rows) {
    console.log(`  ${chalk.dim(label.padEnd(34))}${chalk.white(value)}`)
  }
  if (filtered.top_problems.length) {
    console.log()
    console.log(chalk.dim('  Top problem signatures'))
    for (const p of filtered.top_problems) {
      console.log(`    ${chalk.white(p.signature.padEnd(16))}${chalk.dim(`${p.sessions} session(s)`)}`)
    }
  }
  if (filtered.lessons.length) {
    console.log()
    console.log(chalk.dim('  Lessons for requirements.md'))
    for (const l of filtered.lessons) {
      console.log(`    • ${chalk.white(l.text)} ${chalk.dim(`(${l.count})`)}`)
    }
  }
  console.log()

  if (options.write) {
    const week = filtered.window.end
    const dir = join(homedir(), '.keel', 'retrospectives', options.project || 'all')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${week}.md`)
    const lines = [`## keel retrospective (${filtered.window.start} → ${filtered.window.end})`, '']
    for (const [label, value] of rows) lines.push(`- ${label}: ${value}`)
    lines.push('', `- top problems: ${filtered.top_problems.map((p) => `${p.signature}(${p.sessions})`).join(', ') || 'none'}`, '')
    appendFileSync(path, lines.join('\n'))
    console.log(chalk.dim(`  Wrote ${path}`))
  }
}

// Re-export for the lessons flow (used by gather).
export function extractWorkflowLessons(report: RetrospectiveReport): Array<{ key: string; text: string; count: number }> {
  return report.lessons
}
