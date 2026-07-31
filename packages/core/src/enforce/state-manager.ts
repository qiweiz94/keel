import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface DenyState {
  [ruleId: string]: number  // rule_id → first violation timestamp (ms)
}

export interface CircuitBreakerState {
  [key: string]: { count: number; startTime: number }  // "ruleId:tool" → state
}

export interface RateLimitState {
  [key: string]: { count: number; windowStart: number }
}

export interface VerificationState {
  [key: string]: { createdAt: number; generation: number }
}

const STATE_DIR = join(homedir(), '.keel', 'state')
const TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

/**
 * StateManager — persists enforcement state across process boundaries.
 *
 * Loads state from disk on construction, saves after each mutation.
 * Uses atomic file writes (.tmp + rename) to prevent corruption.
 * Drops entries older than 24h on load.
 */
export class StateManager {
  denyFirstTime: DenyState = {}
  circuitBreaker: CircuitBreakerState = {}
  rateCounts: RateLimitState = {}
  verification: VerificationState = {}

  constructor() {
    this.load()
  }

  private statePath(name: string): string {
    return join(STATE_DIR, `${name}.json`)
  }

  private loadFile<T>(name: string, fallback: T): T {
    const p = this.statePath(name)
    try {
      if (existsSync(p)) {
        return JSON.parse(readFileSync(p, 'utf-8'))
      }
    } catch { /* corrupt — use defaults */ }
    return fallback
  }

  private saveFile(name: string, data: unknown): void {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      const p = this.statePath(name)
      const tmp = p + '.tmp'
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, p)
    } catch { /* state persistence is non-critical */ }
  }

  private load(): void {
    const now = Date.now()

    // Load and clean denyFirstTime
    const rawDenies = this.loadFile<DenyState>('deny-first-time', {})
    this.denyFirstTime = {}
    for (const [ruleId, ts] of Object.entries(rawDenies)) {
      if (now - ts < TTL_MS) this.denyFirstTime[ruleId] = ts
    }

    // Load and clean circuitBreaker
    const rawCB = this.loadFile<CircuitBreakerState>('circuit-breaker', {})
    this.circuitBreaker = {}
    for (const [key, val] of Object.entries(rawCB)) {
      if (now - val.startTime < TTL_MS) this.circuitBreaker[key] = val
    }

    // Load and clean rateCounts
    const rawRate = this.loadFile<RateLimitState>('rate-counts', {})
    this.rateCounts = {}
    for (const [key, val] of Object.entries(rawRate)) {
      if (now - val.windowStart < TTL_MS) this.rateCounts[key] = val
    }

    const rawVerification = this.loadFile<VerificationState>('verification', {})
    this.verification = {}
    for (const [key, val] of Object.entries(rawVerification)) {
      if (now - val.createdAt < TTL_MS) this.verification[key] = val
    }
  }

  /** Mark a rule as having been violated (first time). */
  markFirstTime(ruleId: string): void {
    this.denyFirstTime[ruleId] = Date.now()
    this.saveFile('deny-first-time', this.denyFirstTime)
  }

  /** Check if a rule has been violated before. */
  isFirstTime(ruleId: string): boolean {
    return !(ruleId in this.denyFirstTime)
  }

  /** Record a circuit breaker event. Returns true if threshold (3+) reached. */
  recordCircuitBreaker(ruleId: string, tool: string): boolean {
    const key = `${ruleId}:${tool}`
    const now = Date.now()
    const existing = this.circuitBreaker[key]

    if (existing && now - existing.startTime < 60000) {
      existing.count++
      this.circuitBreaker[key] = existing
    } else {
      this.circuitBreaker[key] = { count: 1, startTime: now }
    }

    this.saveFile('circuit-breaker', this.circuitBreaker)
    return this.circuitBreaker[key].count >= 3
  }

  /** Check and increment rate limit. Returns true if over limit. */
  checkRateLimit(ruleId: string, matchPattern: string, windowSec: number, maxCalls: number): boolean {
    const key = `rate:${ruleId}:${matchPattern}`
    const now = Date.now()
    const existing = this.rateCounts[key]

    if (existing && now - existing.windowStart < windowSec * 1000) {
      existing.count++
      this.rateCounts[key] = existing
      this.saveFile('rate-counts', this.rateCounts)
      return existing.count > maxCalls
    } else {
      this.rateCounts[key] = { count: 1, windowStart: now }
      this.saveFile('rate-counts', this.rateCounts)
      return false
    }
  }

  setVerification(key: string, value: { createdAt: number; generation: number }): void {
    this.verification[key] = value
    this.saveFile('verification', this.verification)
  }

  clearVerification(key: string): void {
    delete this.verification[key]
    this.saveFile('verification', this.verification)
  }
}
