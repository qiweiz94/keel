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
    expect(store.consumePending('', 'rule-a')).toEqual([])
  })

  it('peekPending never consumes — the tag is still there on a second peek', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('peek-session', tag())
    expect(store.peekPending('peek-session').length).toBe(1)
    expect(store.peekPending('peek-session').length, 'a second peek must still see the tag').toBe(1)
  })

  it('consumePending MARKS (never deletes) — a second consume by the SAME rule id finds nothing new, but the tag is still visible to a DIFFERENT rule id and to an unfiltered peek', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('consume-session', tag())
    const consumed = store.consumePending('consume-session', 'rule-a')
    expect(consumed.length).toBe(1)
    expect(store.peekPending('consume-session', 'rule-a'), 'consumed-by-rule-a tag must not still be pending for rule-a').toEqual([])
    expect(store.consumePending('consume-session', 'rule-a'), 'a second consume by rule-a must find nothing new').toEqual([])
    // The whole point of the redesign: a DIFFERENT rule id has not
    // consumed this tag yet, and an unfiltered peek still sees it — it was
    // marked, not deleted.
    expect(store.peekPending('consume-session', 'rule-b').length, 'a different rule id has not consumed it').toBe(1)
    expect(store.peekPending('consume-session').length, 'unfiltered peek still sees the marked-not-deleted tag').toBe(1)
  })

  it('a TTL-expired tag is neither peeked nor consumed', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('stale-session', tag({ timestamp: Date.now() - INJECTION_TAG_TTL_MS - 1000 }))
    expect(store.peekPending('stale-session')).toEqual([])
    expect(store.consumePending('stale-session', 'rule-a')).toEqual([])
  })

  it('a tag recorded well within the TTL still peeks/consumes (not an off-by-one)', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('fresh-session', tag({ timestamp: Date.now() - (INJECTION_TAG_TTL_MS - 60_000) }))
    expect(store.peekPending('fresh-session').length).toBe(1)
    expect(store.consumePending('fresh-session', 'rule-a').length).toBe(1)
  })

  it('multiple tags recorded for the same session are all returned together on consume', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('multi-session', tag({ originTool: 'Read' }))
    store.recordTag('multi-session', tag({ originTool: 'WebFetch', ruleIds: ['untrusted-content-role-markers'] }))
    const consumed = store.consumePending('multi-session', 'rule-a')
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
    expect(() => store2.consumePending('corrupt-session', 'rule-a')).not.toThrow()
    expect(store2.consumePending('corrupt-session', 'rule-a')).toEqual([])
  })
})

describe('PersistentInjectionStore — Lane G: id assignment, artifacts, per-rule consumption', () => {
  it('recordTag assigns an id when the caller omits one', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('id-session', tag())
    const [t] = store.peekPending('id-session')
    expect(typeof t.id).toBe('string')
    expect(t.id!.length).toBeGreaterThan(0)
  })

  it('recordTag preserves a caller-supplied id rather than overwriting it', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('id-session-2', tag({ id: 'caller-supplied-id' }))
    const [t] = store.peekPending('id-session-2')
    expect(t.id).toBe('caller-supplied-id')
  })

  it('ids are unique across rapid writes', () => {
    const store = new PersistentInjectionStore(dir)
    for (let i = 0; i < 30; i++) store.recordTag('rapid-session', tag({ originTool: `tool-${i}` }))
    const tags = store.peekPending('rapid-session')
    const ids = new Set(tags.map(t => t.id))
    expect(ids.size).toBe(tags.length)
  })

  it('prune() backfills a missing id on a legacy tag (simulated pre-Lane-G record with no id field)', () => {
    const store = new PersistentInjectionStore(dir)
    // Simulate a tag written by pre-Lane-G code: no id/artifacts/consumedBy.
    writeFileSync(join(dir, 'injection-tags.json'), JSON.stringify({
      'legacy-session': [{
        source: 'tool_output', timestamp: Date.now(), originTool: 'Read',
        ruleIds: ['injected-instructions-in-tool-output'], markerCount: 1, neutralized: false,
      }],
    }))
    // Any read that goes through prune() (recordTag/consumePending) backfills the id.
    store.consumePending('legacy-session', 'some-rule', [])
    const [t] = store.peekPending('legacy-session')
    expect(typeof t.id).toBe('string')
  })

  it('peekPending(sessionId, ruleId) hides a tag already consumed by THAT rule while still showing it to a different rule id', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('per-rule-session', tag())
    store.consumePending('per-rule-session', 'rule-x')
    expect(store.peekPending('per-rule-session', 'rule-x')).toEqual([])
    expect(store.peekPending('per-rule-session', 'rule-y').length).toBe(1)
  })

  it('consumePending with an explicit ids array marks only those tags', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('selective-session', tag({ id: 'tag-1', originTool: 'Read' }))
    store.recordTag('selective-session', tag({ id: 'tag-2', originTool: 'WebFetch' }))
    const consumed = store.consumePending('selective-session', 'rule-a', ['tag-1'])
    expect(consumed.length).toBe(1)
    expect(consumed[0].id).toBe('tag-1')
    // tag-2 must still be pending for rule-a.
    const stillPending = store.peekPending('selective-session', 'rule-a')
    expect(stillPending.map(t => t.id)).toEqual(['tag-2'])
  })

  it('THE regression guard: the broad rule consuming a tag first must not blind a narrower sibling rule sharing the same store', () => {
    const store = new PersistentInjectionStore(dir)
    store.recordTag('shared-session', tag())
    // Broad rule fires first.
    const broadConsumed = store.consumePending('shared-session', 'untrusted-content-next-call')
    expect(broadConsumed.length).toBe(1)
    // A LATER call still reaches the narrower correlated rule, which must
    // still see the tag as pending FOR ITS OWN id — this is exactly the
    // bug delete-on-consume produced.
    const narrowPending = store.peekPending('shared-session', 'untrusted-content-derived-call')
    expect(narrowPending.length, 'the narrower rule must still see the tag after the broad rule consumed it').toBe(1)
    const narrowConsumed = store.consumePending('shared-session', 'untrusted-content-derived-call')
    expect(narrowConsumed.length).toBe(1)
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
