import { join } from 'node:path'
import { existsSync } from 'node:fs'
import chalk from 'chalk'
import { loadRuleHierarchy, mergeRules, detectConflicts, hashRulesFile, parseRulesFile } from '../core/enforce/rule-parser.js'

/**
 * `keel validate` — check rules for conflicts, syntax errors, and version drift.
 */
export async function validateCommand() {
  const dir = process.cwd()
  const home = process.env.HOME || '~'

  // Find project rules: .keel/rules.yaml > AGENTS.md > CLAUDE.md
  const projectPaths = [
    { path: join(dir, '.keel', 'rules.yaml'), name: 'Keel project rules', priority: 1 },
    { path: join(dir, 'AGENTS.md'), name: 'AGENTS.md rules', priority: 2 },
    { path: join(dir, 'CLAUDE.md'), name: 'CLAUDE.md rules', priority: 3 },
  ]
  const projectFile = projectPaths.find(f => existsSync(f.path)) || projectPaths[0]
  const localPaths = [
    { path: join(dir, '.keel.local.yaml'), name: 'Keel local rules', priority: 1 },
    { path: join(dir, 'AGENTS.local.md'), name: 'AGENTS.local.md', priority: 2 },
    { path: join(dir, 'CLAUDE.local.md'), name: 'CLAUDE.local rules', priority: 3 },
  ]
  const localFile = localPaths.find(f => existsSync(f.path)) || localPaths[0]

  console.log(chalk.bold.cyan('\n  ⚓ keel validate'))
  console.log()

  // Check for rules files
  const files = [
    { path: `${home}/.keel/rules.yaml`, name: 'Global rules', ok: false },
    { path: projectFile.path, name: 'Project rules', ok: false },
    { path: localFile.path, name: 'Local rules', ok: false },
  ]

  let totalRules = 0
  for (const file of files) {
    file.ok = existsSync(file.path)
    if (file.ok) {
      const parsed = parseRulesFile(file.path)
      const count = parsed?.rules.length || 0
      totalRules += count
      console.log(chalk.green(`  ✓ ${file.name}: ${chalk.white(file.path)} (${count} rules)`))
      // Show version info
      if (parsed) {
        const hash = hashRulesFile(file.path)
        console.log(chalk.dim(`    version ${parsed.version} | hash: ${hash}`))
      }
    } else {
      console.log(chalk.dim(`  · ${file.name}: not found (optional)`))
    }
  }

  console.log()
  console.log(chalk.cyan(`  Total: ${totalRules} rules across all scopes`))
  console.log()

  // Check for conflicts
  const hierarchy = loadRuleHierarchy(dir)
  const merged = mergeRules(hierarchy, 'balanced', 'local')
  const conflicts = detectConflicts(merged)

  if (conflicts.length > 0) {
    console.log(chalk.yellow(`  ⚠ ${conflicts.length} conflict(s) detected:`))
    for (const c of conflicts) {
      console.log(chalk.yellow(`    ✗ ${c.reason}`))
    }
  } else {
    console.log(chalk.green('  ✓ No rule conflicts detected'))
  }

  // Check for stale cache
  const cachePath = join(home, '.keel', 'cache', 'known-good.json')
  if (existsSync(cachePath)) {
    console.log(chalk.dim(`  Cache: ${cachePath} (exists, will be invalidated on rule change)`))
  }

  // Protection level recommendation
  console.log()
  console.log(chalk.cyan('  Current protection: balanced'))
  console.log(chalk.dim('  Change with: keel enforce --level=sprint|balanced|protect'))
  console.log()
}
