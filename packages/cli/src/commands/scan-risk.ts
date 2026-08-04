import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Risk assessment for `keel scan`.
 *
 * `keel scan` already discovers which agent hosts and MCP servers exist on a
 * machine. Discovery alone tells a user nothing they did not know. This module
 * turns that inventory into ranked, actionable findings — which is what makes
 * `npx @get-keel/cli scan` worth running before installing anything.
 *
 * Two rules govern every check here:
 *
 *   - A finding must be ACTIONABLE. If keel ships no adapter for a host,
 *     saying "unprotected" is noise the user cannot fix, so those are marked
 *     unsupported instead of flagged.
 *   - A finding must cite EVIDENCE — the actual path or command that tripped
 *     it. An unattributed warning cannot be verified, and unverifiable
 *     warnings are how scanners train people to ignore them.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface McpServer {
  name: string
  command?: string
  args?: string[]
  url?: string
  type: 'stdio' | 'http' | 'sse'
}

export interface DetectedTool {
  name: string
  installed: boolean
  configPaths: string[]
  mcpServers: McpServer[]
  skillsDirs: string[]
}

export interface Finding {
  id: string
  severity: Severity
  title: string
  evidence: string
  remediation: string
}

export interface ProtectionStatus {
  host: string
  /** Whether keel ships an enforcement adapter for this host at all. */
  supported: boolean
  enforced: boolean
  artifact: string | null
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/**
 * Where `keel install` actually writes each host's enforcement artifact.
 * These paths mirror packages/cli/src/commands/install.ts — if they drift,
 * scan reports "unprotected" on a protected machine, which is the single
 * worst false positive this command can produce.
 */
function keelArtifactsFor(host: string, home: string, cwd: string): string[] {
  switch (host) {
    case 'opencode':
      return [
        join(home, '.opencode', 'plugins', 'keel-enforce.js'),
        join(cwd, '.opencode', 'plugins', 'keel-enforce.js'),
      ]
    case 'claude-code':
      return [join(cwd, '.claude', 'hooks', 'PreToolUse', 'keel-enforce')]
    case 'cline':
      return [join(home, '.cline', 'hooks', 'PreToolUse')]
    case 'cursor':
      return [join(cwd, '.cursor', 'hooks', 'keel-enforce.sh')]
    case 'codex':
      return [join(home, '.codex', 'hooks', 'keel-enforce.sh')]
    case 'gemini-cli':
      return [join(home, '.gemini', 'hooks', 'PreToolUse')]
    case 'hermes':
      return [join(home, '.hermes', 'plugins', 'keel', 'keel_plugin.py')]
    case 'openclaw':
      return [join(home, '.openclaw', 'plugins', 'keel', 'index.mjs')]
    default:
      // No adapter exists — see assessProtection().
      return []
  }
}

/** Hosts keel can actually enforce. Anything else is reported, not blamed. */
const SUPPORTED_HOSTS = new Set([
  'opencode', 'claude-code', 'cline', 'cursor', 'codex', 'gemini-cli', 'hermes', 'openclaw',
])

export function assessProtection(tools: DetectedTool[], home: string, cwd: string): ProtectionStatus[] {
  return tools
    .filter(t => t.installed)
    .map(t => {
      const supported = SUPPORTED_HOSTS.has(t.name)
      const artifact = keelArtifactsFor(t.name, home, cwd).find(p => existsSync(p)) ?? null
      return { host: t.name, supported, enforced: artifact !== null, artifact }
    })
}

/** `npx pkg` runs whatever is newest; `npx pkg@1.2.3` runs what you audited. */
const RUNNER_COMMANDS = new Set(['npx', 'bunx', 'pnpx', 'uvx', 'pipx'])
const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'])

function isPinned(spec: string): boolean {
  // `@scope/name@1.2.3` → pinned. `@scope/name` and `name@latest` → not.
  const at = spec.lastIndexOf('@')
  if (at <= 0) return false
  const version = spec.slice(at + 1)
  return version.length > 0 && version !== 'latest' && version !== 'next'
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url)
}

export function assessMcpRisk(tools: DetectedTool[]): Finding[] {
  const findings: Finding[] = []

  for (const tool of tools) {
    for (const server of tool.mcpServers) {
      const where = `${tool.name} → MCP server "${server.name}"`
      const args = server.args ?? []

      if (server.command && SHELL_COMMANDS.has(server.command)) {
        findings.push({
          id: 'mcp-shell-exec',
          severity: 'critical',
          title: 'MCP server runs through a shell',
          evidence: `${where}: ${server.command} ${args.join(' ')}`.trim(),
          remediation: 'Invoke the server binary directly instead of via a shell, so its command line cannot be rewritten by whatever it interpolates.',
        })
      }

      if (server.command && RUNNER_COMMANDS.has(server.command)) {
        const pkg = args.find(a => !a.startsWith('-'))
        if (pkg && !isPinned(pkg)) {
          findings.push({
            id: 'mcp-unpinned-package',
            severity: 'high',
            title: 'MCP server installs an unpinned package at launch',
            evidence: `${where}: ${server.command} ${args.join(' ')}`.trim(),
            remediation: `Pin the version (e.g. ${pkg}@1.2.3). Unpinned runners fetch whatever is newest, which is the slopsquatting and dependency-confusion vector.`,
          })
        }
      }

      if (server.url && /^http:\/\//i.test(server.url) && !isLocalUrl(server.url)) {
        findings.push({
          id: 'mcp-plaintext-transport',
          severity: 'high',
          title: 'MCP server uses an unencrypted transport',
          evidence: `${where}: ${server.url}`,
          remediation: 'Use https://. Tool arguments and results — which routinely include file contents and credentials — travel over this connection in cleartext.',
        })
      }
    }
  }

  return findings
}

export function assessRisk(tools: DetectedTool[], home: string, cwd: string): Finding[] {
  const findings: Finding[] = [...assessMcpRisk(tools)]

  const protection = assessProtection(tools, home, cwd)
  const unprotected = protection.filter(p => p.supported && !p.enforced)

  if (unprotected.length > 0) {
    findings.push({
      id: 'agent-unprotected',
      severity: 'high',
      title: `${unprotected.length} agent host${unprotected.length === 1 ? '' : 's'} can run tools with no enforcement`,
      evidence: unprotected.map(p => p.host).join(', '),
      remediation: 'Run `keel install --all` (or `--<host>` individually). Until then nothing stops these agents from running a destructive command.',
    })
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

export function worstSeverity(findings: Finding[]): Severity | null {
  if (findings.length === 0) return null
  return findings.reduce<Severity>(
    (worst, f) => (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[worst] ? f.severity : worst),
    'low',
  )
}
