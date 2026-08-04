/**
 * MCP Security Gateway — bidirectional proxy with security scanning.
 *
 * Sits between the AI agent and its MCP tool servers, intercepting all
 * traffic in both directions:
 *
 *   AI Agent <-> [keel MCP Gateway] <-> MCP Tool Server
 *
 * Inspired by:
 *   - Microsoft AGT MCP Security Gateway spec (127 conformance tests)
 *   - Pipelock's MCP bidirectional scanning
 *   - Snyk Agent Scan's tool poisoning detection
 *
 * Scanning features:
 *   INPUT:  Tool poisoning (hidden instructions in descriptions)
 *           Prompt injection (malicious arguments)
 *           Path traversal (file system escapes)
 *           Command injection (shell metacharacters)
 *
 *   OUTPUT: DLP (sensitive data in responses)
 *           Secret leakage (API keys, tokens)
 *           Description drift (tool descriptions changing)
 */

import { spawn, ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { daemonCheck } from './daemon-client.js'

// Suspicious patterns in tool descriptions (tool poisoning indicators)
const TOOL_POISONING_PATTERNS = [
  /when\s+you\s+(?:see|read|find)/i,
  /secretly|silently|without\s+telling/i,
  /ignore\s+(?:previous|all|above)\s+(?:instructions|rules|constraints)/i,
  /(?:forget|ignore|disregard).*(?:rules|instructions|constraints)/i,
  /this\s+is\s+(?:a test|just a test|for research|an experiment)/i,
  /you\s+must\s+(?:do this|help me|comply).*(?:for|because|since)/i,
  /(?:urgent|immediately|asap|critical|emergency).*(?:do|run|execute|delete)/i,
  /don'?t\s+(?:tell|say|mention|inform)\s+(?:the user|anyone|them)/i,
]

// DLP patterns for response scanning
const DLP_PATTERNS = [
  { pattern: /(?<![A-Z0-9])(AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/, label: 'AWS Access Key' },
  { pattern: /(?:sk-[a-zA-Z0-9]{32,})/, label: 'OpenAI API Key' },
  { pattern: /(?:ghp_|gho_|ghu_|ghs_)[a-zA-Z0-9]{36}/, label: 'GitHub Token' },
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, label: 'Private Key' },
  { pattern: /\b(?:OPENAI|ANTHROPIC|DEEPSEEK|GITLAB)_(?:API_KEY|SECRET|TOKEN)\b/, label: 'API Key Env Var' },
]

interface UpstreamConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: unknown
}

interface ToolSignature {
  name: string
  description: string
  descriptionHash: string
}

export class MCPGateway {
  private upstream: ChildProcess | null = null
  private rl: ReturnType<typeof createInterface> | null = null
  private upstreamConfig: UpstreamConfig
  private toolCache: Map<string, ToolSignature> = new Map()
  private toolHistory: Map<string, ToolSignature[]> = new Map()
  private requestId = 0
  private pendingRequests: Map<number | string, { resolve: (v: unknown) => void }> = new Map()

  constructor(config: UpstreamConfig) {
    this.upstreamConfig = config
    // Enforcement happens through the keel daemon (one engine, thin
    // clients): every tool call is checked against the modern pipeline
    // before it is forwarded upstream.
  }

  /** Start the upstream MCP server and begin listening */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.upstream = spawn(this.upstreamConfig.command, this.upstreamConfig.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.upstreamConfig.env },
      })

      this.rl = createInterface({ input: this.upstream!.stdout!, crlfDelay: Infinity })

      // Handle upstream responses
      this.rl.on('line', (line: string) => {
        try {
          const msg = JSON.parse(line)
          // Match responses to pending requests
          if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
            const pending = this.pendingRequests.get(msg.id)!
            this.pendingRequests.delete(msg.id)
            pending.resolve(msg)
          }
        } catch { /* ignore parse errors */ }
      })

      this.upstream!.on('error', reject)
      this.upstream!.stdout!.on('error', () => {})
      this.upstream!.stdin!.on('error', () => {})

      // Initialize upstream connection
      this.sendToUpstream({
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'keel-gateway', version: '0.1.0' },
        },
      }).then(() => {
        // Send initialized notification
        this.sendToUpstream({
          jsonrpc: '2.0',
          id: null,
          method: 'notifications/initialized',
        })
        resolve()
      }).catch(reject)
    })
  }

  /** Stop the upstream server */
  stop(): void {
    if (this.upstream) {
      this.upstream.kill()
      this.upstream = null
    }
  }

  /** Send a JSON-RPC message to the upstream and wait for response */
  private async sendToUpstream(msg: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = (msg as any).id
      if (id !== null) {
        this.pendingRequests.set(id, { resolve })
      }

      if (!this.upstream?.stdin?.writable) {
        reject(new Error('Upstream not connected'))
        return
      }

      const timeout = setTimeout(() => {
        if (id !== null) this.pendingRequests.delete(id)
        reject(new Error('Upstream timeout'))
      }, 30000)

      this.upstream.stdin.write(JSON.stringify(msg) + '\n', (err) => {
        if (err) { clearTimeout(timeout); reject(err) }
      })

      // For notifications (no response expected)
      if (id === null) {
        clearTimeout(timeout)
        resolve(undefined)
      }
    })
  }

  // ===== INPUT SCANNING =====

  /** Scan tool descriptions for poisoning indicators */
  scanToolDescription(tool: ToolDefinition): string[] {
    const warnings: string[] = []
    if (!tool.description) return warnings

    // Store for drift detection
    const existing = this.toolCache.get(tool.name)
    if (existing) {
      const currentHash = this.hashDescription(tool.description)
      if (existing.descriptionHash !== currentHash) {
        warnings.push(`Tool description changed: "${tool.name}" — possible rug pull`)
      }
    } else {
      this.toolCache.set(tool.name, {
        name: tool.name,
        description: tool.description,
        descriptionHash: this.hashDescription(tool.description),
      })
    }

    // Check for poisoning patterns
    for (const pattern of TOOL_POISONING_PATTERNS) {
      if (pattern.test(tool.description)) {
        warnings.push(`Suspicious pattern in tool "${tool.name}": ${pattern.source.slice(0, 60)}`)
      }
    }

    return warnings
  }

  /** Scan tool arguments for injection attempts */
  scanToolArgs(toolName: string, args: Record<string, unknown>): string[] {
    const warnings: string[] = []
    const argStr = JSON.stringify(args).toLowerCase()

    // Check for command injection in string arguments
    if (/[;|&`$(){]/.test(argStr)) {
      warnings.push('Shell metacharacters detected in arguments')
    }

    // Check for path traversal
    if (/\.\.\/|\.\.\\|~\/|\/etc\/|\/proc\//.test(argStr)) {
      warnings.push('Path traversal pattern detected')
    }

    // Check for prompt injection in string arguments
    if (/ignore.*instructions|override.*rules|forget.*constraints|you are.*admin/.test(argStr)) {
      warnings.push('Prompt injection pattern detected in arguments')
    }

    return warnings
  }

  // ===== OUTPUT SCANNING =====

  /** Scan tool responses for sensitive data */
  scanResponse(toolName: string, content: string): string[] {
    const warnings: string[] = []
    for (const dlp of DLP_PATTERNS) {
      if (dlp.pattern.test(content)) {
        warnings.push(`DLP: ${dlp.label} detected in ${toolName} response`)
      }
    }
    return warnings
  }

  // ===== TOOL LIST INTERCEPTION =====

  /** Handle incoming tools/list — cache and scan all tool descriptions */
  async handleToolList(): Promise<{ tools: ToolDefinition[] }> {
    const response = await this.sendToUpstream({
      jsonrpc: '2.0',
      id: `req_${++this.requestId}`,
      method: 'tools/list',
    }) as any

    const tools = response?.result?.tools || []

    // Scan all tool descriptions for poisoning
    for (const tool of tools) {
      const warnings = this.scanToolDescription(tool)
      if (warnings.length > 0) {
        console.error(`[keel-gateway] ⚠ Tool poisoning warning for "${tool.name}":`, warnings.join('; '))
      }
    }

    return { tools }
  }

  // ===== TOOL CALL INTERCEPTION =====

  /** Handle incoming tool/call — check policy, forward, scan response */
  async handleToolCall(toolName: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    // 1. Input scanning
    const inputWarnings = this.scanToolArgs(toolName, args)
    if (inputWarnings.length > 0 && inputWarnings.some(w => w.includes('prompt injection'))) {
      return {
        content: [{ type: 'text', text: `SECURITY BLOCKED: ${inputWarnings.join('; ')}` }],
        isError: true,
      }
    }

    // 2. Policy check through the keel daemon (git hook bypass, destructive
    //    commands, etc.) — the same verdicts every integration gets.
    const verdict = await daemonCheck({
      tool: `mcp__${toolName}`,
      args,
      cwd: process.cwd(),
      session_id: 'gateway',
    }).catch(() => null)
    if (verdict && (verdict.action === 'deny' || verdict.action === 'block' || verdict.action === 'prompt')) {
      return {
        content: [{ type: 'text', text: `POLICY BLOCKED: ${verdict.message}` }],
        isError: true,
      }
    }

    // 3. Forward to upstream
    try {
      const response = await this.sendToUpstream({
        jsonrpc: '2.0',
        id: `req_${++this.requestId}`,
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }) as any

      const result = response?.result || response

      // 4. Output scanning (DLP)
      if (result?.content) {
        for (const content of result.content) {
          if (typeof content.text === 'string') {
            const dlpWarnings = this.scanResponse(toolName, content.text)
            if (dlpWarnings.length > 0) {
              console.error(`[keel-gateway] ⚠ DLP alert in "${toolName}" response:`, dlpWarnings.join('; '))
            }
          }
        }
      }

      return result || { content: [{ type: 'text', text: 'OK' }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `ERROR: Upstream server error: ${err}` }],
        isError: true,
      }
    }
  }

  private hashDescription(desc: string): string {
    return createHash('sha256').update(desc).digest('hex')
  }

  /** Process an incoming JSON-RPC message from the AI agent */
  async processRequest(msg: { method: string; params?: any; id?: number | string | null }): Promise<unknown> {
    switch (msg.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'keel-gateway', version: '0.1.0' },
          },
        }

      case 'notifications/initialized':
        return null

      case 'tools/list': {
        const upstreamTools = await this.handleToolList()
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: upstreamTools,
        }
      }

      case 'tools/call': {
        const result = await this.handleToolCall(
          msg.params?.name || '',
          msg.params?.arguments || {}
        )
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result,
        }
      }

      case 'resources/read': {
        // Reads reach real file content, so they get the same file_rules
        // treatment as a Read tool. Previously this fell through to `default`
        // and was forwarded upstream unevaluated — an upstream exposing
        // resources could serve .env straight past the policy.
        const uri = String(msg.params?.uri || '')
        let filePath = uri
        if (uri.startsWith('file://')) {
          // fileURLToPath throws ERR_INVALID_URL on a malformed URI. An
          // upstream (or an agent) could send one; letting it propagate would
          // take the gateway down, which is a denial-of-enforcement.
          try {
            filePath = fileURLToPath(uri)
          } catch {
            return {
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32602, message: 'keel: malformed resource URI' },
            }
          }
        }
        if (filePath) {
          const verdict = await daemonCheck({
            tool: 'read_file',
            args: { filePath },
            cwd: process.cwd(),
            session_id: 'gateway',
          }).catch(() => null)
          if (verdict && (verdict.action === 'deny' || verdict.action === 'block' || verdict.action === 'prompt')) {
            return {
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32000, message: `keel: ${verdict.message}` },
            }
          }
        }
        return this.forward(msg)
      }

      default:
        // Methods with no policy-relevant payload (ping, logging/setLevel,
        // completion/complete, ...) are forwarded. tools/call and
        // resources/read — the two that carry commands and file content — are
        // handled above; extending coverage means adding a case here, not
        // widening this fallthrough.
        return this.forward(msg)
    }
  }

  /** Forward a message upstream, surfacing failure as a JSON-RPC error. */
  private async forward(
    msg: { method: string; params?: any; id?: number | string | null }
  ): Promise<unknown> {
    try {
      return await this.sendToUpstream({
        jsonrpc: '2.0',
        id: msg.id,
        method: msg.method,
        params: msg.params,
      })
    } catch (err) {
      // Previously `result: null`, which reads to the client as a successful
      // empty response rather than a failure.
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: `upstream error: ${(err as Error).message}` },
      }
    }
  }
}
