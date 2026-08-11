/**
 * scripts/perf/bench.mjs — A4 performance-budget lane.
 *
 * Measures wall-clock latency of the REAL `EnforcementPipeline.evaluate()`
 * (packages/core/src/enforce/pipeline.ts, built @get-keel/core — never
 * re-implemented here) against the shipped default ruleset
 * (`DEFAULT_RULES_YAML` in packages/cli/src/commands/install.ts), across a
 * representative corpus of tool calls. Reports p50/p90/p99 overall and a
 * breakdown by which tier/rule fired, so a supervisor can check the <50ms
 * hot-path claim honestly.
 *
 * This is a MEASUREMENT tool. It never edits pipeline.ts/rule-parser.ts/
 * types.ts — every finding below about what's expensive is a note for
 * whichever lane owns those files, not a fix landed here.
 *
 * Isolation: KEEL_STATE_DIR / KEEL_TRACES_DIR / KEEL_OVERRIDES_DIR are all
 * pointed at a fresh mkdtemp() directory before ANYTHING from @get-keel/core
 * is imported or constructed — never the operator's real ~/.keel. The
 * network-touching `unverified-package-install` rule (type: package) is
 * measured with `packageVerifierFetch` mocked (deterministic, no network),
 * plus one separate, clearly-labeled case that mocks a registry TIMEOUT to
 * show what a real cache-miss network stall costs against the 2000ms budget
 * `pipeline.ts` hardcodes for that lookup.
 *
 * Run: node scripts/perf/bench.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── Isolation FIRST — before importing @get-keel/core, which reads these
// env vars at CALL time (not module load) but we still want to never race
// a real ~/.keel path for even one construction. ──
const runRoot = mkdtempSync(join(tmpdir(), 'keel-perf-bench-'))
process.env.KEEL_STATE_DIR = join(runRoot, 'state')
process.env.KEEL_TRACES_DIR = join(runRoot, 'traces')
process.env.KEEL_OVERRIDES_DIR = join(runRoot, 'overrides')
// Defense in depth: even though every package-rule call in this bench
// passes an explicit `packageVerifierFetch` mock, point the real-registry
// fallback at a closed loopback port too, so a coding mistake here fails
// fast (ECONNREFUSED) instead of making a live network call.
process.env.KEEL_NPM_REGISTRY = 'http://127.0.0.1:1'

const {
  EnforcementPipeline,
  ActionCache,
  ContentTracker,
  SequenceDetector,
  FlowTracker,
  StuckTracker,
  ResearchTracker,
  ProblemLedger,
  StateManager,
  parseRulesContent,
} = await import('@get-keel/core')

// ── Extract the shipped default ruleset — same technique as
// packages/cli/src/__tests__/fixture-harness.test.ts's loadDefaultRules():
// read DEFAULT_RULES_YAML straight off install.ts's source rather than
// hand-copying it, so the bench never drifts from what actually ships. ──
const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const INSTALL_SRC = join(REPO_ROOT, 'packages', 'cli', 'src', 'commands', 'install.ts')

function loadDefaultRules() {
  const src = readFileSync(INSTALL_SRC, 'utf-8')
  const m = src.match(/DEFAULT_RULES_YAML = `([\s\S]*?)`\n/)
  if (!m) throw new Error('DEFAULT_RULES_YAML not found in install.ts — has it moved?')
  const parsed = parseRulesContent(m[1], INSTALL_SRC)
  if (parsed.errors) throw new Error(`DEFAULT_RULES_YAML failed to parse: ${parsed.errors.join('; ')}`)
  if (!parsed.rules.length) throw new Error('DEFAULT_RULES_YAML parsed to zero rules')
  return parsed.rules
}

const DEFAULT_RULES = loadDefaultRules()
console.log(`Loaded ${DEFAULT_RULES.length} rules from the shipped default ruleset (${INSTALL_SRC}).`)

// ── Mocked npm-registry fetch — the network path, short-circuited ──
//
// Deterministic verdicts by package-name pattern, matching the semantics
// documented in package-verifier.ts. `fetchJsonCapped` only inspects
// `res.ok` / `res.status` / `res.body` (falls back to `res.json()` when
// `res.body` has no `getReader`), so a plain object satisfies it without
// needing a real Response/stream.
function fastRegistryResponse(name) {
  if (name.includes('hallucinated')) return { ok: false, status: 404 }
  if (name.includes('young')) {
    return { ok: true, status: 200, json: async () => ({ time: { created: new Date(Date.now() - 3 * 86_400_000).toISOString() } }) }
  }
  // default: exists, published years ago
  return { ok: true, status: 200, json: async () => ({ time: { created: '2018-01-01T00:00:00.000Z' } }) }
}

/** @type {typeof fetch} */
const mockFetchFast = async (url) => {
  const u = new URL(String(url))
  if (u.pathname.startsWith('/-/v1/search')) return { ok: true, status: 200, json: async () => ({ objects: [] }) }
  const name = decodeURIComponent(u.pathname.replace(/^\//, ''))
  return fastRegistryResponse(name)
}

/** Never resolves until the caller's AbortController fires — simulates a real registry hang/timeout. */
const mockFetchTimeout = async (url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })

// ── Pipeline construction — mirrors packages/cli/src/commands/enforce.ts's
// initEnforce() and packages/opencode-plugin/src/plugin.ts's real wiring
// (StateManager + real FileRuleOverrideStore + StuckTracker +
// ResearchTracker + ProblemLedger), NOT the lighter stub construction
// fixture-harness.test.ts uses for per-rule isolation tests — the whole
// point of this bench is to catch real I/O side effects those hosts pay on
// every call, which a stubbed override store or missing StateManager would
// hide. ──
let categoryCounter = 0
function buildPipeline(rules, fetchImpl = mockFetchFast) {
  categoryCounter += 1
  const scratch = join(runRoot, `cat-${categoryCounter}`)
  const hierarchy = {
    global: null,
    user: null,
    local: null,
    project: { config: { version: 1, level: 'balanced', rules }, rules, sourcePath: join(scratch, 'nonexistent-rules.yaml'), version: 1, markdown: '' },
  }
  return new EnforcementPipeline({
    level: 'balanced',
    context: 'local',
    cache: new ActionCache({ maxSize: 1000 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    ruleHierarchy: hierarchy,
    ruleVersion: 1,
    allowedFixTransforms: true,
    disableFile: join(scratch, 'DISABLED-unused'),
    // Real disk-backed collaborators, isolated per-category via the env
    // vars set above plus a fresh StateManager pointed at this category's
    // own scratch dir (so no category's rate/deny-ladder state leaks into
    // another's measurement).
    stateManager: new StateManager(join(scratch, 'state')),
    // No explicit overrideStore: the pipeline's own default construction
    // (`new FileRuleOverrideStore()`, see pipeline.ts's constructor) is
    // what real hosts get too, and it already isolates via the
    // KEEL_OVERRIDES_DIR env var set at the top of this file —
    // FileRuleOverrideStore itself isn't part of @get-keel/core's public
    // export surface, so this bench measures it exactly as any consumer
    // of the package would: through the default, not a direct import.
    stuckTracker: new StuckTracker(),
    researchTracker: new ResearchTracker(),
    ledger: new ProblemLedger(join(scratch, 'ledger.json')),
    packageVerifierFetch: fetchImpl,
  })
}

function input(tool, args, sessionId, turn) {
  return {
    tool,
    args,
    cwd: runRoot,
    session_id: sessionId,
    turn_number: turn,
    context_tokens: 0,
    level: 'balanced',
    context: 'local',
    agent: 'keel-perf-bench',
    subagent_of: null,
  }
}

// ── Timing ──

function nowNs() { return process.hrtime.bigint() }
function msSince(startNs) { return Number(process.hrtime.bigint() - startNs) / 1e6 }

function percentile(sortedMs, p) {
  if (!sortedMs.length) return NaN
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1)
  return sortedMs[Math.max(0, idx)]
}

function stats(samples) {
  const ms = samples.map(s => s.ms).slice().sort((a, b) => a - b)
  return {
    n: ms.length,
    min: ms[0],
    p50: percentile(ms, 50),
    p90: percentile(ms, 90),
    p99: percentile(ms, 99),
    max: ms[ms.length - 1],
    mean: ms.reduce((a, b) => a + b, 0) / ms.length,
  }
}

/**
 * Run one category against a FRESH pipeline (fresh StateManager/override
 * store/scratch dir too) so no category's stateful side effects (the
 * warn-then-deny ladder, bash-rate-limit's counter, PackageVerifierCache)
 * contaminate another's numbers. `warmup` calls run first and are excluded
 * from stats (JIT warm-up), on the SAME pipeline instance so they still
 * pay any ladder/first-warning cost before the timed run starts.
 */
async function runCategory(name, { rules = DEFAULT_RULES, fetchImpl, warmup = 3, reps, makeCall }) {
  const pipeline = buildPipeline(rules, fetchImpl)
  const sessionId = `perf-${name}`
  let turn = 0
  for (let i = 0; i < warmup; i++) {
    const { tool, args } = makeCall(i)
    await pipeline.evaluate(input(tool, args, sessionId, ++turn))
  }
  const samples = []
  for (let i = 0; i < reps; i++) {
    const { tool, args } = makeCall(warmup + i)
    const t0 = nowNs()
    const cpu0 = process.cpuUsage()
    const result = await pipeline.evaluate(input(tool, args, sessionId, ++turn))
    const ms = msSince(t0)
    // CPU time (user+sys), NOT wall clock — the only metric in this bench
    // that stays meaningful when the host is under heavy scheduling
    // contention (a preempted process burns zero CPU while waiting for a
    // timeslice, so cpuUsage() deltas are unaffected by contention that
    // wall-clock hrtime() cannot distinguish from real added cost). See
    // a4-perf.md's file-lock-merge addendum for why this got added mid-lane.
    const cpuDelta = process.cpuUsage(cpu0)
    const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000
    samples.push({ ms, cpuMs, tier: result.tier, rule_id: result.rule_id || null, action: result.action, observed_action: result.observed_action || null })
  }
  return { name, samples, stats: stats(samples), cpuStats: stats(samples.map(s => ({ ms: s.cpuMs }))) }
}

// ── Corpus ──

const BENIGN_BASH_CMDS = [
  'git status', 'ls -la src', 'cat package.json', 'git log -5 --oneline',
  'grep -rn "TODO" src', 'npm run build', 'node --version', 'pwd',
  'git diff --stat', 'find . -name "*.ts" -maxdepth 2',
]

function benignWriteContent(i) {
  return `export function helper${i}(x: number): number {\n  // a realistic small function body, no secrets\n  const y = x * 2 + ${i}\n  return y > 0 ? y : -y\n}\n`
}

const categories = [
  {
    name: 'benign-bash',
    label: 'Benign Bash (no rule matches)',
    reps: 25, // stays under bash-rate-limit's 30-calls/60s cap so every rep pays the FULL uncapped tier-matching cost
    makeCall: i => ({ tool: 'Bash', args: { command: BENIGN_BASH_CMDS[i % BENIGN_BASH_CMDS.length] } }),
  },
  {
    name: 'benign-write',
    label: 'Benign Write (content-scan tier, no match)',
    reps: 200,
    makeCall: i => ({ tool: 'Write', args: { path: `src/file-${i}.ts`, content: benignWriteContent(i) } }),
  },
  {
    name: 'benign-read',
    label: 'Benign Read',
    reps: 150,
    makeCall: i => ({ tool: 'Read', args: { path: `src/file-${i}.ts` } }),
  },
  {
    name: 'blocked-rm-rf',
    label: 'Blocked: rm -rf / (protect floor, deny)',
    reps: 60,
    makeCall: () => ({ tool: 'Bash', args: { command: 'rm -rf /' } }),
  },
  {
    name: 'force-push',
    label: 'Blocked: git push --force origin main (protect floor, deny)',
    reps: 60,
    makeCall: () => ({ tool: 'Bash', args: { command: 'git push --force origin main' } }),
  },
  {
    name: 'fs-write-outside-project',
    label: 'Gated: write to /etc/hosts (filesystem rule, prompt)',
    reps: 100,
    makeCall: () => ({ tool: 'Write', args: { path: '/etc/hosts', content: '127.0.0.1 localhost' } }),
  },
  {
    name: 'content-secret-hit',
    label: 'Blocked: hardcoded AWS key literal (content-scan tier, deny)',
    reps: 100,
    makeCall: i => ({ tool: 'Write', args: { path: `src/config-${i}.ts`, content: 'const key = "AKIAABCDEFGHIJKLMNOP"' } }),
  },
  {
    name: 'package-verified-miss',
    label: 'Package install, verified/old (mocked fetch, cache MISS every call)',
    reps: 25,
    makeCall: i => ({ tool: 'Bash', args: { command: `npm install real-package-${i}` } }),
  },
  {
    name: 'package-hallucinated',
    label: 'Package install, hallucinated name (mocked 404, deny)',
    reps: 25,
    makeCall: i => ({ tool: 'Bash', args: { command: `npm install totally-hallucinated-package-${i}` } }),
  },
  {
    name: 'package-cache-hit',
    label: 'Package install, SAME name repeated (first = cache miss, rest = cache hit)',
    reps: 26,
    makeCall: () => ({ tool: 'Bash', args: { command: 'npm install lodash' } }),
    warmup: 0,
  },
]

// A dedicated category to observe the bash-rate-limit cap transition
// (>30 Bash calls in 60s -> warn + early short-circuit) — informational,
// deliberately NOT part of the main weighted aggregate below.
const bashBurst = {
  name: 'bash-burst-60',
  label: 'Sustained Bash burst (60 calls, same pipeline — shows the 30-call/60s rate-limit cap transition)',
  reps: 60,
  warmup: 0,
  makeCall: i => ({ tool: 'Bash', args: { command: BENIGN_BASH_CMDS[i % BENIGN_BASH_CMDS.length] } }),
}

async function main() {
  const results = new Map()

  for (const c of categories) {
    const r = await runCategory(c.name, { reps: c.reps, warmup: c.warmup ?? 3, makeCall: c.makeCall })
    results.set(c.name, { ...r, label: c.label })
  }

  const burstResult = await runCategory(bashBurst.name, { reps: bashBurst.reps, warmup: 0, makeCall: bashBurst.makeCall })

  // ── Dedicated risk case: a network-mocked TIMEOUT on the package rule.
  // pipeline.ts hardcodes totalTimeoutMs: 2000 for checkPackages() — this
  // is NOT part of the aggregate; it exists to measure that hardcoded
  // budget's real cost when the registry is slow/unreachable and nothing
  // is cached yet. ──
  console.log('\nMeasuring mocked-timeout package lookup (this deliberately takes ~2s, run 2x)...')
  const timeoutSamples = []
  for (let i = 0; i < 2; i++) {
    const pipeline = buildPipeline(DEFAULT_RULES, mockFetchTimeout)
    const t0 = nowNs()
    const result = await pipeline.evaluate(input('Bash', { command: `npm install slow-unreachable-registry-package-${i}` }, `perf-timeout-${i}`, 1))
    timeoutSamples.push({ ms: msSince(t0), action: result.action, rule_id: result.rule_id })
  }

  // ── Weighted "representative overall" aggregate ──
  //
  // A real coding session is dominated by benign calls; blocked/gated
  // calls are comparatively rare. Weights below are an explicit editorial
  // choice (documented, not hidden) approximating that mix — NOT a claim
  // about real-world frequency data, which this bench has no access to.
  const weights = {
    'benign-bash': 30,
    'benign-write': 25,
    'benign-read': 20,
    'blocked-rm-rf': 3,
    'force-push': 3,
    'fs-write-outside-project': 5,
    'content-secret-hit': 5,
    'package-verified-miss': 5,
    'package-hallucinated': 2,
    'package-cache-hit': 2,
  }
  const overallPool = []
  for (const [name, weight] of Object.entries(weights)) {
    const cat = results.get(name)
    const take = weight * 10
    for (let i = 0; i < take; i++) overallPool.push(cat.samples[i % cat.samples.length])
  }
  const overallStats = stats(overallPool)
  const overallCpuStats = stats(overallPool.map(s => ({ ms: s.cpuMs })))

  // ── Breakdown by tier across the weighted pool ──
  const byTier = new Map()
  for (const s of overallPool) {
    const key = s.tier ?? 'unknown'
    if (!byTier.has(key)) byTier.set(key, [])
    byTier.get(key).push(s)
  }
  const tierBreakdown = [...byTier.entries()]
    .map(([tier, samples]) => ({ tier, ...stats(samples), share: (samples.length / overallPool.length * 100).toFixed(1) + '%' }))
    .sort((a, b) => b.n - a.n)

  // ── Breakdown by rule_id (which rule dominates, when one fired) ──
  const byRule = new Map()
  for (const s of overallPool) {
    const key = s.rule_id ?? '(no rule matched)'
    if (!byRule.has(key)) byRule.set(key, [])
    byRule.get(key).push(s)
  }
  const ruleBreakdown = [...byRule.entries()]
    .map(([rule_id, samples]) => ({ rule_id, ...stats(samples), share: (samples.length / overallPool.length * 100).toFixed(1) + '%' }))
    .sort((a, b) => b.n - a.n)

  // ── Report ──
  console.log('\n' + '='.repeat(78))
  console.log('KEEL A4 PERF BENCH — EnforcementPipeline.evaluate() over the default ruleset')
  console.log('='.repeat(78))

  console.log('\n-- Per-category (fresh pipeline per category; warm-up excluded) --')
  console.log(padRow(['category', 'n', 'p50 ms', 'p90 ms', 'p99 ms', 'max ms']))
  for (const c of categories) {
    const r = results.get(c.name)
    console.log(padRow([c.name, r.stats.n, r.stats.p50.toFixed(3), r.stats.p90.toFixed(3), r.stats.p99.toFixed(3), r.stats.max.toFixed(3)]))
  }

  console.log('\n-- Per-category CPU time (user+sys; contention-resistant, see cpuMs note) --')
  console.log(padRow(['category', 'n', 'p50 ms', 'p90 ms', 'p99 ms', 'max ms']))
  for (const c of categories) {
    const r = results.get(c.name)
    console.log(padRow([c.name, r.cpuStats.n, r.cpuStats.p50.toFixed(3), r.cpuStats.p90.toFixed(3), r.cpuStats.p99.toFixed(3), r.cpuStats.max.toFixed(3)]))
  }

  console.log('\n-- OVERALL (weighted representative corpus, n=' + overallStats.n + ') --')
  console.log(`p50=${overallStats.p50.toFixed(3)}ms  p90=${overallStats.p90.toFixed(3)}ms  p99=${overallStats.p99.toFixed(3)}ms  max=${overallStats.max.toFixed(3)}ms  mean=${overallStats.mean.toFixed(3)}ms`)
  console.log(`<50ms claim: ${overallStats.p99 < 50 ? 'HOLDS' : 'VIOLATED'} at p99 for this weighted corpus on this machine (wall clock).`)
  console.log(`CPU-time (contention-resistant) overall: p50=${overallCpuStats.p50.toFixed(3)}ms  p99=${overallCpuStats.p99.toFixed(3)}ms  max=${overallCpuStats.max.toFixed(3)}ms`)
  console.log(`<50ms claim by CPU time: ${overallCpuStats.p99 < 50 ? 'HOLDS' : 'VIOLATED'}.`)

  console.log('\n-- Breakdown by tier (weighted pool) --')
  console.log(padRow(['tier', 'n', 'share', 'p50 ms', 'p99 ms']))
  for (const t of tierBreakdown) {
    console.log(padRow([String(t.tier), t.n, t.share, t.p50.toFixed(3), t.p99.toFixed(3)]))
  }

  console.log('\n-- Breakdown by matched rule_id (weighted pool) --')
  console.log(padRow(['rule_id', 'n', 'share', 'p50 ms', 'p99 ms']))
  for (const t of ruleBreakdown) {
    console.log(padRow([t.rule_id, t.n, t.share, t.p50.toFixed(3), t.p99.toFixed(3)]))
  }

  console.log('\n-- bash-rate-limit cap transition (60 sustained Bash calls, one pipeline) --')
  const first30 = burstResult.samples.slice(0, 30)
  const rest = burstResult.samples.slice(30)
  console.log(`  calls 1-30 (pre-cap, full tier-matching cost):  p50=${stats(first30).p50.toFixed(3)}ms  p99=${stats(first30).p99.toFixed(3)}ms`)
  if (rest.length) {
    console.log(`  calls 31-60 (post-cap, rate rule short-circuits earlier): p50=${stats(rest).p50.toFixed(3)}ms  p99=${stats(rest).p99.toFixed(3)}ms`)
    console.log(`  call 31 action/rule: ${rest[0].action} / ${rest[0].rule_id}`)
  }

  console.log('\n-- Package rule: mocked registry TIMEOUT (risk case, NOT in aggregate) --')
  for (const s of timeoutSamples) {
    console.log(`  ${s.ms.toFixed(1)}ms — action=${s.action} rule_id=${s.rule_id}`)
  }
  console.log('  pipeline.ts hardcodes a 2000ms total lookup budget for this rule; a cold')
  console.log('  cache-miss against a slow/unreachable registry pays close to the full')
  console.log('  budget, ~40-100x over the <50ms hot-path claim, on the exact call that')
  console.log('  triggers it (npm/pnpm/yarn/bun add of an uncached package name).')

  // ── Machine-readable dump ──
  const outPath = join(REPO_ROOT, 'scripts', 'perf', 'last-run.json')
  const dump = {
    generated_at: new Date().toISOString(),
    node_version: process.version,
    platform: process.platform,
    rule_count: DEFAULT_RULES.length,
    per_category: categories.map(c => ({ name: c.name, label: c.label, stats: results.get(c.name).stats, cpu_stats: results.get(c.name).cpuStats })),
    overall: overallStats,
    overall_cpu: overallCpuStats,
    by_tier: tierBreakdown,
    by_rule: ruleBreakdown,
    bash_burst: { first30: stats(first30), rest: rest.length ? stats(rest) : null },
    package_timeout_ms: timeoutSamples.map(s => s.ms),
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(outPath, JSON.stringify(dump, null, 2))
  console.log(`\nMachine-readable results written to ${outPath}`)

  rmSync(runRoot, { recursive: true, force: true })
}

function padRow(cells, widths = [34, 8, 10, 10, 10, 10]) {
  return cells.map((c, i) => String(c).padEnd(widths[i] ?? 10)).join('')
}

await main()
