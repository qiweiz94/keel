import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseRulesContent } from '@get-keel/core'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `keel install --all` must install ALL of them.
 *
 * It silently skipped hermes, openclaw and gemini — a flag named `all`
 * that omits three hosts is the same "believed but absent" shape as the
 * installers that wrote prose and printed a green check while enforcing
 * nothing. This session has hit that class twice; this is the test that
 * catches it.
 *
 * Runs into a temp HOME and a temp project, never the real ones.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js')

let home = ''
let project = ''

describe('keel install --all', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'keel-installall-home-'))
    project = mkdtempSync(join(tmpdir(), 'keel-installall-proj-'))
    spawnSync(process.execPath, [CLI, 'install', '--all'], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
      timeout: 120000,
    })
  })
  afterAll(() => {
    rmSafe(home)
    rmSafe(project)
  })

  const homeFile = (...p: string[]) => join(home, ...p)
  const projFile = (...p: string[]) => join(project, ...p)

  it('creates the rules file every mode depends on', () => {
    expect(existsSync(homeFile('.keel', 'rules.yaml'))).toBe(true)
  })

  it('installs the OpenCode plugin', () => {
    expect(existsSync(homeFile('.opencode', 'plugins', 'keel-enforce.js'))).toBe(true)
  })

  it('installs the OpenClaw plugin — was skipped by --all', () => {
    for (const f of ['index.mjs', 'openclaw.plugin.json', 'package.json']) {
      expect(existsSync(homeFile('.openclaw', 'plugins', 'keel', f))).toBe(true)
    }
  })

  it('installs the Hermes plugin — was skipped by --all', () => {
    for (const f of ['keel_plugin.py', 'plugin.yaml', '__init__.py']) {
      expect(existsSync(homeFile('.hermes', 'plugins', 'keel', f))).toBe(true)
    }
  })

  it('installs the Gemini CLI hook', () => {
    expect(existsSync(homeFile('.gemini', 'hooks', 'PreToolUse'))).toBe(true)
  })

  it('installs the Cline hook', () => {
    expect(existsSync(homeFile('.cline', 'hooks', 'PreToolUse'))).toBe(true)
  })

  it('installs the Codex hook', () => {
    expect(existsSync(homeFile('.codex', 'hooks', 'keel-enforce.sh'))).toBe(true)
  })

  it('installs the Claude Code and Cursor hooks in the project', () => {
    expect(existsSync(projFile('.claude', 'hooks', 'PreToolUse', 'keel-enforce'))).toBe(true)
    expect(existsSync(projFile('.cursor', 'hooks', 'keel-enforce.sh'))).toBe(true)
  })

  // Regression: the project rules.yaml stub used to write `rules:` with no
  // list items, which YAML-parses to `rules: null` — parseRulesContent
  // rejects that as "Rules must be an array", and initEnforce throws on any
  // rule-source error. That broke `keel evaluate` and `keel hook <host>` on
  // EVERY tool call after a fresh `install --project` (only OpenCode's own
  // fallback masked it). Fixed to `rules: []`, a valid empty list.
  it('writes a project rules.yaml that actually parses (not `rules: null`)', () => {
    const content = readFileSync(projFile('.keel', 'rules.yaml'), 'utf-8')
    const parsed = parseRulesContent(content, projFile('.keel', 'rules.yaml'))
    expect(parsed.errors, `project rules.yaml failed to parse: ${parsed.errors}`).toBeUndefined()
    expect(Array.isArray(parsed.rules)).toBe(true)
  })

  it('keel evaluate runs cleanly against a fresh --project install (no init-time throw)', () => {
    const result = spawnSync(process.execPath, [
      CLI, 'evaluate', '--tool', 'Bash',
      '--args', JSON.stringify({ command: 'ls -la' }),
      '--cwd', project,
    ], { cwd: project, encoding: 'utf-8', env: { ...process.env, HOME: home }, timeout: 30000 })
    const out = JSON.parse(result.stdout)
    expect(out.action, `evaluate returned an error: ${JSON.stringify(out)}`).not.toBe('error')
    expect(result.status).toBe(0)
  })
})
