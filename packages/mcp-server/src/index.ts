#!/usr/bin/env node
/**
 * keel MCP enforcement server.
 *
 * Two modes:
 *   1. POLICY CHECK (stdio, default) — Exposes keel_check and keel_audit tools
 *      that AI agents can call to check actions against policy. Run via stdio transport.
 *
 *   2. FORWARDING PROXY (HTTP, experimental) — Sits between AI agent and tools,
 *      forwarding approved calls and blocking policy violations.
 *      Requires KEEL_UPSTREAM_SERVERS env var.
 *
 * Usage:
 *   # Policy check mode (stdio):
 *   npx @get-keel/mcp-server
 *
 *   # Forwarding proxy mode (HTTP):
 *   KEEL_UPSTREAM_SERVERS='{"fs":{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}}' \
 *   npx @get-keel/mcp-server --transport http
 */

import { PolicyEngine } from '@get-keel/core'
import { readFileSync, existsSync, writeSync } from 'node:fs'
import { join } from 'node:path'

// ==================== Deprecation guard ====================
//
// @get-keel/mcp-server is deprecated (package.json's description says so
// outright, AGENTS.md says outright "Never publish MCP; packages/mcp-server
// is private and deprecated") and superseded by `keel serve`
// (packages/cli/src/mcp/server.ts) — a separate, actively maintained,
// properly-authenticated implementation with 7 tools, not 2.
//
// This package is `"private": true` (never published to npm) but was still
// runnable from a local checkout, and a local checkout is exactly what a
// live audit found reachable, real bugs in: it fails closed on any project
// with no `.keel.yaml` (the opposite of the CLI's own behavior for the
// identical scenario), it silently returns fake "POLICY OK" for
// unrecognized tool names instead of erroring, its documented HTTP
// transport crashes at startup (a `require()` inside this ESM module, and
// its own `--transport http` argv check can never match a real shell
// invocation of its own documented usage example), a malformed
// `.keel.yaml`'s `network_rules` regex can throw uncaught and get
// mislabeled as a JSON-RPC parse error (losing the request id), and its
// `keel_check` tool is an unconfined path-traversal oracle — no cwd
// confinement, so it can probe arbitrary absolute paths (e.g. `~/.ssh/id_rsa`)
// for secret-pattern matches.
//
// Rather than patch bugs in a package that is supposed to be going away,
// the entry point refuses to run at all. This must fire before
// `loadPolicy()` or any tool-serving logic — so it is the first thing that
// executes here, ahead of even the `policyPath`/`engine` construction below,
// and everything below is unreachable dead code, kept (not deleted) only so
// the implementation survives if this package is ever revived.
//
// `writeSync(2, ...)` (not `console.error`/`process.stderr.write`) because
// stderr can be a non-blocking pipe when spawned as a child process (true
// of every test that exercises this entry point); a plain async write
// racing `process.exit()` can get truncated before the message flushes.
writeSync(
  2,
  "packages/@get-keel/mcp-server is deprecated and no longer maintained. " +
    "Use 'keel serve' instead (part of @get-keel/cli). " +
    "See docs/integrations.md for the current MCP server.\n"
)
process.exit(1)

const policyPath = process.env.KEEL_POLICY || join(process.cwd(), '.keel.yaml')
const engine = new PolicyEngine(policyPath)

if (existsSync(policyPath)) {
  engine.loadPolicy()
}

// Parse transport mode
const transport = process.argv.includes('--transport http') ? 'http' : 'stdio'

const PORT = parseInt(process.env.KEEL_PORT || '3100', 10)

if (transport === 'http') {
  startHttpServer()
} else {
  startStdioServer()
}

// ==================== STDIO Transport ====================

function startStdioServer() {
  process.stdin.setEncoding('utf-8')
  let buffer = ''

  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        handleMessage(JSON.parse(line))
      } catch (err) {
        sendErrorStdio(null, -32700, `Parse error: ${err}`)
      }
    }
  })
}

function sendResponseStdio(id: number | string | null, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function sendErrorStdio(id: number | string | null, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

// ==================== HTTP Transport (experimental) ====================

function startHttpServer() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('node:http')
  const server = http.createServer((req: any, res: any) => {
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        try {
          const msg = JSON.parse(body)
          const response = handleMessageHTTP(msg)
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
  server.listen(PORT, () => {
    console.error(`keel MCP server listening on http://localhost:${PORT}`)
  })
}

function handleMessageHTTP(msg: { jsonrpc: string; id: number | string | null; method: string; params?: Record<string, unknown> }) {
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
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: getToolDefinitions() } }
    case 'tools/call':
      return handleToolCallHTTP(msg.id, msg.params as { name: string; arguments?: Record<string, unknown> })
    default:
      return { jsonrpc: '2.0', id: msg.id, result: null }
  }
}

function handleToolCallHTTP(id: number | string | null, params: { name: string; arguments?: Record<string, unknown> }) {
  return handleToolCallCommon(params?.name || '', params?.arguments || {}, id)
}

// ==================== Common MCP Handler ====================

function handleMessage(msg: { jsonrpc: string; id: number | string | null; method: string; params?: Record<string, unknown> }) {
  switch (msg.method) {
    case 'initialize':
      sendResponseStdio(msg.id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        serverInfo: { name: 'keel', version: '0.1.0' },
      })
      break
    case 'notifications/initialized':
      break
    case 'tools/list':
      sendResponseStdio(msg.id, { tools: getToolDefinitions() })
      break
    case 'tools/call': {
      const result = handleToolCallCommon(
        (msg.params as any)?.name || '',
        (msg.params as any)?.arguments || {},
        msg.id
      )
      sendResponseStdio(msg.id, result)
      break
    }
    case 'resources/list':
      sendResponseStdio(msg.id, { resources: [] })
      break
    default:
      sendResponseStdio(msg.id, null)
  }
}

function handleToolCallCommon(
  toolName: string,
  args: Record<string, unknown>,
  _id: number | string | null
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  // Internal: keel_check — check an action against policy
  if (toolName === 'keel_check') {
    const action = String(args.action || '')
    const target = String(args.target || '')
    // v1 M1r-2 — locked product decision: degenerate input fails closed,
    // never a silent allow. `action` and `target` are both `required` in
    // this tool's own inputSchema (getToolDefinitions below), but nothing
    // enforced that before this handler ran. A missing `action` already
    // fails closed one level down (PolicyEngine.evaluate()'s own
    // degenerate-tool_name guard), but a missing `target` alone did not —
    // `command: '', filePath: ''` matches no real command_rules/file_rules
    // pattern, so a keel_check call that checked nothing at all still read
    // back "POLICY OK" to the caller. Both are caught here, together, at
    // this tool's own arg-contract boundary, before evaluate() runs.
    if (!action || !target) {
      return {
        content: [{
          type: 'text',
          text: 'POLICY BLOCKED: keel_check requires both "action" and "target" — keel could not evaluate this call, so it was blocked.',
        }],
        isError: true,
      }
    }
    const results = engine.evaluate({
      tool_name: action,
      args: { command: target, filePath: target },
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
    })
    const blocks = results.filter(r => r.action === 'block')
    const warns = results.filter(r => r.action === 'warn')

    if (blocks.length > 0) {
      return {
        content: [{ type: 'text', text: `POLICY BLOCKED: ${blocks[0].message}\nRule: ${blocks[0].rule_name}` }],
        isError: true,
      }
    }
    if (warns.length > 0) {
      return {
        content: [{ type: 'text', text: `POLICY WARNING: ${warns[0].message}\nRule: ${warns[0].rule_name}` }],
      }
    }
    return { content: [{ type: 'text', text: 'POLICY OK: Action is allowed by project policy.' }] }
  }

  // Internal: keel_audit — view audit log
  if (toolName === 'keel_audit') {
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

  // External tool call: check policy, allow or block
  const results = engine.evaluate({
    tool_name: toolName,
    args,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
  })
  const blocks = results.filter(r => r.action === 'block')
  if (blocks.length > 0) {
    return {
      content: [{ type: 'text', text: `POLICY BLOCKED: ${blocks[0].message}\nRule: ${blocks[0].rule_name}` }],
      isError: true,
    }
  }

  // If in HTTP mode with upstream configured, forward to upstream
  if (transport === 'http' && process.env.KEEL_UPSTREAM_SERVERS) {
    return {
      content: [{ type: 'text', text: `FORWARD: ${toolName} allowed by policy (proxy forwarding not yet implemented in this version).` }],
    }
  }

  // Stdio mode or no upstream: return policy OK
  return { content: [{ type: 'text', text: `POLICY OK: Action "${toolName}" is allowed by project policy.` }] }
}

function getToolDefinitions() {
  return [
    {
      name: 'keel_check',
      title: 'Check action against policy',
      description: 'Check if an action (file write, command, git operation) is allowed by project policy. Call this BEFORE executing any potentially dangerous operation.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'The action type (e.g., "write_file", "run_command", "git_push")' },
          target: { type: 'string', description: 'The target (e.g., file path, command string)' },
        },
        required: ['action', 'target'],
      },
    },
    {
      name: 'keel_audit',
      title: 'View policy audit log',
      description: 'Retrieve recent policy enforcement actions and violations.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of recent entries (default 10)' },
        },
      },
    },
  ]
}
