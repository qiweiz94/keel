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

export async function findTemplateSource(name: string): Promise<string | null> {
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

export const DEFAULT_RULES_YAML = `# Keel rules — enforced OUTSIDE agent context (via OpenCode plugin)
# These rules cannot be forgotten, overridden, or degraded by context rot.
# Layer 3 enforcement (semantic) — runs before every tool dispatch.
version: 1
level: balanced
rules:
  - id: product-name-is-keel
    type: command
    match: "(sed|replaceAll|rename).{0,80}(keel|product).{0,40}(ai-enforce)"
    action: deny
    level: sprint
    priority: 100
    message: "Product name is 'keel'. Never change it back to ai-enforce."

  - id: keel-control-gate
    type: command
    match: "keel (disable|allow|level|enforce|install|uninstall)( |$)"
    action: deny
    level: protect
    priority: 100
    message: "keel controls are user-owned — run keel disable|allow|level|install in your own terminal, not through the agent."

  - id: no-rules-tampering
    type: filesystem
    paths:
      - "**/.keel/rules.yaml"
      - "**/.keel.local.yaml"
      - "**/.config/keel/rules.yaml"
      - "**/.keel/DISABLED"
      - "**/.opencode/plugins/**"
      - "**/.keel/plugins/**"
    action: deny
    level: protect
    priority: 90
    message: "Modifying keel's own rules, state, or plugin files is blocked."

  - id: no-enforcer-removal
    type: command
    match: "rm[^|;&]*[.]opencode/plugins/|rm[^|;&]*[.]keel/(rules[.]yaml|plugins|DISABLED)"
    action: deny
    level: protect
    priority: 90
    message: "Removing keel's enforcement files is blocked."

  - id: source-change-requires-test
    type: verification
    trigger:
      tools: [write, edit, apply_patch, WriteFile]
      path: "src/"
      paths: ["package.json"]
      pattern: "(src/|package[.]json)"
    satisfy:
      tools: [Bash]
      pattern: "(npm test|npm run test|vitest|jest)"
    boundaries:
      commit:
        pattern: "git commit"
        action: warn
      push:
        pattern: "git push"
        action: deny
    verification_window_seconds: 300
    action: deny
    message: "Source changes require a successful test run before commit or push."

  - id: verify-format-before-decision
    type: command
    match: "(default|choose).*(format|config|rule)"
    action: warn
    unless:
      - regex: "git config|npm config|pnpm config|yarn config|bun config|npx( |$)|npm exec|pipx|dlx( |$)|init( |$)|-y( |$)|--yes"
    message: "You are choosing a format without verifying the user. Ask what they use before deciding."

  - id: no-force-push
    type: command
    match: "git ((--no-pager )|(-C [^ ]+ ))*push.*--force(?!-with-lease)( |=|$)|git ((--no-pager )|(-C [^ ]+ ))*push.*(^| )-f( |=|$)"
    action: deny
    level: sprint
    message: "Use --force-with-lease instead of --force."
  - id: no-verify-bypass
    type: command
    match: "git ((--no-pager )|(-C [^ ]+ ))*(commit|push|merge)(( [^ ]+))*? --no-verify( |$)|git ((--no-pager )|(-C [^ ]+ ))*(commit|push|merge)(( [^ ]+))*? -c[ =][^ ]*?core[.]hooksPath(?![/0-9A-Za-z_])|git ((--no-pager )|(-C [^ ]+ ))*-c[ =][^ ]*?core[.]hooksPath(?![/0-9A-Za-z_])|git commit( [^ ]+)* -n( |$)"
    action: deny
    level: sprint
    priority: 90
    message: "Never bypass git hooks with --no-verify, -n, or core.hooksPath."

  - id: no-curl-pipe-shell
    type: command
    match: "(curl|wget)[^|;&]*[|] *(sudo )*(ba)?sh( |$)|bash <[(]curl"
    action: deny
    level: sprint
    message: "Piping a remote script into a shell executes arbitrary code — blocked."
  - id: no-db-destructive
    type: command
    match: "(psql|mysql|sqlite3|mariadb|pg_restore|cockroach)( |$)[^|;&]*(DROP TABLE|TRUNCATE( |$)|DROP DATABASE|DELETE FROM)"
    action: prompt
    level: sprint
    priority: 80
    message: "Destructive database operation — approval required."
  - id: no-push-to-main
    type: command
    match: "git push( [^ ]+){0,3} (main|master)( |$)|git push.*[:](main|master)( |$)"
    action: prompt
    level: sprint
    priority: 80
    message: "Pushing directly to a protected branch — approval required."
  - id: no-remote-exec
    type: command
    match: "(npx|bunx|npm exec|pipx)( |$)|(pnpm|yarn) dlx( |$)"
    action: prompt
    level: sprint
    priority: 80
    message: "On-the-fly package execution downloads and runs remote code — approval required."


  - id: no-after-hours-publish
    type: time
    match: "git push|npm publish|gh release create|gh release delete|gh repo delete|gh repo transfer"
    schedule:
      start: "09:00"
      end: "22:00"
    action: warn
    level: sprint
    priority: 0
    message: "Publishing or pushing outside 09:00-22:00 — double-check the release is intentional."

  - id: bash-rate-limit
    type: rate
    match: "Bash"
    window_seconds: 60
    max_calls: 30
    action: warn
    level: sprint
    priority: 0
    message: "More than 30 Bash calls in 60 seconds — possible runaway loop. Slow down."

  - id: no-skip-tests
    type: command
    match: "(npm|pnpm|yarn)( run)? test[^|;&]*--(passWithNoTests|skipTests|no-run)( |$)"
    action: deny
    level: sprint
    message: "Faking a green test run is not verification — run the suite."
  - id: no-secrets-in-code
    type: content
    patterns:
      - regex: "AKIA[0-9A-Z]{16}"
      - regex: "ghp_[A-Za-z0-9]{36}"
      - regex: "github_pat_[A-Za-z0-9_]{22,}"
      - regex: "xox[baprs]-[A-Za-z0-9-]{10,}"
      - regex: "sk-[A-Za-z0-9_-]{24,}"
      - regex: "BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY"
      - regex: "-----BEGIN PRIVATE KEY-----"
      - regex: "aws_secret_access_key[\t ]*[:=]"
    action: deny
    level: sprint
    message: "Hardcoded credentials must not be written to files."
  - id: no-secret-files
    type: filesystem
    paths:
      - "**/.env*"
      - "**/.npmrc"
      - "**/.git-credentials"
      - "**/.netrc"
      - "**/.pgpass"
      - "**/*.pem"
      - "**/*.pfx"
      - "**/*.p12"
      - "**/.ssh/**"
      - "**/id_rsa*"
      - "**/id_ed25519*"
    exclude:
      - "**/.env.example"
      - "**/.env.sample"
      - "**/.env.test"
    action: deny
    level: sprint
    message: "Writing or modifying credential files is blocked."
  - id: no-credential-echo
    type: env
    vars:
      - AWS_SECRET_ACCESS_KEY
      - AWS_ACCESS_KEY_ID
      - GITHUB_TOKEN
      - NPM_TOKEN
      - NODE_AUTH_TOKEN
      - OPENAI_API_KEY
      - ANTHROPIC_API_KEY
      - CLOUDFLARE_API_TOKEN
    action: deny
    level: sprint
    message: "Exposing environment credentials in commands is blocked."
  - id: no-exfil-flow
    type: flow
    sources:
      - "**/.env*"
      - "**/.ssh/**"
      - "**/*.pem"
      - "**/.git-credentials"
    sinks: [network]
    action: deny
    message: "Data read from sensitive files must not be sent over the network."

  - id: no-destructive-commands
    type: command
    match: "rm -rf /(?!tmp|var/tmp)|rm -rf ~|rm -rf [.]( |$)|rm -rf [.][.]( |/|$)|rm -rf [.][/](([*])?( |$))|rm -rf [*]( |$)|rm -rf /tmp/[^ ]*[.][.]([/ ]|$)|chmod -R 777 ([/~][^ ]*|[.])( |$)|mkfs[.0-9]*( |$)|mke2fs( |$)|shred( |$)|wipefs( |$)|blkdiscard( |$)|dd if=[^ ]+ of=/dev/[^ ]+|[; ][:][ \t]*[()][ \t]*[()][ \t]*[{][ \t]*[:][ \t]*[|]:&|^[:][ \t]*[()][ \t]*[()][ \t]*[{][ \t]*[:][ \t]*[|]:&"
    action: deny
    level: sprint
    message: "Destructive commands (including fork bombs) are blocked."

  - id: must-sign-commits
    type: command
    match: "git commit(?!.*--signoff)"
    action: fix
    fix:
      - pattern: "git commit"
        replace: "git commit --signoff"
    message: "Auto-adding --signoff to commits."

  - id: git-history-rewrite
    type: command
    match: "git filter-branch|git rebase|git reset (--hard|--soft|--keep|--merge|HEAD~)|git commit --amend|git stash (drop|clear)"
    action: prompt
    level: sprint
    priority: 80
    message: "Git history mutation — this rewrites shared history. Approval required."
  - id: publish-gate
    type: command
    match: "npm publish|npm unpublish|gh release create|gh release delete|gh repo delete|gh repo transfer|git push.*[ \t](--delete|-d)( |$)"
    action: prompt
    level: sprint
    priority: 80
    message: "Publishing or deleting registry artifacts — approval required."
`

/**
 * `keel install --mcp` — print ready-to-paste MCP config snippets. keel
 * speaks MCP (stdio or streamable-http) so ANY MCP-native agent platform
 * gets the keel_check / keel_audit / keel_requirements tools.
 */
function printMcpConfigs(): void {
  console.log(chalk.bold.cyan('\n  ⚓ keel as an MCP server'))
  console.log()
  console.log(chalk.dim('  keel serves keel_check (policy verdict), keel_audit (trace), and'))
  console.log(chalk.dim('  keel_requirements (standing requirements). Pick one transport:'))
  console.log()
  console.log(chalk.white('  STDIO (any platform that launches an MCP server):'))
  console.log(`    ${chalk.dim('command:')} keel`)
  console.log(`    ${chalk.dim('args:')} ["serve"]`)
  console.log()
  console.log(chalk.white('  STREAMABLE-HTTP (platforms with url-based MCP config):'))
  console.log(`    ${chalk.dim('url:')} http://127.0.0.1:3100`)
  console.log(`    ${chalk.dim('transport:')} streamable-http`)
  console.log(`    ${chalk.dim('headers:')} { "Authorization": "Bearer $KEEL_DAEMON_TOKEN" }`)
  console.log()
  console.log(chalk.white('  OpenClaw:'))
  console.log('    openclaw mcp set keel --command keel --args "[\'serve\']"')
  console.log()
  console.log(chalk.white('  Hermes (~/.hermes/config.yaml):'))
  console.log('    mcp_servers:')
  console.log('      keel:')
  console.log("        command: keel")
  console.log("        args: ['serve']")
  console.log()
  console.log(chalk.white('  Cline (.cline/cline_mcp_settings.json):'))
  console.log('    { "mcpServers": { "keel": { "command": "keel", "args": ["serve"] } } }')
  console.log()
  console.log(chalk.white('  OpenCode (opencode.json):'))
  console.log('    { "mcp": { "keel": { "type": "local", "command": ["keel", "serve"] } } }')
  console.log()
  console.log(chalk.white('  Claude Code (.mcp.json):'))
  console.log('    { "mcpServers": { "keel": { "command": "keel", "args": ["serve"] } } }')
  console.log()
  console.log(chalk.dim('  The tools are advisory for the agent (self-checks + audit); for hard'))
  console.log(chalk.dim('  enforcement use the pre-tool hook integration (keel install --opencode,'))
  console.log(chalk.dim('  --claude-code) or the gateway (keel gateway --command "<tool server>").'))
  console.log()
}

export async function installCommand(options: {
  opencode?: boolean
  project?: boolean
  claudeCode?: boolean
  cline?: boolean
  cursor?: boolean
  codex?: boolean
  hermes?: boolean
  mcp?: boolean
  all?: boolean
}) {
  const keelDir = join(homedir(), '.keel')
  const rulesPath = join(keelDir, 'rules.yaml')

  // Rules are the base layer: EVERY install mode ensures ~/.keel/rules.yaml
  // exists (keel install --opencode must not leave "Next steps: review
  // rules.yaml" pointing at a file it never created). Idempotent when present.
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

  if (options.mcp) {
    printMcpConfigs()
    return
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

  if (options.hermes || options.all) {
    await installHermes()
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

/**
 * Hermes Agent plugin — a thin client over the keel daemon.
 *
 * Hermes plugins are Python with a YAML manifest, so unlike the OpenCode
 * plugin there is nothing to bundle: two files into
 * ~/.hermes/plugins/keel/ and the daemon does the enforcing.
 */
async function installHermes() {
  const dir = join(homedir(), '.hermes', 'plugins', 'keel')
  mkdirSync(dir, { recursive: true })

  const plugin = await findTemplateSource(join('hermes', 'keel_plugin.py'))
  const manifest = await findTemplateSource(join('hermes', 'plugin.yaml'))
  if (!plugin || !manifest) {
    console.log(chalk.red('  ✗ Hermes plugin source not found. Run from the keel repo or reinstall the CLI.'))
    return
  }
  copyFileSync(plugin, join(dir, 'keel_plugin.py'))
  copyFileSync(manifest, join(dir, 'plugin.yaml'))
  // Hermes requires __init__.py exposing register(ctx).
  writeFileSync(join(dir, '__init__.py'), 'from .keel_plugin import register  # noqa: F401\n')
  console.log(chalk.green(`  ✓ Installed Hermes plugin to ${dir}`))

  createRequirementsFile()
  console.log()
  console.log(chalk.dim('  The Hermes plugin enforces through the keel daemon:'))
  console.log(chalk.dim('    • start it with `keel daemon` (it idles out after 10 min and respawns)'))
  console.log(chalk.dim('    • if the daemon is unreachable, only catastrophic commands are blocked'))
  console.log(chalk.dim('      and the plugin says so loudly — it never silently stops enforcing'))
  // Say what is NOT enforced, rather than letting it look covered.
  console.log(chalk.yellow('    • Hermes cannot rewrite tool arguments, so keel `fix` rules are'))
  console.log(chalk.yellow('      advisory there — they are reported, not applied'))
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
