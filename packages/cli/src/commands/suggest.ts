import chalk from 'chalk'
import { AuditLog, Suggester, loadRuleHierarchy, mergeRules } from '../core/enforce/index.js'
import type { ProtectionLevel } from '../core/types.js'
import { extractLessons } from './lessons.js'

/**
 * `keel suggest` — analyze audit trail and generate rule improvement suggestions.
 *
 * NEVER modifies rules directly. Only reads the audit log and displays suggestions.
 */
export async function suggestCommand(options: {
  since?: string
  level?: string
}) {
  const level: ProtectionLevel = (options.level || 'balanced') as ProtectionLevel
  const dir = process.cwd()
  const auditLog = new AuditLog()

  console.log(chalk.bold.cyan('\n  ⚓ keel suggest'))
  console.log(chalk.dim(`  Analyzing audit trail...`))
  console.log()

  // Load entries
  let entries
  if (options.since) {
    entries = auditLog.loadDate(options.since)
    if (entries.length === 0) {
      console.log(chalk.yellow(`  No trace data found for ${options.since}`))
      console.log()
      return
    }
    console.log(chalk.dim(`  Session: ${options.since} (${entries.length} events)`))
  } else {
    entries = auditLog.loadAll()
    if (entries.length === 0) {
      console.log(chalk.yellow(`  No trace data found`))
      console.log(chalk.cyan('  Run some agent sessions with `keel enforce` first, then try again.'))
      console.log()
      return
    }
    const uniqueSessions = new Set(entries.map(e => e.session_id)).size
    console.log(chalk.dim(`  ${entries.length} events across ${uniqueSessions} sessions`))
  }

  // Get active rules
  const hierarchy = loadRuleHierarchy(dir)
  const activeRules = mergeRules(hierarchy, level, 'local')

  // Analyze
  const suggester = new Suggester()
  const insights = suggester.analyze(entries, activeRules, level)

  // Extract lessons (self-improvement patterns)
  const lessons = extractLessons(entries)

  // Display insights
  console.log(chalk.cyan(`  📊 Rule Performance:`))

  if (insights.most_fired_rules.length > 0) {
    for (const r of insights.most_fired_rules) {
      const ignored = insights.most_ignored_rules.find(i => i.rule_id === r.rule_id)
      const status = ignored
        ? chalk.yellow(`${r.count} fires, ${ignored.count} overrides`)
        : chalk.green(`${r.count} fires, 0 overrides`)
      console.log(chalk.dim(`    ${r.rule_id}: ${status}`))
    }
  } else {
    console.log(chalk.dim(`    No rules have fired yet.`))
  }

  console.log()

  // Display violation hotspots
  if (insights.violation_hotspots.length > 0) {
    console.log(chalk.cyan(`  🔥 Violation Hotspots (by context size):`))
    for (const h of insights.violation_hotspots) {
      if (h.count > 0) {
        const bar = '█'.repeat(Math.min(h.count, 20))
        console.log(chalk.dim(`    ${h.token_range}: ${bar} ${h.count}`))
      }
    }
    console.log()
  }

  // Display suggestions
  console.log(chalk.cyan(`  💡 Suggestions:`))

  if (insights.suggested_rules.length === 0 && lessons.length === 0) {
    console.log(chalk.green(`    No suggestions — your rules are working well.`))
  } else {
    for (const s of insights.suggested_rules) {
      const confidenceColor = s.confidence === 'high' ? chalk.green : s.confidence === 'medium' ? chalk.yellow : chalk.dim
      console.log(`${confidenceColor(`    ${s.confidence === 'high' ? '→' : '·'} ${s.reason}`)}`)

      if (s.suggested_value) {
        console.log(chalk.dim(`       ${s.suggested_value}`))
      }

      if (s.type === 'modify_rule') {
        console.log(chalk.dim(`       ${s.current_value} → ${s.suggested_value} (${s.evidence.violations_count} violations, ${s.evidence.override_count} overrides)`))
      }
    }

    // Show lessons
    for (const lesson of lessons) {
      const color = lesson.severity === 'high' ? chalk.red
        : lesson.severity === 'medium' ? chalk.yellow
        : chalk.dim
      console.log(color(`    ⚑ ${lesson.pattern} (${lesson.severity})`))
      console.log(chalk.dim(`       ${lesson.description}`))
      if (lesson.suggested_rule) {
        console.log(chalk.cyan(`       Rule: ${lesson.suggested_rule.id || 'unnamed'} | Action: ${lesson.suggested_rule.action}`))
      }
      console.log()
    }

    if (lessons.length > 0) {
      console.log(chalk.cyan('  To apply a lesson as a rule:'))
      console.log(chalk.dim('    keel lessons --apply "<pattern-name>"'))
      console.log()
    }
  }

  // Display cache efficiency
  console.log()
  console.log(chalk.cyan(`  ⚡ Cache Efficiency:`))
  const efficiencyPct = Math.round(insights.cache_efficiency * 100)
  const barLen = Math.round(efficiencyPct / 5)
  const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen)
  console.log(chalk.dim(`    [${bar}] ${efficiencyPct}%`))

  if (insights.cache_efficiency < 0.5 && entries.length > 50) {
    console.log(chalk.yellow(`    Low cache efficiency. Enable persistent cache for speedup.`))
  }

  console.log()
}
