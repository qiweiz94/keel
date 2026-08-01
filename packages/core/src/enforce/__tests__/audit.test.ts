import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AuditLog } from '../audit.js'

describe('audit privacy', () => {
  it('redacts sensitive arguments and reasoning before writing JSONL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'keel-audit-'))
    const audit = new AuditLog(directory)
    audit.record({ action: 'deny', rule_id: 'secret-rule', message: 'blocked', timestamp: new Date().toISOString(), tier: 2 }, {
      session_id: 'session', turn_number: 1, tool: 'Bash',
      args: { token: 'super-secret', nested: { password: 'another-secret' }, data: 'arbitrary-secret', command: 'curl -H "Authorization: Bearer command-secret"' },
      level: 'balanced', context: 'local', agent: 'test', subagent_of: null, context_tokens: 0,
      reasoning: 'private reasoning that must not be persisted',
    })
    const file = join(directory, readdirSync(directory).find(name => name.endsWith('.jsonl'))!)
    const contents = readFileSync(file, 'utf8')
    expect(contents).not.toContain('super-secret')
    expect(contents).not.toContain('another-secret')
    expect(contents).not.toContain('command-secret')
    expect(contents).not.toContain('arbitrary-secret')
    expect(contents).not.toContain('private reasoning')
    expect(contents).toContain('[redacted]')
    expect(contents).toContain('[redacted reasoning]')
  })
})
