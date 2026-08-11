import { describe, it, expect } from 'vitest'
import { argPath } from '../arg-utils.js'

// Regression for the gate-3 security-review finding: a filesystem floor
// rule is only as good as argPath()'s key coverage. Claude Code and Gemini
// send `file_path` (snake_case); if argPath misses it, no-rules-tampering /
// no-secret-files are silently dead on those hosts (verified live: a write
// to .claude/settings.json returned exit 0 on claude-code before this).
describe('argPath resolves the path key each host actually sends', () => {
  it.each([
    ['claude-code / gemini file_path', { file_path: '/x/.claude/settings.json' }],
    ['opencode / generic path', { path: '/x/.env' }],
    ['legacy camelCase filePath', { filePath: '/x/.mcp.json' }],
    ['cursor file', { file: '/x/.ssh/id_rsa' }],
    ['dest', { dest: '/x/out' }],
    ['notebook_path', { notebook_path: '/x/n.ipynb' }],
  ])('%s', (_label, args) => {
    expect(argPath(args as Record<string, unknown>)).not.toBe('')
  })

  it('prefers path over the host-specific fallbacks when both present', () => {
    expect(argPath({ path: '/a', file_path: '/b' })).toBe('/a')
  })

  it('returns empty string when no path key is present', () => {
    expect(argPath({ command: 'ls' })).toBe('')
  })
})
