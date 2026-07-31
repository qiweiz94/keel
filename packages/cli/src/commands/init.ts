import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import chalk from 'chalk'
import { DEFAULT_POLICY_YAML } from '../policy-engine.js'

export async function initCommand(options: { hooks?: boolean }) {
  const cwd = process.cwd()
  const policyPath = join(cwd, '.keel.yaml')

  if (existsSync(policyPath)) {
    console.log(chalk.yellow('.keel.yaml already exists. Use keel check to verify it.'))
  } else {
    writeFileSync(policyPath, DEFAULT_POLICY_YAML, 'utf-8')
    console.log(chalk.green('✓ Created .keel.yaml'))
  }

  if (options.hooks) {
    // Check if pre-commit framework is installed
    let usePreCommit = false
    try {
      execSync('pre-commit --version', { stdio: 'ignore' })
      usePreCommit = true
    } catch { /* pre-commit not installed */ }

    if (usePreCommit && existsSync(join(cwd, '.pre-commit-config.yaml'))) {
      console.log(chalk.cyan('  Detected pre-commit framework.'))
      console.log(chalk.cyan('  Add to .pre-commit-config.yaml:'))
      console.log(chalk.cyan('    repos:'))
      console.log(chalk.cyan('      - repo: https://github.com/qiweiz94/keel'))
      console.log(chalk.cyan('        rev: v0.1.0'))
      console.log(chalk.cyan('        hooks:'))
      console.log(chalk.cyan('          - id: keel-check'))
    }

    const hooksDir = join(cwd, '.git', 'hooks')
    if (!existsSync(hooksDir)) {
      console.log(chalk.red('✗ No .git/hooks directory found. Are you in a git repository?'))
      return
    }
    installHook(hooksDir, 'pre-commit')
    installHook(hooksDir, 'pre-push')
    console.log(chalk.green('✓ Installed git hooks'))
  }

  console.log(chalk.cyan('\nNext steps:'))
  console.log('  1. Review .keel.yaml and customize the rules')
  console.log('  2. Run keel check --ci to verify compliance')
  console.log('  3. Commit .keel.yaml to your repository')
  if (!options.hooks) {
    console.log('  4. Run keel init --hooks to install git hook enforcement')
  }
}

const HOOK_MARKER = '# installed by keel'

function installHook(hooksDir: string, hookName: string) {
  const hookPath = join(hooksDir, hookName)
  const backupPath = join(hooksDir, `${hookName}.keel-backup`)

  // A backup already on disk means a previous install displaced a real hook;
  // keep chaining it even when re-running init over our own hook.
  let hasPredecessor = existsSync(backupPath)

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf-8')
    if (!existing.includes(HOOK_MARKER)) {
      // Preserve, don't destroy. Overwriting a project's pre-commit hook
      // would disable the lint/test/secret-scan gates this tool exists to
      // stop agents from bypassing — the exact harm, self-inflicted.
      writeFileSync(backupPath, existing, 'utf-8')
      execSync(`chmod +x "${backupPath}"`)
      hasPredecessor = true
      console.log(chalk.yellow(`  Preserved existing ${hookName} hook — it will run first, then keel.`))
    }
  }

  const chained = hasPredecessor
    ? `
# Run the hook that was here before keel was installed. Its failure is
# still a failure — keel adds a gate, it does not replace yours.
PRIOR="$(dirname "$0")/${hookName}.keel-backup"
if [ -x "$PRIOR" ]; then
  "$PRIOR" "$@" || exit $?
fi
`
    : ''

  writeFileSync(hookPath, `#!/bin/bash
# keel ${hookName} hook
${HOOK_MARKER}
set -e
${chained}
# Fail closed: a missing binary means enforcement cannot run, which must not
# be silently equivalent to passing.
command -v keel >/dev/null 2>&1 || {
  echo "keel: not installed — refusing to skip enforcement." >&2
  echo "  Install it (npm install -g @get-keel/cli), or remove .git/hooks/${hookName}." >&2
  exit 1
}
keel check --ci
`, 'utf-8')
  execSync(`chmod +x "${hookPath}"`)
}
