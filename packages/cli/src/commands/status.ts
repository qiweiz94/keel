import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'
import { loadRuleHierarchy, mergeRules, validateRules } from '../core/enforce/rule-parser.js'
import { FileRuleOverrideStore } from '../core/enforce/overrides.js'
import { loadTraceEntries, TRACKED_AGENTS } from './retrospective.js'
import { telemetryHealth, type HealthState } from './health.js'
import { findTemplateSource } from './install.js'

const STATE_MARK: Record<HealthState, string> = {
  green: '✓', amber: '!', red: '✗', unknown: '?',
}

/**
 * Distinct rules across scopes, and which scopes are re-reads of a file
 * already counted.
 *
 * Summing `scope.rules.length` is wrong whenever two scopes resolve to the
 * same file — which happens for every user whose working directory is
 * their home directory, because the project lookup
 * (`<cwd>/.keel/rules.yaml`) is then literally the global path. That
 * reported "23 of 46" and implied half the rules were switched off.
 * `mergeRules` dedupes by id, so enforcement was never affected; the
 * status screen was.
 */
export function countDistinctRules(
  scopes: ReadonlyArray<readonly [string, { rules: Array<{ id: string }>; sourcePath: string } | null]>,
): { distinct: number; duplicatePaths: Set<string> } {
  const seenPaths = new Set<string>()
  const duplicatePaths = new Set<string>()
  const ids = new Set<string>()
  for (const [, scope] of scopes) {
    if (!scope) continue
    if (seenPaths.has(scope.sourcePath)) {
      duplicatePaths.add(scope.sourcePath)
      continue
    }
    seenPaths.add(scope.sourcePath)
    for (const rule of scope.rules) ids.add(rule.id)
  }
  return { distinct: ids.size, duplicatePaths }
}

function paintState(state: HealthState, text: string): string {
  if (state === 'green') return chalk.green(text)
  if (state === 'amber') return chalk.yellow(text)
  if (state === 'red') return chalk.red(text)
  return chalk.dim(text)
}

/**
 * `keel status` — one screen showing the enforcement state the user owns:
 * the dial, the kill switch, armed overrides, rule counts, recent blocks,
 * and — most importantly — whether keel is actually receiving data.
 *
 * The telemetry section exists because configuration was always visible
 * while *flow* never was: `keel retrospective` reported zeros for days
 * because the loaded plugin wrote no exit codes, and nothing said so.
 */
export async function statusCommand() {
  const home = homedir()
  const dir = process.cwd()
  const today = new Date().toISOString().slice(0, 10)

  console.log(chalk.bold.cyan('\n  ⚓ keel status'))
  console.log()

  // ── Speed dial ──
  const hierarchy = loadRuleHierarchy(dir)
  const dial = hierarchy.project?.config?.level || hierarchy.global?.config?.level || 'balanced'
  const dialColor = dial === 'sprint' ? chalk.yellow : dial === 'protect' ? chalk.red : chalk.green
  console.log(chalk.dim('  Speed dial:') + ` ${dialColor(dial.toUpperCase())}${chalk.dim(' (sprint=warn-only · balanced=default · protect=block-first)')}`)
  console.log(chalk.dim('    Change: keel level sprint|balanced|protect [--project]'))

  // ── Kill switch ──
  const disableFile = join(home, '.keel', 'DISABLED')
  if (existsSync(disableFile)) {
    try {
      const state = JSON.parse(readFileSync(disableFile, 'utf8'))
      const expires = state.expires_at ? ` until ${new Date(state.expires_at).toLocaleString()}` : ' (until restart)'
      console.log(`  Kill switch: ${chalk.red('DISABLED')}${chalk.dim(`${expires} — ${state.reason || 'no reason'}`)}`)
      console.log(chalk.dim('    Re-enable: keel enable'))
    } catch {
      console.log(`  Kill switch: ${chalk.red('DISABLED (corrupt sentinel — enforcement stays ON until fixed)')}`)
      console.log(chalk.dim('    Fix: keel enable'))
    }
  } else {
    console.log(`  Kill switch: ${chalk.green('enabled (enforcement active)')}`)
  }

  // ── Armed overrides ──
  const store = new FileRuleOverrideStore(home)
  const overrides = store.list()
  const armed = Object.entries(overrides).filter(([, o]) => o.expires_at > Date.now())
  const expired = Object.entries(overrides).filter(([, o]) => o.expires_at <= Date.now())
  if (armed.length) {
    console.log(`  Overrides: ${chalk.yellow(armed.length.toString())} armed`)
    for (const [id, o] of armed) {
      const mode = o.mode === 'window' ? 'window (all violations until expiry)' : 'once (single use)'
      const remaining = Math.round((o.expires_at - Date.now()) / 60000)
      console.log(chalk.dim(`    • ${id} — ${mode} — ${remaining} min left`))
    }
  } else {
    console.log(`  Overrides: ${chalk.dim('none armed')}`)
  }
  if (expired.length) {
    console.log(chalk.dim(`    (${expired.length} expired — cleared on next match)`))
  }

  // ── Rule counts ──
  const scopes = [
    ['global', hierarchy.global],
    ['legacy', hierarchy.user],
    ['project', hierarchy.project],
    ['local', hierarchy.local],
  ] as const
  // Count DISTINCT rules, not the sum of scope sizes. When the working
  // directory is the home directory, the project lookup
  // (`<cwd>/.keel/rules.yaml`) resolves to the very same file as the
  // global one, so summing scopes double-counted every rule and reported
  // "23 of 46" — telling the user half their rules were inactive when in
  // fact all 23 were live. mergeRules dedupes by rule id, so enforcement
  // was always correct; only this screen lied, and this is the screen
  // people read to decide whether keel is working.
  const { distinct, duplicatePaths } = countDistinctRules(scopes)
  const counted = new Set<string>()
  let invalid = 0
  for (const [name, scope] of scopes) {
    if (!scope) continue
    const isRepeat = counted.has(scope.sourcePath)
    counted.add(scope.sourcePath)
    const issues = isRepeat ? [] : [...(scope.errors || []), ...validateRules(scope.rules)]
    invalid += issues.length
    const badge = issues.length ? chalk.red(`⚠ ${issues.length} issue(s)`) : chalk.green(`${scope.rules.length} rules`)
    const note = isRepeat && duplicatePaths.has(scope.sourcePath) ? chalk.dim(' (same file as above)') : ''
    console.log(chalk.dim(`  Rules (${name}):`) + ` ${badge}${chalk.dim(` — ${scope.sourcePath}`)}${note}`)
  }
  const active = mergeRules(hierarchy, dial, 'local').length
  console.log(chalk.dim(`  Active at current dial:`) + ` ${chalk.white(active.toString())} of ${distinct}${invalid ? chalk.red(` (${invalid} rule issue(s) — run keel validate)`) : ''}`)

  // ── Recent blocks ──
  const traceFile = join(home, '.keel', 'traces', `${today}.jsonl`)
  const blocks: Array<{ t: string; tool: string; rule_id: string; action: string; message: string }> = []
  for (const file of [traceFile, join(home, '.keel', 'traces', `${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}.jsonl`)]) {
    try {
      if (!existsSync(file)) continue
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0 && blocks.length < 5; i--) {
        try {
          const entry = JSON.parse(lines[i])
          // Only real agent traffic. The `keel evaluate` harness writes
          // fixture rules (strict-action, protect-only-level-inheritance-*)
          // with no timestamp, and they used to fill this panel with
          // "[deny] Bash (strict-action)" at time "?" — the one screen a
          // user checks to see whether keel is working, showing entries
          // from a test.
          if (!TRACKED_AGENTS.has(String(entry.agent))) continue
          if (['deny', 'block', 'prompt'].includes(entry.action)) blocks.push(entry)
        } catch {}
      }
    } catch {}
  }
  console.log()
  if (blocks.length) {
    console.log(chalk.dim('  Recent blocks:'))
    for (const b of blocks) {
      const time = b.t ? new Date(b.t).toLocaleTimeString() : '?'
      console.log(`    ${chalk.dim(time)} ${chalk.red(`[${b.action}]`)} ${chalk.dim(b.tool)} (${b.rule_id})`)
    }
  } else {
    console.log(chalk.dim('  Recent blocks: none'))
  }

  // ── Plugin ──
  const plugin = join(home, '.opencode', 'plugins', 'keel-enforce.js')
  if (existsSync(plugin)) {
    const installed = readFileSync(plugin)
    // Compare against the template `keel install --opencode` copies from,
    // resolved the same way install.ts resolves it — so a stale plugin is
    // visible rather than being reported as simply "installed".
    const source = await findTemplateSource('keel-enforce.js')
    let freshness = ''
    if (source) {
      const current = readFileSync(source)
      freshness = installed.equals(current)
        ? chalk.green(' · current')
        : chalk.yellow(' · STALE — run `keel install --opencode`, then restart OpenCode')
    }
    console.log(`  OpenCode plugin: ${chalk.green('installed')} (${(installed.length / 1024).toFixed(0)}kb)${freshness}`)
  } else {
    console.log(`  OpenCode plugin: ${chalk.yellow('not installed — run `keel install --opencode`')}`)
  }

  // ── Telemetry: is keel actually receiving data? ──
  console.log()
  console.log(chalk.dim('  Telemetry:'))
  // Bounded on purpose: `keel status` runs constantly, and the trace
  // corpus only grows (6 MB today). Health is a question about the recent
  // past, so a week of files answers it without re-parsing history on
  // every invocation.
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const entries = loadTraceEntries(join(home, '.keel', 'traces'), weekAgo)
  const health = telemetryHealth(entries, Date.now())
  for (const check of health) {
    const mark = paintState(check.state, STATE_MARK[check.state])
    console.log(`    ${mark} ${chalk.dim(check.label.padEnd(18))}${check.detail}`)
    if (check.fix) console.log(`      ${chalk.yellow('→')} ${chalk.dim(check.fix)}`)
  }
  if (health.some(c => c.state === 'red' || c.state === 'unknown')) {
    console.log()
    console.log(chalk.dim('    Metrics (`keel retrospective`) stay uninformative until these are green.'))
  }

  console.log()
}
