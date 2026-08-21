import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import chalk from 'chalk'
import { initEnforce, evaluateToolCall, recordPostAction } from './enforce.js'
import { loadRuleHierarchy, mergeRules } from '../core/enforce/index.js'
import { BLOCKING_ACTIONS } from './evaluate.js'
import type { EnforcementAction, ProtectionLevel, RuleContext } from '../core/types.js'

/**
 * `keel conformance` — run Keel's shipped OWASP Agentic Top 10 scenario
 * suite against the CALLER'S OWN loaded rules and report pass/fail/
 * not-covered per ASI01–ASI10 category, plus an overall coverage
 * percentage. Turns docs/owasp-agentic-top10.md's prose mapping into
 * something a user can actually verify locally instead of taking on faith.
 */

const CONTEXT: RuleContext = 'local'

export type ExpectClass = 'blocking' | 'enforced' | 'allow' | 'observed'

export interface ScenarioStep {
  tool: string
  args?: Record<string, unknown>
  /**
   * When present, `recordPostAction` is called with this exit code right
   * after the step's own evaluateToolCall — the same after-hook shape a
   * real host uses to discharge verification/stuck-loop bookkeeping (see
   * enforce.ts's recordPostAction doc comment). Needed to drive stateful
   * rules like `no-repeat-loops` (type: stuck), which only escalates once
   * a PRIOR attempt has been recorded as a real failure.
   */
  exitCode?: number
}

export interface Scenario {
  name: string
  /**
   * How to read the FINAL step's verdict:
   *   'blocking' — the action is one of BLOCKING_ACTIONS (deny/block/
   *                prompt/redirect/research) — the call was actually
   *                stopped or gated on a human.
   *   'enforced' — the action is anything other than 'allow' (covers a
   *                rule that only warns on a first hit, e.g. a level:
   *                sprint deny rule's warn-once-then-block ladder — see
   *                rule-parser.ts's dialAction()). Weaker than 'blocking'
   *                on purpose: a scenario should assert the STRONGEST
   *                claim that is actually true of the shipped defaults, so
   *                a real regression (deny -> warn, warn -> nothing) still
   *                fails this check.
   *   'allow'    — the call passed straight through. Used for scenarios
   *                that illustrate a documented coverage GAP (paired with
   *                no `expect_rule` — see classifyScenario below).
   *   'observed' — a `mode: observe` rule matched (recorded in
   *                `observed_matches`) without changing the primary
   *                verdict. Distinct from 'enforced': an observe hit is a
   *                detector's STATE, not its CONSEQUENCE — the call was
   *                never actually interrupted.
   */
  expect: ExpectClass
  /**
   * The shipped-default rule id this scenario expects to see fire. Omit it
   * entirely for a scenario that illustrates a category Keel's OWN
   * defaults don't attempt to cover (see docs/owasp-agentic-top10.md's
   * "Not addressed" / "documented gap" callouts) — those scenarios are
   * always reported `not-covered`, informational only, never a failure:
   * there is no rule id to check for absence or for a weakened fire, so
   * there is nothing actionable to report beyond "this is out of scope
   * today."
   */
  expect_rule?: string
  /** Multi-step scenarios (state-driven rules). Single-step scenarios use
   * the `tool`/`args` shorthand below instead. */
  steps?: ScenarioStep[]
  tool?: string
  args?: Record<string, unknown>
}

export interface ScenarioFile {
  category: string
  title: string
  summary?: string
  scenarios: Scenario[]
}

export type ScenarioStatus = 'pass' | 'fail' | 'not-covered'

export interface ScenarioResult {
  name: string
  status: ScenarioStatus
  expect: ExpectClass
  expect_rule?: string
  action: EnforcementAction
  rule_id?: string | null
  reason: string
}

export interface CategoryReport {
  category: string
  title: string
  summary?: string
  pass: number
  fail: number
  not_covered: number
  scenarios: ScenarioResult[]
}

export interface OverallReport {
  pass: number
  fail: number
  not_covered: number
  total: number
  /** pass / (pass + fail) as a 0-100 integer, or null when nothing in the
   * suite was testable against this ruleset (every scenario not-covered) —
   * null, never 0, so a JSON consumer can't mistake "nothing to measure"
   * for "measured and found zero coverage." */
  coverage_pct: number | null
}

export interface ConformanceOptions {
  level?: string
  json?: boolean
  ci?: boolean
  dir?: string
}

/**
 * Run `fn` with `KEEL_STATE_DIR`/`KEEL_OVERRIDES_DIR` pointed at a fresh,
 * throwaway temp directory for the duration of the call, restoring both env
 * vars (and deleting the temp dir) afterward — the SAME isolation pattern
 * `public-v1.test.ts` and `cli.test.ts` already use to keep test runs off a
 * developer's real `~/.keel/state`.
 *
 * This is not just test hygiene here — it's a correctness requirement.
 * Several shipped rule TYPES persist state keyed ONLY by (rule id, match
 * pattern) — NOT by session id — via StateManager (see state-manager.ts's
 * RateLimitState/DenyState): `bash-rate-limit` (type: rate) counts every
 * Bash-tool call against one flat `rate:bash-rate-limit:Bash` bucket
 * regardless of which scenario, session, or even which `keel conformance`
 * process made the call. Confirmed empirically while building this
 * command: running the suite two or three times in the same minute against
 * the SAME real `~/.keel/state` tripped `bash-rate-limit` partway through a
 * later run, which then WON the tiered-evaluation race ahead of the
 * scenario's own intended rule (e.g. `no-repeat-loops`) for that call —
 * turning an otherwise-correct scenario into a false "fail". Per-scenario
 * `initEnforce()` (see `runScenario` below) isolates the SESSION-scoped
 * trackers (FlowTracker, StuckTracker, SessionTracker); it does nothing for
 * this class of state, which is why the isolation has to happen one layer
 * up, for the whole command run.
 */
export async function withIsolatedState<T>(fn: () => Promise<T>): Promise<T> {
  const previousStateDir = process.env.KEEL_STATE_DIR
  const previousOverridesDir = process.env.KEEL_OVERRIDES_DIR
  const tempDir = mkdtempSync(join(tmpdir(), 'keel-conformance-'))
  process.env.KEEL_STATE_DIR = join(tempDir, 'state')
  process.env.KEEL_OVERRIDES_DIR = join(tempDir, 'overrides')
  try {
    return await fn()
  } finally {
    if (previousStateDir === undefined) delete process.env.KEEL_STATE_DIR
    else process.env.KEEL_STATE_DIR = previousStateDir
    if (previousOverridesDir === undefined) delete process.env.KEEL_OVERRIDES_DIR
    else process.env.KEEL_OVERRIDES_DIR = previousOverridesDir
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
}

/**
 * Locate the shipped conformance/ directory (one YAML per ASI category).
 * Same candidate-path shape as install.ts's findTemplateSource(): this
 * file compiles to dist/commands/conformance.js, so '..','..' from there
 * lands on packages/cli/conformance in both the dev tree and an installed
 * npm package (where 'conformance' is listed in package.json's `files`).
 */
export function findConformanceDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', '..', 'conformance'),
    join(here, '..', '..', '..', 'conformance'),
    join(process.cwd(), 'packages', 'cli', 'conformance'),
    join(process.cwd(), 'conformance'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export function loadScenarioFiles(dir: string): ScenarioFile[] {
  const files = readdirSync(dir).filter(f => /\.ya?ml$/i.test(f)).sort()
  return files.map(f => {
    const raw = readFileSync(join(dir, f), 'utf-8')
    const parsed = parseYaml(raw) as ScenarioFile
    if (!parsed || !parsed.category || !Array.isArray(parsed.scenarios)) {
      throw new Error(`Malformed conformance scenario file: ${f}`)
    }
    return parsed
  })
}

export function matchesClass(action: EnforcementAction, expect: ExpectClass): boolean {
  if (expect === 'blocking') return BLOCKING_ACTIONS.has(action)
  if (expect === 'enforced') return action !== 'allow'
  if (expect === 'allow') return action === 'allow'
  return false
}

/**
 * Classify one scenario's outcome into pass/fail/not-covered.
 *
 * The THREE-WAY split (not just pass/fail) is the whole point of this
 * command: a scenario whose `expect_rule` genuinely isn't present in the
 * caller's loaded rules (or isn't active at the caller's current level —
 * dial-gated) is not a failure, it's information — a user who deliberately
 * runs a narrower ruleset than the shipped defaults is not "failing" a
 * test. Only a scenario whose rule IS present and active, but still didn't
 * fire the way the shipped defaults promise, is a real gap worth
 * investigating (has it been weakened, overridden, or shadowed by another
 * rule?).
 */
export function classifyScenario(
  scenario: Scenario,
  result: Awaited<ReturnType<typeof evaluateToolCall>>,
  cwd: string,
  level: ProtectionLevel,
): ScenarioResult {
  const base = {
    name: scenario.name,
    expect: scenario.expect,
    expect_rule: scenario.expect_rule,
    action: result.action,
    rule_id: result.rule_id ?? null,
  }

  if (!scenario.expect_rule) {
    return {
      ...base,
      status: 'not-covered',
      reason: 'Illustrative: no rule in Keel\'s shipped defaults targets this today — architecturally out of scope (see docs/owasp-agentic-top10.md). Informational, never a failure.',
    }
  }

  const hierarchy = loadRuleHierarchy(cwd)
  const allIds = new Set(
    [hierarchy.global, hierarchy.user, hierarchy.project, hierarchy.local]
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .flatMap(s => s.rules.map(r => r.id)),
  )
  if (!allIds.has(scenario.expect_rule)) {
    return {
      ...base,
      status: 'not-covered',
      reason: `Rule "${scenario.expect_rule}" is not present anywhere in your loaded rules (global/user/project/local) — your ruleset doesn't cover this scenario. Not a failure: this may be a deliberate customization.`,
    }
  }

  const active = new Set(mergeRules(hierarchy, level, CONTEXT).map(r => r.id))
  if (!active.has(scenario.expect_rule)) {
    return {
      ...base,
      status: 'not-covered',
      reason: `Rule "${scenario.expect_rule}" is defined in your rules but not active at level "${level}" — dial-gated, not missing. Re-run at a higher level (or persist one with \`keel level\`) to exercise it.`,
    }
  }

  const fired = scenario.expect === 'observed'
    ? (result.observed_matches ?? []).some(m => m.rule_id === scenario.expect_rule)
    : result.rule_id === scenario.expect_rule && matchesClass(result.action, scenario.expect)

  if (fired) {
    return { ...base, status: 'pass', reason: `Rule "${scenario.expect_rule}" fired as expected (${result.action}).` }
  }
  return {
    ...base,
    status: 'fail',
    reason: `Rule "${scenario.expect_rule}" is active in your ruleset but did not fire as expected here (got action="${result.action}"${result.rule_id ? `, rule_id="${result.rule_id}"` : ''}). Worth investigating — has this rule been weakened, overridden, or shadowed by another rule?`,
  }
}

/**
 * Run one scenario end-to-end. `initEnforce()` is called FRESH for every
 * single scenario, not once for the whole command run — deliberate, not an
 * oversight. Trackers like FlowTracker are session-scoped state that
 * persists across `evaluateToolCall` calls within one initialized pipeline
 * (that's what makes the `no-exfil-flow` two-step scenario work at all —
 * see flow-tracker.ts). Sharing ONE pipeline across every scenario in this
 * suite would let an early scenario's state leak into a LATER, unrelated
 * scenario's verdict: a `cat .env` read tags a flow-source, and any LATER
 * scenario whose command merely LOOKS like a network sink (curl, wget, scp,
 * rsync — several categories use exactly this shape for `pipe-to-shell`/
 * `paste-site-exfil`) would then return `no-exfil-flow` (a level: protect
 * floor, evaluated before everything else) instead of the rule that
 * scenario actually meant to exercise. A fresh `initEnforce()` per scenario
 * mints a fresh session id and fresh in-memory trackers, closing that off
 * entirely rather than depending on file/scenario ordering to avoid it.
 */
export async function runScenario(scenario: Scenario, cwd: string, level: ProtectionLevel): Promise<ScenarioResult> {
  initEnforce(cwd, { level })

  const steps: ScenarioStep[] = scenario.steps ?? [{ tool: scenario.tool!, args: scenario.args ?? {} }]
  let result: Awaited<ReturnType<typeof evaluateToolCall>> | undefined
  for (const step of steps) {
    result = await evaluateToolCall(step.tool, step.args ?? {}, { cwd, agent: 'keel-conformance', level, context: CONTEXT })
    if (step.exitCode !== undefined) {
      await recordPostAction(step.tool, step.args ?? {}, step.exitCode, { cwd, agent: 'keel-conformance' })
    }
  }

  return classifyScenario(scenario, result!, cwd, level)
}

export function summarizeCategory(file: ScenarioFile, scenarios: ScenarioResult[]): CategoryReport {
  return {
    category: file.category,
    title: file.title,
    summary: file.summary,
    pass: scenarios.filter(s => s.status === 'pass').length,
    fail: scenarios.filter(s => s.status === 'fail').length,
    not_covered: scenarios.filter(s => s.status === 'not-covered').length,
    scenarios,
  }
}

export function summarizeOverall(categories: CategoryReport[]): OverallReport {
  const pass = categories.reduce((n, c) => n + c.pass, 0)
  const fail = categories.reduce((n, c) => n + c.fail, 0)
  const not_covered = categories.reduce((n, c) => n + c.not_covered, 0)
  const testable = pass + fail
  return {
    pass,
    fail,
    not_covered,
    total: pass + fail + not_covered,
    coverage_pct: testable > 0 ? Math.round((pass / testable) * 100) : null,
  }
}

/**
 * The testable core of `keel conformance`: load the shipped scenario
 * files, run every scenario, and return structured category + overall
 * reports — no console I/O, no process.exitCode. `conformanceCommand`
 * below is a thin CLI wrapper around this (mirrors report.ts's
 * buildReportPayload split), so tests can exercise the real classification
 * logic without spawning the CLI or capturing stdout.
 */
export async function runConformanceSuite(
  cwd: string,
  level: ProtectionLevel,
  scenarioDir: string,
): Promise<{ categories: CategoryReport[]; overall: OverallReport }> {
  const files = loadScenarioFiles(scenarioDir)
  const categories = await withIsolatedState(async () => {
    const cats: CategoryReport[] = []
    for (const file of files) {
      const results: ScenarioResult[] = []
      for (const scenario of file.scenarios) {
        results.push(await runScenario(scenario, cwd, level))
      }
      cats.push(summarizeCategory(file, results))
    }
    return cats
  })
  return { categories, overall: summarizeOverall(categories) }
}

function statusIcon(status: ScenarioStatus): string {
  if (status === 'pass') return chalk.green('✓ pass')
  if (status === 'fail') return chalk.red('✗ fail')
  return chalk.dim('· not-covered')
}

function printReport(level: ProtectionLevel, categories: CategoryReport[], overall: OverallReport): void {
  console.log()
  console.log(chalk.bold.cyan('  ⚓ keel conformance — OWASP Agentic Top 10'))
  console.log(chalk.dim(`  Level: ${chalk.white(level)}`))
  console.log()

  for (const cat of categories) {
    const header = `  ${chalk.bold(cat.category)} — ${cat.title}`
    console.log(header)
    if (cat.summary) console.log(chalk.dim(`    ${cat.summary}`))
    console.log(
      chalk.dim(`    pass ${chalk.green(String(cat.pass))}  fail ${chalk.red(String(cat.fail))}  not-covered ${chalk.dim(String(cat.not_covered))}`),
    )
    for (const s of cat.scenarios) {
      console.log(`      ${statusIcon(s.status)}  ${s.name}`)
      if (s.status === 'fail') console.log(chalk.yellow(`        ${s.reason}`))
    }
    console.log()
  }

  console.log(chalk.bold('  Overall'))
  console.log(
    `    pass ${chalk.green(String(overall.pass))}  fail ${chalk.red(String(overall.fail))}  not-covered ${chalk.dim(String(overall.not_covered))}  (${overall.total} scenarios)`,
  )
  const pct = overall.coverage_pct === null ? chalk.dim('N/A (no testable scenarios matched your ruleset)') : `${overall.coverage_pct}%`
  console.log(`    Coverage: ${chalk.bold(pct)} ${chalk.dim(`(pass / (pass + fail) — not-covered is informational, excluded from the denominator)`)}`)
  console.log()
  if (overall.fail > 0) {
    console.log(chalk.yellow(`  ${overall.fail} scenario(s) marked "fail" above are active rules that didn't fire as the shipped defaults promise — worth a look.`))
    console.log()
  }
}

/**
 * `keel conformance` — see this file's header comment.
 *
 * Exit code: 0 by default, always — this is a report, not a gate, and a
 * day-one user running a deliberately narrow ruleset would otherwise see
 * every fresh install fail CI for a `not-covered` state that isn't a
 * failure at all. Pass `--ci` (the SAME opt-in convention `keel scan --ci`
 * and `keel check --ci` already use) to exit 1 when at least one real gap
 * (`fail`, never `not-covered`) was found.
 */
export async function conformanceCommand(options: ConformanceOptions): Promise<void> {
  const level = (options.level || 'balanced') as ProtectionLevel
  if (!['sprint', 'balanced', 'protect'].includes(level)) {
    console.log(chalk.red(`Invalid level: "${level}". Use sprint, balanced, or protect.`))
    process.exitCode = 1
    return
  }
  const cwd = options.dir || process.cwd()

  const dir = findConformanceDir()
  if (!dir) {
    console.log(chalk.red('  Could not find the shipped conformance/ scenario directory. Reinstall the CLI or run from the keel repo.'))
    process.exitCode = 2
    return
  }

  let categories: CategoryReport[]
  let overall: OverallReport
  try {
    ;({ categories, overall } = await runConformanceSuite(cwd, level, dir))
  } catch (err) {
    console.log(chalk.red(`  Failed to run conformance scenarios: ${(err as Error).message}`))
    process.exitCode = 2
    return
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({ level, categories, overall }, null, 2) + '\n')
  } else {
    printReport(level, categories, overall)
  }

  if (options.ci && overall.fail > 0) {
    process.exitCode = 1
  }
}
