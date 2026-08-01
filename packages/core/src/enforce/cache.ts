import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { CacheEntry, CacheStats } from '../types.js'

export interface CacheContext {
  cwd: string
  level: string
  context: string
  depth: string
  action?: string
  rules_hash?: string
}

export class ActionCache {
  private session: Map<string, CacheEntry> = new Map()
  private persistent: Map<string, CacheEntry> = new Map()
  private maxSize: number
  private persistentPath: string | null = null
  private stats = { hits: 0, misses: 0 }

  constructor(opts?: { maxSize?: number; persistentPath?: string }) {
    this.maxSize = opts?.maxSize || 10000
    this.persistentPath = opts?.persistentPath || null
    if (this.persistentPath && existsSync(this.persistentPath)) {
      try {
        const data = JSON.parse(readFileSync(this.persistentPath, 'utf-8'))
        if (typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            this.persistent.set(k, v as CacheEntry)
          }
        }
      } catch { /* ignore corrupt cache */ }
    }
  }

  hash(tool: string, args: unknown, ruleVersion: number, context?: CacheContext): string {
    const raw = `${tool}:${this.canonicalize(args)}:${ruleVersion}:${this.canonicalize(context || {})}`
    return createHash('sha256').update(raw).digest('hex')
  }

  get(tool: string, args: unknown, ruleVersion: number, context?: CacheContext): CacheEntry | null {
    const key = this.hash(tool, args, ruleVersion, context)

    // Check session cache first
    const sessionEntry = this.session.get(key)
    if (sessionEntry) {
      this.stats.hits++
      sessionEntry.count++
      return sessionEntry
    }

    // Check persistent cache
    const persistentEntry = this.persistent.get(key)
    if (persistentEntry) {
      this.stats.hits++
      persistentEntry.count++
      // Promote to session cache
      this.session.set(key, persistentEntry)
      return persistentEntry
    }

    this.stats.misses++
    return null
  }

  set(tool: string, args: unknown, ruleVersion: number, entry: CacheEntry, context?: CacheContext): void {
    const key = this.hash(tool, args, ruleVersion, context)
    this.session.set(key, entry)

    // Evict least-used if over max size
    if (this.session.size > this.maxSize) {
      let minKey = ''
      let minCount = Infinity
      for (const [k, v] of this.session) {
        if (v.count < minCount) { minCount = v.count; minKey = k }
      }
      if (minKey) this.session.delete(minKey)
    }
  }

  setPersistent(tool: string, args: unknown, ruleVersion: number, entry: CacheEntry, context?: CacheContext): void {
    const key = this.hash(tool, args, ruleVersion, context)
    this.persistent.set(key, entry)
    this.flush()
  }

  flush(): void {
    if (!this.persistentPath) return
    const dir = this.persistentPath.substring(0, this.persistentPath.lastIndexOf('/'))
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data: Record<string, CacheEntry> = {}
    for (const [k, v] of this.persistent) {
      data[k] = v
    }
    writeFileSync(this.persistentPath, JSON.stringify(data, null, 0))
  }

  clear(): void {
    this.session.clear()
    this.persistent.clear()
    this.stats = { hits: 0, misses: 0 }
  }

  clearSession(): void {
    this.session.clear()
  }

  invalidate(ruleVersion: number): void {
    // Remove entries that used the old rule version
    // (rule version is part of the hash key, so it's automatic on hash mismatch)
    // But we should clear persistent to avoid stale entries
    this.session.clear()
    this.persistent.clear()
    this.flush()
  }

  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses
    return {
      size: this.session.size + this.persistent.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hit_rate: total > 0 ? this.stats.hits / total : 0,
    }
  }

  private canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(item => this.canonicalize(item)).join(',')}]`
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${this.canonicalize((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
}

/**
 * Track which files have changed since last check.
 * Uses content hashing to avoid re-scanning unchanged files.
 */
export class ContentTracker {
  private hashes: Map<string, string> = new Map()

  hasChanged(filePath: string): boolean {
    if (!existsSync(filePath)) return true
    const content = readFileSync(filePath, 'utf-8')
    let h = 0
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) - h) + content.charCodeAt(i)
      h |= 0
    }
    const hash = h.toString(36)
    const prev = this.hashes.get(filePath)
    this.hashes.set(filePath, hash)
    return prev !== hash
  }

  markUnchanged(filePath: string): void {
    if (!existsSync(filePath)) return
    const content = readFileSync(filePath, 'utf-8')
    let h = 0
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) - h) + content.charCodeAt(i)
      h |= 0
    }
    this.hashes.set(filePath, h.toString(36))
  }

  clear(): void {
    this.hashes.clear()
  }
}
