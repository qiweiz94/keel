import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRulesContent } from '@get-keel/core'
import { DEFAULT_RULES_YAML } from '../commands/install.js'
import {
  classifyScenario,
  findConformanceDir,
  loadScenarioFiles,
  matchesClass,
  runConformanceSuite,
  summarizeOverall,
  conformanceCommand,
  type CategoryReport,
  type Scenario,
} from '../commands/conformance.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * `keel conformance` runs Keel's shipped OWASP Agentic Top 10 scenario
 * suite (packages/cli/conformance/*.yaml) against the caller's OWN loaded
 * rules. These tests isolate ~/.keel (HOME/KEEL_STATE_DIR) the same way
 * public-v1.test.ts does — evaluateToolCall/initEnforce default-construct
 * trackers from those env vars, and this file must never touch a real
 * developer's state.
 */

let tempHome: string
let previousHome: string | undefined
let previousStateDir: string | undefined

beforeAll(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'keel-conformance-test-home-'))
  previousHome = process.env.HOME
  previousStateDir = process.env.KEEL_STATE_DIR
  process.env.HOME = tempHome
  process.env.KEEL_STATE_DIR = join(tempHome, '.keel', 'state')
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousStateDir === undefined) delete process.env.KEEL_STATE_DIR
  else process.env.KEEL_STATE_DIR = previousStateDir
  rmSafe(tempHome)
})

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'keel-conformance-project-'))
}

function installDefaultRules(project: string): void {
  mkdirSync(join(project, '.keel'), { recursive: true })
  writeFileSync(join(project, '.keel', 'rules.yaml'), DEFAULT_RULES_YAML, 'utf-8')
}

function installEmptyRules(project: string): void {
  mkdirSync(join(project, '.keel'), { recursive: true })
  writeFileSync(join(project, '.keel', 'rules.yaml'), 'version: 1\nrules: []\n', 'utf-8')
}

// ---------------------------------------------------------------------
// Scenario-file integrity: every expect_rule the shipped scenarios name
// must be a REAL id in DEFAULT_RULES_YAML. Without this test, a typo'd
// expect_rule silently degrades to permanent "not-covered" for that
// scenario — never fails, never gets noticed — which is exactly the "a
// control that cannot fire" failure mode: the scenario LOOKS like it's
// asserting real coverage but can never do so again.
// ---------------------------------------------------------------------
describe('shipped scenario files reference real rule ids', () => {
  const dir = findConformanceDir()
  if (!dir) throw new Error('conformance/ directory not found — is the package tree intact?')
  const files = loadScenarioFiles(dir)
  const parsedDefaults = parseRulesContent(DEFAULT_RULES_YAML, 'install.ts')
  const defaultIds = new Set((parsedDefaults.rules ?? []).map(r => r.id))

  it('ships exactly one file per ASI01-ASI10 category', () => {
    const categories = files.map(f => f.category).sort()
    expect(categories).toEqual(
      Array.from({ length: 10 }, (_, i) => `ASI${String(i + 1).padStart(2, '0')}`),
    )
  })

  it('every scenario has a name and a valid expect class', () => {
    for (const file of files) {
      for (const s of file.scenarios as Scenario[]) {
        expect(s.name, `${file.category}: unnamed scenario`).toBeTruthy()
        expect(['blocking', 'enforced', 'allow', 'observed']).toContain(s.expect)
        const hasSteps = Array.isArray(s.steps) && s.steps.length > 0
        const hasShorthand = typeof s.tool === 'string'
        expect(hasSteps || hasShorthand, `${file.category}/${s.name}: needs steps[] or tool+args`).toBe(true)
      }
    }
  })

  it.each(
    files.flatMap(file =>
      (file.scenarios as Scenario[])
        .filter(s => s.expect_rule)
        .map(s => ({ category: file.category, name: s.name, expect_rule: s.expect_rule! })),
    ),
  )('$category/$name expects a real rule id ($expect_rule)', ({ expect_rule }) => {
    expect(defaultIds.has(expect_rule), `"${expect_rule}" is not a rule id in DEFAULT_RULES_YAML`).toBe(true)
  })

  it('at least one scenario per file targets a real shipped rule (no all-illustrative file)', () => {
    for (const file of files) {
      const withRule = (file.scenarios as Scenario[]).filter(s => s.expect_rule)
      // ASI06/ASI07 are documented as entirely "not addressed" — every
      // scenario there is illustrative by design (see the files' own
      // header comments). Every other category ships at least one real,
      // checkable rule reference.
      if (file.category === 'ASI06' || file.category === 'ASI07') continue
      expect(withRule.length, `${file.category} has no scenario referencing a real rule id`).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------
// Pure classification logic
// ---------------------------------------------------------------------
describe('matchesClass', () => {
  it('blocking matches deny/block/prompt/redirect/research only', () => {
    expect(matchesClass('deny', 'blocking')).toBe(true)
    expect(matchesClass('prompt', 'blocking')).toBe(true)
    expect(matchesClass('redirect', 'blocking')).toBe(true)
    expect(matchesClass('warn', 'blocking')).toBe(false)
    expect(matchesClass('allow', 'blocking')).toBe(false)
  })
  it('enforced matches anything but allow', () => {
    expect(matchesClass('warn', 'enforced')).toBe(true)
    expect(matchesClass('deny', 'enforced')).toBe(true)
    expect(matchesClass('allow', 'enforced')).toBe(false)
  })
  it('allow matches only allow', () => {
    expect(matchesClass('allow', 'allow')).toBe(true)
    expect(matchesClass('warn', 'allow')).toBe(false)
  })
})

function fakeResult(overrides: Partial<Parameters<typeof classifyScenario>[1]> = {}) {
  return {
    action: 'allow' as const,
    rule_id: null,
    message: '',
    timestamp: new Date().toISOString(),
    ...overrides,
  } as Parameters<typeof classifyScenario>[1]
}

describe('classifyScenario', () => {
  it('reports not-covered (never fail) when the scenario names no expect_rule', () => {
    const project = tempProject()
    installEmptyRules(project)
    const scenario: Scenario = { name: 'illustrative gap', expect: 'allow', tool: 'Bash', args: {} }
    const result = classifyScenario(scenario, fakeResult({ action: 'allow' }), project, 'balanced')
    expect(result.status).toBe('not-covered')
  })

  it('reports not-covered when expect_rule is absent from the loaded ruleset', () => {
    const project = tempProject()
    installEmptyRules(project)
    const scenario: Scenario = { name: 'x', expect: 'blocking', expect_rule: 'no-destructive-commands', tool: 'Bash', args: {} }
    const result = classifyScenario(scenario, fakeResult({ action: 'allow' }), project, 'balanced')
    expect(result.status).toBe('not-covered')
    expect(result.reason).toContain('not present')
  })

  it('reports not-covered when expect_rule exists but is dial-gated at the current level', () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: only-at-protect
    type: command
    match: "dangerous"
    action: deny
    level: balanced
    message: "x"
`, 'utf-8')
    const scenario: Scenario = { name: 'x', expect: 'blocking', expect_rule: 'only-at-protect', tool: 'Bash', args: { command: 'dangerous' } }
    // Evaluate at 'sprint': a level: balanced rule is filtered out of
    // mergeRules() at the sprint dial (dialRank[balanced] > dialRank[sprint]).
    const result = classifyScenario(scenario, fakeResult({ action: 'allow' }), project, 'sprint')
    expect(result.status).toBe('not-covered')
    expect(result.reason).toContain('dial-gated')
  })

  it('reports pass when the rule is active and fired as expected', () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: my-rule
    type: command
    match: "dangerous"
    action: deny
    level: protect
    message: "x"
`, 'utf-8')
    const scenario: Scenario = { name: 'x', expect: 'blocking', expect_rule: 'my-rule', tool: 'Bash', args: { command: 'dangerous' } }
    const result = classifyScenario(scenario, fakeResult({ action: 'deny', rule_id: 'my-rule' }), project, 'balanced')
    expect(result.status).toBe('pass')
  })

  it('reports fail when the rule is active but did not fire as expected (a real gap)', () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: my-rule
    type: command
    match: "dangerous"
    action: deny
    level: protect
    message: "x"
`, 'utf-8')
    const scenario: Scenario = { name: 'x', expect: 'blocking', expect_rule: 'my-rule', tool: 'Bash', args: { command: 'dangerous' } }
    // The rule is present and active, but the ACTUAL evaluated verdict
    // (as if the pattern silently stopped matching) allowed the call.
    const result = classifyScenario(scenario, fakeResult({ action: 'allow', rule_id: null }), project, 'balanced')
    expect(result.status).toBe('fail')
    expect(result.reason).toContain('did not fire as expected')
  })

  it('observed class checks observed_matches, not the primary action', () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: observe-rule
    type: content
    mode: observe
    patterns:
      - regex: "TODO"
    action: warn
    level: sprint
    message: "x"
`, 'utf-8')
    const scenario: Scenario = { name: 'x', expect: 'observed', expect_rule: 'observe-rule', tool: 'Write', args: {} }
    const observed = fakeResult({
      action: 'allow',
      rule_id: 'observe-rule',
      observed_matches: [{ rule_id: 'observe-rule', observed_action: 'warn', message: 'x' }],
    })
    expect(classifyScenario(scenario, observed, project, 'balanced').status).toBe('pass')

    const notObserved = fakeResult({ action: 'allow', rule_id: null })
    expect(classifyScenario(scenario, notObserved, project, 'balanced').status).toBe('fail')
  })
})

// ---------------------------------------------------------------------
// Coverage-percentage math
// ---------------------------------------------------------------------
describe('summarizeOverall', () => {
  function cat(pass: number, fail: number, not_covered: number): CategoryReport {
    return { category: 'ASIxx', title: 't', pass, fail, not_covered, scenarios: [] }
  }

  it('excludes not-covered from the coverage denominator', () => {
    const overall = summarizeOverall([cat(3, 1, 10)])
    expect(overall.pass).toBe(3)
    expect(overall.fail).toBe(1)
    expect(overall.not_covered).toBe(10)
    expect(overall.total).toBe(14)
    expect(overall.coverage_pct).toBe(75) // 3 / (3+1)
  })

  it('is null, not 0, when nothing is testable', () => {
    const overall = summarizeOverall([cat(0, 0, 5)])
    expect(overall.coverage_pct).toBeNull()
  })

  it('is 100 when everything testable passed', () => {
    const overall = summarizeOverall([cat(4, 0, 2), cat(2, 0, 0)])
    expect(overall.coverage_pct).toBe(100)
  })

  it('sums across multiple categories', () => {
    const overall = summarizeOverall([cat(1, 1, 1), cat(2, 0, 0)])
    expect(overall.pass).toBe(3)
    expect(overall.fail).toBe(1)
    expect(overall.not_covered).toBe(1)
    expect(overall.total).toBe(5)
  })
})

// ---------------------------------------------------------------------
// End-to-end: the real shipped scenario suite against real rulesets
// ---------------------------------------------------------------------
describe('runConformanceSuite against the real shipped scenarios', () => {
  const dir = findConformanceDir()
  if (!dir) throw new Error('conformance/ directory not found')

  it('a fresh `keel install`-equivalent ruleset passes every checkable scenario', async () => {
    const project = tempProject()
    installDefaultRules(project)
    const { overall } = await runConformanceSuite(project, 'balanced', dir)
    expect(overall.fail).toBe(0)
    expect(overall.pass).toBeGreaterThan(0)
    expect(overall.coverage_pct).toBe(100)
  }, 30000)

  it('an empty ruleset reports every rule-checking scenario as not-covered, never fail', async () => {
    const project = tempProject()
    installEmptyRules(project)
    const { overall } = await runConformanceSuite(project, 'balanced', dir)
    expect(overall.fail).toBe(0)
    expect(overall.pass).toBe(0)
    expect(overall.not_covered).toBe(overall.total)
    expect(overall.coverage_pct).toBeNull()
  }, 30000)

  it('a weakened rule (present but never matches) is reported as a real fail, not not-covered', async () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: no-destructive-commands
    type: command
    match: "this-will-never-match-anything-xyz"
    action: deny
    level: protect
    message: "weakened"
`, 'utf-8')
    const { overall, categories } = await runConformanceSuite(project, 'balanced', dir)
    expect(overall.fail).toBeGreaterThan(0)
    const failed = categories.flatMap(c => c.scenarios).filter(s => s.status === 'fail')
    expect(failed.some(s => s.expect_rule === 'no-destructive-commands')).toBe(true)
  }, 30000)
})

// ---------------------------------------------------------------------
// CLI wrapper: --json shape and --ci exit code
// ---------------------------------------------------------------------
describe('conformanceCommand CLI wrapper', () => {
  it('--json emits a stable, parseable shape', async () => {
    const project = tempProject()
    installDefaultRules(project)
    let written = ''
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written += typeof chunk === 'string' ? chunk : String(chunk)
      return true
    })
    try {
      await conformanceCommand({ dir: project, json: true, level: 'balanced' })
    } finally {
      writeSpy.mockRestore()
    }
    const parsed = JSON.parse(written)
    expect(parsed.level).toBe('balanced')
    expect(Array.isArray(parsed.categories)).toBe(true)
    expect(parsed.categories.length).toBe(10)
    expect(parsed.overall).toHaveProperty('pass')
    expect(parsed.overall).toHaveProperty('fail')
    expect(parsed.overall).toHaveProperty('not_covered')
    expect(parsed.overall).toHaveProperty('coverage_pct')
    for (const cat of parsed.categories) {
      expect(cat).toHaveProperty('category')
      expect(cat).toHaveProperty('title')
      expect(Array.isArray(cat.scenarios)).toBe(true)
    }
  }, 30000)

  it('--ci exits 0 (no real gaps) against a fresh install-equivalent ruleset', async () => {
    const project = tempProject()
    installDefaultRules(project)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const previousExitCode = process.exitCode
    process.exitCode = undefined
    try {
      await conformanceCommand({ dir: project, ci: true, level: 'balanced' })
      expect(process.exitCode).toBeUndefined()
    } finally {
      logSpy.mockRestore()
      process.exitCode = previousExitCode
    }
  }, 30000)

  it('--ci exits 1 when a real gap exists; a bare run without --ci does not', async () => {
    const project = tempProject()
    mkdirSync(join(project, '.keel'), { recursive: true })
    writeFileSync(join(project, '.keel', 'rules.yaml'), `version: 1
rules:
  - id: no-destructive-commands
    type: command
    match: "this-will-never-match-anything-xyz"
    action: deny
    level: protect
    message: "weakened"
`, 'utf-8')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const previousExitCode = process.exitCode
    try {
      process.exitCode = undefined
      await conformanceCommand({ dir: project, level: 'balanced' })
      expect(process.exitCode).toBeUndefined()

      process.exitCode = undefined
      await conformanceCommand({ dir: project, ci: true, level: 'balanced' })
      expect(process.exitCode).toBe(1)
    } finally {
      logSpy.mockRestore()
      process.exitCode = previousExitCode
    }
  }, 30000)

  it('rejects an invalid --level', async () => {
    const project = tempProject()
    installEmptyRules(project)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const previousExitCode = process.exitCode
    try {
      process.exitCode = undefined
      await conformanceCommand({ dir: project, level: 'nonsense' })
      expect(process.exitCode).toBe(1)
    } finally {
      logSpy.mockRestore()
      process.exitCode = previousExitCode
    }
  })
})

// ---------------------------------------------------------------------
// packaging: conformance/ must actually ship in the published package
// ---------------------------------------------------------------------
describe('packaging', () => {
  it('package.json files[] includes "conformance"', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'))
    expect(pkg.files).toContain('conformance')
  })

  it('every file in conformance/ is a .yaml scenario file with content', () => {
    const dir = findConformanceDir()
    if (!dir) throw new Error('conformance/ directory not found')
    const entries = readdirSync(dir)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry).toMatch(/\.ya?ml$/i)
    }
  })
})
