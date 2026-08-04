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
const RUNNER_COMMANDS = new Set(['npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'dlx'])
const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'powershell', 'pwsh'])
/** Windows wrappers. `cmd /c npx …` is the DOCUMENTED MCP config shape. */
const WRAPPER_COMMANDS = new Set(['cmd', 'cmd.exe'])

/**
 * Commands arrive as `sh`, `/bin/sh`, or `npx.cmd` depending on platform and
 * how the config was written. Matching the raw string missed every absolute
 * path — `/opt/homebrew/bin/npx` sailed through unchecked.
 */
function commandName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command
  return base.replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase()
}

/**
 * Pinned means an EXACT version. Ranges (`^1.0.0`, `1`, `~1.2`, `*`) and
 * mutable dist-tags (`beta`, `canary`) all resolve to whatever is newest at
 * launch, which is the entire supply-chain risk this check exists to catch —
 * yet the old test only blacklisted `latest` and `next` and passed the rest.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** A local path has no version to pin — flagging it would be noise. */
function isLocalPath(spec: string): boolean {
  return /^[./~]/.test(spec)
}

/** git+ssh://…, https://… — a remote ref, pinned only by an explicit #ref. */
function isRemoteRef(spec: string): boolean {
  return /^[a-z+]+:\/\//i.test(spec) || spec.startsWith('git+')
}

/** Whether this spec is something we can meaningfully judge as pinned. */
function isVersionedSpec(spec: string): boolean {
  return !isLocalPath(spec)
}

function isPinned(spec: string): boolean {
  // A remote ref resolves to the default branch unless a ref is given, so
  // `git+ssh://git@host/repo` is unpinned — and its userinfo `@` must never
  // be mistaken for a version.
  if (isRemoteRef(spec)) return /#.+$/.test(spec)
  const at = spec.lastIndexOf('@')
  if (at <= 0) return false
  return EXACT_VERSION.test(spec.slice(at + 1))
}

/** Runner flags that consume the next argument, so it is not the package. */
const VALUE_FLAGS = new Set(['--python', '--registry', '--from', '--with', '--index-url', '--index', '-p', '--package'])

/**
 * Pick the package spec from a runner's arguments. `args.find(a => !a.startsWith('-'))`
 * returned option VALUES: `uvx --python 3.11 srv@1.2.3` yielded `3.11`, so a
 * correctly pinned server was reported unpinned and the real package never checked.
 */
function packageSpec(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (VALUE_FLAGS.has(arg)) {
      // `--from pkg` names the package itself; other value flags do not.
      if (arg === '--from' || arg === '--package' || arg === '-p') return args[i + 1]
      i++
      continue
    }
    if (arg.startsWith('-')) continue
    return arg
  }
  return undefined
}

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0.0.0.0', '::'])

/**
 * Parse rather than regex. The old pattern matched on the raw URL prefix, so
 * `http://localhost:3000@evil.com` — where `localhost:3000` is userinfo and
 * the real host is evil.com — was reported as local, and every loopback
 * address outside 127.0.0.1 (all of 127.0.0.0/8) was reported as remote.
 */
function isLocalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (LOOPBACK_HOSTS.has(hostname)) return true
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true
    if (/^::ffff:127\./i.test(hostname)) return true
    return false
  } catch {
    return false
  }
}

export function assessMcpRisk(tools: DetectedTool[]): Finding[] {
  const findings: Finding[] = []

  for (const tool of tools) {
    for (const server of tool.mcpServers) {
      const where = `${tool.name} → MCP server "${server.name}"`
      const rawArgs = server.args ?? []
      const shown = `${server.command ?? server.url ?? ''} ${rawArgs.join(' ')}`.trim()

      // `cmd /c npx -y pkg` is the documented Windows MCP shape, not an
      // exploit. Unwrap it and judge what it actually runs; flagging the
      // wrapper put a CRITICAL false positive in front of every Windows user
      // following the official setup docs, AND skipped the real package.
      let command = server.command ? commandName(server.command) : ''
      let args = rawArgs
      if (WRAPPER_COMMANDS.has(command)) {
        const rest = rawArgs.slice(rawArgs[0] === '/c' || rawArgs[0] === '/k' ? 1 : 0)
        if (rest.length > 0) {
          command = commandName(rest[0])
          args = rest.slice(1)
        }
      }

      if (command && SHELL_COMMANDS.has(command)) {
        findings.push({
          id: 'mcp-shell-exec',
          severity: 'critical',
          title: 'MCP server runs through a shell',
          evidence: `${where}: ${shown}`,
          remediation: 'Invoke the server binary directly instead of via a shell, so its command line cannot be rewritten by whatever it interpolates.',
        })
      }

      if (command && RUNNER_COMMANDS.has(command)) {
        const pkg = packageSpec(args)
        if (pkg && isVersionedSpec(pkg) && !isPinned(pkg)) {
          findings.push({
            id: 'mcp-unpinned-package',
            severity: 'high',
            title: 'MCP server installs an unpinned package at launch',
            evidence: `${where}: ${shown}`,
            remediation: `Pin the version (e.g. ${pkg.split('@')[0] || pkg}@1.2.3). Unpinned runners resolve to whatever is newest at launch, which is the slopsquatting and dependency-confusion vector.`,
          })
        }
      }

      if (server.url && /^(http|ws):\/\//i.test(server.url) && !isLocalUrl(server.url)) {
        findings.push({
          id: 'mcp-plaintext-transport',
          severity: 'high',
          title: 'MCP server uses an unencrypted transport',
          evidence: `${where}: ${server.url}`,
          remediation: 'Use https:// (or wss://). Tool arguments and results — which routinely include file contents and credentials — travel over this connection in cleartext.',
        })
      }
    }
  }

  // The same server can appear in both a global and a project config, which
  // produced byte-identical duplicate findings and inflated the count.
  const seen = new Set<string>()
  return findings.filter(f => {
    const key = `${f.id} ${f.evidence}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
