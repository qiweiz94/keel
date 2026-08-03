import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'
import { loadRuleHierarchy, mergeRules, validateRules } from '../core/enforce/rule-parser.js'
import { FileRuleOverrideStore } from '../core/enforce/overrides.js'
import { writeRulesLevel } from './level.js'
import type { ProtectionLevel } from '../core/types.js'

/**
 * `keel dashboard` — an interactive terminal panel for the dial and the
 * enforcement state the user owns. Runs on a TTY only: the level switches
 * require a human at the keyboard, which structurally keeps them out of an
 * agent's reach (unlike a localhost web UI, which an agent could curl).
 *
 *   [1/2/3] switch the dial   [p] target global/project   [r] refresh   [q] quit
 *
 * Non-interactive modes for scripts and CI:
 *   keel dashboard --once    print the panel once and exit
 *   keel dashboard --json    dump the state as JSON
 */

const VALID_LEVELS: ProtectionLevel[] = ['sprint', 'balanced', 'protect']

interface DashboardState {
  dir: string
  dial: ProtectionLevel
  dialGlobal: ProtectionLevel | null
  dialProject: ProtectionLevel | null
  killSwitch: { state: 'disabled' | 'enabled' | 'corrupt'; expires_at?: string; reason?: string }
  overrides: Array<{ id: string; mode: string; minutes_left: number }>
  expiredOverrides: number
  rules: Array<{ scope: string; count: number; issues: number; source: string }>
  active: number
  total: number
  blocks: Array<{ t: string; tool: string; rule_id: string; action: string }>
  pluginInstalled: boolean
}

export function collectState(dir: string, home: string): DashboardState {
  const hierarchy = loadRuleHierarchy(dir)
  const dialProject = hierarchy.project?.config?.level ?? null
  const dialGlobal = hierarchy.global?.config?.level ?? null
  const dial = dialProject || dialGlobal || 'balanced'

  let killSwitch: DashboardState['killSwitch'] = { state: 'enabled' }
  const disableFile = join(home, '.keel', 'DISABLED')
  if (existsSync(disableFile)) {
    try {
      const state = JSON.parse(readFileSync(disableFile, 'utf8'))
      killSwitch = { state: 'disabled', expires_at: state.expires_at, reason: state.reason }
    } catch {
      killSwitch = { state: 'corrupt' }
    }
  }

  const store = new FileRuleOverrideStore(home)
  const all = store.list()
  const armed = Object.entries(all).filter(([, o]) => o.expires_at > Date.now())
  const expiredCount = Object.entries(all).filter(([, o]) => o.expires_at <= Date.now()).length

  const scopes = [
    ['global', hierarchy.global],
    ['legacy', hierarchy.user],
    ['project', hierarchy.project],
    ['local', hierarchy.local],
  ] as const
  const rules: DashboardState['rules'] = []
  let total = 0
  for (const [name, scope] of scopes) {
    if (!scope) continue
    const issues = [...(scope.errors || []), ...validateRules(scope.rules)]
    total += scope.rules.length
    rules.push({ scope: name, count: scope.rules.length, issues: issues.length, source: scope.sourcePath })
  }
  const active = mergeRules(hierarchy, dial, 'local').length

  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const blocks: DashboardState['blocks'] = []
  for (const file of [join(home, '.keel', 'traces', `${today}.jsonl`), join(home, '.keel', 'traces', `${yesterday}.jsonl`)]) {
    try {
      if (!existsSync(file)) continue
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0 && blocks.length < 5; i--) {
        try {
          const entry = JSON.parse(lines[i])
          if (['deny', 'block', 'prompt'].includes(entry.action)) {
            blocks.push({ t: entry.t, tool: entry.tool, rule_id: entry.rule_id, action: entry.action })
          }
        } catch {}
      }
    } catch {}
  }

  return {
    dir,
    dial,
    dialGlobal,
    dialProject,
    killSwitch,
    overrides: armed.map(([id, o]) => ({
      id,
      mode: o.mode === 'window' ? 'window' : 'once',
      minutes_left: Math.max(0, Math.round((o.expires_at - Date.now()) / 60000)),
    })),
    expiredOverrides: expiredCount,
    rules,
    active,
    total,
    blocks,
    pluginInstalled: existsSync(join(home, '.opencode', 'plugins', 'keel-enforce.js')),
  }
}

function dialLabel(level: ProtectionLevel | null): string {
  if (!level) return chalk.dim('—')
  const color = level === 'sprint' ? chalk.yellow : level === 'protect' ? chalk.red : chalk.green
  return color(level.toUpperCase())
}

function renderPanel(state: DashboardState, target: 'global' | 'project'): string {
  const out: string[] = []
  out.push(chalk.bold.cyan('\n  ⚓ keel dashboard'))
  out.push('')
  out.push(`  ${chalk.dim('Global dial:')} ${dialLabel(state.dialGlobal)}${state.dialGlobal === null ? chalk.dim(' (not set — defaults to balanced)') : ''}  ${chalk.dim('Project dial:')} ${dialLabel(state.dialProject)}${state.dialProject === null ? chalk.dim(' (not set)') : ''}`)
  out.push(chalk.dim(`  Target: ${chalk.white(target.toUpperCase())}   (press p to switch)`))
  out.push('')
  out.push(`  ${chalk.dim('Speed dial:')} ${dialLabel(state.dial)} ${chalk.dim('(sprint=warn-only · balanced=warn-then-block · protect=block-first)')}`)
  if (state.killSwitch.state === 'disabled') {
    const expires = state.killSwitch.expires_at ? ` until ${new Date(state.killSwitch.expires_at).toLocaleString()}` : ' (until restart)'
    out.push(`  ${chalk.dim('Kill switch:')} ${chalk.red('DISABLED')}${chalk.dim(`${expires} — ${state.killSwitch.reason || 'no reason'}`)}`)
  } else if (state.killSwitch.state === 'corrupt') {
    out.push(`  ${chalk.dim('Kill switch:')} ${chalk.red('DISABLED (corrupt sentinel — enforcement stays ON until fixed)')}`)
  } else {
    out.push(`  ${chalk.dim('Kill switch:')} ${chalk.green('enabled (enforcement active)')}`)
  }
  if (state.overrides.length) {
    out.push(`  ${chalk.dim('Overrides:')} ${chalk.yellow(state.overrides.length.toString())} armed — ${state.overrides.map(o => `${o.id} (${o.mode}, ${o.minutes_left}min)`).join(', ')}`)
  } else {
    out.push(`  ${chalk.dim('Overrides:')} none armed${state.expiredOverrides ? chalk.dim(` (${state.expiredOverrides} expired — cleared on next match)`) : ''}`)
  }
  for (const r of state.rules) {
    const badge = r.issues ? chalk.red(`⚠ ${r.issues} issue(s)`) : chalk.green(`${r.count} rules`)
    out.push(`  ${chalk.dim(`Rules (${r.scope}):`)} ${badge}${chalk.dim(` — ${r.source}`)}`)
  }
  out.push(`  ${chalk.dim('Active at current dial:')} ${chalk.white(state.active.toString())} of ${state.total}`)
  out.push('')
  if (state.blocks.length) {
    out.push(chalk.dim('  Recent blocks:'))
    for (const b of state.blocks) {
      const time = b.t ? new Date(b.t).toLocaleTimeString() : '?'
      out.push(`    ${chalk.dim(time)} ${chalk.red(`[${b.action}]`)} ${chalk.dim(b.tool)} (${b.rule_id})`)
    }
  } else {
    out.push(chalk.dim('  Recent blocks: none'))
  }
  out.push(chalk.dim(`  OpenCode plugin: ${state.pluginInstalled ? chalk.green('installed') : chalk.yellow('not installed — run keel install --opencode')}`))
  return out.join('\n')
}

export function switchLevel(target: 'global' | 'project', level: ProtectionLevel): { ok: boolean; message: string } {
  const home = homedir()
  const path = target === 'global' ? join(home, '.keel', 'rules.yaml') : join(process.cwd(), '.keel', 'rules.yaml')
  if (!existsSync(path)) {
    return { ok: false, message: target === 'global' ? 'No global rules file — run `keel install` first.' : 'No project rules file in this directory.' }
  }
  try {
    writeRulesLevel(path, level)
    return { ok: true, message: `${target} dial → ${level.toUpperCase()}` }
  } catch (err) {
    return { ok: false, message: `Failed to write level: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function dashboardCommand(options: { once?: boolean; json?: boolean } = {}) {
  const home = homedir()
  const dir = process.cwd()

  if (options.json) {
    const state = collectState(dir, home)
    console.log(JSON.stringify(state, null, 2))
    return
  }

  if (options.once || !process.stdin.isTTY) {
    const state = collectState(dir, home)
    console.log(renderPanel(state, 'global'))
    console.log(chalk.dim('  Change with: keel level sprint|balanced|protect [--project]  |  dashboard: run `keel dashboard` in a terminal'))
    console.log()
    return
  }

  // ── Interactive TUI ──
  let target: 'global' | 'project' = 'global'
  let statusLine = ''
  let statusColor: 'green' | 'red' = 'green'
  const render = () => {
    const state = collectState(dir, home)
    const panel = renderPanel(state, target)
    const legend = chalk.dim(`\n  [1] sprint  [2] balanced  [3] protect  [p] target: ${target.toUpperCase()}  [r] refresh  [q] quit`)
    const status = statusLine ? `\n  ${chalk[statusColor](statusLine)}` : ''
    process.stdout.write('\x1b[2J\x1b[H' + panel + legend + status + '\n')
  }

  const { emitKeypressEvents } = await import('node:readline')
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  const quit = () => {
    process.stdin.setRawMode(false)
    process.stdout.write('\n')
    process.exit(0)
  }
  process.on('SIGINT', quit)

  render()
  process.stdin.on('keypress', (str: string | null, key: { name: string; ctrl: boolean }) => {
    if (key?.name === 'q' || (key?.ctrl && key?.name === 'c')) return quit()
    if (key?.name === 'r') {
      statusLine = ''
      render()
      return
    }
    if (key?.name === 'p') {
      const projectRules = existsSync(join(dir, '.keel', 'rules.yaml'))
      target = target === 'global' && projectRules ? 'project' : 'global'
      statusLine = ''
      render()
      return
    }
    if (key?.name === '1' || key?.name === '2' || key?.name === '3') {
      const level = VALID_LEVELS[Number(key.name) - 1]
      const result = switchLevel(target, level)
      statusColor = result.ok ? 'green' : 'red'
      statusLine = result.message
      render()
      return
    }
  })
}
