import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ActionCache,
  ContentTracker,
  EnforcementPipeline,
  FlowTracker,
  SequenceDetector,
  StateManager,
  StuckTracker,
  ResearchTracker,
  loadRuleHierarchy,
  parseRulesContent,
  hashRulesFile,
  validateRules,
  projectAuditArgs,
  createReceipt,
  verifyFileSyntax,
  isVerifiableFile,
} from '../../core/src/keel-core.js'

/** Tools whose completion means a file on disk just changed. */
const EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch', 'writefile', 'write_file', 'multiedit'])

const KEEL_DIR = path.join(os.homedir(), '.keel')
const RULES_PATH = path.join(KEEL_DIR, 'rules.yaml')
const REQUIREMENTS_PATH = path.join(KEEL_DIR, 'requirements.md')
const DISABLED_PATH = path.join(KEEL_DIR, 'DISABLED')
let sentinelCorrupted = false
const TRACES_DIR = path.join(KEEL_DIR, 'traces')
const LEGACY_PRODUCT_NAME = 'ai-' + 'enforce'
export const DEFAULT_RULES_YAML = `version: 1
level: balanced
rules:
  - id: product-name-is-keel
    type: command
    match: "(sed|replaceAll|rename).{0,80}(keel|product).{0,40}(${LEGACY_PRODUCT_NAME})"
    action: deny
    level: sprint
    priority: 100
    message: "Product name is 'keel'. Never change it back to ${LEGACY_PRODUCT_NAME}."
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

function ensureRules(): void {
  try {
    if (!fs.existsSync(RULES_PATH)) {
      fs.mkdirSync(KEEL_DIR, { recursive: true })
      fs.writeFileSync(RULES_PATH, DEFAULT_RULES_YAML, 'utf8')
    }
  } catch {}
}

function isDisabled(): boolean {
  try {
    if (!fs.existsSync(DISABLED_PATH)) return false
    const state = JSON.parse(fs.readFileSync(DISABLED_PATH, 'utf8'))
    if (state.expires_at && new Date(state.expires_at) < new Date()) {
      fs.rmSync(DISABLED_PATH, { force: true })
      return false
    }
    return true
  } catch {
    // A corrupt kill-switch must never silently keep enforcement off: fail
    // CLOSED (enforcement stays on) and record the corruption for `keel
    // status` and the audit trace.
    sentinelCorrupted = true
    try { record({ event: 'corrupt-kill-switch-fail-closed', message: 'Invalid keel kill-switch state; enforcement stays ON until ' + DISABLED_PATH + ' is fixed or removed' }) } catch {}
    return false
  }
}

function consumeRestartDisable(): void {
  try {
    if (!fs.existsSync(DISABLED_PATH)) return
    const state = JSON.parse(fs.readFileSync(DISABLED_PATH, 'utf8'))
    if (state.auto_enable_on_restart && !state.expires_at) fs.rmSync(DISABLED_PATH, { force: true })
  } catch { /* Keep a corrupt disable sentinel in place until manual recovery. */ }
}

function record(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(TRACES_DIR, { recursive: true })
    const now = new Date()
    fs.appendFileSync(path.join(TRACES_DIR, `${now.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({
      t: Date.now(), timestamp: now.toISOString(), agent: 'opencode-plugin', ...entry,
    })}\n`)
  } catch {}
}

function requirementLines(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) return []
    return fs.readFileSync(filePath, 'utf8').split('\n')
      .map(line => line.replace(/^#+\s*/, '').trim())
      .filter(line => line && !line.startsWith('[') && !line.startsWith('<!--'))
  } catch { return [] }
}

/**
 * Per-session turn counter.
 *
 * OpenCode hands us no turn index, and `turn_number` was hardcoded to 0 —
 * which silently broke everything keyed on it. The FlowTracker buckets on
 * `flow:<session>:<turn>` (flow-tracker.ts:52,74), so with a constant 0
 * every turn collapsed into one bucket: a rule meant to catch "read a
 * secret and reached a network sink IN THE SAME TURN" instead matched any
 * read and any later sink anywhere in the session — a false-positive
 * generator. `keel lessons` has the mirror problem (lessons.ts:116 pairs a
 * claim with a tool call by turn).
 *
 * The turn boundary is `experimental.chat.system.transform`, which fires
 * once per model call. Degradation is graceful: if that hook arrives
 * without a sessionID we advance the most recently active session, and if
 * we can attribute nothing the counter simply stays put — i.e. today's
 * behavior, never worse.
 */
const turnCounters = new Map<string, number>()
let lastActiveSession = 'unknown'

function currentTurn(sessionId: string): number {
  return turnCounters.get(sessionId) ?? 0
}

function advanceTurn(sessionId: string): void {
  turnCounters.set(sessionId, (turnCounters.get(sessionId) ?? 0) + 1)
}

function toEnforceInput(tool: string, args: Record<string, unknown>, hookInput: any, level: any, cwd: string) {
  const sessionId = hookInput?.sessionID || 'unknown'
  lastActiveSession = sessionId
  return {
    tool, args, cwd, session_id: sessionId, turn_number: currentTurn(sessionId),
    context_tokens: 0, level, depth: level === 'protect' ? 'deep' : level === 'sprint' ? 'fast' : 'full',
    context: 'local' as const, agent: 'opencode', subagent_of: null,
    ...(hookInput?.reasoning ? { reasoning: String(hookInput.reasoning) } : {}),
  }
}

function applyFix(args: Record<string, unknown>, result: any): void {
  const fixed = result.fix_result?.fixed
  if (typeof fixed === 'string' && typeof args.command === 'string') args.command = fixed
}

function worktreeFingerprint(directory: string, sourcePath: string | undefined): string | null {
  if (!sourcePath) return null
  try {
    const diff = spawnSync('git', ['-C', directory, 'diff', '--binary', 'HEAD', '--', sourcePath], { encoding: 'utf8' })
    const untracked = spawnSync('git', ['-C', directory, 'ls-files', '--others', '--exclude-standard', '--', sourcePath], { encoding: 'utf8' })
    if (diff.status !== 0 || untracked.status !== 0) return null
    let content = `${diff.stdout}\n${untracked.stdout}`
    for (const relative of untracked.stdout.split('\n').filter(Boolean)) {
      try { content += `\n${relative}\n${fs.readFileSync(path.join(directory, relative), 'utf8')}` } catch {}
    }
    return content
  } catch { return null }
}

export default {
  id: 'keel-enforce',
  server: async (pluginInput: any) => {
    ensureRules()
    const directory = pluginInput?.directory || process.cwd()
    const client = pluginInput?.client
    // Last known good: an invalid rules file must not disable the guardrails.
    // Any source with errors is replaced by the built-in default rules (so
    // enforcement continues), the error is logged loudly, and strict mode
    // (KEEL_STRICT=1) restores the old throw-on-invalid behavior.
    let hierarchy = loadRuleHierarchy(directory)
    let ruleErrors = [hierarchy.global, hierarchy.user, hierarchy.project, hierarchy.local]
      .flatMap(source => source ? [...(source.errors || []), ...validateRules(source.rules)] : [])
    const logError = (event: string, errors: string[]) => {
      try { record({ event, errors, directory }) } catch {}
      try { client?.app?.log?.({ body: { service: 'keel', level: 'error', message: `[Keel] ${event}: ${errors.join('; ')}` } }) } catch {}
    }
    if (ruleErrors.length) {
      if (process.env.KEEL_STRICT === '1') {
        throw new Error(`[Keel] Invalid Keel rules (KEEL_STRICT=1): ${ruleErrors.join('; ')}`)
      }
      logError('invalid-rules-fallback-to-defaults', ruleErrors)
      hierarchy = { global: parseRulesContent(DEFAULT_RULES_YAML, 'keel:defaults'), user: null, project: null, local: null }
      ruleErrors = []
    }
    let level = hierarchy.project?.config.level || hierarchy.global?.config.level || 'balanced'
    let activeHierarchy = hierarchy
    let verificationIds = new Set<string>()
    let verificationBaselines = new Map<string, string | null>()
    const refreshVerificationMetadata = (nextHierarchy: typeof hierarchy) => {
      activeHierarchy = nextHierarchy
      level = nextHierarchy.project?.config.level || nextHierarchy.global?.config.level || 'balanced'
      verificationIds = new Set([
        ...(nextHierarchy.global?.rules || []), ...(nextHierarchy.project?.rules || []), ...(nextHierarchy.local?.rules || []),
      ].filter(rule => rule.type === 'verification').map(rule => rule.id))
      const nextBaselines = new Map<string, string | null>()
      for (const rule of [...(nextHierarchy.global?.rules || []), ...(nextHierarchy.project?.rules || []), ...(nextHierarchy.local?.rules || [])]) {
        if (rule.type === 'verification') nextBaselines.set(rule.id, worktreeFingerprint(directory, rule.trigger?.path))
      }
      verificationBaselines = nextBaselines
    }
    refreshVerificationMetadata(hierarchy)
    const pipeline = new EnforcementPipeline({
      level, context: 'local', cache: new ActionCache({ maxSize: 1000 }),
      contentTracker: new ContentTracker(), sequenceDetector: new SequenceDetector(),
      flowTracker: new FlowTracker(), ruleHierarchy: hierarchy, ruleVersion: 1,
      allowedFixTransforms: true,
      stateManager: new StateManager(),
      stuckTracker: new StuckTracker(),
      researchTracker: new ResearchTracker(),
      reloadRules: () => loadRuleHierarchy(directory),
      ruleFingerprint: () => [
        path.join(directory, '.keel', 'rules.yaml'), path.join(directory, 'AGENTS.md'), path.join(directory, 'CLAUDE.md'),
        path.join(directory, '.keel.local.yaml'), path.join(directory, 'AGENTS.local.md'), path.join(directory, 'CLAUDE.local.md'),
        RULES_PATH, path.join(os.homedir(), '.config', 'keel', 'rules.yaml'),
      ].map(source => hashRulesFile(source)).join(':'),
      onRulesReload: refreshVerificationMetadata,
      onRulesError: (errors) => {
        // Mid-session typo: keep enforcing with the last known good rules,
        // but surface the error so the user knows the new rules did not take.
        logError('invalid-rules-reload-kept-last-known-good', errors)
      },
    })
    const verificationWarnings = new Set<string>()
    const surfacedWarnings = new Set<string>()
    const surfaceWarn = (ruleId: string, message: string, sessionID: string | undefined) => {
      // Warn-level results are audit-only by default; surface each rule once
      // per session so "warnings vs blocks" is a visible dial, not a silent
      // trace entry.
      const key = `${ruleId}:${sessionID || 'unknown'}`
      if (surfacedWarnings.has(key)) return
      surfacedWarnings.add(key)
      try {
        client?.app?.log?.({
          body: {
            service: 'keel',
            level: 'warn',
            message: `[Keel] ${ruleId}: ${message}`,
            extra: { rule_id: ruleId, session_id: sessionID },
          },
        })
      } catch {}
    }
    const refreshExternalChanges = async () => {
      for (const rule of [...(activeHierarchy.global?.rules || []), ...(activeHierarchy.project?.rules || []), ...(activeHierarchy.local?.rules || [])]) {
        if (rule.type !== 'verification' || !rule.trigger?.path) continue
        const current = worktreeFingerprint(directory, rule.trigger.path)
        const baseline = verificationBaselines.get(rule.id)
        if (current && baseline && current !== baseline) {
          verificationBaselines.set(rule.id, current)
          const tool = rule.trigger.tools?.[0] || rule.trigger.tool || 'WriteFile'
          await pipeline.evaluate(toEnforceInput(tool, { path: rule.trigger.path, content: rule.trigger.path }, pluginInput, level, directory))
        }
      }
    }
    const requirementSources = [REQUIREMENTS_PATH, path.join(directory, '.keel', 'requirements.md')]
      .filter((source, index, all) => all.indexOf(source) === index)
    consumeRestartDisable()

    /**
     * Post-edit syntax check (tier 1).
     *
     * Runs after an edit lands, so a broken file is caught where it was
     * made rather than at the next test run. Findings are QUEUED, not
     * thrown: the after-hook's only channel is the client log, which the
     * user sees but the model may not. The proven model-visible channel is
     * a throw from the before-hook, so the finding is surfaced on the
     * agent's next tool call — the same deferred-boundary shape the
     * verification obligations already use.
     *
     * Ships observe-first: it warns, it never blocks. Promotion to a
     * harder action is earned by a measured false-positive rate, not
     * assumed.
     */
    const pendingSyntaxFindings: string[] = []

    const verifyEdit = async (tool: string | undefined, args: Record<string, unknown>, sessionID: string | undefined, turn: number) => {
      if (!EDIT_TOOLS.has(String(tool).toLowerCase())) return
      const raw = String(args.filePath || args.path || args.file || '')
      if (!raw) return
      const target = path.isAbsolute(raw) ? raw : path.join(directory, raw)
      if (!isVerifiableFile(target) || !fs.existsSync(target)) return
      const detail = await verifyFileSyntax(target)
      if (!detail) return          // clean, or no verifier available
      const message = `${path.basename(target)} has a syntax error after your edit: ${detail}`
      pendingSyntaxFindings.push(message)
      record({ session_id: sessionID, turn_number: turn, tool, args: { path: target }, rule_id: 'post-edit-syntax', action: 'warn', message, hook: 'tool.execute.after', cwd: directory })
      surfaceWarn('post-edit-syntax', message, sessionID)
    }

    const before = async (input: any, output: any) => {
      if (isDisabled()) return
      if (sentinelCorrupted) {
        sentinelCorrupted = false
        surfaceWarn('corrupt-kill-switch', 'Invalid keel kill-switch state (DISABLED) detected — enforcement stays ON. Fix or delete ~/.keel/DISABLED to clear this.', input?.sessionID)
      }
      // The dial is user-owned; surface once per session what it actually
      // means at sprint so "fewer checks" is a visible choice, not a silent
      // weakening (content/sequence/flow checks are skipped at sprint).
      if (level === 'sprint') surfaceWarn('dial-sprint', 'Sprint dial is active: deny rules warn only, and content, sequence, and flow checks are skipped.', input?.sessionID)
      await refreshExternalChanges()
      // Deliver any post-edit finding here, on the model-visible channel,
      // before evaluating this call. Non-blocking by design: the agent is
      // told the file it just wrote is broken and can fix it, which is the
      // whole point — interrupting the edit itself would be too late.
      if (pendingSyntaxFindings.length) {
        const findings = pendingSyntaxFindings.splice(0, pendingSyntaxFindings.length)
        surfaceWarn(`post-edit-syntax:${findings.length}`, findings.join(' · '), input?.sessionID)
      }
      const args = output?.args || {}
      const enforceInput = toEnforceInput(input?.tool || 'unknown', args, input, level, directory)
      const result = await pipeline.evaluate(enforceInput)
      record({ session_id: input?.sessionID, turn_number: enforceInput.turn_number, tool: input?.tool, args: projectAuditArgs(args), rule_id: result.rule_id, action: result.action, message: result.message, hook: 'tool.execute.before' })
      if (result.action === 'warn' && result.rule_id) surfaceWarn(result.rule_id, result.message, input?.sessionID)
      if (result.action === 'fix') applyFix(args, result)
      if (result.action === 'warn' && result.rule_id && verificationIds.has(result.rule_id)) {
        const key = `${result.rule_id}:${directory}`
        if (verificationWarnings.has(key)) {
          throw new Error(`[Keel] ${result.rule_id}: ${result.message}`)
        }
        verificationWarnings.add(key)
      }
      if (result.action === 'deny' || result.action === 'block' || result.action === 'prompt') {
        // Signed-receipt ledger: every gated/blocked action emits an offline-
        // verifiable, hash-chained receipt (`keel verify` reads the same dir).
        try {
          createReceipt('opencode-plugin', input?.tool || 'unknown', projectAuditArgs(args), result.action, result.rule_id || 'unknown', 'keel', input?.sessionID)
        } catch {}
        throw new Error(`[Keel] ${result.rule_id}: ${result.message}`)
      }
      if (result.action === 'redirect') {
        // Course correction: interrupts this call with the directive so the
        // model sees it (the hook cannot inject tool results), but is NOT a
        // deny — complying with the directive clears it and the same action
        // passes next time. No receipt (nothing was blocked).
        const directive = result.redirect
        const hint = directive?.suggested_call ? ` Try: ${directive.suggested_call}` : ''
        throw new Error(`[Keel] REDIRECT ${result.rule_id}: ${result.message}${hint}`)
      }
    }

    return {
      'tool.execute.before': async (input: any, output: any) => {
        try { await before(input, output) } catch (error) {
          if (error instanceof Error && error.message.startsWith('[Keel]')) throw error
          throw new Error(`[Keel] Enforcement failed closed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      'tool.execute.after': async (input: any, output: any) => {
        try {
          const args = input?.args || {}
          const action = toEnforceInput(input?.tool || 'unknown', args, input, level, directory)
          const exit = output?.metadata?.exit === undefined ? null : Number(output?.metadata?.exit)
          if (exit === 0) pipeline.markVerificationSatisfied(action)
          // Outcome telemetry: exit codes feed the stuck-loop detector and
          // make every trace analysis (attempts-until-success, churn)
          // exact. Also record the working directory for per-project work.
          pipeline.recordAttemptOutcome(action, exit)
          record({ session_id: input?.sessionID, turn_number: action.turn_number, tool: input?.tool, args: projectAuditArgs(args), action: 'allow', message: 'Tool completed', hook: 'tool.execute.after', exit, cwd: directory })
          await verifyEdit(input?.tool, args, input?.sessionID, action.turn_number)
        } catch {}
      },
      'experimental.chat.system.transform': async (input: any, output: any) => {
        try {
          // One model call = one turn. This is the only turn boundary the
          // plugin can observe, and everything keyed on turn_number
          // (flow correlation, claim-to-tool-call pairing) depends on it.
          advanceTurn(input?.sessionID || lastActiveSession)
          const blocks = requirementSources.map(requirementLines).filter(lines => lines.length)
          if (blocks.length) {
            output.system ||= []
            output.system.push(...blocks.map(lines => `Standing Requirements (mandatory):\n${lines.map(line => `- ${line}`).join('\n')}`))
          }
        } catch {}
      },
      'experimental.session.compacting': async (_input: any, output: any) => {
        try {
          const lines = requirementSources.flatMap(requirementLines)
          if (lines.length) {
            output.context ||= []
            output.context.push(`## Standing Requirements (survive compaction)\n${lines.map(line => `- ${line}`).join('\n')}`)
          }
        } catch {}
      },
    }
  },
}
