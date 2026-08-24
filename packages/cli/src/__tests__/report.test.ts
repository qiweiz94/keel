import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { computeActionSummary, computePromotionReport, type TraceEntry } from '../commands/retrospective.js'
import { buildReportPayload } from '../commands/report.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `keel report` reads the same trace stream and TRACKED_AGENTS/isBefore
 * filter as retrospective.ts (see computeActionSummary's comment for why
 * that filter is mandatory — untracked agents like the `keel evaluate` test
 * harness must not inflate the counts). These tests build synthetic JSONL-
 * shaped fixtures directly rather than spawning the CLI, matching
 * retrospective.test.ts's existing pattern for the same reason: the counting
 * logic is unit-testable without disk I/O, so it should be tested that way.
 */

let tick = 2_000_000
function before(session: string, extra: Partial<TraceEntry> = {}): TraceEntry {
  tick += 1000
  return {
    t: tick,
    agent: 'opencode-plugin',
    session_id: session,
    tool: 'Bash',
    args: { command: 'echo hi' },
    rule_id: null,
    action: 'allow',
    hook: 'tool.execute.before',
    cwd: '/tmp/proj-a',
    ...extra,
  }
}

describe('computeActionSummary', () => {
  it('counts deny/block/prompt as blocked, warn as warned, redirect separately', () => {
    const entries: TraceEntry[] = [
      before('s1', { rule_id: 'no-verify-commits', action: 'deny' }),
      before('s1', { rule_id: 'no-force-push', action: 'block' }),
      before('s1', { rule_id: 'confirm-prod-deploy', action: 'prompt' }),
      before('s1', { rule_id: 'no-destructive-rm', action: 'warn' }),
      before('s1', { rule_id: 'no-test-loops', action: 'redirect' }),
      before('s1', { rule_id: null, action: 'allow' }),
    ]
    const summary = computeActionSummary(entries)
    expect(summary.total_evaluations).toBe(6)
    expect(summary.blocked).toBe(3)
    expect(summary.warned).toBe(1)
    expect(summary.redirected).toBe(1)
    expect(summary.top_blocking_rules.map((r) => r.rule_id).sort()).toEqual(
      ['confirm-prod-deploy', 'no-force-push', 'no-test-loops', 'no-verify-commits'].sort(),
    )
  })

  it('counts every observe_matches entry, preferring it over the legacy single slot', () => {
    const entries: TraceEntry[] = [
      before('s1', {
        rule_id: null,
        action: 'allow',
        observed_action: 'warn',
        observed_matches: [
          { rule_id: 'observe-large-diff', observed_action: 'warn' },
          { rule_id: 'observe-slow-test', observed_action: 'deny' },
        ],
      }),
    ]
    const summary = computeActionSummary(entries)
    // Both observe rules fired on the same call: comprehensive count is 2,
    // not 1 — using the legacy single-slot field alone would under-count.
    expect(summary.observe_fires).toBe(2)
    expect(summary.top_observe_rules.map((r) => r.rule_id).sort()).toEqual(
      ['observe-large-diff', 'observe-slow-test'].sort(),
    )
  })

  it('falls back to the legacy single-slot field when observed_matches is absent', () => {
    const entries: TraceEntry[] = [
      before('s1', { rule_id: 'observe-old-rule', action: 'allow', observed_action: 'deny' }),
    ]
    const summary = computeActionSummary(entries)
    expect(summary.observe_fires).toBe(1)
    expect(summary.top_observe_rules).toEqual([{ rule_id: 'observe-old-rule', count: 1 }])
  })

  it('ignores untracked agents entirely, matching isBefore everywhere else in this file', () => {
    const entries: TraceEntry[] = [
      before('s1', { agent: 'unknown', rule_id: 'no-verify-commits', action: 'deny' }),
    ]
    const summary = computeActionSummary(entries)
    expect(summary.total_evaluations).toBe(0)
    expect(summary.blocked).toBe(0)
  })

  it('reports zero counts honestly on an empty window rather than omitting fields', () => {
    const summary = computeActionSummary([])
    expect(summary).toEqual({
      total_evaluations: 0,
      blocked: 0,
      warned: 0,
      redirected: 0,
      observe_fires: 0,
      top_blocking_rules: [],
      top_warning_rules: [],
      top_observe_rules: [],
    })
  })

  it('ranks top_blocking_rules by count, capped at 5', () => {
    const entries: TraceEntry[] = []
    for (let i = 0; i < 7; i++) {
      entries.push(before('s1', { rule_id: `rule-${i}`, action: 'deny' }))
    }
    // rule-0 fires three times total — should sort to the top.
    entries.push(before('s1', { rule_id: 'rule-0', action: 'deny' }))
    entries.push(before('s1', { rule_id: 'rule-0', action: 'deny' }))
    const summary = computeActionSummary(entries)
    expect(summary.top_blocking_rules.length).toBe(5)
    expect(summary.top_blocking_rules[0]).toEqual({ rule_id: 'rule-0', count: 3 })
  })
})

describe('buildReportPayload scoping', () => {
  const entries: TraceEntry[] = [
    before('s1', { rule_id: 'r1', action: 'deny', cwd: '/tmp/proj-a' }),
    before('s2', { rule_id: 'r2', action: 'warn', cwd: '/tmp/proj-b' }),
  ]

  it('counts distinct sessions with no filter applied', () => {
    const { entries: scoped, sessions } = buildReportPayload(entries, '2020-01-01')
    expect(scoped.length).toBe(2)
    expect(sessions).toBe(2)
  })

  it('filters to a single session id', () => {
    const { entries: scoped, sessions } = buildReportPayload(entries, '2020-01-01', undefined, 's2')
    expect(scoped.length).toBe(1)
    expect(sessions).toBe(1)
    expect(scoped[0].rule_id).toBe('r2')
  })

  it('filters to a project by cwd substring', () => {
    const { entries: scoped, sessions } = buildReportPayload(entries, '2020-01-01', '/tmp/proj-a')
    expect(scoped.length).toBe(1)
    expect(sessions).toBe(1)
    expect(scoped[0].rule_id).toBe('r1')
  })
})

describe('report + promotion pipeline agree on evaluation counts', () => {
  it('computeActionSummary and computePromotionReport read the same denominator', () => {
    const entries: TraceEntry[] = [
      before('s1', { rule_id: null, action: 'allow' }),
      before('s1', { rule_id: null, action: 'allow' }),
      before('s1', { rule_id: 'observe-x', action: 'allow', observed_action: 'warn' }),
    ]
    const summary = computeActionSummary(entries)
    const promotion = computePromotionReport(entries, [{ id: 'observe-x', scoped: false }], 0.01)
    expect(summary.total_evaluations).toBe(3)
    expect(promotion[0].total_evaluations).toBe(3)
  })
})

// ── CLI-level: the "eligible for promotion" render path ────────────────
//
// Every unit test above proves the counting is correct; none of them prove
// the `eligible.length > 0` branch in report.ts's human-readable output
// (the "N rules eligible for promotion" block, and the `keel promote`
// hint) ever actually renders. A branch that only unit-tests its inputs
// and never its own output is the "registered but never consumed" shape —
// so this spawns the real CLI against a real project rules.yaml and a
// real trace file, engineered to cross the eligibility threshold, and
// asserts on what actually prints.

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js')

describe('keel report — promotion candidates actually render', () => {
  it('prints the eligible-for-promotion block when an observe rule clears its threshold', () => {
    const home = mkdtempSync(join(tmpdir(), 'keel-report-promo-home-'))
    // realpath'd: spawnSync's child resolves getcwd() through macOS's
    // /var -> /private/var symlink, so process.cwd() inside the CLI would
    // not string-match an un-resolved tmpdir() path embedded in the trace
    // fixture's `cwd` field — and computePromotionReport's project-scoping
    // (projectMatches) is a plain string comparison, so that mismatch
    // silently zeroes the scoped denominator instead of erroring.
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'keel-report-promo-proj-')))
    try {
      // A loose threshold (1 per 2 evaluations) keeps minEvaluations low
      // (ceil(1/0.5) = 2) so a handful of synthetic traces is enough to
      // clear it — no need to fabricate 1000+ lines to exercise the branch.
      mkdirSync(join(project, '.keel'), { recursive: true })
      writeFileSync(
        join(project, '.keel', 'rules.yaml'),
        [
          'version: 1',
          'level: balanced',
          'promotion_fp_threshold: 0.5',
          'rules:',
          '  - id: observe-candidate',
          '    type: command',
          '    match: "x"',
          '    mode: observe',
          '    action: warn',
          '    message: "shadow-test candidate"',
          '',
        ].join('\n'),
        'utf-8',
      )

      mkdirSync(join(home, '.keel', 'traces'), { recursive: true })
      const today = new Date().toISOString().slice(0, 10)
      let t = Date.now() - 60_000
      const lines = []
      // 3 evaluations, zero would-blocks (observed_action: 'warn', not in
      // the deny/block/prompt/redirect would-block set) — rate is 0, well
      // under the 0.5 threshold, and 3 >= minEvaluations (2).
      for (let i = 0; i < 3; i++) {
        t += 1000
        lines.push(JSON.stringify({
          t, agent: 'opencode-plugin', session_id: 's1', tool: 'Bash', args: { command: 'x' },
          rule_id: null, action: 'allow', hook: 'tool.execute.before', cwd: project,
          observed_matches: [{ rule_id: 'observe-candidate', observed_action: 'warn' }],
        }))
      }
      writeFileSync(join(home, '.keel', 'traces', `${today}.jsonl`), lines.join('\n') + '\n', 'utf-8')

      const result = spawnSync(process.execPath, [CLI, 'report'], {
        cwd: project,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf-8',
        timeout: 120000,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/eligible for promotion/)
      expect(result.stdout).toMatch(/observe-candidate/)
      expect(result.stdout).toMatch(/keel promote <rule-id>/)

      const json = spawnSync(process.execPath, [CLI, 'report', '--json'], {
        cwd: project,
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf-8',
        timeout: 120000,
      })
      const payload = JSON.parse(json.stdout)
      expect(payload.promotion).toContainEqual(
        expect.objectContaining({ rule_id: 'observe-candidate', recommendation: 'eligible' }),
      )
    } finally {
      rmSafe(home)
      rmSafe(project)
    }
  })
})
