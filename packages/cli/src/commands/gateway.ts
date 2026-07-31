import { createInterface } from 'node:readline'
import chalk from 'chalk'
import { MCPGateway } from '../mcp/gateway.js'

export async function gatewayCommand(options: { upstream?: string; command?: string; port?: string }) {
  // Parse upstream config
  const upstreamJson = options.upstream || process.env.KEEL_UPSTREAM_SERVERS
  if (!upstreamJson && !options.command) {
    console.log(chalk.red('Error: Upstream MCP server required.'))
    console.log('Usage:')
    console.log('  keel gateway --command "npx @modelcontextprotocol/server-filesystem ."')
    console.log('  KEEL_UPSTREAM_SERVERS=\'{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}\' keel gateway')
    return
  }

  let config: { command: string; args: string[]; env?: Record<string, string> }
  if (options.command) {
    const parts = options.command.split(/\s+/)
    config = { command: parts[0], args: parts.slice(1) }
  } else {
    try {
      config = JSON.parse(upstreamJson!)
    } catch {
      console.log(chalk.red('Error: Invalid KEEL_UPSTREAM_SERVERS JSON'))
      return
    }
  }

  console.log(chalk.cyan('\n🔐 keel MCP Security Gateway'))
  console.log(chalk.cyan(`   Upstream: ${config.command} ${config.args.join(' ')}\n`))

  const gateway = new MCPGateway(config)

  try {
    await gateway.start()
    console.log(chalk.green('✓ Connected to upstream MCP server\n'))
  } catch (err) {
    console.log(chalk.red(`✗ Failed to connect: ${err}`))
    return
  }

  // Listen on stdin for incoming MCP requests
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      const result = await gateway.processRequest(msg)
      if (result) {
        process.stdout.write(JSON.stringify(result) + '\n')
      }
    } catch (err) {
      console.error(`[gateway] Error: ${err}`)
    }
  }
}
