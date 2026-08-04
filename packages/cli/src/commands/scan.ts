import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import chalk from 'chalk'
import { assessRisk, assessProtection, worstSeverity, type Severity } from './scan-risk.js'

/**
 * keel scan command
 * Auto-discovers AI coding assistant configurations on the machine.
 * Inspired by Snyk Agent Scan's discovery pipeline.
 */

interface DetectedTool {
  name: string
  installed: boolean
  configPaths: string[]
  mcpServers: Array<{
    name: string
    command?: string
    args?: string[]
    url?: string
    type: 'stdio' | 'http' | 'sse'
  }>
  skillsDirs: string[]
}

const HOME = homedir()
const IS_MAC = platform() === 'darwin'
const IS_LINUX = platform() === 'linux'
const IS_WIN = platform() === 'win32'

// Per-OS file path definitions for every supported AI agent
// Based on Snyk Agent Scan's well_known_clients.py data model
const AGENT_PATHS: Record<string, {
  installCheck: string[]
  configs: string[]
  skills?: string[]
  managed?: Record<string, string>
  workspace?: string[]
  platform?: string[]
}> = {
  'claude-code': {
    installCheck: [join(HOME, '.claude')],
    configs: [
      join(HOME, '.claude.json'),
    ],
    skills: [join(HOME, '.claude', 'skills')],
    // Claude Code's documented project-scope MCP file. It was the only host
    // with no workspace entry, so project-scoped servers were never read.
    workspace: ['.mcp.json'],
    managed: IS_MAC
      ? { darwin: '/Library/Application Support/ClaudeCode/managed-mcp.json' }
      : IS_LINUX
      ? { linux: '/etc/claude-code/managed-mcp.json' }
      : { win32: '%PROGRAMFILES%/ClaudeCode/managed-mcp.json' },
  },
  'cursor': {
    installCheck: [join(HOME, '.cursor')],
    configs: [join(HOME, '.cursor', 'mcp.json')],
    skills: [join(HOME, '.cursor', 'skills')],
    workspace: ['.cursor/mcp.json'],
  },
  'windsurf': {
    installCheck: [join(HOME, '.codeium')],
    configs: [join(HOME, '.codeium', 'windsurf', 'mcp_config.json')],
    skills: [join(HOME, '.codeium', 'windsurf', 'skills')],
    workspace: ['.windsurf/mcp.json'],
  },
  'vscode': {
    installCheck: [join(HOME, '.vscode')],
    configs: IS_MAC ? [
      join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
      join(HOME, '.vscode', 'mcp.json'),
      join(HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    ] : IS_LINUX ? [
      join(HOME, '.config', 'Code', 'User', 'settings.json'),
      join(HOME, '.vscode', 'mcp.json'),
      join(HOME, '.config', 'Code', 'User', 'mcp.json'),
    ] : [
      join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),
      join(HOME, '.vscode', 'mcp.json'),
    ],
    skills: [join(HOME, '.copilot', 'skills')],
    workspace: ['.vscode/mcp.json'],
  },
  'claude-desktop': {
    installCheck: IS_MAC
      ? [join(HOME, 'Library', 'Application Support', 'Claude')]
      : IS_WIN
      ? [join(HOME, 'AppData', 'Roaming', 'Claude')]
      : [],
    configs: IS_MAC
      ? [join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')]
      : IS_WIN
      ? [join(HOME, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')]
      : [],
  },
  'gemini-cli': {
    // Host-owned markers: `keel install --gemini` writes
    // ~/.gemini/hooks/PreToolUse, which creates ~/.gemini.
    installCheck: [
      join(HOME, '.gemini', 'settings.json'),
      join(HOME, '.gemini', 'installation_id'),
      join(HOME, '.gemini', 'oauth_creds.json'),
    ],
    configs: [join(HOME, '.gemini', 'settings.json')],
    skills: [join(HOME, '.gemini', 'skills')],
  },
  'amazon-q': {
    installCheck: [join(HOME, '.aws', 'amazonq')],
    configs: [
      join(HOME, '.aws', 'amazonq', 'agents', 'default.json'),
      join(HOME, '.aws', 'amazonq', 'agents', 'mcp.json'),
      join(HOME, '.aws', 'amazonq', 'mcp.json'),
    ],
  },
  'antigravity': {
    installCheck: [join(HOME, '.gemini', 'antigravity')],
    configs: [join(HOME, '.gemini', 'antigravity', 'mcp_config.json')],
  },
  'kiro': {
    installCheck: [join(HOME, '.kiro')],
    configs: [join(HOME, '.kiro', 'settings', 'mcp.json')],
    workspace: ['.kiro/mcp.json'],
  },
  'opencode': {
    installCheck: [join(HOME, '.config', 'opencode')],
    configs: [],
  },
  'codex': {
    // Host-owned markers: `keel install --codex` writes ~/.codex/hooks/,
    // which creates ~/.codex — so the bare directory would make keel's own
    // installer "prove" Codex is present.
    installCheck: [
      join(HOME, '.codex', 'config.toml'),
      join(HOME, '.codex', 'auth.json'),
    ],
    configs: [],
    skills: [join(HOME, '.codex', 'skills')],
  },
  // The three below need HOST-OWNED marker files rather than the bare
  // directory: `keel install --cline` creates ~/.cline/hooks/ and
  // `--openclaw` creates ~/.openclaw/plugins/keel/, so detecting on the
  // parent directory would make installing keel "prove" the host exists.
  // That false positive would land on the exact claim scan is built to
  // make ("this host is unprotected"), so it must key on files only the
  // host writes.
  'cline': {
    installCheck: [
      join(HOME, '.cline', 'data', 'settings', 'providers.json'),
      join(HOME, '.cline', 'data'),
    ],
    configs: [join(HOME, '.cline', 'data', 'settings', 'mcp_settings.json')],
    workspace: ['.cline/mcp.json'],
  },
  'openclaw': {
    installCheck: [join(HOME, '.openclaw', 'openclaw.json')],
    configs: [join(HOME, '.openclaw', 'openclaw.json')],
  },
  'hermes': {
    // Not installed on any machine this was built against — best effort,
    // matching the `docs`-level verification hermes carries in
    // docs/integrations.md.
    installCheck: [
      join(HOME, '.hermes', 'config.yaml'),
      join(HOME, '.hermes', 'hermes.json'),
    ],
    configs: [join(HOME, '.hermes', 'mcp.json')],
  },
}

function parseMCPConfig(filePath: string): Array<{ name: string; command?: string; args?: string[]; url?: string; type: 'stdio' | 'http' | 'sse' }> {
  try {
    if (!existsSync(filePath)) return []
    const raw = readFileSync(filePath, 'utf-8')
    const config = JSON.parse(raw)

    const toEntry = ([name, cfg]: [string, any]) => ({
      name,
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      type: (cfg.command ? 'stdio' : cfg.url ? 'http' : 'stdio') as 'stdio' | 'http' | 'sse',
    })

    // Format 1: {"mcpServers": {"name": {"command": "...", ...}}}
    if (config.mcpServers && typeof config.mcpServers === 'object')
      return Object.entries(config.mcpServers).map(toEntry)

    // Format 2: {"mcp": {"servers": {"name": {...}}}}
    if (config.mcp?.servers && typeof config.mcp.servers === 'object')
      return Object.entries(config.mcp.servers).map(toEntry)

    // Format 3: {"servers": {"name": {...}}}
    if (config.servers && typeof config.servers === 'object')
      return Object.entries(config.servers).map(toEntry)

    // Format 5: Claude Code — {"projects": {"<abs path>": {"mcpServers": {...}}}}
    // There is NO top-level mcpServers key in ~/.claude.json, so every check
    // above misses it and MCP findings on the flagship host were all false
    // negatives. Servers are merged across projects and de-duplicated by name.
    if (config.projects && typeof config.projects === 'object') {
      const byName = new Map<string, ReturnType<typeof toEntry>>()
      for (const project of Object.values(config.projects) as any[]) {
        if (!project?.mcpServers || typeof project.mcpServers !== 'object') continue
        for (const entry of Object.entries(project.mcpServers)) {
          const parsed = toEntry(entry as [string, any])
          if (!byName.has(parsed.name)) byName.set(parsed.name, parsed)
        }
      }
      if (byName.size > 0) return [...byName.values()]
    }

    // Format 4: {"name": {"command": "...", ...}}
    const entries = Object.entries(config).filter(([_, c]: [string, any]) => c && (c.command || c.url))
    if (entries.length > 0) return entries.map(toEntry)

    return []
  } catch {
    return []
  }
}

function detectTools(detectDir?: string): DetectedTool[] {
  const results: DetectedTool[] = []
  const cwd = detectDir || process.cwd()

  for (const [name, paths] of Object.entries(AGENT_PATHS)) {
    const tool: DetectedTool = {
      name,
      installed: false,
      configPaths: [],
      mcpServers: [],
      skillsDirs: [],
    }

    // Check installation
    for (const checkPath of paths.installCheck) {
      if (existsSync(checkPath)) {
        tool.installed = true
        break
      }
    }

    // Check config files
    for (const configPath of paths.configs) {
      tool.configPaths.push(configPath)
      const servers = parseMCPConfig(configPath)
      tool.mcpServers.push(...servers)
    }

    // Check workspace configs
    if (paths.workspace) {
      for (const wsPath of paths.workspace) {
        const fullPath = join(cwd, wsPath)
        if (existsSync(fullPath)) {
          tool.configPaths.push(fullPath)
          const servers = parseMCPConfig(fullPath)
          tool.mcpServers.push(...servers)
        }
      }
    }

    // Check skills directories
    if (paths.skills) {
      for (const skillPath of paths.skills) {
        if (existsSync(skillPath)) {
          tool.skillsDirs.push(skillPath)
        }
      }
    }

    results.push(tool)
  }

  return results
}

export async function scanCommand(options: { json?: boolean; dir?: string; ci?: boolean }) {
  const cwd = options.dir || process.cwd()

  // --json must emit ONLY JSON: anything else on stdout makes it unpipeable,
  // which is the one thing the flag exists for.
  if (!options.json) {
    console.log(chalk.cyan(`\nkeel scan — auditing this machine's AI agent setup\n`))
    console.log(`  Scanning: ${cwd}\n`)
  }

  const tools = detectTools(options.dir)

  const installed = tools.filter(t => t.installed)
  const withMCP = tools.filter(t => t.mcpServers.length > 0)
  const findings = assessRisk(tools, HOME, cwd)
  const protection = assessProtection(tools, HOME, cwd)

  if (options.json) {
    const output = {
      tools: tools.map(t => ({
        name: t.name,
        installed: t.installed,
        configPaths: t.configPaths.filter(p => existsSync(p)),
        mcpServers: t.mcpServers,
        skillsDirs: t.skillsDirs.filter(p => existsSync(p)),
        configCount: t.configPaths.filter(p => existsSync(p)).length,
        mcpCount: t.mcpServers.length,
      })),
      protection,
      findings,
      summary: {
        hostsInstalled: installed.length,
        hostsUnprotected: protection.filter(p => p.supported && !p.enforced).length,
        worstSeverity: worstSeverity(findings),
      },
    }
    console.log(JSON.stringify(output, null, 2))
    if (options.ci && findings.length > 0) process.exit(1)
    return
  }

  // NOT an early return. MCP servers are read from project configs too, so a
  // machine with no installed host can still carry a critical finding — and
  // returning here printed "nothing detected" and exited 0 while
  // `--json --ci` on the same input exited 1 with a CRITICAL `curl | sh`
  // server. Anyone running `keel scan --ci` in a pipeline got a false pass.
  if (installed.length === 0) {
    console.log(chalk.yellow('  No AI coding assistants detected on this machine.\n'))
  } else {
    console.log(chalk.green(`  Found ${installed.length} AI coding assistant(s):\n`))
  }

  for (const tool of installed) {
    const mcpCount = tool.mcpServers.length
    const configCount = tool.configPaths.filter(p => existsSync(p)).length
    const skillCount = tool.skillsDirs.filter(p => existsSync(p)).length

    console.log(`  ${chalk.bold(tool.name)}`)
    console.log(`    Config files: ${configCount}${tool.configPaths.map(p => existsSync(p) ? `\n      ${p}` : '').join('')}`)

    if (mcpCount > 0) {
      console.log(`    MCP servers: ${mcpCount}`)
      for (const server of tool.mcpServers) {
        const type = server.command ? `stdio:${server.command}` : server.url ? `http:${server.url}` : 'unknown'
        console.log(`      - ${server.name} (${type})`)
      }
    }

    if (skillCount > 0) {
      console.log(`    Skills directories: ${skillCount}`)
      for (const dir of tool.skillsDirs) {
        if (existsSync(dir)) console.log(`      ${dir}`)
      }
    }

    console.log('')
  }

  // ── Enforcement coverage ────────────────────────────────────────────
  const actionable = protection.filter(p => p.supported)
  if (actionable.length > 0) {
    console.log(chalk.bold('  Enforcement coverage\n'))
    for (const p of actionable) {
      const mark = p.enforced
        ? chalk.green('✓ enforced   ')
        : chalk.red('✗ unprotected')
      console.log(`    ${mark}  ${p.host}`)
      if (p.artifact) console.log(chalk.dim(`                   ${p.artifact}`))
    }
    console.log('')
  }

  // ── Findings ────────────────────────────────────────────────────────
  if (findings.length === 0) {
    console.log(chalk.green('  No risks found.\n'))
  } else {
    console.log(chalk.bold(`  ${findings.length} finding${findings.length === 1 ? '' : 's'}\n`))
    for (const f of findings) {
      console.log(`  ${severityBadge(f.severity)} ${chalk.bold(f.title)}`)
      console.log(chalk.dim(`     ${f.evidence}`))
      console.log(chalk.dim(`     → ${f.remediation}`))
      console.log('')
    }
  }

  if (withMCP.length > 0) {
    console.log(chalk.dim('  MCP servers execute commands on your machine with your privileges.\n'))
  }

  if (options.ci && findings.length > 0) process.exit(1)
}

function severityBadge(severity: Severity): string {
  switch (severity) {
    case 'critical': return chalk.bgRed.white.bold(' CRITICAL ')
    case 'high': return chalk.red.bold('   HIGH   ')
    case 'medium': return chalk.yellow.bold('  MEDIUM  ')
    case 'low': return chalk.dim('   LOW    ')
  }
}
