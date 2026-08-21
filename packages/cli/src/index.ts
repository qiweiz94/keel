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
import { haltCommand, resumeCommand } from './commands/halt.js'
import { runCommand } from './commands/run.js'
import { suggestCommand } from './commands/suggest.js'
import { allowCommand } from './commands/allow.js'
import { levelCommand } from './commands/level.js'
import { promoteCommand } from './commands/promote.js'
import { statusCommand } from './commands/status.js'
import { dashboardCommand } from './commands/dashboard.js'
import { dashboardWebCommand } from './commands/dashboard-web.js'
import { daemonCommand } from './commands/daemon.js'
import { retrospectiveCommand } from './commands/retrospective.js'
import { reportCommand } from './commands/report.js'
import { receiptsCommand } from './commands/receipts.js'
import { lessonsCommand } from './commands/lessons.js'
import { installCommand, DEFAULT_RULES_YAML } from './commands/install.js'
import { hookCommand } from './commands/hook.js'
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
  .description("Check a file or command against Keel's enforcement rules (.keel/rules.yaml)")
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
  .option('--append', 'harness only: add the rules to ~/.keel/rules.yaml (human-run; requires a TTY)')
  .action(rulesCommand)

program
  .command('scan')
  .description('Audit this machine\'s AI agent setup — unprotected hosts and risky MCP servers')
  .option('--json', 'Output as JSON')
  .option('--dir <path>', 'Custom project directory to scan')
  .option('--ci', 'Exit with code 1 if any finding is reported')
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

const policy = program.command('policy').description('[EXPERIMENTAL, unsupported] Stand-alone Rego/WASM policy tools — NOT wired into keel enforce/hook/daemon; see docs/comparison.md')

policy
  .command('init')
  .description('[EXPERIMENTAL] Create a sample .rego policy file')
  .action(policyInitCommand)

policy
  .command('build')
  .description('[EXPERIMENTAL] Compile a .rego file to .wasm (requires the opa CLI, not bundled)')
  .argument('<file>', 'Path to .rego file')
  .option('--output <dir>', 'Output directory')
  .action(policyBuildCommand)

policy
  .command('eval')
  .description('[EXPERIMENTAL] Evaluate a WASM policy against input, standalone — not part of real-time enforcement (requires @open-policy-agent/opa-wasm, not bundled)')
  .argument('<wasm>', 'Path to .wasm file')
  .option('--input <file>', 'JSON input file')
  .action(policyEvalCommand)

// ── New enforce commands ──

const enforceCmd = program.command('enforce')
  .description('Enforce rules on AI agent behavior')
  .option('--level <level>', 'Protection level for this run: sprint, balanced, or protect (omit to show the current dial; add --persist to make it the standing dial)')
  .option('--persist', 'Persist --level into the project rules.yaml (the speed dial) — requires --level')
  .option('--action <action>', 'Override action: report, warn, deny, or fix')
  .option('--depth <depth>', 'Override depth: fast, full, or deep')
  .option('--learn', 'Learning mode: observe only, never block')
  .option('--audit', 'Show recent violations')
  .action(enforceCommand)

enforceCmd
  .command('init')
  .description('Create .keel/rules.yaml with starter Keel rules')
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
  .option('--until <seconds>', 'Disable for N seconds (positive integer)')
  .option('--reason <text>', 'Reason for disabling')
  .action(disableCommand)

program
  .command('enable')
  .description('Re-enable enforcement after a disable')
  .action(enableCommand)

program
  .command('halt')
  .description('Lockdown: deny every subsequent tool call until a human runs `keel resume` (no auto-expiry)')
  .option('--reason <text>', 'Reason for halting')
  .option('--kill', 'Also send SIGTERM/SIGKILL to a `keel run`-supervised process (see safety checks in run-kill.ts)')
  .option('--kill-pid <pid>', 'With --kill, target one specific tracked pid instead of auto-selecting')
  .option('--kill-all', 'With --kill, target every tracked run instead of refusing when more than one is tracked')
  .option('--kill-grace <seconds>', 'With --kill, SIGTERM grace period before SIGKILL (default: 5)')
  .action(haltCommand)

program
  .command('resume')
  .description('Clear a halt set by `keel halt`')
  .action(resumeCommand)

program
  .command('run')
  .description('Run an agent command under keel supervision, so `keel halt --kill` can reach it even mid-flight (POSIX only — see docs)')
  .argument('<agent-cmd...>', 'Agent command and its own arguments (use `--` before it if it has flags of its own, e.g. `keel run -- claude --dangerously-skip-permissions`)')
  .allowUnknownOption()
  .action(runCommand)

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
  .command('retrospective')
  .description('Weekly report of agent improvement metrics (attempts-until-success, stuck loops, research compliance)')
  .option('--since <date>', 'Window start (YYYY-MM-DD), default: all traces')
  .option('--project <path>', 'Filter to a project')
  .option('--json', 'Emit machine-readable JSON')
  .option('--write', 'Append the report to ~/.keel/retrospectives/')
  .action((options: { since?: string; project?: string; json?: boolean; write?: boolean }) => retrospectiveCommand(options))

program
  .command('report')
  .description('What did keel do for you: blocks, warns, redirects, and observe-mode fires over a session or week')
  .option('--since <date>', 'Window start (YYYY-MM-DD), default: last 7 days')
  .option('--project <path>', 'Filter to a project (matches on recorded cwd)')
  .option('--session <id>', 'Filter to a single agent session')
  .option('--json', 'Emit machine-readable JSON')
  .action((options: { since?: string; project?: string; session?: string; json?: boolean }) => reportCommand(options))

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
  .option('--gemini', 'Install the Gemini CLI PreToolUse hook (~/.gemini/hooks/)')
  .option('--openclaw', 'Install the OpenClaw plugin (~/.openclaw/plugins/keel/, enforces via keel daemon)')
  .option('--hermes', 'Install the Hermes Agent plugin (~/.hermes/plugins/keel/, enforces via keel daemon)')
  .option('--mcp', 'Print MCP server config snippets for any MCP-native platform')
  .option('--all', 'Install everything (default)')
  .action(installCommand)

program
  .command('allow')
  .description('Override a rule temporarily (user-owned — run this yourself, not through the agent)')
  .argument('<rule-id>', 'Rule ID to override')
  .option('--once', 'Allow the NEXT violation only (5 minutes if unused)')
  .option('--session [session-id]', 'Allow every violation, but only for one agent session (auto-resolved from the audit trail, or an explicit id — useful with multiple sessions running in parallel; 24h ceiling)')
  .action(allowCommand)

program
  .command('hook')
  .description('Enforcement entry point for agent hosts (reads the tool call on stdin)')
  .argument('<host>', 'claude-code | cline | cursor | codex | gemini | generic')
  .option('--cwd <path>', 'Working directory to evaluate against')
  .option('--level <level>', 'Protection level override: sprint, balanced, or protect')
  .action((host: string, options: { cwd?: string; level?: string }) => hookCommand(host, options))

program
  .command('status')
  .description('Show the current enforcement state: dial, kill switch, overrides, rules, recent blocks')
  .action(statusCommand)

program
  .command('daemon')
  .description('Start the local enforcement daemon (one engine, thin clients: /v1/check · /v1/requirements · /v1/health)')
  .option('--port <port>', 'Port to listen on (default 31990)')
  .action((options: { port?: number }) => { void daemonCommand({ port: options.port }) })

program
  .command('dashboard')
  .description('Interactive dial control panel (run in your own terminal — level switches are human-only)')
  .option('--once', 'Print the panel once and exit (non-interactive)')
  .option('--json', 'Dump the panel state as JSON')
  .option('--web', 'Start the browser UI (127.0.0.1 only, one-time token, TTY required)')
  .option('--port <port>', 'Port for --web (default: random free port)')
  .action((options: { once?: boolean; json?: boolean; web?: boolean; port?: number }) => {
    if (options.web) return dashboardWebCommand({ port: options.port })
    return dashboardCommand(options)
  })

const receiptsCmd = program.command('receipts')
  .description('Manage signed receipt keys')

receiptsCmd
  .command('rotate')
  .description('Rotate the receipt/signing private keys (old keys stay readable for verification)')
  .action(() => receiptsCommand('rotate'))

program
  .command('level')
  .description('Show or set the protection level (the speed dial)')
  .argument('[level]', 'sprint, balanced, or protect')
  .option('--project', 'Set the project level (.keel/rules.yaml) instead of global')
  .action((levelArg, options) => levelCommand(options, levelArg))

program
  .command('promote')
  .description('Advance a mode: observe rule to warn/block (user-owned — run this yourself, not through the agent)')
  .argument('<rule-id>', 'Rule ID to promote')
  .option('--to <mode>', 'Target mode: warn or block (default: the next rung — observe→warn, warn→block)')
  .option('--force', 'Skip the evidence gate (observe rules only — see promotion_fp_threshold) and promote anyway')
  .action((ruleId: string, options: { to?: string; force?: boolean }) => promoteCommand(ruleId, options))

program.parse(process.argv)

/**
 * Create standalone .keel/rules.yaml with Keel enforce rules.
 *
 * This used to carry its own stale, second copy of a default ruleset (a
 * 6-rule set that had drifted from DEFAULT_RULES_YAML — no-external-network
 * was a blanket network-deny, exactly the do-not-ship guard install.ts's
 * ruleset deliberately avoids; no-delete-outside-src had no equivalent in
 * the tiered ruleset and was dropped rather than carried over uninspected).
 * It now emits the SAME canonical DEFAULT_RULES_YAML `keel install` writes,
 * so there is exactly one default ruleset in this codebase, not three —
 * drift.test.ts asserts this structurally (no third inline `rules:` copy).
 */
async function createEnforceInit() {
  const { existsSync, mkdirSync, writeFileSync: writeRulesFile } = await import('node:fs')
  const { join } = await import('node:path')
  const { resolveHome } = await import('./core/home.js')
  const rulesPath = join(process.cwd(), '.keel', 'rules.yaml')
  if (existsSync(rulesPath)) {
    console.log('.keel/rules.yaml already exists.')
    return
  }
  // Project rules override global rules by id (see mergeRules), and the
  // project file's own `level:` line wins over the global dial too. A user
  // who already ran `keel install` and picked a level there (e.g. protect)
  // would have that dial silently overridden the moment this writes a full
  // project ruleset that starts at level: balanced. Warn rather than guess.
  if (existsSync(join(resolveHome(), '.keel', 'rules.yaml'))) {
    console.log(
      'Note: a global ruleset exists at ~/.keel/rules.yaml. This project file will ' +
        'take priority for any rule id it shares with the global set, including the ' +
        '`level:` dial — check both files if enforcement behaves differently than expected.'
    )
  }
  mkdirSync(join(process.cwd(), '.keel'), { recursive: true })
  writeRulesFile(rulesPath, DEFAULT_RULES_YAML, 'utf-8')
  console.log('Created .keel/rules.yaml with Keel enforce rules.')
  console.log('Review it, then run `keel enforce` to activate.')
  return
}
