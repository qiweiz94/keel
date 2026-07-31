import chalk from 'chalk'

export async function serveCommand(options: { port?: string; transport?: string }) {
  const port = parseInt(options.port || '3100', 10)
  const transport = options.transport === 'http' ? 'http' : 'stdio'

  console.log(chalk.cyan(`keel MCP server starting (${transport} transport)...`))

  if (transport === 'http') {
    console.log(chalk.cyan(`  Listening on http://localhost:${port}`))
    console.log(chalk.yellow('  Note: HTTP proxy forwarding is experimental.'))
    console.log(chalk.yellow('  Set AI_ENFORCE_UPSTREAM_SERVERS env var for upstream tool forwarding.'))
  } else {
    console.log(chalk.cyan('  Reading JSON-RPC from stdin, writing to stdout'))
    console.log(chalk.yellow('  Stdio mode: provides ai_enforce_check and ai_enforce_audit tools.'))
    console.log(chalk.yellow('  AI agents call these to check actions against policy.'))
  }

  // Dynamic import of MCP server
  const { startStdioServer, startHttpServer } = await import('../mcp/server.js')

  if (transport === 'http') {
    startHttpServer(port)
  } else {
    startStdioServer()
  }
}
