#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { initCommand } from './commands/init.js'
import { checkCommand } from './commands/check.js'
import { auditCommand } from './commands/audit.js'
import { serveCommand } from './commands/serve.js'
import { templateCommand } from './commands/template.js'
import { rulesCommand } from './commands/rules.js'
import { scanCommand } from './commands/scan.js'
import { verifyCommand } from './commands/verify.js'
import { gatewayCommand } from './commands/gateway.js'
import { policyBuildCommand, policyEvalCommand, policyInitCommand } from './rego-engine.js'
import { enforceCommand } from './commands/enforce.js'
import { evaluateCommand } from './commands/evaluate.js'
import { testCommand, testFromAudit } from './commands/test.js'
import { validateCommand } from './commands/validate.js'
import { disableCommand, enableCommand } from './commands/disable.js'
import { suggestCommand } from './commands/suggest.js'
import { allowCommand } from './commands/allow.js'
import { lessonsCommand } from './commands/lessons.js'
import { installCommand } from './commands/install.js'
import { gatherCommand } from './commands/gather.js'
import { scheduleCommand } from './commands/schedule.js'
import { watchCommand } from './commands/watch.js'

// Read version from package.json
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
const VERSION = pkg.version

const program = new Command()

program
  .name('keel')
  .description('Enforce rules on AI agents. Rules survive context rot, compaction, and agent amnesia.')
  .version(VERSION)

// ── Existing commands ──

program
  .command('init')
  .description('Initialize keel in the current project')
  .option('--hooks', 'Also install git hooks')
  .action(initCommand)

program
  .command('check')
  .description('Check a file or command against the policy')
  .argument('[target]', 'File path or command string to check')
  .option('-f, --file <path>', 'Check a specific file')
  .option('-c, --command <cmd>', 'Check a specific command')
  .option('--ci', 'CI mode: exit with error on any violation')
  .option('--write', 'Evaluate the target as a WRITE rather than a read (use with --file)')
  .option('--analyze-reasoning <text>', 'Analyze agent reasoning trace for suspicious patterns')
  .action(checkCommand)

program
  .command('audit')
  .description('View the enforcement audit log')
  .option('--json', 'Output as JSON')
  .option('--tail <n>', 'Show last N entries', '50')
  .action(auditCommand)

program
  .command('serve')
  .description('Start the MCP enforcement server')
  .option('--port <number>', 'Port for HTTP transport', '3100')
  .option('--transport <mode>', 'Transport mode: stdio or http', 'stdio')
  .action(serveCommand)

program
  .command('template')
  .description('List or preview policy templates')
  .argument('[name]', 'Template name (default, strict, minimal, security)')
  .option('--list', 'List all available templates')
  .action(templateCommand)

program
  .command('rules')
  .description('Import rules from external sources')
  .argument('[source]', 'Rule source (atr)')
  .option('--output <path>', 'Output directory')
  .option('--lane <mode>', 'Detection lane: enforce, alert, or hunt (default: hunt)')
  .action(rulesCommand)

program
  .command('scan')
  .description('Detect AI coding assistant configurations on this machine')
  .option('--json', 'Output as JSON')
  .option('--dir <path>', 'Custom project directory to scan')
  .action(scanCommand)

program
  .command('verify')
  .description('Verify signed action receipts')
  .argument('[receipt-file]', 'Receipt JSON file to verify (optional — verifies all if omitted)')
  .option('--receipt <path>', 'Path to receipt file')
  .option('--key <path>', 'Public key JWK file for verification')
  .option('--json', 'JSON output')
  .action(verifyCommand)

program
  .command('gateway')
  .description('Start the MCP security gateway (bidirectional proxy)')
  .option('--upstream <json>', 'Upstream MCP server config (JSON)')
  .option('--command <cmd>', 'Upstream command string')
  .option('--port <number>', 'HTTP port for gateway dashboard', '3100')
  .action(gatewayCommand)

const policy = program.command('policy').description('Manage Rego/WASM policies')

policy
  .command('init')
  .description('Create a sample .rego policy file')
  .action(policyInitCommand)

policy
  .command('build')
  .description('Compile a .rego file to .wasm (requires opa CLI)')
  .argument('<file>', 'Path to .rego file')
  .option('--output <dir>', 'Output directory')
  .action(policyBuildCommand)

policy
  .command('eval')
  .description('Evaluate a WASM policy against input')
  .argument('<wasm>', 'Path to .wasm file')
  .option('--input <file>', 'JSON input file')
  .action(policyEvalCommand)

// ── New enforce commands ──

const enforceCmd = program.command('enforce')
  .description('Enforce rules on AI agent behavior')
  .option('--level <level>', 'Protection level: sprint, balanced, or protect', 'balanced')
  .option('--action <action>', 'Override action: report, warn, deny, or fix')
  .option('--depth <depth>', 'Override depth: fast, full, or deep')
  .option('--learn', 'Learning mode: observe only, never block')
  .option('--watch', 'Watch filesystem for agent activity')
  .option('--audit', 'Show recent violations')
  .action(enforceCommand)

enforceCmd
  .command('init')
  .description('Create a sample CLAUDE.md with Keel rules')
  .action(createEnforceInit)

program
  .command('test')
  .description('Dry-run a tool call against current rules')
  .argument('<action>', 'Action to test (command string or JSON)')
  .option('--level <level>', 'Protection level', 'balanced')
  .option('--from-audit <path>', 'Test new rule against previous audit trace')
  .option('--new-rule <yaml>', 'New rule to test (YAML)')
  .action((action, options) => {
    if (options.fromAudit) {
      testFromAudit(options.fromAudit, options.newRule || action)
    } else {
      testCommand(action, options)
    }
  })

program
  .command('validate')
  .description('Check rules for conflicts, syntax, and version drift')
  .action(validateCommand)

program
  .command('disable')
  .description('Disable all enforcement (kill switch)')
  .option('--until <seconds>', 'Disable for N seconds', parseInt)
  .option('--reason <text>', 'Reason for disabling')
  .action(disableCommand)

program
  .command('enable')
  .description('Re-enable enforcement after a disable')
  .action(enableCommand)

program
  .command('evaluate')
  .description('Evaluate a tool call and return JSON result (for programmatic use)')
  .requiredOption('--tool <name>', 'Tool name (bash, read, edit, etc.)')
  .option('--args <json>', 'Tool arguments as JSON string')
  .option('--cwd <path>', 'Working directory')
  .option('--turn-number <n>', 'Turn number', '0')
  .option('--context-tokens <n>', 'Context token count', '0')
  .option('--level <level>', 'Protection level', 'balanced')
  .option('--agent <name>', 'Agent name', 'opencode-plugin')
  .option('--reasoning <text>', 'Agent reasoning trace')
  .action(evaluateCommand)

program
  .command('suggest')
  .description('Analyze audit trail and suggest rule improvements')
  .option('--since <date>', 'Analyze traces from a specific date (YYYY-MM-DD)')
  .option('--level <level>', 'Protection level for suggestions', 'balanced')
  .action(suggestCommand)

program
  .command('lessons')
  .description('Extract self-improvement lessons from audit logs')
  .option('--since <date>', 'Analyze from date (YYYY-MM-DD)')
  .option('--apply <pattern>', 'Generate rule YAML for a specific lesson pattern')
  .option('--list', 'List saved lessons')
  .action(lessonsCommand)

program
  .command('watch')
  .description('Watch the audit trail live for plugin activity')
  .option('--json', 'Output as JSON')
  .action(watchCommand)

program
  .command('gather')
  .description('Distill audit history into standing requirements (requirements.md)')
  .option('--since <days>', 'Only analyze the last N days')
  .option('--output <path>', 'Output file (default: ~/.keel/requirements.md)')
  .option('--apply', 'Show proposed rules derived from the audit history')
  .option('--apply-and-save', 'Append proposed rules to ~/.keel/rules.yaml')
  .option('--dry-run', 'Show what would be written without writing')
  .action(gatherCommand)

program
  .command('schedule')
  .description('Schedule automatic keel gather/suggest runs (launchd/cron)')
  .argument('[frequency]', 'daily | weekly (omit to show status)')
  .option('--remove', 'Remove the scheduled job')
  .option('--status', 'Show job status')
  .action(scheduleCommand)

program
  .command('install')
  .description('Install Keel enforcement in the environment')
  .option('--opencode', 'Wire the OpenCode plugin')
  .option('--project', 'Wire OpenCode plugin + rules in the current project')
  .option('--claude-code', 'Wire Claude Code hooks in the current project')
  .option('--cline', 'Wire Cline (.clinerules + MCP check server)')
  .option('--cursor', 'Wire Cursor (.cursor/rules declarative rules)')
  .option('--codex', 'Wire Codex CLI (AGENTS.md instructions)')
  .option('--all', 'Install everything (default)')
  .action(installCommand)

program
  .command('allow')
  .description('Override a rule temporarily')
  .argument('<rule-id>', 'Rule ID to override')
  .option('--once', 'Override for 5 minutes (default: 24 hours)')
  .action(allowCommand)

program.parse(process.argv)

/**
 * Create sample CLAUDE.md with Keel enforce rules.
 */
async function createEnforceInit() {
  const { writeFileSync } = await import('node:fs')
  const sampleConfig = `---
keel:
  version: 1
  level: balanced
  rules:
    - id: never-force-push
      type: command
      match: "git push --force"
      action: deny
      level: sprint
      message: "Never force push to git branches"

    - id: no-delete-outside-src
      type: filesystem
      paths: ["!/src/*"]
      operations: [delete, overwrite]
      action: deny
      level: balanced
      message: "Do not delete files outside /src"

    - id: must-sign-commits
      type: command
      match: "git commit"
      action: fix
      level: sprint
      fix:
        - pattern: "git commit"
          replace: "git commit --signoff"
      message: "Auto-adding --signoff to commits"

    - id: no-external-network
      type: network
      match: "."
      except: [api.github.com, registry.npmjs.org]
      action: deny
      level: protect
      message: "Block external network access except GitHub and npm"

    - id: re-inject-rules
      type: context
      level: sprint
      message: "Re-inject rules at 8K/16K/32K token thresholds"
---

# CLAUDE.md — Keel enforced rules

## Git
- NEVER use \`git push --force\`
- ALWAYS sign commits with \`--signoff\`

## Filesystem
- NEVER delete or overwrite files outside \`/src\`

## Network
- No external network access except GitHub and npm
`

  const { existsSync } = await import('node:fs')
  if (existsSync('CLAUDE.md')) {
    console.log('CLAUDE.md already exists. Use `keel enforce init --force` to overwrite.')
    return
  }

  writeFileSync('CLAUDE.md', sampleConfig, 'utf-8')
  console.log('Created CLAUDE.md with Keel enforce rules.')
  console.log()
  console.log('Next steps:')
  console.log('  1. Review rules in CLAUDE.md')
  console.log('  2. Run `keel enforce` to activate')
  console.log('  3. Run `keel test "git push --force"` to verify')
}
