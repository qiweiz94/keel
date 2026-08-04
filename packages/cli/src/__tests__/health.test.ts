import { describe, it, expect } from 'vitest'
import { telemetryHealth } from '../commands/health.js'
import { countDistinctRules } from '../commands/status.js'
import type { TraceEntry } from '../commands/retrospective.js'

/**
 * The health check answers "is keel actually receiving data?" — the
 * question that went unanswered while every metric silently reported zero.
 *
 * These fixtures are pure in-memory entries: the check reads
 * ~/.keel/traces in production, and ~21% of that directory is test noise
 * partly written by this repo's own suites. A health check whose tests
 * assert on the mess they created would measure itself.
 */

const NOW = Date.UTC(2026, 7, 4, 12, 0, 0)
const MIN = 60_000

function after(tMinutesAgo: number, exit?: number): TraceEntry {
  return {
    t: NOW - tMinutesAgo * MIN,
    agent: 'opencode-plugin',
    hook: 'tool.execute.after',
    tool: 'Bash',
    args: { command: 'npm test' },
    ...(exit === undefined ? {} : { exit }),
  }
}

function before(tMinutesAgo: number, turn?: number): TraceEntry {
  return {
    t: NOW - tMinutesAgo * MIN,
    agent: 'opencode-plugin',
    hook: 'tool.execute.before',
    tool: 'Bash',
    args: { command: 'ls' },
    ...(turn === undefined ? {} : { turn_number: turn }),
  }
}

const line = (lines: ReturnType<typeof telemetryHealth>, id: string) =>
  lines.find(l => l.id === id)!

describe('telemetry health', () => {
  it('reports unknown — not green — when there is no trace data at all', () => {
    // A health check that reports healthy on absent data is the exact
    // failure this exists to prevent.
    const lines = telemetryHealth([], NOW)
    expect(line(lines, 'agent-activity').state).toBe('unknown')
    expect(line(lines, 'exit-telemetry').state).toBe('unknown')
  })

  it('reports red when no recent outcome carries an exit code', () => {
    // Today's real state: 2,753 after-hook entries, zero exit codes.
    const entries = Array.from({ length: 300 }, (_, i) => after(i + 1))
    const lines = telemetryHealth(entries, NOW)
    expect(line(lines, 'exit-telemetry').state).toBe('red')
    expect(line(lines, 'exit-telemetry').fix).toMatch(/restart/i)
  })

  it('reports green once recent outcomes carry exit codes', () => {
    const entries = Array.from({ length: 30 }, (_, i) => after(i + 1, i % 2))
    expect(line(telemetryHealth(entries, NOW), 'exit-telemetry').state).toBe('green')
  })

  it('reports GREEN on a mixed corpus of old blind entries and fresh good ones', () => {
    // The state the user is in the moment they restart: a handful of new
    // entries carrying exit, thousands of historical ones without. A share
    // taken over the whole corpus reads ~0.2% and would report red while
    // telemetry is in fact working — the same wrong-denominator bug that
    // made attempts-to-success negative.
    const historical = Array.from({ length: 2000 }, (_, i) => after(i + 60))
    const fresh = Array.from({ length: 5 }, (_, i) => after(i + 1, 0))
    const lines = telemetryHealth([...historical, ...fresh], NOW)
    expect(line(lines, 'exit-telemetry').state).toBe('green')
  })

  it('reports red while turn numbers are all zero, green once they advance', () => {
    const stuck = Array.from({ length: 30 }, (_, i) => before(i + 1, 0))
    expect(line(telemetryHealth(stuck, NOW), 'turn-telemetry').state).toBe('red')

    const flowing = Array.from({ length: 30 }, (_, i) => before(i + 1, i + 1))
    expect(line(telemetryHealth(flowing, NOW), 'turn-telemetry').state).toBe('green')
  })

  it('ignores test-harness noise when judging agent activity', () => {
    // `keel evaluate` writes entries with agent "unknown" and no hook.
    // Treating those as agent activity would report a live agent on a
    // system where none has run.
    const noise: TraceEntry[] = Array.from({ length: 50 }, () => ({
      t: NOW - MIN, agent: 'unknown', tool: 'Bash', args: {},
    }))
    const lines = telemetryHealth(noise, NOW)
    expect(line(lines, 'agent-activity').state).toBe('unknown')
    expect(line(lines, 'noise').detail).toContain('%')
  })

  it('flags a stale agent as amber rather than green', () => {
    const old = [after(60 * 24 * 3, 0)]   // three days ago
    expect(line(telemetryHealth(old, NOW), 'agent-activity').state).toBe('amber')
  })
})

describe('rule counting on the status screen', () => {
  const rules = (n: number, prefix = 'r') =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))

  it('counts a file once when two scopes resolve to the same path', () => {
    // Every user whose shell sits in their home directory hits this: the
    // project lookup is <cwd>/.keel/rules.yaml, which IS the global path.
    // Summing scopes reported "23 of 46" and implied half the rules were
    // switched off.
    const same = { rules: rules(23), sourcePath: '/home/u/.keel/rules.yaml' }
    const { distinct, duplicatePaths } = countDistinctRules([
      ['global', same],
      ['project', same],
    ])
    expect(distinct).toBe(23)
    expect(duplicatePaths.has('/home/u/.keel/rules.yaml')).toBe(true)
  })

  it('still counts genuinely distinct scopes, minus shared ids', () => {
    const { distinct, duplicatePaths } = countDistinctRules([
      ['global', { rules: rules(23), sourcePath: '/home/u/.keel/rules.yaml' }],
      // one id overlaps the global set, so it is the same rule overridden
      ['project', { rules: [{ id: 'r0' }, { id: 'proj-only' }], sourcePath: '/repo/.keel/rules.yaml' }],
    ])
    expect(distinct).toBe(24)
    expect(duplicatePaths.size).toBe(0)
  })

  it('tolerates absent scopes', () => {
    expect(countDistinctRules([['global', null], ['project', null]]).distinct).toBe(0)
  })
})
