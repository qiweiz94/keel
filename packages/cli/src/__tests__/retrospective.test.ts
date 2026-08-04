import { describe, it, expect } from 'vitest'
import { analyzeSession, buildReport, loadTraceEntries } from '../commands/retrospective.js'

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
