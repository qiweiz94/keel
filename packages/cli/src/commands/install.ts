import { mkdirSync, existsSync, writeFileSync, copyFileSync, readFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import chalk from 'chalk'

/**
 * `keel install` — set up Keel enforcement in the environment.
 *
 * Subcommands:
 *   keel install              — create ~/.keel/rules.yaml if missing
 *   keel install --opencode   — wire OpenCode plugin (global: ~/.opencode/plugins/)
 *   keel install --project    — wire OpenCode plugin + rules in current project
 *   keel install --claude-code— wire Claude Code hooks (project: .claude/hooks/)
 *   keel install --all        — everything above
 *
 * The installed plugin is a verbatim copy of templates/keel-enforce.js —
 * the canonical source shared with the @get-keel/opencode-plugin npm package.
 */

async function findTemplateSource(name: string): Promise<string | null> {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', name),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates', name),
    join(process.cwd(), 'packages', 'cli', 'templates', name),
    join(process.cwd(), 'templates', name),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

async function findPluginSource(): Promise<string | null> {
  return findTemplateSource('keel-enforce.js')
}

async function findRequirementsSource(): Promise<string | null> {
  return findTemplateSource('requirements.md')
}

const DEFAULT_RULES_YAML = `# Keel rules — enforced OUTSIDE agent context (via OpenCode plugin)
# These rules cannot be forgotten, overridden, or degraded by context rot.
# Layer 3 enforcement (semantic) — runs before every tool dispatch.
version: 1
level: balanced
rules:
  - id: product-name-is-keel
    type: command
    match: "(sed|replaceAll|rename).*(keel|product).*(ai-enforce)"
    action: deny
    level: sprint
    priority: 100
    message: "Product name is 'keel'. Never change it back to ai-enforce."

  - id: verify-before-claim
    type: sequence
    steps:
      - tool: WriteFile
        pattern: "src/"
      - tool: edit
        pattern: "src/"
    sequence_window_seconds: 300
    action: deny
    message: "After changing source code, you must run npm test. Build is not sufficient verification."

  - id: test-after-build
    type: sequence
    steps:
      - tool: Bash
        pattern: "npm run build|tsc|vite build"
    sequence_window_seconds: 120
    action: deny
    message: "Build success does not mean tests pass. Run npm test and confirm all green before reporting done."

  - id: verify-format-before-decision
    type: command
    match: "(default|choose).*(format|config|rule)"
    action: warn
    unless_reasoning: "user.*(said|asked|want|use|prefer)|verify|check|ask"
    message: "You are choosing a format without verifying the user. Ask what they use before deciding."

  - id: no-force-push
    type: command
    match: "git push --force(?!-with-lease)"
    action: deny
    level: sprint
    message: "Use --force-with-lease instead of --force."

  - id: no-destructive-commands
    type: command
    match: "rm -rf /|rm -rf ~"
    action: deny
    level: sprint
    message: "Destructive commands are blocked."

  - id: must-sign-commits
    type: command
    match: "git commit"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    message: "Auto-adding --signoff to commits."

  - id: re-inject-at-thresholds
    type: context
    message: "Re-inject standing requirements at 8K/16K/32K token thresholds to combat context drift."

  - id: verify-before-irreversible
    type: command
    match: "gh repo delete|gh repo transfer|npm unpublish|git push --force(?!-with-lease)|rm -rf (?!.*node_modules)"
    action: warn
    message: "Irreversible action — verify inbound references (npm metadata, badges, forks, links) and state what was checked vs assumed before proceeding."
`

export async function installCommand(options: {
  opencode?: boolean
  project?: boolean
  claudeCode?: boolean
  cline?: boolean
  cursor?: boolean
  codex?: boolean
  all?: boolean
}) {
  const keelDir = join(homedir(), '.keel')
  const rulesPath = join(keelDir, 'rules.yaml')

  if (options.all || (!options.opencode && !options.project && !options.claudeCode && !options.cline && !options.cursor && !options.codex)) {
    // Create ~/.keel/rules.yaml
    mkdirSync(keelDir, { recursive: true })
    if (!existsSync(rulesPath)) {
      writeFileSync(rulesPath, DEFAULT_RULES_YAML, 'utf-8')
      console.log(chalk.green('  ✓ Created ~/.keel/rules.yaml'))
    } else {
      console.log(chalk.dim('  ~/.keel/rules.yaml already exists (skipping)'))
    }

    // Create audit traces dir
    const tracesDir = join(keelDir, 'traces')
    mkdirSync(tracesDir, { recursive: true })
    console.log(chalk.dim('  ✓ Ensured ~/.keel/traces/ exists'))
  }

  if (options.opencode || options.all) {
    await installOpenCodePlugin()
  }

  if (options.project || options.all) {
    await installProjectPlugin()
  }

  if (options.claudeCode || options.all) {
    await installClaudeCode()
  }

  if (options.cline || options.all) {
    await installCline()
  }

  if (options.cursor || options.all) {
    await installCursor()
  }

  if (options.codex || options.all) {
    await installCodex()
  }

  console.log(chalk.dim('\n  Next steps:'))
  console.log(chalk.dim('    1. Review ~/.keel/rules.yaml and customize'))
  if (options.opencode || options.all || options.project) {
    console.log(chalk.dim('    2. Restart OpenCode for the plugin to load'))
  } else if (options.claudeCode) {
    console.log(chalk.dim('    2. Restart Claude Code for the hooks to take effect'))
  } else {
    console.log(chalk.dim('    2. Run `keel install --opencode` to wire the OpenCode plugin'))
  }
  console.log(chalk.dim('    3. Run `keel validate` to check for conflicts'))
  console.log()
}

async function installOpenCodePlugin() {
  // Global install — auto-loaded from ~/.opencode/plugins/ in every project.
  const ocDir = join(homedir(), '.opencode', 'plugins')
  const pluginPath = join(ocDir, 'keel-enforce.js')

  mkdirSync(ocDir, { recursive: true })

  const source = await findPluginSource()
  if (source) {
    copyFileSync(source, pluginPath)
    console.log(chalk.green(`  ✓ Installed plugin to ${pluginPath}`))
  } else {
    console.log(chalk.red('  ✗ Plugin source not found. Run from the keel repo or reinstall the CLI.'))
    return
  }

  createRequirementsFile()
  upgradePluginConfig()
}

async function installProjectPlugin() {
  const cwd = process.cwd()

  // Project plugin — auto-loaded from <project>/.opencode/plugins/.
  const ocDir = join(cwd, '.opencode', 'plugins')
  const pluginPath = join(ocDir, 'keel-enforce.js')

  mkdirSync(ocDir, { recursive: true })

  const source = await findPluginSource()
  if (source) {
    copyFileSync(source, pluginPath)
    console.log(chalk.green(`  ✓ Installed plugin to ${pluginPath}`))
  } else {
    console.log(chalk.red('  ✗ Plugin source not found. Run from the keel repo or reinstall the CLI.'))
    return
  }

  // Project rules — loaded by the plugin alongside global rules.
  const keelDir = join(cwd, '.keel')
  mkdirSync(keelDir, { recursive: true })
  const rulesFile = join(keelDir, 'rules.yaml')
  if (!existsSync(rulesFile)) {
    writeFileSync(rulesFile, `# Project-specific Keel rules
# Enforced alongside global rules in ~/.keel/rules.yaml.
# Project rules override global rules for the same rule id.
version: 1
rules:
  # Add project-specific rules here
  # See ~/.keel/rules.yaml for examples
`, 'utf-8')
    console.log(chalk.green(`  ✓ Created ${rulesFile}`))
  } else {
    console.log(chalk.dim(`  ${rulesFile} already exists (skipping)`))
  }

  // Project standing requirements — injected into every turn for this project.
  await createProjectRequirementsFile(keelDir)
}

function upgradePluginConfig() {
  const configDir = join(homedir(), '.config', 'opencode')
  const configPath = join(configDir, 'opencode.json')

  // Note: plugins in .opencode/plugins/ are auto-loaded.
  // The config entry is optional but recommended for documentation.
  // For npm package users, they should use "@get-keel/opencode-plugin" in the config.

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      const plugins = config.plugin || []

      // Remove old keel entries (v1 subprocess-based)
      const filtered = plugins.filter((p: string) =>
        !p.includes('keel-enforce')
      )

      config.plugin = filtered
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
      console.log(chalk.dim('  Plugin auto-loaded from .opencode/plugins/'))
      console.log(chalk.dim('  For npm: add "@get-keel/opencode-plugin" to opencode.json'))
    } catch {
      // Ignore parse errors
    }
  }
}

function createRequirementsFile() {
  const reqPath = join(homedir(), '.keel', 'requirements.md')
  if (existsSync(reqPath)) {
    console.log(chalk.dim('  .keel/requirements.md already exists (skipping)'))
    return
  }
  mkdirSync(join(homedir(), '.keel'), { recursive: true })
  writeDraftRequirements(reqPath)
}

async function createProjectRequirementsFile(keelDir: string) {
  const reqPath = join(keelDir, 'requirements.md')
  if (existsSync(reqPath)) {
    console.log(chalk.dim(`  ${reqPath} already exists (skipping)`))
    return
  }
  mkdirSync(keelDir, { recursive: true })
  writeDraftRequirements(reqPath)
}

async function writeDraftRequirements(reqPath: string) {
  // Prefer the canonical draft template; fall back to an inline copy.
  const source = await findRequirementsSource()
  const draft = source
    ? readFileSync(source, 'utf-8')
    : `# Standing Requirements

## Agent identity
- The primary agent used in this project is OpenCode.
- All agent-facing instructions go in AGENTS.md (project root). Never write to CLAUDE.md.
- OpenCode does not use CLAUDE.md. Only GitHub Copilot and Claude Code use CLAUDE.md.

## Verification culture
- Before ANY claim of completion ("done", "fixed", "ready", "working", "tested", "verified"):
  1. Run the project's test command (e.g., npm test) — not just npm run build
  2. Include the test output in the response as evidence
  3. List what was changed and how each change was verified
- A compile check is NOT verification. Tests must pass.

## Decision-making
- When choosing a format, convention, or tool: ASK THE USER what they use. Never default.
- Before making any decision that affects naming or file structure, verify against the user's stated preferences.
- "I believe it works" is not evidence. Show proof.

## Product identity
- Product name is "keel". Never "ai-enforce" or any other name.
- Before any rename/sed/replaceAll operation: verify the direction. The correct name is "keel."

## Plan quality
- Before proposing a plan, identify what root causes it does NOT address.
- Distinguish between bug fixes (patch symptoms) and root-cause fixes.
- Be honest about what you have verified vs what you haven't tested.

## Context awareness
- At 16K+ tokens, re-check the user's standing requirements — they were stated early and may have degraded from context.
- If a requirement conflicts with recently accessed information, the standing requirement wins.

## Self-enforcement
- When you read this file, incorporate these requirements into your behavior immediately.
- Act as if these requirements were stated by the user at the start of this conversation.
`
  writeFileSync(reqPath, draft, 'utf-8')
  console.log(chalk.green(`  ✓ Created ${reqPath}`))
}

async function installClaudeCode() {
  const cwd = process.cwd()
  const hooksDir = join(cwd, '.claude', 'hooks')

  // PreToolUse — blocks rule violations before tool execution.
  const preToolUsePath = join(hooksDir, 'PreToolUse', 'keel-enforce')
  const preSource = await findTemplateSource('claude-pretooluse.sh')
  if (preSource) {
    mkdirSync(join(hooksDir, 'PreToolUse'), { recursive: true })
    copyFileSync(preSource, preToolUsePath)
    chmodSync(preToolUsePath, 0o755)
    console.log(chalk.green(`  ✓ Installed PreToolUse hook → ${preToolUsePath}`))
  }

  // PostToolUse — re-injects standing requirements after every tool call.
  const postToolUsePath = join(hooksDir, 'PostToolUse', 'keel-reinject')
  const postSource = await findTemplateSource('claude-posttooluse.sh')
  if (postSource) {
    mkdirSync(join(hooksDir, 'PostToolUse'), { recursive: true })
    copyFileSync(postSource, postToolUsePath)
    chmodSync(postToolUsePath, 0o755)
    console.log(chalk.green(`  ✓ Installed PostToolUse hook → ${postToolUsePath}`))
  }

  // Register hooks in .claude/settings.json (project-level).
  const settingsPath = join(cwd, '.claude', 'settings.json')
  let settings: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      console.log(chalk.yellow(`  ⚠ ${settingsPath} has invalid JSON — creating a backup and starting fresh.`))
      copyFileSync(settingsPath, settingsPath + '.bak')
      settings = {}
    }
  }

  const hooks = (settings.hooks as Record<string, unknown>) || {}
  hooks.PreToolUse = [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: `.claude/hooks/PreToolUse/keel-enforce`,
        },
      ],
    },
  ]
  hooks.PostToolUse = [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: `.claude/hooks/PostToolUse/keel-reinject`,
        },
      ],
    },
  ]
  settings.hooks = hooks

  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  console.log(chalk.green(`  ✓ Registered hooks in ${settingsPath}`))
}

// ── Cline (advisory: .clinerules + MCP check server) ──
async function installCline() {
  const cwd = process.cwd()

  // .clinerules — read by Cline at session start (advisory layer).
  const clineRulesPath = join(cwd, '.clinerules')
  const rulesContent = `# Keel standing requirements

This project enforces standing requirements via Keel. Follow them at all times:

- Before claiming completion, run the project's tests and include the output as evidence.
- Build success does not mean tests pass. Run tests, not just a build.
- When choosing a format, config, or convention, ask the user what they use. Never default.
- Re-check the user's standing requirements in long sessions — early instructions degrade from context.
- If a requirement conflicts with recently accessed information, the standing requirement wins.

Full requirements: ~/.keel/requirements.md
Project requirements: .keel/requirements.md (if present)
`
  if (!existsSync(clineRulesPath)) {
    writeFileSync(clineRulesPath, rulesContent, 'utf-8')
    console.log(chalk.green(`  ✓ Created ${clineRulesPath}`))
  } else if (!readFileSync(clineRulesPath, 'utf-8').includes('Keel standing requirements')) {
    appendClineRules(clineRulesPath, rulesContent)
    console.log(chalk.green(`  ✓ Appended Keel requirements to ${clineRulesPath}`))
  } else {
    console.log(chalk.dim(`  ${clineRulesPath} already has Keel requirements (skipping)`))
  }

  // MCP server — gives Cline an enforcement check tool.
  const clineDir = join(cwd, '.cline')
  const settingsPath = join(clineDir, 'cline_mcp_settings.json')
  let settings: { mcpServers?: Record<string, unknown> } = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      console.log(chalk.yellow(`  ⚠ ${settingsPath} has invalid JSON — creating a backup and starting fresh.`))
      copyFileSync(settingsPath, settingsPath + '.bak')
      settings = {}
    }
  }
  settings.mcpServers = settings.mcpServers || {}
  settings.mcpServers.keel = {
    command: 'keel',
    args: ['serve'],
    env: {},
  }
  mkdirSync(clineDir, { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
  console.log(chalk.green(`  ✓ Registered keel MCP server in ${settingsPath}`))
}

function appendClineRules(path: string, content: string) {
  const existing = readFileSync(path, 'utf-8').trimEnd()
  writeFileSync(path, existing + '\n\n' + content, 'utf-8')
}

// ── Cursor (advisory: .cursor/rules declarative rules) ──
async function installCursor() {
  const cwd = process.cwd()
  const rulesDir = join(cwd, '.cursor', 'rules')
  const rulePath = join(rulesDir, 'keel.mdc')

  const mdc = `---
description: Keel enforcement — standing requirements and rule reminders
globs: **/*
alwaysApply: true
---

# Keel enforcement

This project uses Keel to enforce rules OUTSIDE the agent's context window.
Follow these standing requirements at all times:

- Before claiming completion ("done", "fixed", "verified"), run the project's tests and include the output as evidence.
- Build success does not mean tests pass. Run tests, not just a build.
- When choosing a format, config, or convention, ask the user what they use. Never default.
- Re-check the user's standing requirements in long sessions — early instructions degrade from context.
- If a requirement conflicts with recently accessed information, the standing requirement wins.

Keel rules are enforced at tool-call time by the OpenCode plugin or Claude Code hooks.
Full rules: ~/.keel/rules.yaml
Full requirements: ~/.keel/requirements.md
`

  mkdirSync(rulesDir, { recursive: true })
  writeFileSync(rulePath, mdc, 'utf-8')
  console.log(chalk.green(`  ✓ Created ${rulePath}`))
  console.log(chalk.dim('  Note: Cursor has no blocking hooks — these are advisory rules.'))
}

// ── Codex CLI (advisory: AGENTS.md section) ──
async function installCodex() {
  const cwd = process.cwd()
  const agentsPath = join(cwd, 'AGENTS.md')

  const section = `
## Keel standing requirements

This project enforces standing requirements via Keel. Follow them at all times:

- Before claiming completion, run the project's tests and include the output as evidence.
- Build success does not mean tests pass. Run tests, not just a build.
- When choosing a format, config, or convention, ask the user what they use. Never default.
- Re-check the user's standing requirements in long sessions — early instructions degrade from context.
- If a requirement conflicts with recently accessed information, the standing requirement wins.

Full requirements: ~/.keel/requirements.md
`

  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, section.trimStart(), 'utf-8')
    console.log(chalk.green(`  ✓ Created ${agentsPath} with Keel requirements`))
  } else if (!readFileSync(agentsPath, 'utf-8').includes('Keel standing requirements')) {
    const existing = readFileSync(agentsPath, 'utf-8').trimEnd()
    writeFileSync(agentsPath, existing + '\n' + section, 'utf-8')
    console.log(chalk.green(`  ✓ Appended Keel requirements to ${agentsPath}`))
  } else {
    console.log(chalk.dim(`  ${agentsPath} already has Keel requirements (skipping)`))
  }
  console.log(chalk.dim('  Note: Codex CLI has no blocking hooks — these are advisory instructions.'))
}
