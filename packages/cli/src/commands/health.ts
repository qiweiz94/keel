import { TRACKED_AGENTS, type TraceEntry } from './retrospective.js'

/**
 * Telemetry liveness — "is keel actually receiving data?"
 *
 * This exists because every metric keel reports depends on trace fields
 * that were silently absent: `keel retrospective` reported 0% verification
 * completion for days, and the cause was not the metric but an old plugin
 * that never wrote exit codes. Nothing surfaced that. Configuration was
 * visible; *flow* was not.
 *
 * Design rules, each learned from a bug in this codebase:
 *
 * 1. **Absent data is `unknown`, never `green`.** A health check that
 *    reports healthy when it has nothing to look at is worse than none.
 * 2. **Judge on a recent window, not the whole corpus.** After a plugin
 *    upgrade the history is a mix of thousands of blind entries and a few
 *    good ones; a ratio over everything reads ~0% and says "broken" while
 *    telemetry works. Same wrong-denominator shape as the
 *    attempts-to-success defect.
 * 3. **Filter noise before judging.** `keel evaluate` writes entries with
 *    `agent: "unknown"` and no hook; counting those as agent activity
 *    would report a live agent on an idle machine.
 */

export type HealthState = 'green' | 'amber' | 'red' | 'unknown'

export interface HealthLine {
  id: string
  label: string
  state: HealthState
  detail: string
  /** What the user should actually do. Omitted when nothing is wrong. */
  fix?: string
}

/** How many recent entries define "now". Large enough to survive a quiet
 *  patch, small enough that yesterday's blind history cannot outvote it. */
const WINDOW = 20
const STALE_MS = 24 * 60 * 60 * 1000

const isTracked = (e: TraceEntry) => TRACKED_AGENTS.has(String(e.agent))

/** Newest-first, so a window is simply a slice from the front. */
function recent(entries: TraceEntry[], hook: string): TraceEntry[] {
  return entries
    .filter(e => isTracked(e) && e.hook === hook)
    .sort((a, b) => (b.t || 0) - (a.t || 0))
    .slice(0, WINDOW)
}

function humanAge(ms: number): string {
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function telemetryHealth(entries: TraceEntry[], now: number): HealthLine[] {
  const lines: HealthLine[] = []
  const tracked = entries.filter(isTracked)

  // ── Has a real agent session run, and when? ──
  const newest = tracked.reduce<TraceEntry | null>((a, e) => (!a || (e.t || 0) > (a.t || 0) ? e : a), null)
  if (!newest?.t) {
    lines.push({
      id: 'agent-activity',
      label: 'Agent activity',
      state: 'unknown',
      detail: 'no agent session recorded yet',
      fix: 'restart OpenCode so the plugin loads, then run a session',
    })
  } else {
    const age = now - newest.t
    lines.push({
      id: 'agent-activity',
      label: 'Agent activity',
      state: age > STALE_MS ? 'amber' : 'green',
      detail: `last session ${humanAge(age)}`,
      ...(age > STALE_MS ? { fix: 'no recent activity — is OpenCode running with the plugin loaded?' } : {}),
    })
  }

  // ── Outcome telemetry: exit codes. Everything downstream needs these. ──
  const afters = recent(entries, 'tool.execute.after')
  const withExit = afters.filter(e => typeof e.exit === 'number').length
  if (afters.length === 0) {
    lines.push({
      id: 'exit-telemetry',
      label: 'Outcome telemetry',
      state: 'unknown',
      detail: 'no completed tool calls to inspect',
      fix: 'restart OpenCode, then run a session',
    })
  } else if (withExit === 0) {
    lines.push({
      id: 'exit-telemetry',
      label: 'Outcome telemetry',
      state: 'red',
      detail: `0 of the last ${afters.length} tool results carried an exit code`,
      fix: 'restart OpenCode — the loaded plugin predates exit-code telemetry, so every metric reads zero',
    })
  } else {
    lines.push({
      id: 'exit-telemetry',
      label: 'Outcome telemetry',
      state: 'green',
      detail: `${withExit} of the last ${afters.length} tool results carried an exit code`,
    })
  }

  // ── Turn numbers: same-turn correlation and claim pairing need these. ──
  const befores = recent(entries, 'tool.execute.before')
  const withTurn = befores.filter(e => typeof e.turn_number === 'number' && e.turn_number > 0).length
  if (befores.length === 0) {
    lines.push({ id: 'turn-telemetry', label: 'Turn telemetry', state: 'unknown', detail: 'no tool calls to inspect' })
  } else if (withTurn === 0) {
    lines.push({
      id: 'turn-telemetry',
      label: 'Turn telemetry',
      state: 'red',
      detail: `turn numbers are all zero across the last ${befores.length} calls`,
      fix: 'restart OpenCode — without real turns, same-turn rules degrade to session-wide',
    })
  } else {
    lines.push({
      id: 'turn-telemetry',
      label: 'Turn telemetry',
      state: 'green',
      detail: `${withTurn} of the last ${befores.length} calls carried a real turn number`,
    })
  }

  // ── How much of the corpus is test-harness noise? ──
  if (entries.length) {
    const noise = entries.filter(e => !isTracked(e)).length
    const pct = Math.round((noise / entries.length) * 100)
    lines.push({
      id: 'noise',
      label: 'Trace quality',
      state: pct > 50 ? 'amber' : 'green',
      detail: `${pct}% of ${entries.length} recent entries are non-agent (test-harness) records, excluded from metrics`,
    })
  }

  return lines
}
