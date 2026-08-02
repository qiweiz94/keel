import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'

const BINARY_EXTENSIONS = new Set(['.wasm', '.woff', '.woff2', '.ttf', '.eot', '.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.mp4', '.mp3', '.pdf', '.zip', '.gz', '.tar', '.node', '.so', '.dylib', '.dll', '.exe', '.o', '.a', '.pyc', '.pyo'])
function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return !BINARY_EXTENSIONS.has(ext)
}
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  PolicyFile, ToolCallEvent, EnforcementResult, AuditEntry,
  CommandRule, FileRule, ContentRule, EnforcementAction, PatternDef,
} from './types.js'
import { createSignedEntry, initSigning } from './signing.js'
import { createReceipt } from './receipts.js'

export const SECRET_ENV_PATTERNS = [
  /\b(?:OPENAI|ANTHROPIC|DEEPSEEK|AWS|GITLAB|OPENCODE)_(?:API_KEY|SECRET|TOKEN)(?![a-zA-Z0-9])/,
  /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_ACCESS_KEY|AWS_SECRET_ACCESS)(?![a-zA-Z0-9])/,
]

export class PolicyEngine {
  private policy: PolicyFile | null = null
  private auditLog: AuditEntry[] = []
  private secretPatterns: PatternDef[] = []
  private rateLimitCounts: Map<string, { count: number; windowStart: number }> = new Map()
  /** Compiled user patterns; null marks one that failed to compile. */
  private regexCache: Map<string, RegExp | null> = new Map()
  /** Tracks files read in current session — used for edit-before-read enforcement */
  private readFiles: Set<string> = new Set()
  /** Tracks recent edits for auto-verify */
  private recentEdits: Array<{ path: string; tool: string; timestamp: string }> = []

  constructor(private policyPath?: string) {}

  recordFileRead(filePath: string): void {
    this.readFiles.add(filePath)
  }

  hasReadFile(filePath: string): boolean {
    return this.readFiles.has(filePath)
  }

  clearSession(): void {
    this.readFiles.clear()
    this.recentEdits = []
  }

  getRecentEdits(): Array<{ path: string; tool: string; timestamp: string }> {
    return this.recentEdits
  }

  /**
   * Two distinct situations, deliberately given opposite outcomes:
   *
   *   no policy file        -> defaults (a fresh project should still work)
   *   file present, broken  -> FAIL CLOSED
   *
   * Falling back to defaults on a parse error is a silent downgrade: a
   * project with a stricter-than-default policy would quietly revert to
   * permissive defaults the moment its YAML was corrupted — including by an
   * agent that truncated it. Leaving `policy` null routes evaluate() into its
   * fail-closed branch instead.
   *
   * An empty file is the sharp edge here: parseYaml("") returns null WITHOUT
   * throwing, so it must be checked explicitly rather than relying on catch.
   */
  loadPolicy(path?: string): PolicyFile {
    const p = path || this.policyPath
    if (!p || !existsSync(p)) {
      this.policy = this.defaultPolicy()
      this.secretPatterns = this.policy.patterns || []
      return this.policy
    }

    let parsed: unknown
    try {
      parsed = parseYaml(readFileSync(p, 'utf-8'))
    } catch (err) {
      console.error(`keel: cannot parse policy file ${p}: ${err}`)
      console.error('keel: failing closed — every action will be denied until this is fixed.')
      this.policy = null
      this.secretPatterns = []
      return this.defaultPolicy()
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`keel: policy file ${p} is empty or is not a policy object.`)
      console.error('keel: failing closed — every action will be denied until this is fixed.')
      this.policy = null
      this.secretPatterns = []
      return this.defaultPolicy()
    }

    this.policy = parsed as PolicyFile
    this.secretPatterns = this.policy.patterns || []
    return this.policy
  }

  evaluate(event: ToolCallEvent): EnforcementResult[] {
    const results: EnforcementResult[] = []
    if (!this.policy) {
      // Fail-closed: no policy means deny everything
      results.push({
        action: 'block', rule_name: 'fail-closed',
        message: 'No policy loaded. Set up .keel.yaml to enable enforcement.',
        timestamp: new Date().toISOString(),
      })
      return results
    }

    if (event.tool_name === 'bash' || event.tool_name === 'run_command') {
      const cmd = String(event.args.command || '')
      results.push(...this.evaluateCommand(cmd))
      // API key exposure via shell commands (echo $KEY, cat .env, env | grep)
      results.push(...this.checkApiKeyExposure(cmd))
      // Check secrets in command string
      const secretResult = this.checkSecret(cmd)
      if (secretResult) results.push(secretResult)
    }

    if (event.tool_name === 'write_file' || event.tool_name === 'edit') {
      const filePath = String(event.args.filePath || event.args.path || '')
      results.push(...this.evaluateFileWrite(filePath))
      // Edit-before-read enforcement
      if (filePath && !this.readFiles.has(filePath)) {
        results.push({
          action: 'warn',
          rule_name: 'edit-before-read',
          message: `Editing "${filePath}" without reading it first. Read the file first to understand its context.`,
          timestamp: new Date().toISOString(),
        })
      }
      this.recentEdits.push({ path: filePath, tool: event.tool_name, timestamp: event.timestamp })
    }

    if (event.tool_name === 'read' || event.tool_name === 'read_file') {
      const filePath = String(event.args.filePath || '')
      this.readFiles.add(filePath)
      results.push(...this.evaluateFileRead(filePath))
      // Check file content for secrets and content rules (with safety limits)
      try {
        const st = statSync(filePath)
        if (st.size <= 10 * 1024 * 1024 && isTextFile(filePath)) {
          const content = readFileSync(filePath, 'utf-8')
          const secretResult = this.checkSecret(content)
          if (secretResult) results.push(secretResult)
          results.push(...this.evaluateContentRules(content, filePath))
        }
      } catch { /* file may not exist or be readable */ }
    }

    if (event.tool_name === 'write_file' || event.tool_name === 'edit') {
      // Also check content for writes (if content is provided)
      const content = String(event.args.content || event.args.text || '')
      if (content) {
        const secretResult = this.checkSecret(content)
        if (secretResult) results.push(secretResult)
        const filePath = String(event.args.filePath || event.args.path || '')
        results.push(...this.evaluateContentRules(content, filePath))
      }
    }

    // Evaluate env_rules (check command against restricted env vars)
    if (this.policy.env_rules && event.tool_name === 'bash') {
      const cmd = String(event.args.command || '')
      for (const rule of this.policy.env_rules) {
        for (const v of rule.vars) {
          if (cmd.includes(v)) {
            results.push({
              action: rule.action, rule_name: rule.name,
              message: rule.message || `Restricted environment variable referenced: ${v}`,
              timestamp: new Date().toISOString(),
            })
          }
        }
      }
    }

    // Evaluate rate_limits
    if (this.policy.rate_limits) {
      const now = Date.now()
      for (const rule of this.policy.rate_limits) {
        const key = `${rule.scope}:${rule.name}`
        const entry = this.rateLimitCounts.get(key)
        if (entry && (now - entry.windowStart) < rule.window * 1000) {
          entry.count++
          if (entry.count > rule.max_calls) {
            results.push({
              action: rule.action, rule_name: rule.name,
              message: rule.message || `Rate limit exceeded: ${rule.max_calls} per ${rule.window}s`,
              timestamp: new Date().toISOString(),
            })
          }
        } else {
          this.rateLimitCounts.set(key, { count: 1, windowStart: now })
        }
      }
    }

    // Evaluate time_rules
    if (this.policy.time_rules) {
      const now = new Date()
      const hour = now.getHours()
      const minute = now.getMinutes()
      const currentMinutes = hour * 60 + minute
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      const currentDay = dayNames[now.getDay()]

      for (const rule of this.policy.time_rules) {
        if (!rule.schedule) continue
        const startParts = rule.schedule.start.split(':').map(Number)
        const endParts = rule.schedule.end.split(':').map(Number)
        const startMinutes = startParts[0] * 60 + (startParts[1] || 0)
        const endMinutes = endParts[0] * 60 + (endParts[1] || 0)

        const withinSchedule = currentMinutes >= startMinutes && currentMinutes < endMinutes
        const dayMatch = !rule.schedule.days || rule.schedule.days.includes(currentDay)

        if (!withinSchedule || !dayMatch) {
          // Outside allowed schedule — check if this action is in scope
          for (const subject of rule.subjects) {
            for (const p of subject.patterns || []) {
              if (p.regex && new RegExp(p.regex, 'i').test(String(event.args.command || event.args.filePath || ''))) {
                results.push({
                  action: rule.outside_schedule_action || 'prompt',
                  rule_name: rule.name,
                  message: rule.message || `Action restricted outside allowed hours (${rule.schedule.start}-${rule.schedule.end})`,
                  timestamp: new Date().toISOString(),
                })
              }
            }
          }
        }
      }
    }

    // Evaluate network_rules (basic URL pattern matching)
    if (this.policy.network_rules && event.tool_name === 'bash') {
      const cmd = String(event.args.command || '')
      for (const rule of this.policy.network_rules) {
        for (const p of rule.patterns) {
          if (p.regex && new RegExp(p.regex, 'i').test(cmd)) {
            results.push({
              action: rule.action, rule_name: rule.name,
              message: rule.message || `Network rule matched: ${p.regex.slice(0, 80)}`,
              timestamp: new Date().toISOString(),
            })
          }
        }
      }
    }

    if (this.policy.settings?.audit_log !== false) {
      for (const r of results) {
        this.audit(r, event)
      }
    }

    return results
  }

  /**
   * Detect secret exposure via shell commands.
   *
   * Two things were wrong before:
   *
   * 1. The docstring advertised `cat .env`, but every branch also required a
   *    SECRET_ENV_PATTERNS name to appear in the command string — and
   *    `cat .env` contains no variable name, so it never matched. Reading a
   *    secrets file is now its own check.
   * 2. `^(echo|cat|...)` anchored at position 0, so a leading space,
   *    `/bin/cat`, `sudo cat`, `less`, `head`, or `sh -c '...'` all walked
   *    past it. Matching is now against any command in the pipeline.
   */
  checkApiKeyExposure(cmd: string): EnforcementResult[] {
    const results: EnforcementResult[] = []
    // Split on pipes/&&/;/newlines so `foo && cat .env` is examined too, and
    // strip any leading path so /bin/cat reads the same as cat.
    const segments = cmd.split(/[|;&\n]+/).map((s) => s.trim()).filter(Boolean)
    const verb = (s: string) => {
      const first = s.split(/\s+/)[0] || ''
      return (first.split('/').pop() || '').toLowerCase()
    }
    const READERS = new Set([
      'cat', 'type', 'less', 'more', 'head', 'tail', 'xxd', 'od', 'strings',
      'bat', 'nl', 'base64', 'cp', 'mv',
    ])
    const SECRET_FILES = /(^|[\s"'=/])(\.env(\.[\w-]+)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|credentials|\.git-credentials)(["'\s]|$)/i
    // Templates carry placeholders, not secrets, and DEFAULT_POLICY already
    // excludes .env.example from file_rules. Flagging them would be the same
    // false-positive habit that gets security tools switched off.
    const TEMPLATE_FILES = /\.(example|sample|template|dist|tpl)(["'\s]|$)/i

    const readsSecretFile = segments.some(
      (s) =>
        (READERS.has(verb(s)) || /^sudo\s/.test(s)) &&
        SECRET_FILES.test(s) &&
        !TEMPLATE_FILES.test(s)
    )

    const exposurePatterns = [
      // echo $KEY, print $KEY — a named secret going to stdout
      segments.some((s) => ['echo', 'print', 'printf'].includes(verb(s))) &&
        SECRET_ENV_PATTERNS.some(p => p.test(cmd)),
      // reading a secrets file by any common reader, anywhere in the pipeline
      readsSecretFile,
      // python3 -c "print(os.environ['KEY'])"
      cmd.includes('-c') && cmd.includes('environ') && SECRET_ENV_PATTERNS.some(p => p.test(cmd)),
      // env | grep KEY, export KEY, set KEY
      segments.some((s) => ['env', 'export', 'set', 'printenv'].includes(verb(s))) &&
        SECRET_ENV_PATTERNS.some(p => p.test(cmd)),
      // curl with Bearer token
      cmd.includes('Bearer') && SECRET_ENV_PATTERNS.some(p => p.test(cmd)),
    ]
    if (exposurePatterns.some(Boolean)) {
      results.push({
        action: 'block',
        rule_name: 'api-key-exposure',
        message: 'Potential API key exposure via shell command. Use environment variables in code instead of printing or transmitting them.',
        timestamp: new Date().toISOString(),
      })
    }
    return results
  }

  /**
   * Syntax-check a file, so a broken edit is caught where it is made rather
   * than at the next run.
   *
   * Two things were wrong before and both mattered:
   *
   * 1. The path was interpolated into a shell string
   *    (`python3 -m py_compile "${filePath}"`), so a filename containing a
   *    quote, backtick or $(...) executed arbitrary commands — inside the tool
   *    whose purpose is preventing exactly that. Every checker now uses
   *    execFileSync with an argv array, and the two that need no subprocess at
   *    all (JSON, YAML) are parsed in-process.
   * 2. Nothing called it. A verifier that never runs verifies nothing; it is
   *    wired into `check --file` and `check --ci` below.
   *
   * A missing interpreter is reported as "cannot verify" (null), never as a
   * syntax error — a machine without python3 must not fail every .py file.
   */
  async autoVerify(filePath: string): Promise<EnforcementResult | null> {
    const { execFileSync } = await import('node:child_process')
    const ext = extname(filePath).toLowerCase()

    const spawn = (cmd: string, args: string[]) =>
      execFileSync(cmd, args, { stdio: 'pipe', timeout: 10000 })

    try {
      switch (ext) {
        case '.py':
          spawn('python3', ['-m', 'py_compile', filePath])
          break
        case '.sh':
        case '.bash':
          spawn('bash', ['-n', filePath])
          break
        case '.js':
        case '.mjs':
        case '.cjs':
          spawn(process.execPath, ['--check', filePath])
          break
        case '.json':
          JSON.parse(readFileSync(filePath, 'utf-8'))
          break
        case '.yaml':
        case '.yml':
          // Directly relevant to this tool: a malformed .keel.yaml now
          // fails closed, so catching it at edit time beats discovering it
          // when every action starts being denied.
          parseYaml(readFileSync(filePath, 'utf-8'))
          break
        default:
          return null
      }
    } catch (err: any) {
      // ENOENT from the interpreter itself is "no verifier available" —
      // distinct from "the file is broken", and must not be reported as one.
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) return null
      const detail = String(err?.message || '').split('\n')[0]
      return {
        action: 'warn',
        rule_name: 'auto-verify',
        message: `Syntax error in ${basename(filePath)}: ${detail}`,
        timestamp: new Date().toISOString(),
      }
    }
    return null
  }

  private evaluateCommand(cmd: string): EnforcementResult[] {
    const results: EnforcementResult[] = []
    if (!this.policy?.command_rules) return results

    for (const rule of this.policy.command_rules) {
      const matched = this.matchCommandRule(cmd, rule)
      if (matched) {
        results.push({
          action: rule.action,
          rule_name: rule.name,
          message: rule.message,
          matched_pattern: matched,
          timestamp: new Date().toISOString(),
        })
      }
    }
    return results
  }

  /**
   * Compile a user-supplied pattern.
   *
   * Policy files are hand-edited, so an invalid regex is a normal authoring
   * mistake — not an exceptional condition. Previously `new RegExp` was called
   * bare here, so ONE malformed pattern threw out of evaluate() and took down
   * enforcement for every rule, while evaluateContentRules right below already
   * guarded its own compile. A broken rule must fail alone and say so.
   */
  private compilePattern(source: string, context: string): RegExp | null {
    const cached = this.regexCache.get(source)
    if (cached !== undefined) return cached
    let compiled: RegExp | null = null
    try {
      compiled = new RegExp(source, 'i')
    } catch (err) {
      console.error(
        `keel: ignoring invalid regex in ${context}: ${source} (${(err as Error).message})`
      )
    }
    this.regexCache.set(source, compiled)
    return compiled
  }

  /** True when any `unless` clause exempts this command. */
  private isExempt(cmd: string, rule: CommandRule): boolean {
    if (!rule.unless) return false
    return rule.unless.some((u) => {
      if (!u.regex) return false
      const re = this.compilePattern(u.regex, `"${rule.name}" unless`)
      return re ? re.test(cmd) : false
    })
  }

  private matchCommandRule(cmd: string, rule: CommandRule): string | null {
    for (const p of rule.patterns) {
      if (p.prefix && cmd.trim().startsWith(p.prefix)) {
        return this.isExempt(cmd, rule) ? null : p.prefix
      }
      if (p.regex) {
        const re = this.compilePattern(p.regex, `command rule "${rule.name}"`)
        if (re && re.test(cmd)) {
          return this.isExempt(cmd, rule) ? null : p.regex
        }
      }
    }
    return null
  }

  private evaluateFileWrite(filePath: string): EnforcementResult[] {
    const results: EnforcementResult[] = []
    if (!this.policy?.file_rules) return results

    for (const rule of this.policy.file_rules) {
      if (!rule.actions.write) continue
      if (this.matchGlobList(filePath, rule.paths, rule.exclude)) {
        results.push({
          action: rule.actions.write,
          rule_name: rule.name,
          message: rule.message,
          matched_pattern: filePath,
          timestamp: new Date().toISOString(),
        })
      }
    }
    return results
  }

  private evaluateFileRead(filePath: string): EnforcementResult[] {
    const results: EnforcementResult[] = []
    if (!this.policy?.file_rules) return results

    for (const rule of this.policy.file_rules) {
      if (!rule.actions.read) continue
      if (this.matchGlobList(filePath, rule.paths, rule.exclude)) {
        results.push({
          action: rule.actions.read,
          rule_name: rule.name,
          message: rule.message,
          matched_pattern: filePath,
          timestamp: new Date().toISOString(),
        })
      }
    }
    return results
  }

  /** Evaluate content rules against file content */
  private evaluateContentRules(content: string, filePath: string): EnforcementResult[] {
    const results: EnforcementResult[] = []
    if (!this.policy?.content_rules) return results

    for (const rule of this.policy.content_rules) {
      // Check if rule applies to this file path
      if (rule.paths && rule.paths.length > 0) {
        const matchesPath = rule.paths.some(p => this.matchGlob(filePath, p))
        if (!matchesPath) continue
      }

      for (const pattern of rule.patterns) {
        const regexStr = pattern.regex || pattern.ref
        if (!regexStr) continue
        try {
          const regex = new RegExp(regexStr, 'i')
          if (regex.test(content)) {
            results.push({
              action: rule.action,
              rule_name: rule.name,
              message: rule.message,
              matched_pattern: regexStr.slice(0, 100),
              timestamp: new Date().toISOString(),
            })
          }
        } catch { /* skip invalid regex */ }
      }
    }
    return results
  }

  private matchGlobList(filePath: string, patterns: string[], exclude?: string[]): boolean {
    const match = patterns.some(p => this.matchGlob(filePath, p))
    if (!match) return false
    if (exclude) {
      return !exclude.some(p => this.matchGlob(filePath, p))
    }
    return true
  }

  /**
   * Translate a glob to a regex body.
   *
   * Historically this ran a chain of .replace() calls that escaped "." LAST,
   * after doublestar had already been expanded to ".*" — so the wildcard's own
   * dot was escaped into a literal, and any pattern containing a non-leading
   * doublestar silently matched nothing. A rule such as
   * "config/<doublestar>/secrets.yaml" protected none of the files the author
   * believed it covered, and the very common exclude
   * "<doublestar>/node_modules/<doublestar>" excluded nothing. Silent, because
   * a glob that matches nothing raises no error.
   */
  private globToRegexBody(pattern: string): string {
    // Single pass: each wildcard is translated as it is encountered, so a
    // metacharacter produced by an expansion can never be re-escaped by a
    // later stage. The previous implementation escaped "." last, which turned
    // the "." of an already-expanded ".*" into a literal-dot match.
    return pattern.replace(/\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) => {
      if (token === '**') return '.*'
      if (token === '*') return '[^/]*'
      if (token === '?') return '[^/]'
      return '\\' + token
    })
  }

  private matchGlob(filePath: string, pattern: string): boolean {
    // A leading **/ must also match the bare name: **/.env matches .env.
    const escaped = pattern.startsWith('**/')
      ? `(^|.*/)${this.globToRegexBody(pattern.slice(3))}$`
      : `^${this.globToRegexBody(pattern)}$`
    return new RegExp(escaped).test(filePath)
  }

  checkSecret(content: string): EnforcementResult | null {
    const patterns = [
      /(?<![A-Z0-9])(AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/,
      /(?:sk-[a-zA-Z0-9]{32,})/,
      /(?:ghp_[a-zA-Z0-9]{36})/,
      /(?:gho_[a-zA-Z0-9]{36})/,
      /(?:ghu_[a-zA-Z0-9]{36})/,
      /(?:ghs_[a-zA-Z0-9]{36})/,
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
      /\b(?:OPENAI|ANTHROPIC|DEEPSEEK|GITLAB)_(?:API_KEY|SECRET|TOKEN)(?![a-zA-Z0-9_])/,
      /\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)(?![a-zA-Z0-9_])/,
      /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_ACCESS_KEY)(?![a-zA-Z0-9_])/,
    ]

    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return {
          action: 'block',
          rule_name: 'secret-detection',
          message: 'Potential secret or API key detected in content',
          matched_pattern: pattern.source,
          timestamp: new Date().toISOString(),
        }
      }
    }
    return null
  }

  isDestructiveCommand(cmd: string): boolean {
    const parts = cmd.trim().split(/[;&|]{1,2}/)
    return parts.some(p => {
      const t = p.trim()
      return /^(rm(\s|$)|kill(\s|$)|pkill(\s|$)|reboot(\s|$)|shutdown(\s|$)|poweroff(\s|$))/.test(t)
    })
  }

  checkSudo(cmd: string): boolean {
    return /\bsudo\b/.test(cmd)
  }

  checkPKillPython(cmd: string): boolean {
    return /pkill.*-f.*python/.test(cmd)
  }

  isSSHCmd(cmd: string): boolean {
    return /^ssh\b/.test(cmd.trim()) || /^scp\b/.test(cmd.trim()) || /^rsync\b/.test(cmd.trim())
  }

  extractSSHTarget(cmd: string): string | null {
    const tokens = cmd.trim().split(/\s+/)
    for (const tok of tokens) {
      if (tok === 'ssh' || tok === 'scp' || tok === 'rsync') continue
      if (tok.startsWith('-')) continue
      if (tok.includes('@')) return tok.split('@').pop()!
      return tok
    }
    return null
  }

  checkForcePush(cmd: string): boolean {
    return /git push --force\b/.test(cmd) && !/git push --force-with-lease\b/.test(cmd)
  }

  checkNoVerify(cmd: string): boolean {
    return /git.*--no-verify\b/.test(cmd) ||
      // -n is the short form of --no-verify. The long form is caught anywhere
      // in the command by the pattern above; the short form must be too, or
      // `git commit -m msg -n` slips through while `git commit -n -m msg` is
      // blocked. A -n inside a quoted commit message is a false positive we
      // accept over a real bypass.
      /\bgit\s+commit\b(?:\s+\S+)*\s+-n(?:\s|$)/.test(cmd) ||
      /\bgit\s+merge\s+--no-verify\b/.test(cmd) ||
      /\bgit\s+rebase\s+--no-verify\b/.test(cmd) ||
      /\bgit\s+cherry-pick\s+--no-verify\b/.test(cmd) ||
      /\bgit\s+am\s+--no-verify\b/.test(cmd)
  }

  checkHookBypass(cmd: string): boolean {
    return /core\.hooksPath/.test(cmd) ||
      /\bHUSKY=0\b/.test(cmd) ||
      /\bLEFTHOOK=0\b/.test(cmd) ||
      /SKIP=/.test(cmd) ||
      // MCP GitHub API writes that bypass local git hooks
      /\bmcp__github__push_files\b/.test(cmd) ||
      /\bmcp__github__create_or_update_file\b/.test(cmd) ||
      /\bmcp__github__delete_file\b/.test(cmd) ||
      /\bmcp__github__merge_pull_request\b/.test(cmd) ||
      /\bmcp__github__update_pull_request_branch\b/.test(cmd) ||
      // Generic MCP tool detection for file operations via API
      /\bmcp__.*__(?:push|create|delete|write|merge|update)_/i.test(cmd)
  }

  private audit(result: EnforcementResult, event: ToolCallEvent): void {
    // Create signed entry (Ed25519, hash-chained)
    let signed: any
    try {
      initSigning()
      signed = createSignedEntry({
        action: result.action,
        rule_name: result.rule_name || '',
        message: result.message,
        tool_name: event.tool_name,
      })
    } catch {
      // Fall back to unsigned entry if signing fails
      signed = {
        version: 'audit-entry/v1',
        id: randomUUID(),
        timestamp: result.timestamp,
        action: result.action,
        rule_name: result.rule_name,
        message: result.message,
        tool_name: event.tool_name,
        args: event.args,
        previousEntryHash: null,
      }
    }

    const entry: AuditEntry = {
      timestamp: result.timestamp,
      tool_name: event.tool_name,
      args: event.args,
      rule_name: result.rule_name,
      action: result.action,
      message: result.message,
      session_id: process.env.KEEL_SESSION_ID || '',
    }
    this.auditLog.push(entry)
    // Persist to disk (signed)
    try {
      const dir = join(process.cwd(), '.keel', 'audit')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'audit.log'), JSON.stringify(signed) + '\n')
    } catch { /* best-effort disk write */ }

    // Generate signed action receipt (offline-verifiable evidence)
    try {
      createReceipt(
        process.env.KEEL_SESSION_ID || 'local',
        event.tool_name,
        event.args,
        result.action,
        result.rule_name || '',
        'default'
      )
    } catch { /* best-effort receipt generation */ }
  }

  getAuditLog(): AuditEntry[] {
    return this.auditLog
  }

  clearAuditLog(): void {
    this.auditLog = []
  }

  private defaultPolicy(): PolicyFile {
    return { ...DEFAULT_POLICY }
  }
}

export const DEFAULT_POLICY: PolicyFile = {
  version: '1.0',
  name: 'keel default policy',
  description: 'Sensible defaults for AI coding assistant governance',
  settings: { default_action: 'warn', audit_log: true },
  command_rules: [
    {
      name: 'Block destructive commands',
      patterns: [
        { regex: '^rm -rf /(?!tmp|var/tmp)' },
        { regex: '^rm -rf ~' },
        { regex: '^(>\\s*>\\s*)+/dev/' },
        { regex: '\\| sudo bash' },
        { regex: 'pkill.*-f.*python' },
      ],
      action: 'block',
      message: 'Destructive command blocked. This operation could damage your system.',
    },
    {
      name: 'Restrict sudo usage',
      patterns: [{ prefix: 'sudo ' }],
      action: 'block',
      message: 'Sudo commands blocked by default. Use explicit approval if needed.',
    },
    {
      name: 'Block git hook bypass',
      patterns: [
        { regex: 'git.*--no-verify' },
        { regex: 'git push --force(?!-with-lease)' },
        { regex: 'core\\.hooksPath' },
      ],
      action: 'block',
      message: 'Git hook bypass is not allowed. AI agents must respect git hooks.',
    },
    {
      name: 'Require safe force-push',
      patterns: [{ prefix: 'git push --force ' }],
      action: 'block',
      unless: [{ regex: 'git push --force-with-lease' }],
      message: 'Use --force-with-lease instead of --force for safer pushing.',
    },
    {
      name: 'Safe package installers',
      patterns: [
        { regex: '^npm (install|add|i)' },
        { regex: '^pnpm (install|add|i)' },
        { regex: '^yarn add' },
      ],
      action: 'allow',
      message: 'Approved package manager.',
    },
  ],
  file_rules: [
    {
      name: 'Protect secret files',
      paths: ['**/.env', '**/.env.*', '**/credentials*', '**/*.pem', '**/*-key.json'],
      exclude: ['.env.example'],
      actions: { read: 'block', write: 'block', glob: 'block' },
      message: 'Protected file: use a secrets manager instead.',
    },
    {
      name: 'Protect git config',
      paths: ['**/.git/config', '**/.git-credentials'],
      actions: { read: 'block', write: 'block' },
      message: 'Git configuration files are protected.',
    },
    {
      // Without this, an agent disables every rule above by editing one file —
      // the exact failure mode this tool exists to prevent. Reads stay allowed
      // so an agent can still explain the policy it is bound by.
      name: 'Protect enforcement configuration',
      paths: [
        '**/.keel.yaml',
        '**/.keel/audit/**',
        '**/.keel/receipts/**',
        '**/.claude/settings.json',
        '**/.git/hooks/**',
      ],
      actions: { write: 'block' },
      message:
        'Enforcement configuration is protected. Change it deliberately as a human, not through an agent.',
    },
  ],
  patterns: [],
  content_rules: [],
}

/**
 * The file "keel init" writes.
 *
 * GENERATED from DEFAULT_POLICY rather than hand-maintained. The two were
 * previously independent copies of the same policy and had already drifted:
 * the object blocked "| sudo bash" and redirects into /dev/, the string did
 * not — so a project that ran "init" ended up with weaker rules than one with
 * no policy file at all. Edit DEFAULT_POLICY; this follows.
 */
export const DEFAULT_POLICY_YAML = `# keel policy file
# Generated from keel's built-in defaults. Edit freely — this file is
# authoritative once it exists.
${stringifyYaml(DEFAULT_POLICY)}`
