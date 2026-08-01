import { describe, expect, it } from 'vitest'
import { ActionCache } from '../cache.js'

describe('action cache keys', () => {
  it('canonicalizes nested arguments and includes evaluation context', () => {
    const cache = new ActionCache()
    const base = { cwd: '/project', level: 'balanced', context: 'local', depth: 'full' }
    expect(cache.hash('Bash', { nested: { a: 1, b: 2 } }, 1, base))
      .toBe(cache.hash('Bash', { nested: { b: 2, a: 1 } }, 1, base))
    expect(cache.hash('Bash', { nested: { a: 1 } }, 1, base))
      .not.toBe(cache.hash('Bash', { nested: { b: 2 } }, 1, base))
    expect(cache.hash('Bash', { command: 'echo hi' }, 1, base))
      .not.toBe(cache.hash('Bash', { command: 'echo hi' }, 1, { ...base, level: 'protect' }))
  })
})
