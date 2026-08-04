import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

/**
 * Session-scoped research cache.
 *
 * Daemon memory is authoritative (fast, per-session); a disk mirror at
 * ~/.keel/cache/research/<session>/<sha256>.json (0600, atomic writes)
 * survives daemon restarts mid-session. `fetched_at` is the freshness
 * timestamp rules evaluate against.
 */

export interface ResearchEntry {
  key: string
  topic: string
  kind: 'search' | 'fetch'
  session_id: string
  fetched_at: number
  expires_at: number
  results?: Array<{ title: string; url: string; snippet: string; rank: number }>
  text?: string
  title?: string
  url?: string
  source: 'duckduckgo' | 'api' | 'platform'
  truncated: boolean
}

export function researchCacheDir(): string {
  return process.env.KEEL_RESEARCH_CACHE_DIR || join(homedir(), '.keel', 'cache', 'research')
}

export function researchKey(sessionId: string, topic: string): string {
  return createHash('sha256').update(`${sessionId}:${topic.toLowerCase().trim()}`).digest('hex')
}

export class ResearchCache {
  private memory = new Map<string, ResearchEntry>()

  constructor(private readonly diskRoot: string = researchCacheDir()) {}

  private diskPath(sessionId: string, key: string): string {
    return join(this.diskRoot, sessionId, `${key}.json`)
  }

  private readDisk(sessionId: string, key: string): ResearchEntry | null {
    try {
      const path = this.diskPath(sessionId, key)
      if (!existsSync(path)) return null
      return JSON.parse(readFileSync(path, 'utf-8')) as ResearchEntry
    } catch {
      return null
    }
  }

  private writeDisk(entry: ResearchEntry): void {
    try {
      const dir = join(this.diskRoot, entry.session_id)
      mkdirSync(dir, { recursive: true })
      const target = this.diskPath(entry.session_id, entry.key)
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 })
      renameSync(tmp, target)
    } catch { /* best effort */ }
  }

  get(sessionId: string, topic: string): ResearchEntry | null {
    const key = researchKey(sessionId, topic)
    const mem = this.memory.get(key)
    if (mem) return mem
    const disk = this.readDisk(sessionId, key)
    if (disk) {
      this.memory.set(key, disk)
      return disk
    }
    return null
  }

  put(entry: Omit<ResearchEntry, 'key' | 'expires_at'> & { maxAgeHours?: number }): ResearchEntry {
    const key = researchKey(entry.session_id, entry.topic)
    const maxAgeMs = (entry.maxAgeHours ?? 24) * 3600_000
    const stored: ResearchEntry = {
      key,
      topic: entry.topic,
      kind: entry.kind,
      session_id: entry.session_id,
      fetched_at: entry.fetched_at,
      expires_at: entry.fetched_at + maxAgeMs,
      results: entry.results,
      text: entry.text,
      title: entry.title,
      url: entry.url,
      source: entry.source,
      truncated: entry.truncated,
    }
    this.memory.set(key, stored)
    this.writeDisk(stored)
    return stored
  }

  /** Probe freshness for a set of topic matchers (regex list). */
  probe(sessionId: string, topics: string[], maxAgeHours: number): { hit: boolean; entries: ResearchEntry[]; stalenessHours?: number } {
    const entries: ResearchEntry[] = []
    for (const [key, entry] of this.memory) {
      if (entry.session_id !== sessionId) continue
      if (topics.some((t) => new RegExp(t, 'i').test(entry.topic))) entries.push(entry)
    }
    if (entries.length === 0) return { hit: false, entries }
    const newest = Math.max(...entries.map((e) => e.fetched_at))
    const maxAgeMs = maxAgeHours * 3600_000
    if (Date.now() - newest <= maxAgeMs) return { hit: true, entries }
    return { hit: false, entries, stalenessHours: (Date.now() - newest) / 3600_000 }
  }

  list(sessionId: string, topicSubstring?: string): ResearchEntry[] {
    const out: ResearchEntry[] = []
    for (const entry of this.memory.values()) {
      if (entry.session_id !== sessionId) continue
      if (topicSubstring && !entry.topic.toLowerCase().includes(topicSubstring.toLowerCase())) continue
      out.push(entry)
    }
    return out.sort((a, b) => b.fetched_at - a.fetched_at)
  }

  clear(sessionId?: string): void {
    if (sessionId) {
      for (const [key, entry] of this.memory) {
        if (entry.session_id === sessionId) this.memory.delete(key)
      }
    } else {
      this.memory.clear()
    }
  }
}
