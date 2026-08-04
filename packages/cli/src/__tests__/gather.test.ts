import { describe, it, expect } from 'vitest'
import { buildGatherBlock } from '../commands/gather.js'
import type { AuditEntry } from '../core/types.js'

/**
 * Phase 3 — the workflow lessons the retrospective derives (stuck-loop,
 * no-research-before-solve, no-pivot) must reach the requirements.md
 * markers. `keel gather` reads the same trace stream, so the wire is
 * buildReport() alongside extractLessons(); without it the
 * LESSON_REQUIREMENTS entries for those keys are unreachable.
 */

let tick = 2_000_000
function trace(session: string, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): AuditEntry {
  tick += 1000
  return {
    t: tick,
    timestamp: new Date(tick).toISOString(),
    agent: 'opencode-plugin',
    session_id: session,
    tool,
    args,
    rule_id: null,
    action: 'allow',
    hook: 'tool.execute.before',
    cwd: '/tmp/proj-a',
    ...extra,
  } as unknown as AuditEntry
}

const S = 'gather-wire-1'
// One session that edits before researching, loops on the same denied
// command, and never pivots — evidence for all three lessons at once.
const fixture: AuditEntry[] = [
  trace(S, 'write', { filePath: '/tmp/proj-a/src/a.ts' }),
  trace(S, 'Bash', { command: 'npm test' }, { rule_id: 'r1', action: 'warn' }),
  trace(S, 'Bash', { command: 'npm test' }, { rule_id: 'r1', action: 'warn' }),
  trace(S, 'Bash', { command: 'npm test' }, { rule_id: 'r1', action: 'redirect' }),
  trace(S, 'Bash', { command: 'npm test' }, { rule_id: 'r1', action: 'deny' }),
  trace(S, 'Bash', { command: 'npm test' }, { rule_id: 'r1', action: 'deny' }),
  trace(S, 'Bash', { command: 'npm test' }, { rule_id: 'r1', action: 'deny' }),
  trace(S, 'Bash', { command: 'npm test' }, { rule_id: 'r1', action: 'deny' }),
  trace(S, 'websearch', { command: 'why is it failing' }),
]

describe('gather consumes the retrospective workflow lessons', () => {
  it('renders all three problem-solving bullets inside the markers', () => {
    const block = buildGatherBlock(fixture)
    const start = block.indexOf('<!-- keel:gather-start -->')
    const end = block.indexOf('<!-- keel:gather-end -->')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    expect(block).toContain('### Problem-solving')
    expect(block).toContain('Do not retry an identical blocked command')
    expect(block).toContain('Research before editing')
    expect(block).toContain('Switch approach after 2 failed attempts')

    const section = block.indexOf('### Problem-solving')
    expect(section).toBeGreaterThan(start)
    expect(section).toBeLessThan(end)
  })

  it('is idempotent for the same entries', () => {
    expect(buildGatherBlock(fixture)).toBe(buildGatherBlock(fixture))
  })

  it('emits the no-issues block when there is no evidence', () => {
    expect(buildGatherBlock([])).toContain('no recurring issues detected yet')
  })
})
