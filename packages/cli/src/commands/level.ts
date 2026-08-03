import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import chalk from 'chalk'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { parseRulesFile, validateRules } from '../core/enforce/rule-parser.js'
import type { ProtectionLevel } from '../core/types.js'

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
  const home = process.env.HOME || '~'
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
  writeRulesLevel(targetPath, level)
  console.log(chalk.green(`  ${targetName} level: ${chalk.white(previous)} → ${chalk.white(level)}`))
  console.log(chalk.dim(`  ${targetPath}`))
  console.log()
  for (const effect of LEVEL_EFFECTS[level]) {
    console.log(chalk.dim('  • ') + chalk.white(effect))
  }
  console.log(chalk.dim('\n  The plugin picks this up on the next tool call — no restart needed.'))
  console.log()
}

/**
 * Write the top-level `level:` into a rules.yaml, preserving comments and
 * formatting via a surgical line edit. Falls back to a YAML re-serialization
 * for the `keel: { ... }` wrapper format.
 */
export function writeRulesLevel(filePath: string, level: ProtectionLevel): void {
  const source = readFileSync(filePath, 'utf-8')
  const line = source.split('\n').findIndex(l => /^level:\s*\S*/.test(l))
  if (line >= 0) {
    const lines = source.split('\n')
    lines[line] = `level: ${level}`
    writeFileSync(filePath, lines.join('\n'))
    return
  }
  const parsed = parseYaml(source) as Record<string, unknown> | null
  if (parsed && typeof parsed === 'object' && 'keel' in parsed) {
    const config = parsed.keel as Record<string, unknown>
    config.level = level
    writeFileSync(filePath, stringifyYaml(parsed))
    return
  }
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `level: ${level}\n${source}`)
}
