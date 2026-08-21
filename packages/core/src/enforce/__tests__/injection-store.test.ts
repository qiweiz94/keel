import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PersistentInjectionStore, INJECTION_TAG_TTL_MS, type PersistedInjectionTag } from '../injection-store.js'
import { rmSafe } from './helpers/fs-safe.js'

/**
 * Lane F — the next-call scrutiny gate's persisted backing store, modeled
 * directly on flow-store.ts's own PersistentFlowStore (see flow-store.test.ts
 * for the sibling suite this mirrors). Proves the same safety properties
 * that make it safe to ship at warn tier: session scoping, TTL expiry,
 * consume-once semantics (peek never burns the tag, consume always does),
 * bounded growth, and fail-open-on-corruption.
 *
 * Real cross-PROCESS file-lock safety under concurrent writers is covered
 * separately in injection-store-concurrency.test.ts.
 */

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'keel-injection-store-test-'))
})

afterEach(() => {
  rmSafe(dir)
})

function tag(overrides: Partial<PersistedInjectionTag> = {}): PersistedInjectionTag {
  return {
    source: 'tool_output',
    timestamp: Date.now(),
    originTool: 'Read',
    ruleIds: ['injected-instructions-in-tool-output'],
    markerCount: 1,
    neutralized: false,
    ...overrides,
  }
}

describe('PersistentInjectionStore — arm/peek/consume', () => {
  it('a tag recorded by one instance is visible to a SEPARATE instance sharing the same directory + session', () => {
    const store1 = new PersistentInjectionStore(dir)
    store1.recordTag('shared-session', tag())

    const store2 = new PersistentInjectionStore(dir)
    const pending = store2.peekPending('shared-session')
    expect(pending.length).toBe(1)
    expect(pending[0].ruleIds).toEqual(['injected-instructions-in-tool-output'])
  })

  it('a DIFFERENT session_id does not see the tag — no cross-session leak', () => {
    const store1 = new PersistentInjectionStore(dir)
    store1.recordTag('session-A', tag())

    const store2 = new PersistentInjectionStore(dir)
    expect(store2.peekPending('session-B')).toEqual([])
  })

  it('an empty session_id is a no-op on write and read', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('', tag())
    expect(store.peekPending('')).toEqual([])
    expect(store.consumePending('')).toEqual([])
  })

  it('peekPending never consumes — the tag is still there on a second peek', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('peek-session', tag())
    expect(store.peekPending('peek-session').length).toBe(1)
    expect(store.peekPending('peek-session').length, 'a second peek must still see the tag').toBe(1)
  })

  it('consumePending clears the tag — a second consume (or peek) sees nothing', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('consume-session', tag())
    const consumed = store.consumePending('consume-session')
    expect(consumed.length).toBe(1)
    expect(store.peekPending('consume-session'), 'consumed tag must not still be pending').toEqual([])
    expect(store.consumePending('consume-session'), 'a second consume must find nothing').toEqual([])
  })

  it('a TTL-expired tag is neither peeked nor consumed', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('stale-session', tag({ timestamp: Date.now() - INJECTION_TAG_TTL_MS - 1000 }))
    expect(store.peekPending('stale-session')).toEqual([])
    expect(store.consumePending('stale-session')).toEqual([])
  })

  it('a tag recorded well within the TTL still peeks/consumes (not an off-by-one)', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('fresh-session', tag({ timestamp: Date.now() - (INJECTION_TAG_TTL_MS - 60_000) }))
    expect(store.peekPending('fresh-session').length).toBe(1)
    expect(store.consumePending('fresh-session').length).toBe(1)
  })

  it('multiple tags recorded for the same session are all returned together on consume', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('multi-session', tag({ originTool: 'Read' }))
    store.recordTag('multi-session', tag({ originTool: 'WebFetch', ruleIds: ['untrusted-content-role-markers'] }))
    const consumed = store.consumePending('multi-session')
    expect(consumed.length).toBe(2)
    expect(consumed.map(t => t.originTool).sort()).toEqual(['Read', 'WebFetch'])
  })

  it('a corrupt store file degrades to "nothing pending", never throws (fail-safe: warn/observe tier, not a floor)', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('corrupt-session', tag())
    writeFileSync(join(dir, 'injection-tags.json'), '{ not valid json')

    const store2 = new PersistentInjectionStore(dir)
    expect(() => store2.peekPending('corrupt-session')).not.toThrow()
    expect(store2.peekPending('corrupt-session')).toEqual([])
    expect(() => store2.consumePending('corrupt-session')).not.toThrow()
    expect(store2.consumePending('corrupt-session')).toEqual([])
  })
})

describe('PersistentInjectionStore — bounds', () => {
  it('caps tags retained per session at MAX_TAGS_PER_SESSION (bounded, not unbounded growth)', () => {
    const store = new PersistentInjectionStore(dir)
    for (let i = 0; i < 80; i++) {
      store.recordTag('hot-session', tag({ originTool: `tool-${i}` }))
    }
    const tags = store.peekPending('hot-session')
    expect(tags.length).toBeLessThanOrEqual(50)
    // The most RECENT tags survive, not the oldest.
    expect(tags[tags.length - 1].originTool).toBe('tool-79')
  })

  it('caps the number of distinct sessions retained at MAX_SESSIONS, evicting least-recently-active first', () => {
    const store = new PersistentInjectionStore(dir)
    for (let i = 0; i < 210; i++) {
      store.recordTag(`session-${i}`, tag({ timestamp: Date.now() + i }))
    }
    expect(store.peekPending('session-0')).toEqual([])
    expect(store.peekPending('session-209').length).toBe(1)
  })
})
