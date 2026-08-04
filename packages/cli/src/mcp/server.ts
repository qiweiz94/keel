/**
 * keel MCP enforcement server — rebuilt on the daemon contract.
 *
 * The MCP layer is a THIN CLIENT of `keel daemon` (auto-spawned on first
 * use): the modern EnforcementPipeline runs in exactly one process, and the
 * MCP tools expose the same verdicts every other integration sees.
 *
 * Transports:
 *   stdio (default) — newline-delimited JSON-RPC (the reference MCP stdio
 *     framing), launched by platforms as `keel serve`.
 *   HTTP — streamable-HTTP (POST JSON-RPC, GET SSE stream). Token required:
 *     Bearer header or X-Keel-Token, from ~/.keel/daemon-token.
 *
 * Tools:
 *   keel_check        { tool, args, cwd?, session_id? } → EnforceResult
 *   keel_audit        { limit? } → recent enforcement trace entries
 *   keel_requirements { cwd? }   → standing requirements for prompt injection
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ensureDaemon, daemonCheck, daemonRequirements, daemonResearch, daemonResearchCache } from './daemon-client.js'
import type { EnforceResult } from '../core/types.js'
import type { ResearchEntry } from '../core/enforce/research/research-cache.js'

const VERSION = '0.1.0'

function auditEntries(limit: number): string[] {
  const out: string[] = []
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  for (const file of [join(homedir(), '.keel', 'traces', `${today}.jsonl`), join(homedir(), '.keel', 'traces', `${yesterday}.jsonl`)]) {
    try {
      if (!existsSync(file)) continue
      const lines = readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) out.push(lines[i])
    } catch {}
  }
  return out
}

function toolDefinitions() {
  return [
    {
      name: 'keel_check',
      description: 'Check an action against keel policy BEFORE executing it. Returns the verdict (allow/warn/deny), the matching rule, and a message. Call this before any potentially dangerous tool use.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'The tool/action name (e.g. "Bash", "write")' },
          args: { type: 'object', description: 'The tool arguments (e.g. { command: "rm -rf /" } for Bash)' },
          cwd: { type: 'string', description: 'Working directory for rule resolution (defaults to the server cwd)' },
          session_id: { type: 'string', description: 'Session identifier for escalation state (warn-once/deny-repeat)' },
        },
        required: ['tool', 'args'],
      },
    },
    {
      name: 'keel_audit',
      description: 'Retrieve recent enforcement trace entries (denies, warnings, gates).',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Number of recent entries (default 10)' } },
      },
    },
    {
      name: 'keel_requirements',
      description: 'Retrieve the standing requirements for prompt injection into the system context.',
      inputSchema: {
        type: 'object',
        properties: { cwd: { type: 'string', description: 'Working directory (defaults to the server cwd)' } },
      },
    },
    {
      name: 'keel_research',
      description: 'Search the web for current information on a topic (latest API versions, breaking changes, exact error text) and cache the result for this session. Use BEFORE attempting fixes — satisfies knowledge-freshness gates. Backend: DuckDuckGo by default; configure KEEL_SEARCH_BACKEND / KEEL_SEARCH_API_URL / KEEL_SEARCH_API_KEY.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query naming the exact module/API/error' },
          session_id: { type: 'string', description: 'Session identifier (must match keel_check)' },
          max_results: { type: 'number', description: 'Max results (default 5, max 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'keel_fetch',
      description: 'Fetch a URL, strip scripts/styles, and return readable text (capped at 1 MB). SSRF-guarded: private IPs, localhost, and metadata endpoints are blocked.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL to fetch' },
          session_id: { type: 'string' },
        },
        required: ['url'],
      },
    },
    {
      name: 'keel_search_cache',
      description: 'List research cached for this session with fetched_at timestamps (freshness evidence).',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          topic: { type: 'string', description: 'Optional topic filter (substring)' },
        },
        required: ['session_id'],
      },
    },
  ]
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  if (name === 'keel_check') {
    const tool = String(args.tool || 'unknown')
    const toolArgs = (args.args || {}) as Record<string, unknown>
    const cwd = String(args.cwd || process.cwd())
    const session_id = String(args.session_id || 'mcp')
    try {
      const result: EnforceResult = await daemonCheck({ tool, args: toolArgs, cwd, session_id, level: 'balanced' })
      return {
        content: [{ type: 'text', text: `VERDICT: ${result.action}\nRULE: ${result.rule_id || 'none'}\nMESSAGE: ${result.message}` }],
        isError: result.action === 'deny' || result.action === 'block' || result.action === 'prompt',
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `KEEL ERROR: ${err}` }], isError: true }
    }
  }

  if (name === 'keel_audit') {
    const limit = Math.min(Number(args.limit) || 10, 100)
    const entries = auditEntries(limit)
    return { content: [{ type: 'text', text: entries.length ? entries.join('\n') : 'No enforcement activity recorded.' }] }
  }

  if (name === 'keel_requirements') {
    const cwd = String(args.cwd || process.cwd())
    try {
      const content = await daemonRequirements(cwd)
      return { content: [{ type: 'text', text: content || 'No standing requirements configured.' }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `KEEL ERROR: ${err}` }], isError: true }
    }
  }

  if (name === 'keel_research' || name === 'keel_fetch' || name === 'keel_search_cache') {
    const sessionId = String(args.session_id || 'mcp')
    try {
      if (name === 'keel_research') {
        const query = String(args.query || '')
        if (!query) return { content: [{ type: 'text', text: 'KEEL ERROR: query is required' }], isError: true }
        const result = await daemonResearch({
          query,
          session_id: sessionId,
          max_results: Number(args.max_results) || 5,
        })
        const lines = [
          `RESEARCH: ${result.entry.topic} (cached: ${result.cached})`,
          ...(result.entry.results || []).map((r) => `${r.rank}. ${r.title}\n   ${r.url}\n   ${r.snippet}`),
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
      if (name === 'keel_fetch') {
        const url = String(args.url || '')
        if (!url) return { content: [{ type: 'text', text: 'KEEL ERROR: url is required' }], isError: true }
        const result = await daemonResearch({ url, session_id: sessionId })
        const page = result.entry
        return { content: [{ type: 'text', text: `TITLE: ${page.title || ''}\nURL: ${page.url || ''}\n\n${(page.text || '').slice(0, 20000)}${page.truncated ? '\n[truncated]' : ''}` }] }
      }
      const result = await daemonResearchCache(sessionId, String(args.topic || ''))
      const lines = result.entries.length
        ? result.entries.map((e) => `${new Date(e.fetched_at).toISOString()} [${e.kind}] ${e.topic} (${e.results?.length ?? 0} results)`).join('\n')
        : 'No research cached for this session.'
      return { content: [{ type: 'text', text: lines }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `KEEL ERROR: ${err}` }], isError: true }
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
}

async function handleRequest(msg: { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }): Promise<Record<string, unknown> | null> {
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id ?? null,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'keel', version: VERSION },
        },
      }
    case 'notifications/initialized':
    case 'notifications/tools/list_changed':
      return null
    case 'ping':
      return { jsonrpc: '2.0', id: msg.id ?? null, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id ?? null, result: { tools: toolDefinitions() } }
    case 'tools/call': {
      const params = msg.params || {}
      const result = await handleToolCall(String(params.name || ''), (params.arguments || {}) as Record<string, unknown>)
      return { jsonrpc: '2.0', id: msg.id ?? null, result }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id ?? null, result: null }
  }
}

// ==================== Stdio transport ====================

export function startStdioServer(): void {
  process.stdin.setEncoding('utf-8')
  let buffer = ''
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        handleRequest(msg).then((response) => {
          if (response) process.stdout.write(JSON.stringify(response) + '\n')
        }).catch(() => {})
      } catch (err) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err}` } }) + '\n')
      }
    }
  })
}

// ==================== HTTP transport (streamable-http) ====================

export function startHttpServer(port = 3100): void {
  const tokenFile = join(homedir(), '.keel', 'daemon-token')
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf-8').trim() : ''

  const server = createServer((req, res) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
    const authed = token.length > 0 && (bearer === token || String(req.headers['x-keel-token'] || '') === token)

    if (req.method === 'GET') {
      // SSE stream for server-initiated events (none today — held open with
      // a heartbeat so clients that expect a stream stay connected).
      if (!authed) {
        res.writeHead(401)
        res.end()
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      })
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)
      req.on('close', () => clearInterval(heartbeat))
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    if (!authed) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        const msg = JSON.parse(body)
        handleRequest(msg).then((response) => {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(response || { jsonrpc: '2.0', id: msg.id ?? null, result: null }))
        }).catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: 'internal error' } }))
        })
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err}` } }))
      }
    })
  })

  server.listen(port, () => {
    console.error(`keel MCP server listening on port ${port} (streamable-http, token from ~/.keel/daemon-token)`)
  })
}
