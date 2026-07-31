import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import chalk from 'chalk'
import type { AuditEntry, ProjectInsights, Suggestion, KeelRule } from '../core/types.js'

interface ExtractedLesson {
  pattern: string
  category: 'claim-without-evidence' | 'context-drift' | 'sequence-violation' | 'rate-violation' | 'format-default' | 'build-not-test' | 'irreversible-action'
  severity: 'high' | 'medium' | 'low'
  description: string
  suggested_rule: Omit<KeelRule, 'id'> & { id?: string }
  occurrences: number
  example_turns: number[]
}

/**
 * `keel lessons` — extract self-improvement lessons from audit logs.
 *
 * Analyzes patterns in agent behavior, identifies recurring failure modes,
 * and suggests rules that would prevent them. This is the self-learning
 * layer — it never writes rules automatically, only suggests.
 *
 * Lessons are saved to ~/.keel/lessons.json for reference.
 */
export async function lessonsCommand(options: {
  since?: string
  apply?: string   // lesson ID to apply (auto-generate rule)
  list?: boolean
}) {
  const lessonsDir = join(homedir(), '.keel')
  const lessonsPath = join(lessonsDir, 'lessons.json')

  if (options.apply) {
    applyLesson(options.apply, lessonsPath, lessonsDir)
    return
  }

  // Load audit traces
  const auditDir = join(homedir(), '.keel', 'traces')
  if (!existsSync(auditDir)) {
    console.log(chalk.yellow('\n  No audit data found. Run some sessions with Keel enabled first.\n'))
    return
  }

  const entries: AuditEntry[] = loadAuditEntries(auditDir, options.since)
  if (entries.length === 0) {
    console.log(chalk.dim('\n  No entries in audit log.\n'))
    return
  }

  console.log(chalk.bold.cyan('\n  ⚓ Keel Lessons — Self-Improvement Analysis\n'))
  console.log(chalk.dim(`  Analyzing ${entries.length} audit entries...\n`))

  const lessons = extractLessons(entries)

  // Save lessons
  mkdirSync(lessonsDir, { recursive: true })
  writeFileSync(lessonsPath, JSON.stringify(lessons, null, 2), 'utf-8')

  if (lessons.length === 0) {
    console.log(chalk.green('  ✓ No recurring issues found. Keel is doing its job.\n'))
    return
  }

  for (const lesson of lessons) {
    const color = lesson.severity === 'high' ? chalk.red
      : lesson.severity === 'medium' ? chalk.yellow
      : chalk.dim

    console.log(color(`  ── ${lesson.pattern} (${lesson.severity})`))
    console.log(`     ${lesson.description}`)
    console.log(`     Occurred ${lesson.occurrences} time(s), turns: ${lesson.example_turns.slice(0, 5).join(', ')}`)
    console.log()

    if (lesson.suggested_rule) {
      console.log(chalk.cyan(`     Suggested rule:`))
      console.log(chalk.dim(`       id: ${lesson.suggested_rule.id || lesson.pattern.toLowerCase().replace(/\s+/g, '-')}`))
      if (lesson.suggested_rule.type) console.log(chalk.dim(`       type: ${lesson.suggested_rule.type}`))
      if (lesson.suggested_rule.match) console.log(chalk.dim(`       match: "${lesson.suggested_rule.match}"`))
      if (lesson.suggested_rule.action) console.log(chalk.dim(`       action: ${lesson.suggested_rule.action}`))
      if (lesson.suggested_rule.steps) {
        console.log(chalk.dim(`       steps:`))
        for (const s of lesson.suggested_rule.steps) {
          console.log(chalk.dim(`         - tool: ${s.tool}${s.pattern ? ` pattern: ${s.pattern}` : ''}`))
        }
      }
      console.log()
    }
  }

  console.log(chalk.dim(`  Lessons saved to ${lessonsPath}`))
  console.log(chalk.cyan('  To apply a lesson as a rule, run:'))
  console.log(chalk.dim('    keel lessons --apply <pattern-name>\n'))
}

export function extractLessons(entries: AuditEntry[]): ExtractedLesson[] {
  const lessons: ExtractedLesson[] = []

  // ── Lesson 1: Claim without evidence ──
  // Agent says "fixed" or "done" without running tests
  const claimToolCalls = entries.filter(e =>
    e.tool === 'Bash' && e.args?.command &&
    typeof e.args.command === 'string' &&
    !(e.args.command as string).includes('npm test') &&
    !(e.args.command as string).includes('vitest') &&
    !(e.args.command as string).includes('jest')
  )
  const claimPattern = entries.filter(e =>
    e.tool === 'WriteFile' || e.tool === 'edit'
  )
  const buildClaims = claimPattern.filter(e => {
    // Look for a "build" after the edit but no test
    const turnIdx = claimToolCalls.findIndex(tc => tc.turn_number === e.turn_number)
    return turnIdx >= 0
  })
  if (buildClaims.length >= 2) {
    lessons.push({
      pattern: 'Claim without evidence',
      category: 'claim-without-evidence',
      severity: 'high',
      description: 'Agent made changes and claimed completion without running tests. Add a sequence rule requiring npm test after source file edits.',
      suggested_rule: {
        id: 'verify-before-claim',
        type: 'sequence',
        steps: [
          { tool: 'WriteFile', pattern: 'src/' },
          { tool: 'edit', pattern: 'src/' },
        ],
        sequence_window_seconds: 300,
        action: 'deny',
        message: 'After changing source code, you must run npm test. Build is not sufficient verification.',
        priority: 80,
      },
      occurrences: buildClaims.length,
      example_turns: buildClaims.slice(0, 5).map(e => e.turn_number ?? 0),
    })
  }

  // ── Lesson 2: Build-only verification ──
  // Agent ran npm run build but NOT npm test
  const buildOnly = findBuildWithoutTest(entries)
  if (buildOnly.length >= 1) {
    lessons.push({
      pattern: 'Build-only verification',
      category: 'build-not-test',
      severity: 'high',
      description: 'Agent ran build but skipped tests. Build success does not mean tests pass.',
      suggested_rule: {
        id: 'test-after-build',
        type: 'sequence',
        steps: [
          { tool: 'Bash', pattern: 'npm run build|tsc|vite build' },
        ],
        sequence_window_seconds: 120,
        action: 'deny',
        message: 'Build success does not mean tests pass. Run npm test and confirm all green before reporting done.',
        priority: 85,
      },
      occurrences: buildOnly.length,
      example_turns: buildOnly.slice(0, 5),
    })
  }

  // ── Lesson 3: Format defaulting without asking ──
  // Agent chose a file format/name without verifying
  const formatDecisions = entries.filter(e => {
    const cmdStr = e.args?.command ? String(e.args.command) : ''
    return /default.*(format|config|rule)|choose.*(format|file)/i.test(cmdStr) &&
      !/CLAUDE\.md|AGENTS\.md|ask|verify|check/i.test(cmdStr)
  })
  if (formatDecisions.length >= 1) {
    lessons.push({
      pattern: 'Format default without verification',
      category: 'format-default',
      severity: 'medium',
      description: 'Agent chose a default format/config without verifying what the user actually uses.',
      suggested_rule: {
        id: 'verify-format-before-decision',
        type: 'command',
        match: '(default|choose).*(format|config|rule|file)',
        action: 'warn',
        unless_reasoning: 'user.*(said|asked|want|use|prefer)|verify|check|ask',
        message: 'You are choosing a format without verifying the user preference. Ask before deciding.',
        priority: 60,
      },
      occurrences: formatDecisions.length,
      example_turns: formatDecisions.slice(0, 5).map(e => e.turn_number ?? 0),
    })
  }

  // ── Lesson 4: Context drift (violations cluster at high token counts) ──
  const deniesByToken = entries.filter(e => e.action === 'deny' && e.context_tokens != null)
  const lateDenies = deniesByToken.filter(e => (e.context_tokens ?? 0) > 16000)
  if (lateDenies.length >= 3 && lateDenies.length > deniesByToken.length * 0.5) {
    lessons.push({
      pattern: 'Context drift violations',
      category: 'context-drift',
      severity: 'high',
      description: `${lateDenies.length}/${deniesByToken.length} violations occurred after 16K tokens. Context degradation is causing rule forgetting. Increase re-injection frequency.`,
      suggested_rule: {
        id: 're-inject-at-8k',
        type: 'context',
        message: 'Re-inject standing requirements at 8K/16K/32K token thresholds to combat context drift.',
        priority: 100,
      } as unknown as Omit<KeelRule, 'id'>,
      occurrences: lateDenies.length,
      example_turns: lateDenies.slice(0, 5).map(e => e.turn_number ?? 0),
    })
  }

  // ── Lesson 5: Repeated same-tool calls (runaway) ──
  const toolSequence: string[] = entries.map(e => e.tool || '').filter(Boolean)
  const toolRuns: Array<{ tool: string; count: number; turns: number[] }> = []
  let currentRun: { tool: string; count: number; turns: number[] } | null = null
  for (const e of entries) {
    const tool = e.tool || ''
    if (!tool) continue
    if (currentRun && currentRun.tool === tool) {
      currentRun.count++
      currentRun.turns.push(e.turn_number ?? 0)
    } else {
      if (currentRun && currentRun.count >= 5) toolRuns.push(currentRun)
      currentRun = { tool, count: 1, turns: [e.turn_number ?? 0] }
    }
  }
  if (currentRun && currentRun.count >= 5) toolRuns.push(currentRun)

  for (const run of toolRuns) {
    lessons.push({
      pattern: `Repeated ${run.tool} calls (${run.count}x)`,
      category: 'rate-violation',
      severity: 'medium',
      description: `Agent called ${run.tool} ${run.count} times in a row without doing other work. May indicate runaway behavior.`,
      suggested_rule: {
        id: `rate-limit-${run.tool.toLowerCase()}`,
        type: 'rate',
        match: run.tool,
        window_seconds: 60,
        max_calls: Math.max(10, Math.floor(run.count / 2)),
        action: 'warn',
        message: `Rate limit: too many consecutive ${run.tool} calls. Consider if something is stuck.`,
        priority: 50,
      },
      occurrences: run.count,
      example_turns: run.turns.slice(0, 5),
    })
  }

  // ── Lesson 6: Irreversible action without prior verification ──
  // Destructive/irreversible commands executed without an adjacent
  // verification step (registry/API/reference checks). Based on the
  // 2026-07-31 near-miss: a repo deletion was recommended without checking
  // inbound npm metadata references.
  const irreversible = entries.filter(e => {
    const cmdStr = e.args?.command ? String(e.args.command) : ''
    return /gh repo delete|gh repo transfer|npm unpublish|npm publish|git push --force(?!-with-lease)/i.test(cmdStr)
  })
  const irreversiblesWithoutCheck: Array<{ e: AuditEntry; turn: number }> = []
  for (const e of irreversible) {
    const idx = entries.indexOf(e)
    const window = entries.slice(Math.max(0, idx - 5), idx)
    const hasCheck = window.some(w => {
      const c = w.args?.command ? String(w.args.command) : ''
      return /curl.*registry|npm (view|info)|gh api|gh repo view|git remote -v|git ls-remote/i.test(c)
    })
    if (!hasCheck) irreversiblesWithoutCheck.push({ e, turn: e.turn_number ?? 0 })
  }
  if (irreversiblesWithoutCheck.length >= 1) {
    lessons.push({
      pattern: 'Irreversible action without verification',
      category: 'irreversible-action',
      severity: 'high',
      description: 'Agent executed (or recommended) an irreversible action without verifying inbound references first. Destructive actions need evidence of what links to the target.',
      suggested_rule: {
        id: 'verify-before-irreversible',
        type: 'command',
        match: 'gh repo delete|gh repo transfer|npm unpublish|git push --force(?!-with-lease)|rm -rf (?!.*node_modules)',
        action: 'warn',
        message: 'Irreversible action — verify inbound references (npm metadata, badges, forks, links) and state what was checked vs assumed before proceeding.',
        priority: 90,
      },
      occurrences: irreversiblesWithoutCheck.length,
      example_turns: irreversiblesWithoutCheck.slice(0, 5).map(x => x.turn),
    })
  }

  return lessons
}

function findBuildWithoutTest(entries: AuditEntry[]): number[] {
  const turns: number[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const cmd = e.args?.command ? String(e.args.command) : ''
    if (cmd.includes('npm run build') || cmd.includes('npm run typecheck') || cmd.includes('tsc') || cmd.includes('vite build')) {
      // Check if tests were run in the next 5 entries
      let hasTest = false
      for (let j = i + 1; j < Math.min(i + 6, entries.length); j++) {
        const nextEntry = entries[j]
        const nextCmd = nextEntry?.args?.command ? String(nextEntry.args.command) : ''
        if (nextCmd.includes('npm test') || nextCmd.includes('npm run test') || nextCmd.includes('vitest run') || nextCmd.includes('jest')) {
          hasTest = true
          break
        }
      }
      if (!hasTest) {
        turns.push(e.turn_number ?? 0)
      }
    }
  }
  return turns
}

function loadAuditEntries(auditDir: string, since?: string): AuditEntry[] {
  const entries: AuditEntry[] = []

  if (!existsSync(auditDir)) return entries

  for (const file of readdirSync(auditDir)) {
    if (!file.endsWith('.jsonl')) continue
    if (since && file.replace('.jsonl',')') < since) continue

    try {
      const lines = readFileSync(join(auditDir, file), 'utf-8').trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line))
        } catch { /* skip corrupt */ }
      }
    } catch { /* skip unreadable */ }
  }

  return entries
}

function applyLesson(patternName: string, lessonsPath: string, keelDir: string) {
  if (!existsSync(lessonsPath)) {
    console.log(chalk.red(`  No lessons file found at ${lessonsPath}`))
    console.log(chalk.yellow('  Run `keel lessons` first to generate lessons.\n'))
    return
  }

  const lessons: ExtractedLesson[] = JSON.parse(readFileSync(lessonsPath, 'utf-8'))
  const matching = lessons.filter(l => l.pattern.toLowerCase().includes(patternName.toLowerCase()))

  if (matching.length === 0) {
    console.log(chalk.yellow(`  No lessons matching "${patternName}"\n`))
    return
  }

  if (matching.length > 1) {
    console.log(chalk.yellow(`  Multiple lessons match "${patternName}". Be more specific:\n`))
    for (const m of matching) {
      console.log(`    - "${m.pattern}"`)
    }
    console.log()
    return
  }

  const lesson = matching[0]
  if (!lesson.suggested_rule) {
    console.log(chalk.yellow(`  Lesson "${lesson.pattern}" has no suggested rule.\n`))
    return
  }

  // Generate a rule YAML block
  const ruleId = lesson.suggested_rule.id || lesson.pattern.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const ruleYaml = generateRuleYaml(ruleId, lesson.suggested_rule)

  const rulesPath = join(keelDir, 'rules.yaml')
  console.log(chalk.green(`\n  ✓ Lesson "${lesson.pattern}" ready to apply\n`))
  console.log(chalk.cyan('  Add this to your rules file:\n'))
  console.log(chalk.white(ruleYaml))
  console.log(chalk.dim(`  File: ${rulesPath}\n`))
  console.log(chalk.cyan('  Or run: `keel lessons --apply-and-save ' + patternName + '`\n'))
}

function generateRuleYaml(id: string, rule: Omit<KeelRule, 'id'>): string {
  let yaml = `    - id: ${id}\n`
  yaml += `      type: ${rule.type}\n`
  if (rule.match) yaml += `      match: "${rule.match.replace(/"/g, '\\"')}"\n`
  if (rule.action) yaml += `      action: ${rule.action}\n`
  if (rule.message) yaml += `      message: "${rule.message.replace(/"/g, '\\"')}"\n`
  if (rule.priority) yaml += `      priority: ${rule.priority}\n`
  if (rule.unless_reasoning) yaml += `      unless_reasoning: "${rule.unless_reasoning.replace(/"/g, '\\"')}"\n`
  if (rule.steps) {
    yaml += `      steps:\n`
    for (const s of rule.steps) {
      yaml += `        - tool: ${s.tool}${s.pattern ? `\n          pattern: "${s.pattern.replace(/"/g, '\\"')}"` : ''}\n`
    }
  }
  if (rule.window_seconds) yaml += `      window_seconds: ${rule.window_seconds}\n`
  if (rule.sequence_window_seconds) yaml += `      sequence_window_seconds: ${rule.sequence_window_seconds}\n`
  if (rule.max_calls) yaml += `      max_calls: ${rule.max_calls}\n`
  return yaml
}
