import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateToolCall, initEnforce } from '../commands/enforce.js'

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url))

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'keel-public-v1-'))
}

describe('public v1 behavior', () => {
  it('learn mode observes a deny without blocking it', async () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: dangerous
    type: command
    match: "dangerous-command"
    action: deny
    message: "blocked"
`)
    initEnforce(project, { learn: true })
    const result = await evaluateToolCall('Bash', { command: 'dangerous-command' }, { cwd: project })
    expect(result.action).toBe('warn')
    expect(result.message).toContain('Learning mode')
  })

  it('action override changes the enforcement mode', async () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: strict-action
    type: command
    match: "strict-command"
    action: deny
    message: "blocked"
`)
    initEnforce(project, { action: 'deny' })
    const result = await evaluateToolCall('Bash', { command: 'strict-command' }, { cwd: project })
    expect(result.action).toBe('deny')
  })

  it('inherits the configured protection level when evaluation omits one', async () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
level: protect
rules:
  - id: protect-only-level-inheritance-${Date.now()}
    type: command
    match: "protected-command"
    level: protect
    action: deny
    message: "protected"
`)
    initEnforce(project, { level: 'protect' })
    const first = await evaluateToolCall('Bash', { command: 'protected-command' }, { cwd: project })
    const second = await evaluateToolCall('Bash', { command: 'protected-command' }, { cwd: project })
    expect(first.action).toBe('warn')
    expect(second.action).toBe('deny')
  })

  it('reports when fix override has no automatic transform', async () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: no-fix
    type: command
    match: "no-fix-command"
    action: deny
    message: "blocked"
`)
    initEnforce(project, { action: 'fix' })
    const result = await evaluateToolCall('Bash', { command: 'no-fix-command' }, { cwd: project })
    expect(result.action).toBe('warn')
    expect(result.message).toContain('no automatic fix available')
  })

  it('fast depth skips deep sequence checks', async () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: deep-sequence
    type: sequence
    steps:
      - tool: WriteFile
      - tool: edit
    action: deny
    message: "sequence"
`)
    initEnforce(project, { depth: 'fast' })
    await evaluateToolCall('WriteFile', { filePath: 'src/a.ts' }, { cwd: project })
    const result = await evaluateToolCall('edit', { filePath: 'src/a.ts' }, { cwd: project })
    expect(result.action).toBe('allow')
  })

  it('enforce init creates standalone project rules', () => {
    const project = tempProject()
    const output = execFileSync(process.execPath, [CLI, 'enforce', 'init'], { cwd: project, encoding: 'utf8' })
    expect(output).toContain('Created .keel/rules.yaml')
    expect(existsSync(join(project, '.keel', 'rules.yaml'))).toBe(true)
    expect(readFileSync(join(project, '.keel', 'rules.yaml'), 'utf8')).toContain('never-force-push')
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false)
  })

  it('validate exits nonzero for malformed project rules', () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), 'version: 1\nrules: [bad\n')
    expect(() => execFileSync(process.execPath, [CLI, 'validate'], { cwd: project, encoding: 'utf8' })).toThrow()
  })
})
