import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import chalk from 'chalk'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  parseRulesFile, validateRules, loadRuleHierarchy, mergeRules, dialAction,
  sprintExpiryStatus, effectiveHierarchyLevel, DEFAULT_SPRINT_EXPIRY_HOURS,
} from '../core/enforce/rule-parser.js'
import { resolveHome } from '../core/home.js'
import type { ProtectionLevel, KeelRule } from '../core/types.js'

const VALID_LEVELS: ProtectionLevel[] = ['sprint', 'balanced', 'protect']

const LEVEL_EFFECTS: Record<ProtectionLevel, string[]> = {
  sprint: [
    'deny/block rules are downgraded to warnings (least friction)',
    'fast depth: content, sequence, flow, and reasoning checks are skipped',
    'prompt approval gates still block irreversible operations',
    'rules marked `level: protect` are floors — never downgraded, never hidden',
  ],
  balanced: [
    'deny rules warn once, then block on repeat (default)',
    'full depth: content, sequence, and flow checks are enabled',
    'prompt approval gates still block irreversible operations',
    'rules marked `level: protect` are floors — never downgraded, never hidden',
  ],
  protect: [
    'deep depth: content, sequence, and flow checks plus reasoning checks are enabled',
    'deny rules block immediately after a first warning',
    'prompt approval gates still block irreversible operations',
    'rules marked `level: protect` are floors — never downgraded, never hidden',
  ],
}

/**
 * Rule `level` is a strictness hint, not a dial filter: every rule is active
 * at every dial. The dial softens enforcement globally (sprint downgrades
 * deny→block to warn via effectiveAction), and rules marked `level: protect`
 * are exempt from that downgrade — a floor that is never silently disabled
 * when the dial is low.
 */

/**
 * The "speed dial" — how much enforcement keel applies.
 *
 * `keel level`            — show the current level (global + project)
 * `keel level <level>`    — set the level in ~/.keel/rules.yaml (or the
 *                           project's .keel/rules.yaml with --project)
 *
 * The level is read live by the OpenCode plugin on every tool call, so the
 * change takes effect without a restart.
 */
export async function levelCommand(options: { project?: boolean }, levelArg?: string) {
  const home = resolveHome()
  const globalPath = join(home, '.keel', 'rules.yaml')
  const projectPath = join(process.cwd(), '.keel', 'rules.yaml')

  const targetPath = options.project ? projectPath : globalPath
  const targetName = options.project ? 'project' : 'global'

  console.log(chalk.bold.cyan('\n  ⚓ keel level'))

  if (!levelArg) {
    for (const [name, path] of [['global', globalPath], ['project', projectPath]] as const) {
      if (existsSync(path)) {
        const parsed = parseRulesFile(path)
        console.log(chalk.dim(`  ${name}:`) + chalk.white(` ${parsed?.config?.level || 'balanced'}`))
        const expiry = sprintExpiryStatus(parsed?.config)
        if (expiry?.expired) {
          console.log(chalk.yellow(`    sprint expired → balanced (set ${Math.round(expiry.hoursElapsed)} hours ago)`))
        }
      } else {
        console.log(chalk.dim(`  ${name}: not configured (${path})`))
      }
    }
    console.log(chalk.dim('\n  Set with: keel level sprint | balanced | protect [--project]'))
    console.log()
    return
  }

  if (!(VALID_LEVELS as string[]).includes(levelArg)) {
    console.log(chalk.red(`  Invalid level: "${levelArg}". Use sprint, balanced, or protect.`))
    return
  }
  const level = levelArg as ProtectionLevel

  if (!existsSync(targetPath)) {
    console.log(chalk.yellow(`  No ${targetName} rules file found: ${targetPath}`))
    console.log(chalk.cyan(options.project ? '  Run `keel enforce init` to create .keel/rules.yaml.' : '  Run `keel install` to create ~/.keel/rules.yaml.'))
    return
  }

  const parsed = parseRulesFile(targetPath)
  const issues = [...(parsed?.errors || []), ...validateRules(parsed?.rules || [])]
  if (issues.length) {
    console.log(chalk.red(`  Refusing to change level — current rules have issues:`))
    for (const issue of issues) console.log(chalk.yellow(`    ⚠ ${issue}`))
    return
  }

  const previous = parsed?.config?.level || 'balanced'
  const hierarchyBefore = loadRuleHierarchy(process.cwd())
  const effectiveBefore = effectiveHierarchyLevel(hierarchyBefore, 'balanced')

  writeRulesLevel(targetPath, level)
  console.log(chalk.green(`  ${targetName} level: ${chalk.white(previous)} → ${chalk.white(level)}`))
  console.log(chalk.dim(`  ${targetPath}`))
  console.log()
  for (const effect of LEVEL_EFFECTS[level]) {
    console.log(chalk.dim('  • ') + chalk.white(effect))
  }
  if (level === 'sprint') {
    console.log(chalk.dim(`  • sprint auto-reverts to balanced after ${DEFAULT_SPRINT_EXPIRY_HOURS}h unless \`sprint_expiry_hours\` overrides it (0 disables); check with \`keel status\``))
  }
  console.log(chalk.dim('\n  The plugin picks this up on the next tool call — no restart needed.'))

  // Dial transparency: what actually changes, derived from the real merged
  // ruleset and the real dialAction logic — not the LEVEL_EFFECTS prose
  // above, which only describes the dial in general terms. Reload after
  // the write so the diff reflects the rules that will actually be
  // evaluated next.
  const hierarchyAfter = loadRuleHierarchy(process.cwd())
  const effectiveAfter = effectiveHierarchyLevel(hierarchyAfter, 'balanced')
  if (targetName === 'global' && hierarchyAfter.project?.config?.level) {
    console.log()
    console.log(chalk.yellow(`  Note: the project level ("${hierarchyAfter.project.config.level}") overrides the global level — the effective dial is still ${chalk.white(effectiveAfter)}.`))
  }
  const diff = computeDialDiff(hierarchyAfter, effectiveBefore, effectiveAfter)
  printDialDiff(diff, effectiveBefore, effectiveAfter)
  console.log()
}

export interface DialDiff {
  /** Rule ids whose enforced action softens deny/block → warn under the new dial. */
  softened: string[]
  /** Rule ids whose enforced action hardens warn → deny/block under the new dial. */
  hardened: string[]
  /** Rule ids active before the switch that the new dial's `level` floor filters out entirely. */
  deactivated: string[]
  /** Rule ids the new dial newly activates. */
  activated: string[]
  /** `level: protect` floor rule ids present at both dials (sanity check: never in `softened`). */
  floors: string[]
}

/**
 * What switching the dial from `previous` to `level` actually changes,
 * computed from the REAL merged ruleset (mergeRules) and the REAL
 * effectiveAction logic (dialAction) — never hardcoded prose. `hierarchy`
 * should be the freshly reloaded hierarchy (post-write) so the diff
 * matches what the pipeline will evaluate on the very next call.
 */
export function computeDialDiff(
  hierarchy: import('../core/enforce/rule-parser.js').RuleHierarchy,
  previous: ProtectionLevel,
  level: ProtectionLevel,
): DialDiff {
  const before = new Map<string, KeelRule>(mergeRules(hierarchy, previous, 'local').map(r => [r.id, r]))
  const after = new Map<string, KeelRule>(mergeRules(hierarchy, level, 'local').map(r => [r.id, r]))

  const softened: string[] = []
  const hardened: string[] = []
  const deactivated: string[] = []
  const activated: string[] = []
  const floors: string[] = []

  for (const [id, rule] of before) {
    const afterRule = after.get(id)
    if (!afterRule) { deactivated.push(id); continue }
    const beforeAction = dialAction(rule, previous)
    const afterAction = dialAction(afterRule, level)
    if (beforeAction !== afterAction) {
      const softens = (beforeAction === 'deny' || beforeAction === 'block') && afterAction === 'warn'
      const hardens = beforeAction === 'warn' && (afterAction === 'deny' || afterAction === 'block')
      if (softens) softened.push(id)
      else if (hardens) hardened.push(id)
    }
    if (rule.level === 'protect') floors.push(id)
  }
  for (const id of after.keys()) if (!before.has(id)) activated.push(id)

  return { softened, hardened, deactivated, activated, floors }
}

function printDialDiff(diff: DialDiff, previous: ProtectionLevel, level: ProtectionLevel): void {
  console.log()
  if (previous === level) {
    console.log(chalk.dim(`  Dial diff: effective dial is unchanged (${level}) — no rule changes effective action.`))
    return
  }
  console.log(chalk.dim(`  Dial diff (${previous} → ${level}), from the merged ruleset:`))
  if (diff.softened.length) {
    console.log(`    ${chalk.yellow(`${diff.softened.length} rule(s) soften deny/block → warn:`)} ${chalk.white(diff.softened.join(', '))}`)
  }
  if (diff.hardened.length) {
    console.log(`    ${chalk.green(`${diff.hardened.length} rule(s) harden warn → deny/block:`)} ${chalk.white(diff.hardened.join(', '))}`)
  }
  if (diff.deactivated.length) {
    console.log(chalk.dim(`    ${diff.deactivated.length} rule(s) deactivated (their \`level\` floor is above ${level}): `) + chalk.white(diff.deactivated.join(', ')))
  }
  if (diff.activated.length) {
    console.log(chalk.dim(`    ${diff.activated.length} rule(s) newly active: `) + chalk.white(diff.activated.join(', ')))
  }
  if (!diff.softened.length && !diff.hardened.length && !diff.deactivated.length && !diff.activated.length) {
    console.log(chalk.dim('    No rule changes effective action or activation at this dial.'))
  }
  console.log(chalk.dim(`    ${diff.floors.length} \`level: protect\` floor(s) unchanged: `) + (diff.floors.length ? chalk.white(diff.floors.join(', ')) : chalk.dim('(none declared)')))
}

/**
 * Write the top-level `level:` into a rules.yaml, preserving comments and
 * formatting via a surgical line edit. Falls back to a YAML re-serialization
 * for the `keel: { ... }` wrapper format.
 *
 * Setting `sprint` also (re)writes `sprint_started_at` to now — this is
 * sprint's expiry clock (paired with `sprint_expiry_hours`, read by
 * resolvedLevel()/sprintExpiryStatus() in rule-parser.ts). Setting any
 * other level clears a leftover `sprint_started_at`: without that, a
 * stale timestamp from a previous sprint run would make a LATER, manually
 * hand-edited `level: sprint` look already-expired the instant it's
 * saved — a hand-edited sprint with no timestamp key correctly never
 * expires instead.
 *
 * rules.yaml, not KEEL_STATE_DIR, is where the expiry timestamp lives: it
 * is scoped identically to `level` itself (global vs. project), travels
 * with the file if it's copied or synced, and is already re-read on every
 * process invocation — no extra plumbing needed for a process-per-call
 * host to see the reversion.
 */
export function writeRulesLevel(filePath: string, level: ProtectionLevel): void {
  const source = readFileSync(filePath, 'utf-8')
  const sprintStartedAt = level === 'sprint' ? new Date().toISOString() : null
  const lines = source.split('\n')
  const levelIdx = lines.findIndex(l => /^level:\s*\S*/.test(l))
  const expiryIdx = lines.findIndex(l => /^sprint_started_at:\s*\S*/.test(l))

  if (levelIdx >= 0) {
    lines[levelIdx] = `level: ${level}`
    if (expiryIdx >= 0) {
      if (sprintStartedAt) lines[expiryIdx] = `sprint_started_at: ${sprintStartedAt}`
      else lines.splice(expiryIdx, 1)
    } else if (sprintStartedAt) {
      lines.splice(levelIdx + 1, 0, `sprint_started_at: ${sprintStartedAt}`)
    }
    writeFileSync(filePath, lines.join('\n'))
    return
  }
  const parsed = parseYaml(source) as Record<string, unknown> | null
  if (parsed && typeof parsed === 'object' && 'keel' in parsed) {
    const config = parsed.keel as Record<string, unknown>
    config.level = level
    if (sprintStartedAt) config.sprint_started_at = sprintStartedAt
    else delete config.sprint_started_at
    writeFileSync(filePath, stringifyYaml(parsed))
    return
  }
  mkdirSync(dirname(filePath), { recursive: true })
  const prefix = sprintStartedAt ? `level: ${level}\nsprint_started_at: ${sprintStartedAt}\n` : `level: ${level}\n`
  writeFileSync(filePath, `${prefix}${source}`)
}
