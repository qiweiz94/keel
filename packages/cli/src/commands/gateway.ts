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

  // Nothing anywhere in this command previously stopped the spawned
  // upstream process on shutdown -- gateway.stop() existed but was never
  // called. Killing this process (SIGTERM, the default for a graceful
  // stop) does not automatically kill a spawned child on either POSIX or
  // Windows, so the upstream process was silently orphaned every time,
  // left running with its own open handles (including whatever log file
  // it may be writing to) for an indeterminate time after. Confirmed as
  // the source of an intermittent Windows CI failure: mcp.test.ts's
  // gateway test killed this process, then its own teardown hit EBUSY
  // removing the temp HOME the orphaned upstream was still holding a file
  // open in.
  const shutdown = () => { gateway.stop(); process.exit(0) }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

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
