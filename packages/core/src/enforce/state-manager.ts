import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface DenyState {
  [ruleId: string]: number | { timestamp: number; version?: string }  // legacy timestamp or versioned first warning
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

export interface OracleFailureState {
  [key: string]: { timestamp: number; command: string }  // "oracle:<ruleId>:<cwd>" → last failing test run
}

/**
 * Resolves KEEL_STATE_DIR from the environment at CALL time, not module
 * load. Mirrors audit.ts's AuditLog (KEEL_TRACES_DIR) and overrides.ts's
 * FileRuleOverrideStore (KEEL_OVERRIDES_DIR) — a module-level const is
 * fixed at first import of this file (whichever test happens to import it
 * first, process-wide), which defeats a test that sets the env var in its
 * own beforeEach/it after some other file already triggered the import.
 * Called from the constructor's default parameter below, so every `new
 * StateManager()` with no explicit dir re-reads the current env var.
 */
export function stateDir(): string {
  return process.env.KEEL_STATE_DIR || join(homedir(), '.keel', 'state')
}

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
  oracleFailures: OracleFailureState = {}

  private readonly dir: string

  constructor(dir: string = stateDir()) {
    this.dir = dir
    this.load()
  }

  private statePath(name: string): string {
    return join(this.dir, `${name}.json`)
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
      mkdirSync(this.dir, { recursive: true })
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
    for (const [ruleId, value] of Object.entries(rawDenies)) {
      const timestamp = typeof value === 'number' ? value : value.timestamp
      if (now - timestamp < TTL_MS) this.denyFirstTime[ruleId] = value
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

    // Load and clean oracleFailures. The 24h TTL here is a hygiene bound
    // (drop ancient entries so the file doesn't grow forever) — it is NOT
    // the recency window a rule fires on; that is `rule.window_seconds`
    // (default 900s), checked separately by OracleTracker.recentFailure.
    const rawOracle = this.loadFile<OracleFailureState>('oracle-failures', {})
    this.oracleFailures = {}
    for (const [key, val] of Object.entries(rawOracle)) {
      if (now - val.timestamp < TTL_MS) this.oracleFailures[key] = val
    }
  }

  /** Mark a rule as having been violated (first time). */
  markFirstTime(ruleId: string, version?: string): void {
    this.denyFirstTime[ruleId] = version
      ? { timestamp: Date.now(), version }
      : Date.now()
    this.saveFile('deny-first-time', this.denyFirstTime)
  }

  /** Check if a rule has been violated before. */
  isFirstTime(ruleId: string, version?: string): boolean {
    const value = this.denyFirstTime[ruleId]
    if (value === undefined) return true
    if (!version) return false
    return typeof value === 'number' || value.version !== version
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

  /** Record a failing test run for the oracle-tampering detector's recency window. */
  setOracleFailure(key: string, value: { timestamp: number; command: string }): void {
    this.oracleFailures[key] = value
    this.saveFile('oracle-failures', this.oracleFailures)
  }
}
