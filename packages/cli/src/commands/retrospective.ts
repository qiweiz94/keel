import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { resolveHome } from '../core/home.js'
import { commandFingerprint } from '../core/enforce/command-fingerprint.js'
import { loadRuleHierarchy, winningPromotionThreshold } from '../core/enforce/rule-parser.js'
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
 * Metrics definitions.
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
  /** Real per-session turn index. Was hardcoded 0 before the plugin fix,
   *  so absent-or-zero means the trace predates working turn telemetry. */
  turn_number?: number
  /**
   * Mirrors EnforceResult.observed_action: set when exactly one `mode:
   * observe` rule matched (or, for older/simpler entries, whichever one
   * landed in the single-slot legacy field). See observed_matches for the
   * complete picture when more than one observe rule matched on the call.
   */
  observed_action?: string
  /**
   * Mirrors EnforceResult.observed_matches — every `mode: observe` rule
   * that matched during this call, written by opencode-plugin's `record()`
   * (plugin.ts's `before()` hook) straight from the pipeline result. This
   * is the promotion pipeline's shadow-counter source: see
   * computePromotionReport() below.
   */
  observed_matches?: Array<{ rule_id: string; observed_action: string; message?: string }>
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

/**
 * Agents whose traces are real enforcement events. The `keel evaluate` test
 * harness writes entries with `agent: "unknown"` and no `hook` — §2.1 of the
 * design doc measured 224 of 3,201 entries on one day, which produced
 * hundreds of false repeat hits. Filtering is mandatory for every detector.
 *
 * This is a list, not a single id, because Phase 4 adds thin clients on other
 * platforms; each new client's agent id must land here or its whole trace
 * stream becomes invisible to the retrospective and to `keel gather`.
 */
export const TRACKED_AGENTS = new Set(['opencode-plugin', 'openclaw-plugin', 'hermes-plugin', 'claude-code-hook'])

/**
 * Exported so the promotion pipeline (computePromotionReport, below) reuses
 * the SAME "which entries count as a real enforcement evaluation" filter
 * every other retrospective metric uses — a would-block rate computed
 * against a different denominator than attempts-to-success or stuck-loops
 * would silently disagree with the rest of this report for no principled
 * reason.
 */
export function isBefore(e: TraceEntry): boolean {
  return e.hook === 'tool.execute.before' && TRACKED_AGENTS.has(String(e.agent))
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
  // Two things this must get right, both learned the hard way:
  //
  // 1. The after-entry is paired POSITIONALLY. Matching by fingerprint alone
  //    always returns the session's first run of that command, so a
  //    fail → fail → pass sequence (exits 1,1,0) reads exit 1 forever and the
  //    session is scored as never verified — exactly the recoveries this
  //    metric exists to count. Entries are time-sorted by loadTraceEntries.
  //
  // 2. Only a pass AFTER the first source edit counts. A green run that
  //    precedes every edit is a baseline, not a verification of the work —
  //    scanning from index 0 produced negative attempt counts for the
  //    (perfectly normal) baseline-first workflow, and those negatives then
  //    dragged the median. A session with no source edit attempted nothing,
  //    so its attempts-to-success is null rather than an index.
  //
  // Deviation recorded in the decisions log: §6 metric 6 says "sessions with
  // pass evidence"; we require that evidence to post-date the first edit.
  let attemptsToSuccess: number | null = null
  let verificationCompleted = false
  const afterEvents = after.map((a) => ({ cmd: normalize(commandOf(a)), exit: a.exit, t: a.t || 0, used: false }))
  const firstSourceEdit = before.findIndex(isSourceEdit)
  if (firstSourceEdit >= 0) {
    for (let i = firstSourceEdit + 1; i < before.length; i++) {
      const e = before[i]
      if (!isTestCommand(commandOf(e))) continue
      const fp = normalize(commandOf(e))
      // Each result pairs with exactly one call, and is then consumed.
      // Timestamps alone are not enough: the plugin stamps with
      // Date.now(), and a real session lands several calls inside the same
      // millisecond, so a time-ordered `find` kept returning the FIRST
      // matching result and a fail→fail→pass run read as never passing.
      // Consumption makes the pairing genuinely positional.
      const paired = afterEvents.find((a) => !a.used && a.cmd === fp && a.t >= (e.t || 0))
      if (paired) paired.used = true
      if (paired && paired.exit === 0) {
        verificationCompleted = true
        attemptsToSuccess = i - firstSourceEdit
        break
      }
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
  // Two constraints, both found by testing rather than by reading:
  //
  // 1. Only keys that actually formed a stuck cluster may anchor the window.
  //    Scanning every entry collides all the rule-less, command-less calls
  //    (writes, reads) on the key "null:", which puts the anchor at the start
  //    of the session and measures the wrong five calls.
  //
  // 2. EVERY stuck cluster is evaluated, not just the first to repeat. A
  //    session that pivots away from one loop while still circling on another
  //    has not recovered; anchoring on whichever cluster fired first credited
  //    it with a pivot it never made. This is §6 metric 8, the headline
  //    number, so it reports true only when every loop was broken.
  const famOf = (c: string) => c.trim().split(/\s+/)[0] || ''
  let pivotedAfterStuck: boolean | null = null
  if (stuckKeys.size > 0) {
    const perCluster: boolean[] = []
    for (const key of stuckKeys) {
      let seen = 0
      let secondRepeatAt = -1
      for (let i = 0; i < before.length; i++) {
        const e = before[i]
        if (!e.rule_id || !VERDICTS.includes(String(e.action))) continue
        if (clusterKey(e) !== key) continue
        if (++seen === 2) { secondRepeatAt = i; break }
      }
      if (secondRepeatAt < 0) continue
      const window = before.slice(secondRepeatAt + 1, secondRepeatAt + 6)
      const anchorFam = famOf(commandOf(before[secondRepeatAt]))
      perCluster.push(
        window.some(isResearch) || window.some((w) => famOf(commandOf(w)) !== anchorFam),
      )
    }
    if (perCluster.length > 0) pivotedAfterStuck = perCluster.every(Boolean)
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

// ── Promotion pipeline ───────────────────────────────────────────────
//
// Shadow counters per `mode: observe` rule, derived from the SAME trace
// stream the rest of this report reads (loadTraceEntries + isBefore — no
// second parser). Every tracked `tool.execute.before` event is one
// evaluation opportunity for every active rule; an observe rule that
// matched during that call records itself either in the single-slot
// legacy `rule_id`/`observed_action` fields (exactly one observe rule
// matched) or in `observed_matches` (any number, including zero — see
// pipeline.ts's evaluate()/violation() for why more than one can now
// land on a single call: a matched observe rule records and evaluation
// CONTINUES instead of blinding a lower-priority rule).

export type PromotionRecommendation = 'eligible' | 'stay_observe' | 'insufficient_data'

export interface PromotionRow {
  rule_id: string
  total_evaluations: number
  would_block_count: number
  /** would_block_count / total_evaluations, or null when there is no traffic at all. */
  rate: number | null
  threshold: number
  recommendation: PromotionRecommendation
  /** Whether this rule's denominator was scoped to one project's traces (see ObserveRuleRef). */
  scoped: boolean
  detail: string
}

/** A `mode: observe` rule to report on, plus where it lives in the hierarchy. */
export interface ObserveRuleRef {
  id: string
  /**
   * true for a rule declared in a project/local rules.yaml — its
   * denominator must be scoped to THAT project's traces (see
   * computePromotionReport's projectDir param), or traffic from every
   * OTHER project using keel inflates the denominator and pushes an
   * under-measured rate toward `eligible`. false for a global/user rule,
   * which genuinely applies (and is genuinely measured) across every
   * project — its denominator is the full trace stream.
   */
  scoped: boolean
}

/**
 * would-block: the action the rule WOULD have taken is one the host
 * actually THROWS on (interrupts the tool call), not merely "sounds
 * severe". Verified against opencode-plugin/src/plugin.ts's `before()`:
 * `deny`, `block`, and `prompt` throw via the block/gate path, and
 * `redirect` throws too (`throw new Error('[Keel] REDIRECT ...')`) — it is
 * NOT a soft signal, it interrupts exactly like a deny does. `warn`
 * surfaces without interrupting and `fix` mutates args and lets the call
 * proceed, so neither counts. Getting this wrong is not cosmetic: three of
 * the six rules this pipeline exists to serve (no-repeat-loops's
 * escalation ladder, research-before-fix, root-cause-before-refactor) use
 * `redirect` as their primary — often their ONLY — interrupting action;
 * excluding it would make every one of them measure a false-positive rate
 * of zero regardless of how often they actually fire.
 */
function isWouldBlock(action: string | undefined): boolean {
  return action === 'deny' || action === 'block' || action === 'prompt' || action === 'redirect'
}

function projectMatches(cwd: string | undefined, projectDir: string): boolean {
  if (!cwd) return false
  return cwd === projectDir || cwd.startsWith(`${projectDir}/`)
}

/**
 * Per-rule would-block rate and promotion recommendation, computed purely
 * from already-loaded trace entries — no disk I/O, so this is directly
 * unit-testable against synthetic JSONL fixtures. `rules` is the set of
 * `mode: observe` rules to report on (including ones with ZERO matches —
 * "never fired in M evaluations" is itself a real, reportable data point,
 * not silence); the CLI command below derives it from the live
 * rules.yaml hierarchy via collectObserveRuleIds().
 *
 * `threshold` is `promotion_fp_threshold` (default
 * DEFAULT_PROMOTION_FP_THRESHOLD, 1 per 1000) — read from the winning
 * rules.yaml by the caller, never hardcoded here.
 *
 * `projectDir`, when given, scopes the denominator for every `scoped:
 * true` rule (declared in a project/local rules.yaml) to entries whose
 * `cwd` falls under it — a project-only rule measured against every OTHER
 * project's traffic too would report a rate diluted by calls it was never
 * even loaded for, silently pushing it toward `eligible`. Global/user
 * rules are unaffected: they are genuinely active everywhere, so the full
 * trace stream is their correct denominator. Omitting `projectDir`
 * degrades every rule to the unscoped (whole-trace-stream) denominator —
 * still correct, just less precise for project-local rules.
 *
 * A rate below threshold is NOT automatically "eligible": with too few
 * evaluations, a rate near zero is indistinguishable from "we simply
 * haven't seen enough traffic yet" — recommending promotion off three
 * observations is a correctness bug in the headline claim, not caution.
 * `minEvaluations` (1 / threshold — the sample size at which a single
 * would-block would still register above threshold) gates a third
 * recommendation, `insufficient_data`, distinct from both `eligible` and
 * `stay_observe`.
 */
export function computePromotionReport(entries: TraceEntry[], rules: ObserveRuleRef[], threshold: number, projectDir?: string): PromotionRow[] {
  const allBefore = entries.filter(isBefore)
  const scopedBefore = projectDir ? allBefore.filter((e) => projectMatches(e.cwd, projectDir)) : allBefore
  const minEvaluations = threshold > 0 ? Math.ceil(1 / threshold) : Infinity

  const countFor = (before: TraceEntry[]) => {
    const wouldBlockCounts = new Map<string, number>()
    const bump = (ruleId: string | null | undefined, action: string | undefined) => {
      if (!ruleId || !isWouldBlock(action)) return
      wouldBlockCounts.set(ruleId, (wouldBlockCounts.get(ruleId) || 0) + 1)
    }
    for (const e of before) {
      bump(e.rule_id, e.observed_action)
      for (const m of e.observed_matches || []) bump(m.rule_id, m.observed_action)
    }
    return wouldBlockCounts
  }
  const allCounts = countFor(allBefore)
  const scopedCounts = projectDir ? countFor(scopedBefore) : allCounts

  return rules.map(({ id: ruleId, scoped }) => {
    const useScoped = scoped && !!projectDir
    const before = useScoped ? scopedBefore : allBefore
    const counts = useScoped ? scopedCounts : allCounts
    const totalEvaluations = before.length
    const wouldBlock = counts.get(ruleId) || 0
    const rate = totalEvaluations > 0 ? wouldBlock / totalEvaluations : null
    let recommendation: PromotionRecommendation
    let detail: string
    const scopeLabel = useScoped ? 'this project' : 'all traces'
    if (totalEvaluations === 0 || totalEvaluations < minEvaluations) {
      recommendation = 'insufficient_data'
      detail = `${wouldBlock} would-block(s) in ${totalEvaluations} eval(s), ${scopeLabel} — need ${minEvaluations}+ evaluations to trust a rate this small`
    } else if ((rate ?? 1) < threshold) {
      recommendation = 'eligible'
      detail = `${wouldBlock} would-block(s) in ${totalEvaluations} evals, ${scopeLabel} (${((rate ?? 0) * 100).toFixed(3)}%) — eligible for promotion to warn`
    } else {
      recommendation = 'stay_observe'
      detail = `${wouldBlock} would-block(s) in ${totalEvaluations} evals, ${scopeLabel} — review before promoting`
    }
    return { rule_id: ruleId, total_evaluations: totalEvaluations, would_block_count: wouldBlock, rate, threshold, recommendation, scoped: useScoped, detail }
  })
}

/**
 * Every `mode: observe` rule across the whole hierarchy (global, user,
 * project, local), deduped by id. `scoped` marks a project/local rule so
 * computePromotionReport() can scope its denominator to this project's
 * own traces — see ObserveRuleRef's field comment. A rule id that appears
 * at BOTH an unscoped (global/user) source and a scoped (project/local)
 * source is treated as unscoped: global/user is the wider claim ("this
 * rule applies everywhere"), and the wider claim wins when the two
 * disagree, matching how a promotion decision should read the ambiguity —
 * as "measure it against everything", not "measure it against less".
 */
export function collectObserveRuleIds(hierarchy: import('../core/enforce/rule-parser.js').RuleHierarchy): ObserveRuleRef[] {
  const scopedById = new Map<string, boolean>()
  const add = (source: { rules: import('../core/types.js').KeelRule[] } | null | undefined, scoped: boolean) => {
    for (const rule of source?.rules || []) {
      if (rule.mode !== 'observe') continue
      const existing = scopedById.get(rule.id)
      if (existing === undefined || existing === true) scopedById.set(rule.id, scoped)
    }
  }
  add(hierarchy.global, false)
  add(hierarchy.user, false)
  add(hierarchy.project, true)
  add(hierarchy.local, true)
  return [...scopedById.entries()].map(([id, scoped]) => ({ id, scoped }))
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
  // Read fresh on every call, not a module-level const: a module-level
  // const is fixed at first import of this file (whichever test happens
  // to import it first, process-wide) and defeats a test that sets
  // KEEL_TRACES_DIR in its own setup after some other file already
  // triggered the import — the exact reasoning documented on AuditLog's
  // constructor (audit.ts) for the identical env-override-else-real-home
  // shape.
  const auditDir = process.env.KEEL_TRACES_DIR || join(resolveHome(), '.keel', 'traces')
  const entries = loadTraceEntries(auditDir, options.since)
  const filtered = buildReport(entries, options.since, options.project)

  const hierarchy = loadRuleHierarchy(process.cwd())
  const observeRules = collectObserveRuleIds(hierarchy)
  const threshold = winningPromotionThreshold(hierarchy)
  // projectDir scopes a project/local rule's denominator to THIS
  // project's own traces (see computePromotionReport's field comment) —
  // without it, a project-only rule's rate is diluted by every other
  // project's traffic and reads more eligible than it is.
  const promotion = computePromotionReport(entries, observeRules, threshold, process.cwd())

  if (options.json) {
    console.log(JSON.stringify({ ...filtered, promotion }, null, 2))
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
  if (promotion.length) {
    console.log()
    console.log(chalk.dim(`  Promotion (mode: observe rules, threshold ${threshold} = ${(threshold * 100).toFixed(2)}% would-block rate)`))
    for (const p of promotion) {
      const label = p.recommendation === 'eligible'
        ? chalk.green('eligible for promotion to warn')
        : p.recommendation === 'insufficient_data'
          ? chalk.dim('insufficient data')
          : chalk.yellow('stay observe')
      console.log(`    ${chalk.white(p.rule_id.padEnd(30))}${label}`)
      console.log(`      ${chalk.dim(p.detail)}`)
    }
    console.log(chalk.dim('    Promote with: keel promote <rule-id> (run from your own terminal — never through the agent)'))
  } else if (observeRules.length === 0) {
    console.log()
    console.log(chalk.dim('  Promotion: no `mode: observe` rules found in the current rules.yaml hierarchy.'))
  }
  console.log()

  if (options.write) {
    const week = filtered.window.end
    const dir = join(resolveHome(), '.keel', 'retrospectives', options.project || 'all')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${week}.md`)
    const lines = [`## keel retrospective (${filtered.window.start} → ${filtered.window.end})`, '']
    for (const [label, value] of rows) lines.push(`- ${label}: ${value}`)
    lines.push('', `- top problems: ${filtered.top_problems.map((p) => `${p.signature}(${p.sessions})`).join(', ') || 'none'}`, '')
    appendFileSync(path, lines.join('\n'))
    console.log(chalk.dim(`  Wrote ${path}`))
  }
}
