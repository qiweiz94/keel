import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeCommand,
  scoreSecretCandidate,
  SECRET_VALUE_SHAPE_PATTERNS,
  type NormalizedSubcommand,
} from '@get-keel/core'

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
  /** stdio launch-time environment, e.g. `{"OPENAI_API_KEY": "${OPENAI_API_KEY}"}`. */
  env?: Record<string, string>
  /** http/sse request headers, e.g. `{"Authorization": "Bearer ${TOKEN}"}`. */
  headers?: Record<string, string>
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

// ── Unsafe stdio startup-command patterns ───────────────────────────────
//
// modelcontextprotocol.io's security-best-practices page documents stdio
// servers as running with the SAME privileges and filesystem access as the
// host process launching them — there is no sandbox boundary in the spec
// itself. A launch command shaped like a privilege-escalation, wide-wipe,
// or unreviewed-remote-code pattern therefore runs on every single server
// start, unattended, which is a materially different risk than the same
// text appearing in a one-off agent-issued shell command (what
// command-normalizer.ts's other callers, e.g. the default `no-sudo`
// warn-rule, are built to judge).
//
// Detection reuses command-normalizer.ts rather than re-implementing a
// tokenizer: `command`+`args` is fed through normalizeCommand() the same
// way arg-utils.ts's commandSurfaces() feeds a live agent command through
// it, which gets quote-stripped/IFS-expanded/interpreter-body-extracted
// surfaces and a structured per-subcommand token list for free — closing
// the same obfuscation classes (`s"u"do`, `sh -c "..."` bodies) documented
// in that module, not just the literal top-level command.

/** A whitespace-bearing arg re-joined with bare spaces reads as MULTIPLE
 * words to normalizeCommand's tokenizer — `args: ['--message', 'rm -rf /']`
 * (one benign string argument) would otherwise present as the two words
 * `rm` and `-rf` immediately followed by `/`, exactly the false-positive
 * shape command-normalizer.ts's own module doc warns about for `echo "rm
 * -rf /"`. Quoting preserves it as the single argument it actually is.
 */
function quoteArgForNormalization(arg: string): string {
  if (arg === '') return "''"
  if (!/[\s"'\\$`]/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Decoded argv words for one subcommand, with any leading `NAME=value`
 * env-assignment prefix stripped — mirrors normalizeSubcommand's own cut
 * point (command-normalizer.ts) so `FOO=bar rm -rf /` is judged on `rm -rf
 * /`, not misread as `FOO=bar` being the command.
 */
function subcommandWords(sub: NormalizedSubcommand): string[] {
  let i = 0
  while (i < sub.tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(sub.tokens[i].value)) i++
  return sub.tokens.slice(i).map(t => t.value)
}

function flattenSubcommands(subs: NormalizedSubcommand[]): NormalizedSubcommand[] {
  const out: NormalizedSubcommand[] = []
  for (const sub of subs) {
    out.push(sub)
    if (sub.nested) out.push(...flattenSubcommands(sub.nested.subcommands))
  }
  return out
}

/** Wipe targets wide enough to be a root/home/cwd-level disaster — NOT
 * ordinary subdirectory cleanup. Mirrors install.ts's shipped
 * `no-destructive-commands` rule, which explicitly allows `rm -rf
 * node_modules` / `rm -rf dist` "by design (do-not-ship guard: no blanket
 * rm -rf block)" — an MCP startup-command check that flagged every
 * ordinary build-cache wipe would train users to ignore its findings.
 */
function isRootHomeWipeTarget(target: string): boolean {
  if (target === '/' || target === '~' || target === '.' || target === '..' || target === '*') return true
  if (/^\$\{?HOME\}?\/?$/.test(target)) return true
  if (target === '/*' || target === './*' || target === '../*' || target === '~/*') return true
  return false
}

/** `sudo rm -rf /` is `rm -rf /` with a privilege-escalation prefix, not a
 * different command — without stripping it, `commandName(words[0])` reads
 * `sudo` and the destructive-rm check below never even looks at the `rm`
 * that follows. Only strips a bare `sudo` (plus its own short flags, e.g.
 * `sudo -n`); a real `sudo` implementation always execs its argument as a
 * fresh command line, so this is a one-level, non-recursive strip.
 */
function stripSudoPrefix(words: string[]): string[] {
  if (words[0] !== 'sudo') return words
  let i = 1
  while (i < words.length && words[i].startsWith('-')) i++
  return words.slice(i)
}

/** `rm` with both a recursive and a force flag (`-rf`, `-fr`, `-r -f`,
 * `--recursive --force`, in either order or combined in one cluster like
 * `-rfv`) AND a root/home/cwd-wide target. */
function isDestructiveRmSubcommand(rawWords: string[]): boolean {
  const words = stripSudoPrefix(rawWords)
  if (words.length === 0 || commandName(words[0]) !== 'rm') return false
  let hasRecursive = false
  let hasForce = false
  const positional: string[] = []
  for (const w of words.slice(1)) {
    if (w === '--recursive') { hasRecursive = true; continue }
    if (w === '--force') { hasForce = true; continue }
    if (w.startsWith('--')) continue
    if (/^-[a-zA-Z]+$/.test(w)) {
      if (/[rR]/.test(w)) hasRecursive = true
      if (/f/.test(w)) hasForce = true
      continue
    }
    positional.push(w)
  }
  return hasRecursive && hasForce && positional.some(isRootHomeWipeTarget)
}

/**
 * `curl`/`wget` piped straight into a shell interpreter — unreviewed remote
 * code executed with no way to audit what actually ran. Modeled on
 * install.ts's shipped `pipe-to-shell` rule's own `match` pattern (same
 * curl/wget/nc-family verbs, same `| [sudo] <shell>` shape); applied here to
 * normalizeCommand's deobfuscated `.surfaces` rather than the raw string
 * alone, so `c"u"rl x | sh` and a `sh -c "curl x | sh"` wrapper body are
 * both caught the same way a literal `curl x | sh` is.
 */
const PIPE_TO_SHELL_RE = /(?<![A-Za-z])(curl|wget|ncat|socat|nc)(?![A-Za-z])[^;&]*\|[ \t]*(sudo[ \t]+)*(ba|z|k|da|a)?sh([ \t]|$)/i

const STARTUP_PATTERN_CHECKS: Array<{
  id: string
  severity: Severity
  title: string
  remediation: string
}> = [
  {
    id: 'mcp-startup-sudo',
    severity: 'critical',
    title: 'MCP server startup command runs as root via sudo',
    remediation: 'Never grant an MCP server elevated privileges at launch. Run it as the same unprivileged user as the host agent — sudo here runs on every server start, unattended, for the entire process lifetime.',
  },
  {
    id: 'mcp-startup-destructive-rm',
    severity: 'critical',
    title: 'MCP server startup command wipes root, home, or the current directory',
    remediation: 'Remove the destructive delete from the launch command, or scope it to a specific named path. A startup command that wipes / or ~ runs every time the server starts, with no confirmation.',
  },
  {
    id: 'mcp-startup-pipe-to-shell',
    severity: 'critical',
    title: 'MCP server startup command pipes a remote download directly into a shell',
    remediation: 'Download to a file, verify its checksum/signature, then execute. Piping curl/wget straight into sh/bash runs unreviewed remote code with no way to audit what actually ran, on every launch.',
  },
]

function checkUnsafeStartupCommand(where: string, command: string, args: string[]): Finding[] {
  const raw = [command, ...args].map(quoteArgForNormalization).join(' ').trim()
  if (!raw) return []
  const normalized = normalizeCommand(raw)
  const allSubcommands = flattenSubcommands(normalized.subcommands)
  const findings: Finding[] = []
  const shown = [command, ...args].join(' ').trim()

  const hasSudo = allSubcommands.some(sub => commandName(subcommandWords(sub)[0] ?? '') === 'sudo')
  const hasDestructiveRm = allSubcommands.some(sub => isDestructiveRmSubcommand(subcommandWords(sub)))
  const hasPipeToShell = normalized.surfaces.some(s => PIPE_TO_SHELL_RE.test(s))

  const hits: Record<string, boolean> = {
    'mcp-startup-sudo': hasSudo,
    'mcp-startup-destructive-rm': hasDestructiveRm,
    'mcp-startup-pipe-to-shell': hasPipeToShell,
  }

  for (const check of STARTUP_PATTERN_CHECKS) {
    if (hits[check.id]) {
      findings.push({
        id: check.id,
        severity: check.severity,
        title: check.title,
        evidence: `${where}: ${shown}`,
        remediation: check.remediation,
      })
    }
  }
  return findings
}

// ── Dangerous URL schemes ────────────────────────────────────────────────
//
// modelcontextprotocol.io's security-best-practices page documents
// authorization/redirect URLs as an XSS and local-code-execution vector
// when a client renders or navigates to a non-http(s) scheme — javascript:
// runs script in the client's context, data: and file: can smuggle local
// content or execute embedded script, vbscript: is the same class on
// Windows/IE-derived renderers. None of these is ever a legitimate MCP
// server or auth URL.
const DANGEROUS_URL_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:'])

function urlScheme(raw: string): string | null {
  try {
    return new URL(raw).protocol.toLowerCase()
  } catch {
    return null
  }
}

function checkDangerousUrlScheme(where: string, url: string): Finding | null {
  const scheme = urlScheme(url)
  if (!scheme || !DANGEROUS_URL_SCHEMES.has(scheme)) return null
  return {
    id: 'mcp-dangerous-url-scheme',
    severity: 'critical',
    title: `MCP server URL uses a dangerous "${scheme}" scheme`,
    evidence: `${where}: ${url}`,
    remediation: 'Use an https:// (or wss://) URL. The MCP spec documents javascript:/data:/file:/vbscript: URLs as an XSS and local-code-execution vector for any client that renders or navigates to them.',
  }
}

// ── SSRF-shaped URLs ─────────────────────────────────────────────────────
//
// A server's own advertised URL should never resolve to a private network
// or cloud-metadata address — a client that trusts it and fetches it as
// configured hands an attacker a way to reach internal-only services (or,
// for the metadata case, steal the host's cloud credentials outright).
const METADATA_HOSTS = new Set([
  '169.254.169.254', // AWS / Azure / OpenStack instance metadata
  '169.254.170.2',   // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud metadata
  'metadata.google.internal',
])

function classifySsrfTarget(hostname: string): 'metadata' | 'private' | null {
  const h = hostname.toLowerCase()
  if (METADATA_HOSTS.has(h)) return 'metadata'
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return 'private'
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return 'private'
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return 'private'
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return 'private'
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return 'private'
  return null
}

function checkSsrfShapedUrl(where: string, url: string): Finding | null {
  let hostname: string
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
  const kind = classifySsrfTarget(hostname)
  if (!kind) return null
  if (kind === 'metadata') {
    return {
      id: 'mcp-ssrf-metadata-endpoint',
      severity: 'critical',
      title: 'MCP server URL points at a cloud metadata endpoint',
      evidence: `${where}: ${url}`,
      remediation: 'A server whose own advertised URL resolves to a cloud instance-metadata address (169.254.169.254 and equivalents) can be used to steal the host\'s cloud credentials. Remove this server or verify its URL was not tampered with.',
    }
  }
  return {
    id: 'mcp-ssrf-private-target',
    severity: 'medium',
    title: 'MCP server URL points at a private or internal address',
    evidence: `${where}: ${url}`,
    remediation: 'A remote MCP server should not advertise a private-network (RFC1918) or loopback/link-local address as its own URL. If this is an intentional local development server, this finding can be ignored; otherwise verify the URL was not tampered with.',
  }
}

// ── Plaintext credentials in config ─────────────────────────────────────
//
// `env`/`headers` are how a config authorizes a stdio/http server — a
// `${VAR}`-style reference resolved from the shell or a secret manager is
// the safe shape; a literal, provider-shaped credential VALUE baked
// directly into the config file is not (it is committed to source control,
// synced, backed up, and read by anything that can read this file). Reuses
// SECRET_VALUE_SHAPE_PATTERNS + scoreSecretCandidate from
// @get-keel/core (policy-engine.ts's checkSecret / secret-confidence.ts)
// rather than a fourth ad hoc regex list — the same provider shapes
// (AWS/sk-/ghp_/PEM) and the same known-placeholder filter (AKIAIOSFODNN7EXAMPLE,
// `sk-xxxx…`-style redaction placeholders) as the write-path secret check.

/** A `${VAR}` / `$VAR` reference, or empty — the safe, non-literal shape. */
function looksLikeVariableReference(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  if (/\$\{[^}]+\}/.test(trimmed)) return true
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return true
  return false
}

/** Keep enough of a credential to identify it in evidence without printing it. */
function redactForEvidence(value: string): string {
  if (value.length <= 8) return '•'.repeat(value.length)
  return `${value.slice(0, 4)}${'•'.repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`
}

function checkPlaintextCredentials(where: string, server: McpServer): Finding[] {
  const findings: Finding[] = []
  const fields: Array<[string, string, string]> = [
    ...Object.entries(server.env ?? {}).map(([k, v]): [string, string, string] => ['env', k, String(v)]),
    ...Object.entries(server.headers ?? {}).map(([k, v]): [string, string, string] => ['header', k, String(v)]),
  ]

  for (const [kind, key, value] of fields) {
    if (!value || looksLikeVariableReference(value)) continue
    for (const pattern of SECRET_VALUE_SHAPE_PATTERNS) {
      const match = pattern.exec(value)
      if (!match) continue
      if (scoreSecretCandidate(match[0]) === 'deny') {
        findings.push({
          id: 'mcp-plaintext-credential',
          severity: 'high',
          title: `MCP server config stores a literal credential in ${kind === 'env' ? 'env' : 'headers'}`,
          evidence: `${where}: ${kind}.${key} = ${redactForEvidence(value)}`,
          remediation: `Replace the literal value with a variable reference (e.g. "\${${key}}") resolved from your shell or secret manager at launch time, instead of storing the credential in plaintext inside this config file.`,
        })
        break
      }
    }
  }
  return findings
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
      // Unwrapped, NOT basenamed — what checkUnsafeStartupCommand actually
      // executes. Without unwrapping this too, `cmd /c sudo rm -rf /` would
      // present normalizeCommand with `cmd`'s own argv0 as the command and
      // never see the `sudo`/`rm` tokens at all — the same wrapper miss the
      // shell/unpinned-package checks above were fixed for.
      let effectiveCommand = server.command ?? ''
      let effectiveArgs = rawArgs
      if (WRAPPER_COMMANDS.has(command)) {
        const rest = rawArgs.slice(rawArgs[0] === '/c' || rawArgs[0] === '/k' ? 1 : 0)
        if (rest.length > 0) {
          command = commandName(rest[0])
          args = rest.slice(1)
          effectiveCommand = rest[0]
          effectiveArgs = rest.slice(1)
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

      if (effectiveCommand) {
        findings.push(...checkUnsafeStartupCommand(where, effectiveCommand, effectiveArgs))
      }

      if (server.url) {
        const schemeFinding = checkDangerousUrlScheme(where, server.url)
        if (schemeFinding) findings.push(schemeFinding)
        const ssrfFinding = checkSsrfShapedUrl(where, server.url)
        if (ssrfFinding) findings.push(ssrfFinding)
      }

      findings.push(...checkPlaintextCredentials(where, server))
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
