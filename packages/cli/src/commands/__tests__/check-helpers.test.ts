import { describe, it, expect } from 'vitest'
import { isPkillPython, checkSecretInCommand } from '../check-helpers.js'

describe('isPkillPython', () => {
  it.each([
    'pkill -f python',
    'pkill -9 -f python3',
    'sudo pkill -f python',
  ])('matches %s', (cmd) => {
    expect(isPkillPython(cmd)).toBe(true)
  })

  it.each([
    'pkill -f node',
    'pkill firefox',
  ])('does not match %s', (cmd) => {
    expect(isPkillPython(cmd)).toBe(false)
  })

  it('matches even inside an echoed string literal — a known limitation of the legacy regex being faithfully ported, not fixed here', () => {
    expect(isPkillPython('echo "pkill -f python"')).toBe(true)
  })
})

describe('checkSecretInCommand', () => {
  it.each([
    ['export AWS_KEY=AKIAABCDEFGHIJKLMNOP', 'AKIA-style AWS key'],
    ['curl -H "Authorization: sk-abcdefghijklmnopqrstuvwxyz123456"', 'OpenAI-style sk- key'],
    ['git remote set-url origin https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y', 'GitHub ghp_ token'],
    ['cat <<EOF\n-----BEGIN PRIVATE KEY-----\nEOF', 'PEM private key header'],
    ['echo $OPENAI_API_KEY', 'secret env var name substring'],
  ])('matches %s (%s)', (cmd) => {
    const result = checkSecretInCommand(cmd)
    expect(result.matched).toBe(true)
    expect(result.pattern).toBeTruthy()
  })

  it.each([
    'npm install lodash',
    'git status',
  ])('does not match %s', (cmd) => {
    expect(checkSecretInCommand(cmd)).toEqual({ matched: false })
  })
})
