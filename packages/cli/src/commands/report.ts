import chalk from 'chalk'
import { join } from 'node:path'
import { resolveHome } from '../core/home.js'
import { loadRuleHierarchy, winningPromotionThreshold } from '../core/enforce/rule-parser.js'
import {
  loadTraceEntries,
  computeActionSummary,
  computePromotionReport,
  collectObserveRuleIds,
  type TraceEntry,
  type ActionSummary,
  type PromotionRow,
} from './retrospective.js'

/**
 * `keel report` — "what did keel do for me": a plain-language accounting of
 * blocks, warns, redirects, and observe-mode fires over a session or a week,
 * plus which observe rules are ready to promote.
 *
 * This is deliberately a NARROWER lens than `keel retrospective`.
 * Retrospective answers "is the agent getting better at working with me"
 * (attempts-to-success, stuck loops, churn — session productivity).
 * `keel report` answers "what did the enforcement layer actually do" —
 * the adoption question a user asks after their first week running keel.
 * Both read the same trace stream (loadTraceEntries) and the same
 * TRACKED_AGENTS/isBefore filter, via retrospective.ts, so the two
 * surfaces never silently disagree on what counts as a real evaluation.
 *
 * Default window is the last 7 days (a "week" report) rather than
 * retrospective's "since the beginning of time" default — an adoption
 * report that opens with months of accumulated noise is not a week's
 * report. Pass --since to widen it, or --session to narrow to one agent
 * session (the "single session" half of the brief).
 */

function defaultSince(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export interface ReportPayload {
  window: { start: string; end: string }
  sessions: number
  action_summary: ActionSummary
  promotion: PromotionRow[]
}

export function buildReportPayload(entries: TraceEntry[], since: string, project?: string, sessionId?: string): { entries: TraceEntry[]; sessions: number } {
  let scoped = entries
  if (sessionId) scoped = scoped.filter((e) => e.session_id === sessionId)
  if (project) scoped = scoped.filter((e) => (e.cwd || '').includes(project))
  const sessions = new Set(scoped.map((e) => e.session_id || 'unknown'))
  return { entries: scoped, sessions: sessions.size }
}

function pctOf(n: number, total: number): string {
  if (total === 0) return '—'
  return `${((n / total) * 100).toFixed(1)}%`
}

export async function reportCommand(options: { since?: string; project?: string; session?: string; json?: boolean } = {}) {
  // Read fresh on every call — same reasoning as retrospectiveCommand: a
  // module-level const would freeze KEEL_TRACES_DIR at first import.
  const auditDir = process.env.KEEL_TRACES_DIR || join(resolveHome(), '.keel', 'traces')
  const since = options.since || defaultSince()
  const allEntries = loadTraceEntries(auditDir, since)
  const { entries, sessions } = buildReportPayload(allEntries, since, options.project, options.session)

  const actionSummary = computeActionSummary(entries)

  // Deliberately process.cwd(), not options.project: which rules.yaml
  // hierarchy is "active" (and therefore which project/local `mode:
  // observe` rules even exist to report on) is a property of where this
  // command was invoked, not an arbitrary trace filter. This mirrors
  // retrospectiveCommand exactly, so the two surfaces never disagree on a
  // rule's promotion recommendation for the same trace file. One
  // consequence worth knowing: `--project <path>` scopes entries by cwd
  // substring on TOP of computePromotionReport's own project-scoping for
  // scoped rules — running `keel report --project X` from a directory
  // whose OWN rules hierarchy has no rule id matching X's traffic will
  // under-report (insufficient_data, not a wrong answer, just a narrower
  // one). Run `keel report --project X` from inside X to see its full
  // promotion picture.
  const hierarchy = loadRuleHierarchy(process.cwd())
  const observeRules = collectObserveRuleIds(hierarchy)
  const threshold = winningPromotionThreshold(hierarchy)
  const promotion = computePromotionReport(entries, observeRules, threshold, process.cwd())

  const payload: ReportPayload = {
    window: { start: since, end: new Date().toISOString().slice(0, 10) },
    sessions,
    action_summary: actionSummary,
    promotion,
  }

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  console.log(chalk.bold.cyan('\n  ⚓ keel report — what keel did for you'))
  console.log(chalk.dim(`  ${payload.window.start} → ${payload.window.end}${options.session ? `  session: ${options.session}` : ''}${options.project ? `  project: ${options.project}` : ''}`))
  console.log()

  if (actionSummary.total_evaluations === 0) {
    console.log(chalk.yellow('  No enforcement traces in this window.'))
    console.log(chalk.dim('  Nothing to report yet — keel records a trace every time an installed'))
    console.log(chalk.dim('  hook evaluates a tool call. Run an agent session, or widen --since.'))
    console.log()
    return
  }

  console.log(`  ${chalk.white(String(actionSummary.total_evaluations))} tool calls evaluated across ${chalk.white(String(sessions))} session(s)`)
  console.log()
  console.log(`  ${chalk.red('blocked')}     ${String(actionSummary.blocked).padStart(4)}  ${chalk.dim(pctOf(actionSummary.blocked, actionSummary.total_evaluations))}`)
  console.log(`  ${chalk.yellow('warned')}     ${String(actionSummary.warned).padStart(4)}  ${chalk.dim(pctOf(actionSummary.warned, actionSummary.total_evaluations))}`)
  console.log(`  ${chalk.yellow('redirected')} ${String(actionSummary.redirected).padStart(4)}  ${chalk.dim(pctOf(actionSummary.redirected, actionSummary.total_evaluations))}`)
  console.log(`  ${chalk.dim('observed')}   ${String(actionSummary.observe_fires).padStart(4)}  ${chalk.dim('(mode: observe — shadow-recorded, never blocked)')}`)

  const ruleLine = (label: string, rules: ActionSummary['top_blocking_rules']) => {
    if (rules.length === 0) return
    console.log()
    console.log(chalk.dim(`  ${label}`))
    for (const r of rules) {
      console.log(`    ${chalk.white(r.rule_id.padEnd(30))}${chalk.dim(`${r.count}×`)}`)
    }
  }
  ruleLine('Most active blocking/redirect rules', actionSummary.top_blocking_rules)
  ruleLine('Most active warning rules', actionSummary.top_warning_rules)
  ruleLine('Most active observe rules', actionSummary.top_observe_rules)

  if (promotion.length > 0) {
    const eligible = promotion.filter((p) => p.recommendation === 'eligible')
    console.log()
    if (eligible.length > 0) {
      console.log(chalk.green(`  ${eligible.length} rule${eligible.length === 1 ? '' : 's'} eligible for promotion:`))
      for (const p of eligible) {
        console.log(`    ${chalk.white(p.rule_id.padEnd(30))}${chalk.dim(p.detail)}`)
      }
      console.log(chalk.dim('    Promote with: keel promote <rule-id> (run from your own terminal — never through the agent)'))
    } else {
      console.log(chalk.dim(`  No rules eligible for promotion this window (${promotion.length} observe rule(s) tracked — see \`keel retrospective\` for the full breakdown).`))
    }
  }
  console.log()
}
