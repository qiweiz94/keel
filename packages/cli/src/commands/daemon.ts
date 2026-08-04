import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import chalk from 'chalk'
import { EnforcementPipeline } from '../core/enforce/pipeline.js'
import { ActionCache, ContentTracker } from '../core/enforce/cache.js'
import { SequenceDetector } from '../core/enforce/sequencer.js'
import { FlowTracker } from '../core/enforce/flow-tracker.js'
import { StateManager } from '../core/enforce/state-manager.js'
import { loadRuleHierarchy, parseRulesContent } from '../core/enforce/rule-parser.js'
import { ProblemLedger } from '../core/enforce/problem-ledger.js'
import { StuckTracker } from '../core/enforce/stuck-tracker.js'
import { commandString } from '../core/enforce/arg-utils.js'
import { ResearchCache } from '../core/enforce/research/research-cache.js'
import { fetchPage, ResearchError } from '../core/enforce/research/fetcher.js'
import { webSearch, type SearchConfig } from '../core/enforce/research/search.js'
import { DEFAULT_RULES_YAML } from './install.js'
import type { EnforceInput, ProtectionLevel } from '../core/types.js'

/**
 * `keel daemon` — the long-lived enforcement service.
 *
 * The long-term architecture is ONE engine, ONE runtime, thin clients:
 * every platform integration (OpenCode plugin, Claude Code hooks, Hermes
 * and OpenClaw plugins, MCP tools) becomes a thin client of this daemon, so
 * policy logic and enforcement STATE (warn-once/deny-repeat escalation,
 * rate windows, verification obligations) live in exactly one process
 * instead of being duplicated per integration.
 *
 *   POST /v1/check         { tool, args, cwd, session_id, level? } → EnforceResult
 *   GET  /v1/requirements  → standing requirements for prompt injection
 *   GET  /v1/health        → liveness + version + pid
 *
 * Auth: Bearer token (or X-Keel-Token header) read from ~/.keel/daemon-token
 * (created on first start, mode 0600). The token gates the check API so
 * other local processes cannot probe enforcement state.
 */

export const DAEMON_PORT = 31990

export function daemonTokenPath(): string {
  return join(homedir(), '.keel', 'daemon-token')
}

export function daemonStatePath(): string {
  return join(homedir(), '.keel', 'daemon.json')
}

export function loadOrCreateDaemonToken(): string {
  const path = daemonTokenPath()
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf-8').trim()
    if (existing) return existing
  }
  // Atomic exclusive create: concurrent starters must never mint two
  // tokens for one file (the loser reads the winner's).
  const token = randomBytes(24).toString('hex')
  mkdirSync(join(homedir(), '.keel'), { recursive: true })
  try {
    writeFileSync(path, token + '\n', { flag: 'wx', mode: 0o600 })
  } catch { /* a concurrent starter won — use its token */ }
  const onDisk = existsSync(path) ? readFileSync(path, 'utf-8').trim() : token
  return onDisk || token
}

export function loadDaemonState(): { port: number; pid: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(daemonStatePath(), 'utf-8'))
    if (typeof parsed?.port === 'number' && typeof parsed?.pid === 'number') return parsed
    return null
  } catch {
    return null
  }
}

function secureEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// One pipeline per project directory: rules load per cwd, but the shared
// StateManager keeps escalation and rate state across every project and
// every platform client.
const pipelineCache = new Map<string, EnforcementPipeline>()
const sharedState = new StateManager()
const sharedResearchCache = new ResearchCache()
const sharedLedger = new ProblemLedger()

function ruleFingerprint(cwd: string): string {
  const sources = [
    join(cwd, '.keel', 'rules.yaml'),
    join(cwd, 'AGENTS.md'),
    join(cwd, 'CLAUDE.md'),
    join(cwd, '.keel.local.yaml'),
    join(cwd, 'AGENTS.local.md'),
    join(cwd, 'CLAUDE.local.md'),
    join(homedir(), '.keel', 'rules.yaml'),
    join(homedir(), '.config', 'keel', 'rules.yaml'),
  ]
  const hash = createHash('sha256')
  for (const source of sources) {
    hash.update(source)
    if (existsSync(source)) hash.update(readFileSync(source))
  }
  return hash.digest('hex')
}

function pipelineFor(cwd: string): EnforcementPipeline {
  const existing = pipelineCache.get(cwd)
  if (existing) return existing
  let hierarchy = loadRuleHierarchy(cwd)
  // Same fallback as the plugin: when no rules exist anywhere, enforce the
  // built-in defaults so a bare project is still protected.
  const scopes = [hierarchy.global, hierarchy.user, hierarchy.project, hierarchy.local]
  if (!scopes.some((s) => s && s.rules.length > 0)) {
    hierarchy = { global: parseRulesContent(DEFAULT_RULES_YAML, 'keel:defaults'), user: null, project: null, local: null }
  }
  const level = (hierarchy.project?.config?.level || hierarchy.global?.config?.level || 'balanced') as ProtectionLevel
  const pipeline = new EnforcementPipeline({
    level,
    context: 'local',
    cache: new ActionCache({ maxSize: 1000 }),
    contentTracker: new ContentTracker(),
    sequenceDetector: new SequenceDetector(),
    flowTracker: new FlowTracker(),
    researchCache: sharedResearchCache,
    stuckTracker: new StuckTracker(),
    ledger: sharedLedger,
    ruleHierarchy: hierarchy,
    ruleVersion: 1,
    allowedFixTransforms: true,
    stateManager: sharedState,
    reloadRules: () => loadRuleHierarchy(cwd),
    ruleFingerprint: () => ruleFingerprint(cwd),
    onRulesError: (errors) => {
      console.error(`[keel daemon] rules error (${cwd}): ${errors.join('; ')}`)
    },
  })
  pipelineCache.set(cwd, pipeline)
  return pipeline
}

function requirementsContent(cwd: string): string {
  for (const file of [join(homedir(), '.keel', 'requirements.md'), join(cwd, '.keel', 'requirements.md')]) {
    if (existsSync(file)) return readFileSync(file, 'utf-8')
  }
  return ''
}

function searchConfig(): SearchConfig {
  const backend = (process.env.KEEL_SEARCH_BACKEND || 'duckduckgo') as SearchConfig['backend']
  return {
    backend: backend === 'api' || backend === 'none' ? backend : 'duckduckgo',
    apiUrl: process.env.KEEL_SEARCH_API_URL,
    apiKey: process.env.KEEL_SEARCH_API_KEY,
  }
}

function researchErrorStatus(err: unknown): number {
  if (err instanceof ResearchError) {
    if (err.code === 'ssrf_blocked') return 422
    if (err.code === 'timeout') return 504
    if (err.code === 'too_large') return 413
    return 502
  }
  return 500
}

function researchErrorMessage(err: unknown): string {
  if (err instanceof ResearchError) return `${err.code}: ${err.message}`
  return String(err)
}

export interface DaemonHandle {
  port: number
  token: string
  close: () => Promise<void>
}

export function startDaemon(options: { port?: number; token?: string; idleTimeoutMs?: number } = {}): Promise<DaemonHandle> {
  const token = options.token || loadOrCreateDaemonToken()
  const idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60 * 1000
  let lastActivity = Date.now()
  const server = createServer((req, res) => {
    lastActivity = Date.now()
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
    const authed = secureEqual(bearer, token) || secureEqual(String(req.headers['x-keel-token'] || ''), token)
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/v1/health') {
      return send(200, { ok: true, service: 'keel', version: '0.1.0', pid: process.pid })
    }

    if (!authed) return send(401, { error: 'unauthorized' })

    if (url.pathname === '/v1/check' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as Partial<EnforceInput> & { cwd?: string }
          const cwd = parsed.cwd || process.cwd()
          const pipeline = pipelineFor(cwd)
          const hierarchy = loadRuleHierarchy(cwd)
          const dial = (hierarchy.project?.config?.level || hierarchy.global?.config?.level || 'balanced') as ProtectionLevel
          const input: EnforceInput = {
            tool: String(parsed.tool || 'unknown'),
            args: (parsed.args || {}) as Record<string, unknown>,
            cwd,
            session_id: parsed.session_id || 'daemon',
            turn_number: parsed.turn_number ?? 1,
            context_tokens: parsed.context_tokens ?? 0,
            level: (parsed.level as ProtectionLevel | undefined) || dial,
            context: 'local' as const,
            agent: parsed.agent || 'unknown',
            subagent_of: parsed.subagent_of ?? null,
          }
          pipeline.evaluate(input)
            .then((result) => send(200, result))
            .catch((err) => send(500, { error: String(err) }))
        } catch (err) {
          return send(400, { error: String(err) })
        }
      })
      return
    }

    if (url.pathname === '/v1/requirements') {
      const cwd = url.searchParams.get('cwd') || process.cwd()
      return send(200, { content: requirementsContent(cwd) })
    }

    if (url.pathname === '/v1/research' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            query?: string
            url?: string
            session_id?: string
            cwd?: string
            max_results?: number
            max_age_hours?: number
          }
          const sessionId = parsed.session_id || 'daemon'
          const maxResults = Math.min(Math.max(Number(parsed.max_results) || 5, 1), 10)
          const maxAgeHours = parsed.max_age_hours ?? (Number(process.env.KEEL_RESEARCH_MAX_AGE_HOURS) || 24)

          if (parsed.url) {
            fetchPage(parsed.url)
              .then((page) => {
                const entry = sharedResearchCache.put({
                  topic: parsed.url as string,
                  kind: 'fetch',
                  session_id: sessionId,
                  fetched_at: page.fetched_at,
                  maxAgeHours,
                  text: page.text,
                  title: page.title,
                  url: page.finalUrl,
                  source: 'platform',
                  truncated: page.truncated,
                })
                return send(200, { kind: 'fetch', entry, cached: false })
              })
              .catch((err: unknown) => send(researchErrorStatus(err), { error: researchErrorMessage(err) }))
            return
          }

          if (parsed.query) {
            webSearch(parsed.query, searchConfig(), maxResults)
              .then(async (results) => {
                const entry = sharedResearchCache.put({
                  topic: parsed.query as string,
                  kind: 'search',
                  session_id: sessionId,
                  fetched_at: Date.now(),
                  maxAgeHours,
                  results,
                  source: searchConfig().backend === 'api' ? 'api' : 'duckduckgo',
                  truncated: false,
                })
                return send(200, { kind: 'search', entry, cached: false })
              })
              .catch((err: unknown) => send(researchErrorStatus(err), { error: researchErrorMessage(err) }))
            return
          }

          return send(400, { error: 'provide a query or a url' })
        } catch (err) {
          return send(400, { error: String(err) })
        }
      })
      return
    }

    if (url.pathname === '/v1/research/cache') {
      const sessionId = url.searchParams.get('session_id') || 'daemon'
      const topic = url.searchParams.get('topic') || undefined
      return send(200, { entries: sharedResearchCache.list(sessionId, topic) })
    }

    if (url.pathname === '/v1/hypothesis' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { problem_key?: string; statement?: string; evidence?: string[]; session_id?: string }
          if (!parsed.statement || typeof parsed.statement !== 'string') {
            return send(400, { error: 'statement is required' })
          }
          let problemKey = parsed.problem_key
          if (!problemKey) problemKey = sharedLedger.activeProblemKey(parsed.session_id || 'daemon') || ''
          if (!problemKey) return send(400, { error: 'no active problem — provide problem_key' })
          const hypothesis = sharedLedger.addHypothesis(problemKey, parsed.statement, parsed.evidence || [])
          return send(200, { hypothesis, problem_key: problemKey })
        } catch (err) {
          return send(400, { error: String(err) })
        }
      })
      return
    }

    if (url.pathname === '/v1/outcome' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { session_id?: string; cwd?: string; tool?: string; args?: Record<string, unknown>; exit_code?: number | null }
          const cwd = parsed.cwd || process.cwd()
          const command = commandString({ tool: parsed.tool || 'unknown', args: parsed.args || {}, cwd, session_id: parsed.session_id || 'daemon', turn_number: 1, context_tokens: 0, level: 'balanced', context: 'local', agent: 'unknown', subagent_of: null } as EnforceInput)
          const exit = parsed.exit_code === undefined ? null : Number(parsed.exit_code)
          sharedLedger.recordOutcome(cwd, command, exit, parsed.session_id || 'daemon')
          const pipeline = pipelineFor(cwd)
          pipeline.recordAttemptOutcome({ tool: parsed.tool || 'unknown', args: parsed.args || {}, cwd, session_id: parsed.session_id || 'daemon', turn_number: 1, context_tokens: 0, level: 'balanced', context: 'local', agent: 'unknown', subagent_of: null } as EnforceInput, exit)
          return send(200, { recorded: true })
        } catch (err) {
          return send(400, { error: String(err) })
        }
      })
      return
    }

    return send(404, { error: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(options.port || 0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      // Idle exit: a daemon with no requests for the idle window shuts
      // itself down (clients auto-spawn it again on demand), so abandoned
      // daemons cannot pile up.
      const idleTimer = setInterval(() => {
        if (Date.now() - lastActivity > idleTimeoutMs) {
          clearInterval(idleTimer)
          server.close()
        }
      }, 30000)
      resolve({
        port,
        token,
        close: () => {
          clearInterval(idleTimer)
          return new Promise((done) => server.close(() => done()))
        },
      })
    })
  })
}

export async function daemonCommand(options: { port?: number } = {}): Promise<DaemonHandle> {
  const token = loadOrCreateDaemonToken()
  const port = options.port ?? (Number(process.env.KEEL_DAEMON_PORT) || DAEMON_PORT)
  const handle = await startDaemon({ port, token })

  mkdirSync(join(homedir(), '.keel'), { recursive: true })
  writeFileSync(daemonStatePath(), JSON.stringify({ port: handle.port, pid: process.pid }, null, 2) + '\n', { mode: 0o600 })

  console.log(chalk.bold.cyan('\n  ⚓ keel daemon'))
  console.log()
  console.log(`  ${chalk.dim('Listening on:')} ${chalk.green(`127.0.0.1:${handle.port}`)} ${chalk.dim(`(pid ${process.pid})`)}`)
  console.log(chalk.dim('  Token: ~/.keel/daemon-token (0600 — shared with keel clients)'))
  console.log(chalk.dim('  Endpoints: /v1/check · /v1/requirements · /v1/health'))
  console.log(chalk.dim('  Press Ctrl+C to stop.'))
  console.log()

  const cleanup = () => {
    try {
      const state = loadDaemonState()
      if (state?.pid === process.pid) {
        const { unlinkSync } = require('node:fs') as typeof import('node:fs')
        unlinkSync(daemonStatePath())
      }
    } catch {}
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  return handle
}
