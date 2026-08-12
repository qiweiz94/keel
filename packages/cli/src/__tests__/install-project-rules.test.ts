import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseRulesContent } from '@get-keel/core'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * A3 regression: `installProjectPlugin()` used to write the project's
 * `.keel/rules.yaml` as an intentionally empty stub (`rules: []`) on the
 * theory that ~/.keel/rules.yaml (global) always supplies the real rules.
 * That's true right after `keel install --opencode` on the SAME machine,
 * but `.keel/rules.yaml` is exactly the kind of file a project commits to
 * git — a teammate who clones the repo, or CI, or any host that reads
 * project rules without a prior *global* keel install on that machine,
 * got zero enforcement from a project install that printed a green
 * checkmark. `keel install --project` must now write the same enforcing
 * DEFAULT_RULES_YAML content the global tier gets, so the project's own
 * file is enforcing on its own — not a silent dependency on some other
 * install having happened first.
 *
 * All of this runs against scratch HOME/KEEL_HOME/project directories,
 * spawned as the real built CLI (dist/index.js) as a subprocess — the
 * real ~/.keel is never touched.
 */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js')

describe('keel install --project writes an enforcing ruleset', () => {
  let home = ''
  let keelHome = ''
  let project = ''

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'keel-a3-home-'))
    keelHome = mkdtempSync(join(tmpdir(), 'keel-a3-keelhome-'))
    project = mkdtempSync(join(tmpdir(), 'keel-a3-proj-'))
    const result = spawnSync(process.execPath, [CLI, 'install', '--project'], {
      cwd: project,
      // Both HOME and KEEL_HOME set to isolated scratch dirs (KEEL_HOME
      // takes precedence in resolveHome()) — the real ~/.keel is never
      // read or written by this test.
      env: { ...process.env, HOME: home, KEEL_HOME: keelHome },
      encoding: 'utf-8',
      timeout: 60000,
    })
    if (result.status !== 0) {
      throw new Error(`install --project failed: ${result.stdout}\n${result.stderr}`)
    }
  })

  afterAll(() => {
    rmSafe(home)
    rmSafe(keelHome)
    rmSafe(project)
  })

  const projRulesPath = () => join(project, '.keel', 'rules.yaml')

  it('writes a non-empty project rules.yaml', () => {
    expect(existsSync(projRulesPath())).toBe(true)
    const content = readFileSync(projRulesPath(), 'utf-8')
    expect(content).not.toContain('rules: []')
  })

  it('the project rules.yaml parses to real enforcing rules, including the protect-floor destructive-command rule', () => {
    const content = readFileSync(projRulesPath(), 'utf-8')
    const parsed = parseRulesContent(content, projRulesPath())
    expect(parsed.errors, `project rules.yaml failed to parse: ${parsed.errors}`).toBeUndefined()
    expect(Array.isArray(parsed.rules)).toBe(true)
    expect(parsed.rules!.length).toBeGreaterThan(0)
    const ids = parsed.rules!.map((r) => r.id)
    expect(ids).toContain('no-destructive-commands')
  })

  it('keel evaluate denies a destructive command with BOTH global and project tiers present (isolated HOME + KEEL_HOME)', () => {
    const result = spawnSync(process.execPath, [
      CLI, 'evaluate', '--tool', 'Bash',
      '--args', JSON.stringify({ command: 'rm -rf /' }),
      '--cwd', project,
    ], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, KEEL_HOME: keelHome },
      timeout: 30000,
    })
    const out = JSON.parse(result.stdout)
    expect(out.action).toBe('deny')
    expect(out.rule_id).toBe('no-destructive-commands')
    expect(result.status).toBe(1)
  })

  it('keel evaluate STILL denies with the project ruleset alone — no global ~/.keel/rules.yaml on this machine at all', () => {
    // A fresh HOME/KEEL_HOME that installProjectPlugin() never touched:
    // simulates a teammate who cloned the project (getting its committed
    // .keel/rules.yaml and .opencode/plugins/keel-enforce.js) but never
    // ran a *global* `keel install` themselves. If enforcement here
    // depended on the global tier, this would silently pass everything.
    const bareHome = mkdtempSync(join(tmpdir(), 'keel-a3-barehome-'))
    try {
      expect(existsSync(join(bareHome, '.keel', 'rules.yaml'))).toBe(false)
      const result = spawnSync(process.execPath, [
        CLI, 'evaluate', '--tool', 'Bash',
        '--args', JSON.stringify({ command: 'rm -rf /' }),
        '--cwd', project,
      ], {
        cwd: project,
        encoding: 'utf-8',
        env: { ...process.env, HOME: bareHome, KEEL_HOME: bareHome },
        timeout: 30000,
      })
      const out = JSON.parse(result.stdout)
      expect(out.action, `evaluate result: ${JSON.stringify(out)}`).toBe('deny')
      expect(out.rule_id).toBe('no-destructive-commands')
      expect(result.status).toBe(1)
    } finally {
      rmSafe(bareHome)
    }
  })
})
