import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ActionCache,
  ContentTracker,
  EnforcementPipeline,
  FlowTracker,
  SequenceDetector,
  StateManager,
  parseRulesContent,
} from '@get-keel/core'
import type { EnforceInput, KeelRule, PipelineConfig, ProtectionLevel, RuleContext, RuleHierarchy } from '@get-keel/core'

/**
 * A4 perf-budget regression guard (roadmap A4 — see session/v04/EVIDENCE/
 * a4-perf.md for the full measurement writeup and scripts/perf/bench.mjs
 * for the fuller corpus this is distilled from).
 *
 * Asserts EnforcementPipeline.evaluate() against the SHIPPED default
 * ruleset (same DEFAULT_RULES_YAML extraction technique as
 * fixture-harness.test.ts in this same directory) stays under keel's own
 * documented <50ms hot-path claim for a benign Bash call — the modal case
 * (no rule matches, every rule still gets checked).
 *
 * THRESHOLD CHOICE (honest reasoning, not a made-up number):
 *   - Primary gate is the literal 50ms the product promises, not some
 *     stricter number tuned to this developer's laptop — a tighter gate
 *     would be testing "is this machine fast today", not "does keel keep
 *     its promise". Measured on this exact machine at its LEAST loaded
 *     moment, this suite's own bench (scripts/perf/bench.mjs) sees p99
 *     ~1-2ms for this corpus shape (see a4-perf.md) — 50ms leaves at
 *     least an order of magnitude of headroom, which is what makes it
 *     "generous" rather than a floor tuned to just barely pass.
 *   - Skip-guard, calibrated against what was ACTUALLY observed while
 *     building this: this repo is regularly built/tested on a shared dev
 *     machine running several other coding-agent sessions at once. An
 *     earlier version of this test used a timing-based "near-zero-rule
 *     baseline" as its contention probe, on the theory that a busy host
 *     would delay that trivial call too — measured live, it did NOT: the
 *     baseline stayed under 0.1ms across every run (5/5) even while the
 *     SAME test's real 43-rule measurement swung 14ms-92ms run to run.
 *     Wall-clock contention on this machine apparently does not delay a
 *     sub-millisecond call very often, but DOES disproportionately delay
 *     a call that holds the CPU for a millisecond or more (a longer
 *     window of wall-clock time is simply more likely to overlap a
 *     scheduler preemption) — so a trivial-baseline probe is the wrong
 *     signal here. `os.loadavg()` is the direct signal (this is
 *     literally what `uptime` was used to confirm live: load averages of
 *     15-35 on a 16-core box while writing this test — see a4-perf.md).
 *     If the 1-minute load average exceeds `LOAD_PER_CORE_SKIP` per core,
 *     the test skips before spending any time measuring.
 *   - Best-of-N on top of the load check, not instead of it: even a
 *     currently-idle-looking load average can still take a transient hit
 *     mid-measurement (bursty, not sustained, per the same live evidence).
 *     A REAL regression in the pipeline's own cost would be slow on every
 *     attempt; a one-off scheduler hiccup would not. Taking the best of
 *     `ATTEMPTS` independent measurements (fresh pipeline each time) and
 *     asserting only on the best is the standard way to separate those
 *     two cases without loosening the 50ms bar itself.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const INSTALL_SRC = join(HERE, '..', 'commands', 'install.ts')

function loadDefaultRules(): KeelRule[] {
  const src = readFileSync(INSTALL_SRC, 'utf-8')
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  expect(m, 'DEFAULT_RULES_YAML not found in install.ts').toBeTruthy()
  const parsed = parseRulesContent(m![1], INSTALL_SRC)
  expect(parsed.errors, `DEFAULT_RULES_YAML failed to parse: ${parsed.errors}`).toBeUndefined()
  expect(parsed.rules.length).toBeGreaterThan(0)
  return parsed.rules
}

let scratchRoot = ''
let stateDir = ''

// Never the real ~/.keel: the benign corpus below never issues a package
// install (extractPackageInstalls short-circuits on anything without an
// npm/pnpm/yarn/bun token) and never trips a violation (no rule matches a
// benign Bash command), so PackageVerifierCache's default disk path and
// overrideStore.consume() are both structurally unreachable here — but
// EnforcementPipeline's constructor still default-constructs
// PackageVerifierCache() and FileRuleOverrideStore() eagerly whenever a
// caller doesn't supply its own, and both of those default straight to
// process.env.KEEL_STATE_DIR / KEEL_OVERRIDES_DIR falling back to the
// REAL homedir()-based ~/.keel when unset. Same isolation mechanism
// fixture-harness.test.ts in this same directory already uses.
function stubOverrideStore() {
  return { consume: () => false, peek: () => null, list: () => ({}) }
}

function buildHierarchy(rules: KeelRule[]): RuleHierarchy {
  return {
    global: null,
    user: null,
    local: null,
    project: {
      config: { version: 1, level: 'balanced' as ProtectionLevel, rules },
      rules,
      sourcePath: join(scratchRoot, 'nonexistent-rules.yaml'),
      version: 1,
      markdown: '',
    },
  }
}

function buildPipeline(rules: KeelRule[]): EnforcementPipeline {
  const config: PipelineConfig = {
    level: 'balanced',
    context: 'local' as RuleContext,
    cache: new ActionCache({ maxSize: 1000 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: buildHierarchy(rules),
    ruleVersion: 1,
    allowedFixTransforms: true,
    disableFile: join(scratchRoot, 'DISABLED-unused'),
    stateManager: new StateManager(stateDir),
    overrideStore: stubOverrideStore(),
  }
  return new EnforcementPipeline(config)
}

function input(tool: string, args: Record<string, unknown>, turn: number): EnforceInput {
  return {
    tool,
    args,
    cwd: scratchRoot,
    session_id: 'perf-budget-regression',
    turn_number: turn,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'keel-perf-regression-test',
    subagent_of: null,
  }
}

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1)
  return sortedMs[Math.max(0, idx)]
}

async function measureP99(pipeline: EnforcementPipeline, calls: Array<{ tool: string; args: Record<string, unknown> }>, warmup: number): Promise<number> {
  let turn = 0
  for (let i = 0; i < warmup; i++) {
    const c = calls[i % calls.length]
    await pipeline.evaluate(input(c.tool, c.args, ++turn))
  }
  const ms: number[] = []
  for (let i = warmup; i < calls.length; i++) {
    const c = calls[i % calls.length]
    const t0 = process.hrtime.bigint()
    await pipeline.evaluate(input(c.tool, c.args, ++turn))
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  ms.sort((a, b) => a - b)
  return percentile(ms, 99)
}

// A handful of varied benign Bash commands — the modal case, no rule
// matches, but every rule still gets checked. Kept under 30 total calls
// (across warmup + measured, see below) so the shipped bash-rate-limit
// rule's own 30-calls/60s cap never trips mid-measurement and short-
// circuits later calls cheaper than the true full-tier cost this test
// wants to catch a regression in.
const BENIGN_BASH = [
  { tool: 'Bash', args: { command: 'git status' } },
  { tool: 'Bash', args: { command: 'ls -la src' } },
  { tool: 'Bash', args: { command: 'cat package.json' } },
  { tool: 'Bash', args: { command: 'git log -5 --oneline' } },
  { tool: 'Bash', args: { command: 'node --version' } },
]

beforeAll(() => {
  // Isolation: never the operator's real ~/.keel — see stubOverrideStore()'s
  // comment above for exactly which default-constructed collaborators this
  // guards (PackageVerifierCache, FileRuleOverrideStore), mirroring
  // fixture-harness.test.ts's own beforeAll in this same directory.
  stateDir = mkdtempSync(join(tmpdir(), 'keel-perf-state-'))
  scratchRoot = mkdtempSync(join(tmpdir(), 'keel-perf-scratch-'))
  process.env.KEEL_STATE_DIR = stateDir
  process.env.KEEL_OVERRIDES_DIR = join(scratchRoot, 'overrides-unused')
})

afterAll(() => {
  delete process.env.KEEL_STATE_DIR
  delete process.env.KEEL_OVERRIDES_DIR
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(scratchRoot, { recursive: true, force: true })
})

describe('A4 perf budget: EnforcementPipeline.evaluate() vs the <50ms hot-path claim', () => {
  it('p99 for a benign Bash call against the shipped default ruleset stays under 50ms (best-of-3, skip-guarded on a loaded machine)', async ({ skip }) => {
    const rules = loadDefaultRules()

    const LOAD_PER_CORE_SKIP = 1.5
    const cores = cpus().length || 1
    const loadPerCore = loadavg()[0] / cores
    if (loadPerCore > LOAD_PER_CORE_SKIP) {
      // A bare `return` here would report as PASSED (vitest treats a
      // resolved test body with no failed assertion as green) — that is a
      // gate that cannot fail on exactly the loaded box it exists to guard
      // against, which defeats the point of having it. `skip()` reports
      // this run as SKIPPED, not PASSED, so a reporter/CI summary shows
      // the true state honestly instead of a silent pass.
      skip(
        `1-min load average is ${loadavg()[0].toFixed(1)} across ${cores} cores `
        + `(${loadPerCore.toFixed(2)}/core, threshold ${LOAD_PER_CORE_SKIP}/core) — this machine is too `
        + `loaded right now to measure the <50ms claim reliably (see a4-perf.md's live load-average `
        + `evidence for why this guard exists, not a hypothetical).`,
      )
      return
    }

    const ATTEMPTS = 3
    const attemptP99s: number[] = []
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const rulesPipeline = buildPipeline(rules)
      // 5 warmup + 20 measured = 25 total Bash calls on one pipeline
      // instance per attempt, safely under the shipped bash-rate-limit
      // rule's 30-calls/60s cap (a fresh pipeline each attempt, so the
      // cap never carries over between attempts either).
      const calls = Array.from({ length: 25 }, (_, i) => BENIGN_BASH[i % BENIGN_BASH.length])
      attemptP99s.push(await measureP99(rulesPipeline, calls, 5))
    }
    const defaultRulesetP99 = Math.min(...attemptP99s)

    console.log(
      `[perf-budget] ${rules.length}-rule default ruleset p99 across ${ATTEMPTS} attempts: `
      + `[${attemptP99s.map(v => v.toFixed(3)).join(', ')}]ms — best=${defaultRulesetP99.toFixed(3)}ms `
      + `(load ${loadavg()[0].toFixed(1)}/${cores} cores)`,
    )

    expect(
      defaultRulesetP99,
      `Best-of-${ATTEMPTS} p99 evaluate() latency for a benign Bash call against the ${rules.length}-rule `
      + `default ruleset was ${defaultRulesetP99.toFixed(3)}ms across attempts `
      + `[${attemptP99s.map(v => v.toFixed(2)).join(', ')}] — over the 50ms hot-path budget on every `
      + `attempt, at a load average of ${loadavg()[0].toFixed(1)}/${cores} cores (under the `
      + `${LOAD_PER_CORE_SKIP}/core skip threshold, so this machine was not the cause).`,
    ).toBeLessThan(50)
  })

  it('DEFAULT_RULES_YAML is still extractable from install.ts (guards the extraction regex itself, not a perf assertion)', () => {
    expect(existsSync(INSTALL_SRC)).toBe(true)
    const rules = loadDefaultRules()
    expect(rules.length).toBeGreaterThan(10)
  })
})
