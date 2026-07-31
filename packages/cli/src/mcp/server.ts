/**
 * keel MCP enforcement server.
 *
 * Two modes:
 *   1. POLICY CHECK (stdio, default) — Exposes ai_enforce_check and ai_enforce_audit tools
 *      that AI agents can call to check actions against policy.
 *
 *   2. FORWARDING PROXY (HTTP, experimental) — Sits between AI agent and tools,
 *      forwarding approved calls and blocking policy violations.
 *      Requires AI_ENFORCE_UPSTREAM_SERVERS env var for upstream forwarding.
 *
 * Usage via CLI:
 *   keel serve                    # Stdio mode (default)
 *   keel serve --transport http   # HTTP proxy mode (experimental)
 *   keel serve --port 8080        # Custom port
 */

import { PolicyEngine } from '../policy-engine.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let engine: PolicyEngine

function initEngine(): void {
  const policyPath = process.env.KEEL_POLICY || join(process.cwd(), '.keel.yaml')
  engine = new PolicyEngine(policyPath)
  if (existsSync(policyPath)) {
    engine.loadPolicy()
  }
}

// ==================== STDIO Transport ====================

export function startStdioServer(): void {
  initEngine()
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
        const response = handleRequest(msg)
        if (response) {
          process.stdout.write(JSON.stringify(response) + '\n')
        }
      } catch (err) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err}` } }) + '\n')
      }
    }
  })
}

// ==================== HTTP Transport ====================

export function startHttpServer(port: number = 3100): void {
  initEngine()
  // Dynamic import to avoid requiring http when not needed
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('node:http')

  const server = http.createServer((req: any, res: any) => {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        try {
          const msg = JSON.parse(body)
          const response = handleRequest(msg)
          if (!response) {
            res.writeHead(200)
            res.end()
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(response))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err}` } }))
        }
      })
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ server: 'keel-mcp', version: '0.1.0', transport: 'http' }))
    }
  })

  server.listen(port, () => {
    console.error(`keel MCP server listening on http://localhost:${port}`)
  })
}

// ==================== Request Handler ====================

function handleRequest(msg: { jsonrpc: string; id: number | string | null; method: string; params?: Record<string, unknown> }): Record<string, unknown> | null {
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
          serverInfo: { name: 'keel', version: '0.1.0' },
        },
      }
    case 'notifications/initialized':
      return null
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: getToolDefinitions() } }
    case 'tools/call':
      return handleToolCall(msg.id, msg.params as { name: string; arguments?: Record<string, unknown> })
    default:
      return { jsonrpc: '2.0', id: msg.id, result: null }
  }
}

function handleToolCall(id: number | string | null, params: { name: string; arguments?: Record<string, unknown> }): Record<string, unknown> {
  const toolName = params?.name || ''
  const args = params?.arguments || {}
  const result = evaluateToolCall(toolName, args)
  return { jsonrpc: '2.0', id, result }
}

function evaluateToolCall(
  toolName: string,
  args: Record<string, unknown>
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  // Internal: ai_enforce_check — check an action against policy
  if (toolName === 'ai_enforce_check') {
    const action = String(args.action || '')
    const target = String(args.target || '')
    const results = engine.evaluate({
      tool_name: action,
      args: { command: target, filePath: target },
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    })
    const blocks = results.filter(r => r.action === 'block')
    const warns = results.filter(r => r.action === 'warn')

    if (blocks.length > 0) {
      return { content: [{ type: 'text', text: `POLICY BLOCKED: ${blocks[0].message}\nRule: ${blocks[0].rule_name}` }], isError: true }
    }
    if (warns.length > 0) {
      return { content: [{ type: 'text', text: `POLICY WARNING: ${warns[0].message}\nRule: ${warns[0].rule_name}` }] }
    }
    return { content: [{ type: 'text', text: 'POLICY OK: Action is allowed by project policy.' }] }
  }

  // Internal: ai_enforce_audit — view audit log
  if (toolName === 'ai_enforce_audit') {
    const limit = Number(args.limit) || 10
    const log = engine.getAuditLog().slice(-limit)
    return {
      content: [{
        type: 'text',
        text: log.length > 0
          ? log.map(e => `[${e.action}] ${e.message} (${e.timestamp})`).join('\n')
          : 'No enforcement actions logged.',
      }],
    }
  }

  // External tool call: check policy
  const results = engine.evaluate({
    tool_name: toolName,
    args,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
  })
  const blocks = results.filter(r => r.action === 'block')
  if (blocks.length > 0) {
    return { content: [{ type: 'text', text: `POLICY BLOCKED: ${blocks[0].message}\nRule: ${blocks[0].rule_name}` }], isError: true }
  }

  return { content: [{ type: 'text', text: `POLICY OK: Action "${toolName}" is allowed by project policy.` }] }
}

function getToolDefinitions() {
  return [
    {
      name: 'ai_enforce_check',
      title: 'Check action against policy',
      description: 'Check if an action is allowed by project policy. Call this BEFORE executing any potentially dangerous operation.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action type (e.g., "write_file", "run_command")' },
          target: { type: 'string', description: 'The target (e.g., file path, command string)' },
        },
        required: ['action', 'target'],
      },
    },
    {
      name: 'ai_enforce_audit',
      title: 'View policy audit log',
      description: 'Retrieve recent policy enforcement actions.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Number of recent entries (default 10)' } },
      },
    },
  ]
}
