import { describe, it, expect } from 'vitest'
import { analyzeSession, buildReport, loadTraceEntries, computePromotionReport, collectObserveRuleIds } from '../commands/retrospective.js'

/**
 * Phase 3 — the learning loop: metrics computed from the trace stream
 * (exit codes + cwd recorded by the plugin make them exact).
 */

interface FixtureEntry {
  t: number
  agent: string
  session_id: string
  tool: string
  args: Record<string, unknown>
  rule_id?: string | null
  action?: string
  hook: string
  exit?: number
  cwd?: string
  observed_action?: string
  observed_matches?: Array<{ rule_id: string; observed_action: string; message?: string }>
}

let tick = 1_000_000
function entry(session: string, tool: string, command: string, extra: Partial<FixtureEntry> = {}): FixtureEntry {
  tick += 1000
  return {
    t: tick,
    agent: 'opencode-plugin',
    session_id: session,
    tool,
    args: { command },
    rule_id: null,
    action: 'allow',
    hook: 'tool.execute.before',
    cwd: '/tmp/proj-a',
    ...extra,
  }
}

function before(session: string, tool: string, command: string, extra: Partial<FixtureEntry> = {}): FixtureEntry {
  return entry(session, tool, command, { ...extra, hook: 'tool.execute.before' })
}

function after(session: string, tool: string, command: string, exit: number): FixtureEntry {
  return entry(session, tool, command, { hook: 'tool.execute.after', exit })
}

function write(session: string, path: string, extra: Partial<FixtureEntry> = {}): FixtureEntry {
  return entry(session, 'write', '', { ...extra, args: { filePath: path, content: 'x' } })
}

describe('retrospective metrics', () => {
  it('scores a research-first session as successful', () => {
    const s = 'good-1'
    const entries = [
      before(s, 'Bash', 'ls'),
      before(s, 'websearch', 'latest docs for auth'),
      write(s, '/tmp/proj-a/src/auth.ts'),
      before(s, 'Bash', 'npm test'),
      after(s, 'Bash', 'npm test', 0),
      before(s, 'Bash', 'git commit -m x'),
    ]
    const m = analyzeSession(entries)
    expect(m).not.toBeNull()
    expect(m!.research_before_solve).toBe(true)
    expect(m!.verification_completed).toBe(true)
    expect(m!.attempts_to_success).not.toBeNull()
    expect(m!.stuck_loops).toBe(0)
    expect(m!.project).toBe('/tmp/proj-a')
  })

  it('detects a stuck loop and no pivot', () => {
    const s = 'stuck-1'
    const entries = [
      before(s, 'Bash', 'npm test', { rule_id: 'no-test-loops', action: 'warn' }),
      after(s, 'Bash', 'npm test', 1),
      before(s, 'Bash', 'npm test', { rule_id: 'no-test-loops', action: 'warn' }),
      after(s, 'Bash', 'npm test', 1),
      before(s, 'Bash', 'npm test', { rule_id: 'no-test-loops', action: 'redirect' }),
      after(s, 'Bash', 'npm test', 1),
      before(s, 'Bash', 'npm test', { rule_id: 'no-test-loops', action: 'deny' }),
      after(s, 'Bash', 'npm test', 1),
    ]
    const m = analyzeSession(entries)
    expect(m!.stuck_loops).toBe(1)
    expect(m!.verification_completed).toBe(false)
    expect(m!.pivoted_after_stuck).toBe(false)
    expect(m!.attempts_to_success).toBeNull()
  })

  it('counts churn cycles on the same file', () => {
    const s = 'churn-1'
    const entries = [
      write(s, '/tmp/proj-a/src/x.ts'),
      before(s, 'Bash', 'npm test'),
      after(s, 'Bash', 'npm test', 1),
      write(s, '/tmp/proj-a/src/x.ts'),
      before(s, 'Bash', 'npm test'),
      after(s, 'Bash', 'npm test', 1),
      write(s, '/tmp/proj-a/src/x.ts'),
    ]
    const m = analyzeSession(entries)
    expect(m!.churn_cycles).toBeGreaterThanOrEqual(2)
  })

  it('aggregates sessions into a report with lessons', () => {
    const good = [
      before('g2', 'websearch', 'x'),
      write('g2', '/tmp/proj-a/src/a.ts'),
      before('g2', 'Bash', 'npm test'),
      after('g2', 'Bash', 'npm test', 0),
    ]
    const stuck = [
      before('s2', 'Bash', 'npm test', { rule_id: 'r1', action: 'warn' }),
      before('s2', 'Bash', 'npm test', { rule_id: 'r1', action: 'warn' }),
      before('s2', 'Bash', 'npm test', { rule_id: 'r1', action: 'redirect' }),
      after('s2', 'Bash', 'npm test', 1),
    ]
    const report = buildReport([...good, ...stuck])
    expect(report.aggregate.sessions).toBe(2)
    expect(report.aggregate.success_rate).toBe(0.5)
    expect(report.aggregate.stuck_loops_per_session).toBe(0.5)
    expect(report.aggregate.research_before_solve_rate).toBe(1)
    expect(report.lessons.some((l) => l.key === 'stuck-loop')).toBe(true)
    expect(report.top_problems.some((p) => p.signature === 'stuck-loop')).toBe(true)
  })

  it('loads trace files and filters noise', () => {
    // (loadTraceEntries is exercised through the CLI in other suites; here
    // we just confirm the entry loader tolerates missing dirs.)
    expect(loadTraceEntries('/nonexistent-dir-xyz')).toEqual([])
  })

  // ── F1: after-entries must be paired positionally, not by first match ──
  it('credits a fail → fail → pass run as verified, from the first source edit', () => {
    const s = 'recover-1'
    const entries = [
      write(s, '/tmp/proj-a/README.md'),          // 0 — not a source edit
      write(s, '/tmp/proj-a/src/a.ts'),           // 1 — the AUS baseline (§6 metric 1)
      before(s, 'Bash', 'npm test'),              // 2
      after(s, 'Bash', 'npm test', 1),
      before(s, 'Bash', 'npm test'),              // 3
      after(s, 'Bash', 'npm test', 1),
      before(s, 'Bash', 'npm test'),              // 4 — this one passes
      after(s, 'Bash', 'npm test', 0),
    ]
    const m = analyzeSession(entries)
    expect(m!.verification_completed).toBe(true)
    expect(m!.attempts_to_success).toBe(3)
  })

  // ── A2: a green baseline run before any edit is not a verification ──
  it('ignores a passing run that precedes the first source edit', () => {
    const s = 'baseline-1'
    const entries = [
      before(s, 'Bash', 'npm test'),              // 0 — baseline, before any edit
      after(s, 'Bash', 'npm test', 0),
      write(s, '/tmp/proj-a/src/a.ts'),           // 1 — first source edit
      before(s, 'Bash', 'npm test'),              // 2 — the real verification
      after(s, 'Bash', 'npm test', 0),
    ]
    const m = analyzeSession(entries)
    expect(m!.attempts_to_success).toBe(1)   // 2 - 1, never negative
    expect(m!.verification_completed).toBe(true)
  })

  it('reports no attempts-to-success for a session that never edits source', () => {
    const s = 'readonly-1'
    const entries = [
      before(s, 'Bash', 'ls'),
      before(s, 'Bash', 'cat x'),
      before(s, 'Bash', 'npm test'),
      after(s, 'Bash', 'npm test', 0),
    ]
    const m = analyzeSession(entries)
    expect(m!.source_edits).toBe(0)
    expect(m!.attempts_to_success).toBeNull()
    expect(m!.verification_completed).toBe(false)
  })

  it('stops at the first post-edit pass even if later work fails', () => {
    // Chosen behavior, not accidental: §6 metric 1 is "min i such that…".
    const s = 'later-fail-1'
    const entries = [
      write(s, '/tmp/proj-a/src/a.ts'),           // 0
      before(s, 'Bash', 'npm test'),              // 1 — passes
      after(s, 'Bash', 'npm test', 0),
      write(s, '/tmp/proj-a/src/b.ts'),           // 2
      before(s, 'Bash', 'npm test'),              // 3 — later failure
      after(s, 'Bash', 'npm test', 1),
    ]
    expect(analyzeSession(entries)!.attempts_to_success).toBe(1)
  })

  // ── A3: the pivot window must account for EVERY stuck cluster ──
  it('does not credit a pivot when a second stuck cluster never pivoted', () => {
    const s = 'two-clusters'
    const entries = [
      before(s, 'Bash', 'npm test', { rule_id: 'rA', action: 'warn' }),
      before(s, 'Bash', 'npm test', { rule_id: 'rA', action: 'warn' }),
      before(s, 'websearch', 'docs for the failing module'),   // cluster A pivots
      before(s, 'Bash', 'npm test', { rule_id: 'rA', action: 'deny' }),
      before(s, 'Bash', 'git commit -m x', { rule_id: 'rB', action: 'warn' }),
      before(s, 'Bash', 'git commit -m x', { rule_id: 'rB', action: 'warn' }),
      before(s, 'Bash', 'git commit -m x', { rule_id: 'rB', action: 'deny' }),
      before(s, 'Bash', 'git commit -m x', { rule_id: 'rB', action: 'deny' }),
    ]
    const m = analyzeSession(entries)
    expect(m!.stuck_loops).toBe(2)
    // Cluster B never pivoted, so the session did not recover from every loop.
    expect(m!.pivoted_after_stuck).toBe(false)
  })

  it('pairs results positionally when timestamps tie in the same millisecond', () => {
    // Real plugin traces stamp with Date.now(), and a session lands
    // several calls inside one millisecond — so every fixture in this file
    // that spaces entries a second apart was hiding a bug. Matching on
    // time alone returned the FIRST result for every call, and a genuine
    // fail → fail → pass recovery scored as never passing.
    const s = 'tied'
    const at = (t: number, extra: Partial<FixtureEntry>): FixtureEntry => ({
      t, agent: 'opencode-plugin', session_id: s, tool: 'Bash',
      args: { command: 'npm test' }, rule_id: null, action: 'allow',
      hook: 'tool.execute.before', ...extra,
    })
    const entries = [
      { ...at(1000, { tool: 'write', args: { filePath: '/p/src/a.ts' } }) },
      at(1001, {}), at(1001, { hook: 'tool.execute.after', exit: 1 }),
      at(1001, {}), at(1001, { hook: 'tool.execute.after', exit: 1 }),
      at(1001, {}), at(1001, { hook: 'tool.execute.after', exit: 0 }),
    ]
    const m = analyzeSession(entries)
    expect(m!.verification_completed).toBe(true)
    expect(m!.attempts_to_success).toBe(3)
  })

  // ── F2: --project must re-aggregate over the filtered sessions ──
  it('re-aggregates when sessions are filtered to one project', () => {
    const a = [
      before('pa', 'websearch', 'x', { cwd: '/tmp/proj-a' }),
      write('pa', '/tmp/proj-a/src/a.ts', { cwd: '/tmp/proj-a' }),
      before('pa', 'Bash', 'npm test', { cwd: '/tmp/proj-a' }),
      after('pa', 'Bash', 'npm test', 0),
    ]
    const b = [
      write('pb', '/tmp/proj-b/src/b.ts', { cwd: '/tmp/proj-b' }),
      before('pb', 'Bash', 'npm test', { cwd: '/tmp/proj-b' }),
      after('pb', 'Bash', 'npm test', 1),
    ]
    const report = buildReport([...a, ...b])
    expect(report.aggregate.success_rate).toBe(0.5)
    // Scoping to one project must re-aggregate, not reuse the all-projects numbers.
    const scoped = buildReport([...a, ...b], undefined, 'proj-b')
    expect(scoped.sessions).toHaveLength(1)
    expect(scoped.aggregate.success_rate).toBe(0)
    expect(scoped.aggregate.verification_completion_rate).toBe(0)
  })

  // ── F5: the pivot window must anchor on the stuck cluster ──
  it('anchors pivot recovery on the stuck cluster, not on null-command entries', () => {
    const s = 'pivot-1'
    const entries = [
      write(s, '/tmp/proj-a/src/a.ts'),                                  // rule_id null, command ''
      write(s, '/tmp/proj-a/src/a.ts'),                                  // ← the bug anchored here
      before(s, 'websearch', 'docs for the failing module'),
      before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'warn' }),
      before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'warn' }),   // real 2nd repeat
      before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'redirect' }),
      before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'deny' }),
      before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'deny' }),
    ]
    const m = analyzeSession(entries)
    expect(m!.stuck_loops).toBe(1)
    // No research and no command-family change after the real 2nd repeat.
    expect(m!.pivoted_after_stuck).toBe(false)
  })

  // ── F6: clusters are bounded by min(20 calls, 30 min) (§6.1 Pattern A) ──
  it('does not count repeats spread beyond the 30-minute window', () => {
    const s = 'slow-1'
    const hour = 3_600_000
    const base = 5_000_000_000
    const entries = [
      before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'warn', t: base }),
      before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'warn', t: base + hour }),
      before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'deny', t: base + 2 * hour }),
    ]
    expect(analyzeSession(entries)!.stuck_loops).toBe(0)
  })

  it('does not count repeats spread beyond 20 calls', () => {
    const s = 'wide-1'
    const entries = [before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'warn' })]
    for (let i = 0; i < 21; i++) entries.push(before(s, 'Bash', `echo ${i}`))
    entries.push(before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'warn' }))
    for (let i = 0; i < 21; i++) entries.push(before(s, 'Bash', `echo x${i}`))
    entries.push(before(s, 'Bash', 'npm test', { rule_id: 'r1', action: 'deny' }))
    expect(analyzeSession(entries)!.stuck_loops).toBe(0)
  })
})

// ── Promotion pipeline (Wave 3) ──────────────────────────────────────
//
// Shadow counters per `mode: observe` rule, derived from the exact same
// trace stream / isBefore() filter every other retrospective metric uses.
// A rule's shadow count only shows through the REAL pipeline (or, here, a
// trace stream shaped exactly like the real one): entries missing `hook`
// or carrying an untracked `agent` must be excluded from the denominator,
// or the reported rate is computed against traffic that was never real.

const THRESHOLD = 0.001  // DEFAULT_PROMOTION_FP_THRESHOLD — 1 per 1000

/** N tracked before-hook entries for one rule id, none of them would-blocks. */
function quietTraffic(session: string, n: number, extra: Partial<FixtureEntry> = {}): FixtureEntry[] {
  const out: FixtureEntry[] = []
  for (let i = 0; i < n; i++) out.push(before(session, 'Bash', `echo ${i}`, extra))
  return out
}

/** Convenience for tests that only care about one unscoped (global/user) rule. */
function unscoped(id: string) {
  return [{ id, scoped: false }]
}

describe('computePromotionReport', () => {
  it('the denominator is nonzero and counts only tracked before-hook entries', () => {
    const s = 'promo-denom'
    const entries = [
      ...quietTraffic(s, 5),
      // Untracked agent — the `keel evaluate` test-harness shape (§2.1 of
      // the design doc) — must not inflate the denominator.
      { ...before(s, 'Bash', 'echo x'), agent: 'unknown' },
      // after-hook entries are not evaluations of a rule against a NEW
      // action; must not inflate the denominator either.
      { ...before(s, 'Bash', 'echo y'), hook: 'tool.execute.after' },
    ]
    const report = computePromotionReport(entries, unscoped('some-rule'), THRESHOLD)
    expect(report[0].total_evaluations).toBe(5)
    expect(report[0].total_evaluations).toBeGreaterThan(0)
  })

  it('reports insufficient_data below the minimum-evaluation floor, even at a rate of zero', () => {
    // 10 evaluations, 0 would-blocks — a rate of 0 is NOT the same as
    // "proven safe": at threshold 0.001 you need >= 1000 evaluations
    // before a zero would-block count is trustworthy at all.
    const s = 'promo-insufficient'
    const entries = quietTraffic(s, 10)
    const report = computePromotionReport(entries, unscoped('obs-rule'), THRESHOLD)
    expect(report[0].total_evaluations).toBe(10)
    expect(report[0].would_block_count).toBe(0)
    expect(report[0].recommendation).toBe('insufficient_data')
  })

  it('reports eligible when the measured rate is below threshold, with enough evaluations to trust it', () => {
    const s = 'promo-eligible'
    const entries = quietTraffic(s, 1999)
    entries.push(before(s, 'Bash', 'git push origin main', { rule_id: 'obs-rule', observed_action: 'deny' }))
    // 1 would-block in 2000 evals = 0.0005, below the 0.001 threshold, and
    // 2000 >= the 1000-evaluation floor for this threshold.
    const report = computePromotionReport(entries, unscoped('obs-rule'), THRESHOLD)
    expect(report[0].total_evaluations).toBe(2000)
    expect(report[0].would_block_count).toBe(1)
    expect(report[0].rate).toBeCloseTo(0.0005, 6)
    expect(report[0].recommendation).toBe('eligible')
  })

  it('reports stay_observe when the measured rate is at or above threshold', () => {
    const s = 'promo-stay'
    const entries = quietTraffic(s, 1995)
    for (let i = 0; i < 5; i++) entries.push(before(s, 'Bash', `git push origin main ${i}`, { rule_id: 'obs-rule', observed_action: 'deny' }))
    // 5 would-blocks in 2000 evals = 0.0025, above the 0.001 threshold.
    const report = computePromotionReport(entries, unscoped('obs-rule'), THRESHOLD)
    expect(report[0].total_evaluations).toBe(2000)
    expect(report[0].would_block_count).toBe(5)
    expect(report[0].rate).toBeCloseTo(0.0025, 6)
    expect(report[0].recommendation).toBe('stay_observe')
  })

  it('a rate exactly AT threshold is stay_observe, not eligible — "below" is strict', () => {
    const s = 'promo-exact'
    const entries = quietTraffic(s, 999)
    entries.push(before(s, 'Bash', 'git push origin main', { rule_id: 'obs-rule', observed_action: 'deny' }))
    // 1 would-block in 1000 evals = exactly 0.001, the threshold itself.
    const report = computePromotionReport(entries, unscoped('obs-rule'), THRESHOLD)
    expect(report[0].rate).toBeCloseTo(0.001, 6)
    expect(report[0].recommendation).toBe('stay_observe')
  })

  it('warn and fix are recorded but do not count as would-block — the host does not interrupt on either', () => {
    // opencode-plugin's before() hook: 'warn' surfaces without throwing,
    // 'fix' mutates args and lets the call proceed. Neither interrupts.
    const s = 'promo-soft'
    const entries = quietTraffic(s, 1998)
    entries.push(before(s, 'Bash', 'git commit -m x', { rule_id: 'obs-warn', observed_action: 'warn' }))
    entries.push(before(s, 'Bash', 'git commit -m y', { rule_id: 'obs-fix', observed_action: 'fix' }))
    const report = computePromotionReport(entries, [{ id: 'obs-warn', scoped: false }, { id: 'obs-fix', scoped: false }], THRESHOLD)
    for (const row of report) {
      expect(row.would_block_count).toBe(0)
      expect(row.recommendation).toBe('eligible')
    }
  })

  it('redirect DOES count as would-block — the host throws on it exactly like a deny', () => {
    // The reason this matters: no-repeat-loops's escalation ladder is
    // `at: 3 -> redirect, at: 5 -> deny`; research-before-fix and
    // root-cause-before-refactor's default action is 'redirect' too.
    // Three of the six rules this pipeline exists to serve use redirect as
    // their primary interrupting action — excluding it would make every
    // one of them measure a false-positive rate of zero regardless of how
    // often they actually fire. plugin.ts's before() hook confirms this
    // empirically: `if (result.action === 'redirect') { ... throw new
    // Error('[Keel] REDIRECT ...') }` — it interrupts the tool call the
    // same way deny/block/prompt do.
    const s = 'promo-redirect'
    const entries = quietTraffic(s, 1995)
    for (let i = 0; i < 5; i++) entries.push(before(s, 'Bash', `npm test ${i}`, { rule_id: 'no-repeat-loops', observed_action: 'redirect' }))
    const report = computePromotionReport(entries, unscoped('no-repeat-loops'), THRESHOLD)
    expect(report[0].would_block_count).toBe(5)
    expect(report[0].rate).toBeCloseTo(0.0025, 6)
    expect(report[0].recommendation).toBe('stay_observe')
  })

  it('counts observed_matches entries too — the multi-observe-match shape from the observe-continue fix', () => {
    // A single call where TWO observe rules matched (pipeline.ts's
    // evaluate()/violation(): a matched observe rule records and
    // evaluation continues, so more than one can land on one call).
    const s = 'promo-multi'
    const entries = quietTraffic(s, 1998)
    entries.push(before(s, 'Bash', 'git commit -m "all tests pass"', {
      observed_matches: [
        { rule_id: 'rule-a', observed_action: 'warn' },
        { rule_id: 'rule-b', observed_action: 'deny' },
      ],
    }))
    entries.push(before(s, 'Bash', 'git commit -m "all tests pass"', {
      observed_matches: [{ rule_id: 'rule-a', observed_action: 'warn' }],
    }))
    const report = computePromotionReport(entries, [{ id: 'rule-a', scoped: false }, { id: 'rule-b', scoped: false }], THRESHOLD)
    const byId = new Map(report.map((r) => [r.rule_id, r]))
    expect(byId.get('rule-a')!.would_block_count).toBe(0)   // warn only, never would-block
    expect(byId.get('rule-b')!.would_block_count).toBe(1)   // deny once
    expect(byId.get('rule-a')!.total_evaluations).toBe(2000)
    expect(byId.get('rule-b')!.total_evaluations).toBe(2000)
  })

  it('reports every requested rule id, including ones that never matched at all', () => {
    const s = 'promo-never'
    const entries = quietTraffic(s, 2000)
    const report = computePromotionReport(entries, unscoped('never-fired'), THRESHOLD)
    expect(report[0].would_block_count).toBe(0)
    expect(report[0].total_evaluations).toBe(2000)
    expect(report[0].recommendation).toBe('eligible')
  })

  // ── Project scoping ── a project/local rule's denominator must not be
  // inflated by another project's traffic (found in review: an unscoped
  // denominator silently pushed a project-only rule's rate toward
  // eligible using traffic it was never even loaded against).
  it('scopes a project rule\'s denominator to this project\'s own traces, excluding another project\'s traffic', () => {
    const s = 'promo-scope'
    const thisProject = '/tmp/proj-here'
    const otherProject = '/tmp/proj-elsewhere'
    const entries = [
      ...quietTraffic(s, 999, { cwd: thisProject }),
      // A different project's traffic — must NOT count toward this
      // project-scoped rule's denominator or would-block count, even
      // though the rule id happens to match (a real cross-project name
      // collision, or the same rule pasted into two projects).
      ...quietTraffic(s, 5000, { cwd: otherProject }),
      before(s, 'Bash', 'git push origin main', { rule_id: 'obs-rule', observed_action: 'deny', cwd: otherProject }),
    ]
    const report = computePromotionReport(entries, [{ id: 'obs-rule', scoped: true }], THRESHOLD, thisProject)
    expect(report[0].total_evaluations).toBe(999)     // NOT 6000 — otherProject excluded
    expect(report[0].would_block_count).toBe(0)        // the deny happened in otherProject
    expect(report[0].scoped).toBe(true)
  })

  it('does not scope an unscoped (global/user) rule\'s denominator — it genuinely applies everywhere', () => {
    const s = 'promo-unscoped'
    const thisProject = '/tmp/proj-here'
    const otherProject = '/tmp/proj-elsewhere'
    const entries = [
      ...quietTraffic(s, 999, { cwd: thisProject }),
      ...quietTraffic(s, 999, { cwd: otherProject }),
    ]
    const report = computePromotionReport(entries, unscoped('global-rule'), THRESHOLD, thisProject)
    expect(report[0].total_evaluations).toBe(1998)  // both projects counted
    expect(report[0].scoped).toBe(false)
  })

  it('degrades to the unscoped (whole-trace-stream) denominator when no projectDir is given', () => {
    const s = 'promo-noproject'
    const entries = [
      ...quietTraffic(s, 500, { cwd: '/tmp/proj-a' }),
      ...quietTraffic(s, 500, { cwd: '/tmp/proj-b' }),
    ]
    const report = computePromotionReport(entries, [{ id: 'obs-rule', scoped: true }], THRESHOLD)
    expect(report[0].total_evaluations).toBe(1000)
    expect(report[0].scoped).toBe(false)
  })
})

describe('collectObserveRuleIds', () => {
  it('collects mode: observe rules across the hierarchy, deduped, tagging project/local as scoped', () => {
    const hierarchy = {
      global: { rules: [{ id: 'g1', type: 'command', action: 'warn', mode: 'observe', message: 'm' }] },
      user: null,
      project: {
        rules: [
          { id: 'p1', type: 'command', action: 'deny', mode: 'observe', message: 'm' },
          { id: 'p2', type: 'command', action: 'deny', mode: 'block', message: 'm' },
          { id: 'g1', type: 'command', action: 'warn', message: 'm' },  // project override, no mode: not observe
        ],
      },
      local: null,
    } as unknown as Parameters<typeof collectObserveRuleIds>[0]
    const rules = collectObserveRuleIds(hierarchy)
    const byId = new Map(rules.map((r) => [r.id, r.scoped]))
    // g1 is observe at global scope (unscoped) but the identical id also
    // appears at project scope with no mode — collectObserveRuleIds looks
    // at every scope independently, and the WIDER (unscoped) claim wins
    // when the same id disagrees across scopes.
    expect([...byId.keys()].sort()).toEqual(['g1', 'p1'])
    expect(byId.get('g1')).toBe(false)
    expect(byId.get('p1')).toBe(true)
  })

  it('a project-only rule (no global declaration at all) is scoped', () => {
    const hierarchy = {
      global: null,
      user: null,
      project: { rules: [{ id: 'proj-only', type: 'command', action: 'warn', mode: 'observe', message: 'm' }] },
      local: null,
    } as unknown as Parameters<typeof collectObserveRuleIds>[0]
    const rules = collectObserveRuleIds(hierarchy)
    expect(rules).toEqual([{ id: 'proj-only', scoped: true }])
  })
})
