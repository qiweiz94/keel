import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendHarnessRules } from '../commands/rules.js'
import { HARNESS_RULE_IDS } from '../commands/harness-rules.js'
import { parseRulesContent, validateRules } from '../core/enforce/rule-parser.js'

/**
 * `keel rules harness` printed YAML for the user to copy by hand, and
 * across a full working session that copy never happened — so the
 * anti-circling rules stayed inert while the traces kept recording repeat
 * loops. Manual transcription of 80 lines of YAML is the friction.
 *
 * `--append` removes it, which means this command now MUTATES the user's
 * rules file. Three properties matter more than the happy path:
 *   - it is idempotent (running twice must not duplicate rule ids)
 *   - it never leaves rules.yaml invalid (a broken rules file fails closed,
 *     blocking every tool call the user makes)
 *   - it is human-only, like every other keel control surface
 */

let home: string
let rulesPath: string

const BASE = `version: 1
level: balanced
rules:
  - id: no-force-push
    type: command
    match: "git push --force"
    action: deny
    message: "Use --force-with-lease."
`

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'keel-append-'))
  mkdirSync(join(home, '.keel'), { recursive: true })
  rulesPath = join(home, '.keel', 'rules.yaml')
  writeFileSync(rulesPath, BASE, 'utf-8')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('keel rules harness --append', () => {
  it('appends all three rules and keeps the file valid', () => {
    const result = appendHarnessRules(rulesPath)
    expect(result.status).toBe('appended')

    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    expect(parsed.errors ?? []).toEqual([])
    expect(validateRules(parsed.rules)).toEqual([])
    for (const id of HARNESS_RULE_IDS) {
      expect(parsed.rules.map(r => r.id)).toContain(id)
    }
  })

  it('preserves the rules that were already there', () => {
    appendHarnessRules(rulesPath)
    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    expect(parsed.rules.map(r => r.id)).toContain('no-force-push')
    expect(parsed.config.level).toBe('balanced')
  })

  it('is idempotent — a second run does not duplicate rule ids', () => {
    appendHarnessRules(rulesPath)
    const second = appendHarnessRules(rulesPath)
    expect(second.status).toBe('already-present')

    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    for (const id of HARNESS_RULE_IDS) {
      expect(parsed.rules.filter(r => r.id === id)).toHaveLength(1)
    }
  })

  it('appends only the rules that are missing', () => {
    // A user who pasted one rule by hand must not end up with a duplicate.
    const partial = BASE + `
  - id: no-repeat-loops
    type: command
    match: "x"
    action: warn
    message: "hand-written"
`
    writeFileSync(rulesPath, partial, 'utf-8')
    const result = appendHarnessRules(rulesPath)
    expect(result.status).toBe('appended')
    expect(result.added).not.toContain('no-repeat-loops')
    expect(result.added).toContain('research-before-fix')

    const parsed = parseRulesContent(readFileSync(rulesPath, 'utf-8'), rulesPath)
    expect(parsed.rules.filter(r => r.id === 'no-repeat-loops')).toHaveLength(1)
  })

  it('refuses to touch a rules file that is already broken', () => {
    // Appending to an unparseable file would bury the real problem under a
    // second one, and the user would blame the append.
    writeFileSync(rulesPath, 'rules: [unclosed\n', 'utf-8')
    const before = readFileSync(rulesPath, 'utf-8')
    const result = appendHarnessRules(rulesPath)
    expect(result.status).toBe('invalid-source')
    expect(readFileSync(rulesPath, 'utf-8')).toBe(before)
  })

  it('writes a backup before mutating', () => {
    appendHarnessRules(rulesPath)
    expect(existsSync(rulesPath + '.bak')).toBe(true)
    expect(readFileSync(rulesPath + '.bak', 'utf-8')).toBe(BASE)
  })

  it('reports a missing rules file instead of creating a partial one', () => {
    rmSync(rulesPath)
    expect(appendHarnessRules(rulesPath).status).toBe('no-rules-file')
    expect(existsSync(rulesPath)).toBe(false)
  })
})
