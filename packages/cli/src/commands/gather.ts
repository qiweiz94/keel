import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'
import { extractLessons } from './lessons.js'
import type { AuditEntry } from '../core/types.js'

/**
 * `keel gather` — distill audit history into standing requirements.
 *
 * Reads ~/.keel/traces/*.jsonl, runs the same analysis as `keel lessons`,
 * and writes the resulting requirements into ~/.keel/requirements.md
 * (or --output). Only the section between the keel:gather markers is
 * rewritten — user-authored sections are preserved verbatim.
 *
 * The learning layer NEVER writes rules automatically. `--apply` prints
 * the proposed rules for review; appending to rules.yaml requires
 * explicit --apply-and-save.
 */

const GATHER_START = '<!-- keel:gather-start -->'
const GATHER_END = '<!-- keel:gather-end -->'

const LESSON_REQUIREMENTS: Record<string, { title: string; bullet: string }> = {
  'claim-without-evidence': {
    title: 'Verification',
    bullet: 'Before claiming completion ("done", "fixed", "verified"), run the project tests and include the output as evidence.',
  },
  'build-not-test': {
    title: 'Verification',
    bullet: 'Build success does not mean tests pass. Run tests, not just a build, before reporting done.',
  },
  'format-default': {
    title: 'Decision-making',
    bullet: 'When choosing a format, config, or convention, ask the user what they use. Never default.',
  },
  'context-drift': {
    title: 'Context awareness',
    bullet: 'Re-check the user\'s standing requirements when the conversation grows long — early instructions degrade from context.',
  },
  'rate-violation': {
    title: 'Behavior',
    bullet: 'Avoid repeated identical tool calls without making progress. If a tool call fails, change approach.',
  },
  'sequence-violation': {
    title: 'Verification',
    bullet: 'After changing source code, run the test suite before moving on.',
  },
}

function loadAuditEntries(auditDir: string, sinceDays?: number): AuditEntry[] {
  const entries: AuditEntry[] = []
  if (!existsSync(auditDir)) return entries

  const cutoff = sinceDays ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0

  for (const file of readdirSync(auditDir)) {
    if (!file.endsWith('.jsonl')) continue
    try {
      const lines = readFileSync(join(auditDir, file), 'utf-8').trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditEntry & { t?: number }
          const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : entry.t
          if (sinceDays && ts && ts < cutoff) continue
          entries.push(entry)
        } catch { /* skip corrupt */ }
      }
    } catch { /* skip unreadable */ }
  }
  return entries
}

function buildGatherBlock(entries: AuditEntry[]): string {
  const lessons = extractLessons(entries)
  if (lessons.length === 0) {
    return `${GATHER_START}\n\n<!-- keel gather: no recurring issues detected yet -->\n\n${GATHER_END}\n`
  }

  const sections = new Map<string, string[]>()
  for (const lesson of lessons) {
    const spec = LESSON_REQUIREMENTS[lesson.category]
    if (!spec) continue
    if (!sections.has(spec.title)) sections.set(spec.title, [])
    sections.get(spec.title)!.push(spec.bullet)
  }

  const lines: string[] = [GATHER_START, '', '## Gathered from audit history (auto-generated)', '']
  for (const [title, bullets] of sections) {
    lines.push(`### ${title}`)
    for (const bullet of [...new Set(bullets)]) {
      lines.push(`- ${bullet}`)
    }
    lines.push('')
  }
  lines.push(GATHER_END, '')
  return lines.join('\n')
}

function replaceGatherSection(existing: string, newBlock: string): string {
  const start = existing.indexOf(GATHER_START)
  const end = existing.indexOf(GATHER_END)
  if (start === -1 || end === -1 || end < start) {
    // No (complete) markers — append at the end.
    return existing.trimEnd() + '\n\n' + newBlock
  }
  const endIdx = end + GATHER_END.length
  return existing.slice(0, start) + newBlock + existing.slice(endIdx)
}

function renderProposedRules(entries: AuditEntry[]): string {
  const lessons = extractLessons(entries)
  if (lessons.length === 0) return ''
  let out = '# gathered by `keel gather --apply-and-save` — review before trusting\n'
  for (const lesson of lessons) {
    if (!lesson.suggested_rule) continue
    const id = lesson.suggested_rule.id || lesson.pattern.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    out += `    - id: ${id}\n`
    out += `      type: ${lesson.suggested_rule.type}\n`
    if (lesson.suggested_rule.match) out += `      match: "${String(lesson.suggested_rule.match).replace(/"/g, '\\"')}"\n`
    out += `      action: ${lesson.suggested_rule.action}\n`
    if (lesson.suggested_rule.message) out += `      message: "${String(lesson.suggested_rule.message).replace(/"/g, '\\"')}"\n`
    if (lesson.suggested_rule.priority) out += `      priority: ${lesson.suggested_rule.priority}\n`
    out += `\n`
  }
  return out
}

export async function gatherCommand(options: {
  since?: string
  output?: string
  apply?: boolean
  applyAndSave?: boolean
  dryRun?: boolean
}) {
  const auditDir = join(homedir(), '.keel', 'traces')
  const outputPath = options.output || join(homedir(), '.keel', 'requirements.md')

  if (!existsSync(auditDir)) {
    console.log(chalk.yellow('\n  No audit data found. Run some sessions with Keel enabled first.\n'))
    return
  }

  const sinceDays = options.since ? parseInt(options.since, 10) : undefined
  const entries = loadAuditEntries(auditDir, sinceDays)
  if (entries.length === 0) {
    console.log(chalk.dim('\n  No entries in the audit log for the selected window.\n'))
    return
  }

  console.log(chalk.bold.cyan('\n  ⚓ Keel Gather — Audit → Standing Requirements\n'))
  console.log(chalk.dim(`  Analyzing ${entries.length} audit entries...\n`))

  if (options.apply || options.applyAndSave) {
    const proposed = renderProposedRules(entries)
    if (!proposed) {
      console.log(chalk.green('  ✓ No rules to propose.\n'))
      return
    }
    if (options.applyAndSave) {
      const rulesPath = join(homedir(), '.keel', 'rules.yaml')
      mkdirSync(dirname(rulesPath), { recursive: true })
      let existing = ''
      if (existsSync(rulesPath)) existing = readFileSync(rulesPath, 'utf-8')
      if (existing.includes('gathered by `keel gather --apply-and-save`')) {
        console.log(chalk.yellow('  Gathered rules already exist in rules.yaml. Review them manually before re-applying.\n'))
        return
      }
      const block = proposed.split('\n').filter(l => l.trim()).join('\n') + '\n'
      const updated = existing.trimEnd() + '\n' + block
      writeFileSync(rulesPath, updated, 'utf-8')
      console.log(chalk.green(`  ✓ Appended ${proposed.split('\n').filter(l => l.trim()).length} rule line(s) to ${rulesPath}`))
      console.log(chalk.yellow('  Review them with `keel validate` before trusting them.\n'))
    } else {
      console.log(chalk.cyan('  Proposed rules (add to ~/.keel/rules.yaml):\n'))
      console.log(chalk.white(proposed))
      console.log(chalk.dim('  Re-run with --apply-and-save to append them automatically.\n'))
    }
    return
  }

  const block = buildGatherBlock(entries)

  if (options.dryRun) {
    console.log(chalk.cyan('  Dry run — would write to:') + chalk.white(` ${outputPath}\n`))
    console.log(block)
    return
  }

  let existing = ''
  if (existsSync(outputPath)) existing = readFileSync(outputPath, 'utf-8')
  const updated = replaceGatherSection(existing, block)
  if (updated === existing) {
    console.log(chalk.dim('  Requirements unchanged.\n'))
    return
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, updated, 'utf-8')
  console.log(chalk.green(`  ✓ Updated ${outputPath}`))
  console.log(chalk.dim('  Only the section between keel:gather markers was rewritten.'))
  console.log(chalk.dim('  User-authored sections are preserved.\n'))
}
