import { describe, it, expect } from 'vitest'
import { PolicyEngine } from '@get-keel/core'

function engine(): PolicyEngine {
  const e = new PolicyEngine()
  e.loadPolicy()
  return e
}

describe('secret-exposure detection', () => {
  const flags = (cmd: string) => engine().checkApiKeyExposure(cmd).length > 0

  it('catches reading a secrets file — which the docstring promised but the code never did', () => {
    // Every branch used to also require a SECRET_ENV_PATTERNS *variable name*
    // in the command, and `cat .env` contains none, so it never matched.
    expect(flags('cat .env')).toBe(true)
  })

  it.each([
    ['  cat .env', 'leading whitespace defeated the ^ anchor'],
    ['/bin/cat .env', 'absolute path defeated the verb match'],
    ['less .env', 'only cat/type/echo/print were listed'],
    ['head -5 .env', 'same'],
    ['xxd .env', 'same'],
    ['foo && cat .env', 'only the first command in the line was examined'],
    ['cp .env /tmp/exfil', 'copying out is exposure too'],
    ['cat .env.production', 'suffixed env files'],
    ['cat ~/.ssh/id_rsa', 'private keys are secrets too'],
  ])('catches %s', (cmd) => {
    expect(flags(cmd)).toBe(true)
  })

  it.each([
    'cat README.md',
    'ls -la',
    'git status',
    'npm install express',
    'cat .env.example',   // templates hold placeholders, not secrets
    'cat config.sample',
  ])('does not flag %s', (cmd) => {
    // False positives are how a security tool gets switched off.
    expect(flags(cmd)).toBe(false)
  })
})

describe('a malformed rule fails alone', () => {
  it('does not take down enforcement for every other rule', () => {
    // `new RegExp` was called unguarded in matchCommandRule, so one bad pattern
    // threw out of evaluate() and disabled ALL enforcement.
    const e = new PolicyEngine()
    e.loadPolicy()
    ;(e as any).policy = {
      version: '1.0',
      name: 'test',
      command_rules: [
        { name: 'broken', patterns: [{ regex: '([unclosed' }], action: 'block', message: 'x' },
        { name: 'good', patterns: [{ regex: '^rm -rf /' }], action: 'block', message: 'destructive' },
      ],
    }

    let results: any[] = []
    expect(() => {
      results = e.evaluate({
        tool_name: 'bash', args: { command: 'rm -rf /' }, cwd: '.', timestamp: '',
      })
    }).not.toThrow()

    // The valid rule still fires despite its broken neighbour.
    expect(results.some((r) => r.rule_name === 'good' && r.action === 'block')).toBe(true)
  })
})
