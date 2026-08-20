import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, type LockOptions } from './file-lock.js'
import { resolveHome } from '../home.js'

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
 * KEEL_STATE_DIR still wins outright when set (narrower override); when
 * unset the default is now rooted at resolveHome() (KEEL_HOME > HOME >
 * homedir()) instead of a bare homedir(), so this reader agrees with
 * `keel install` under KEEL_HOME.
 */
export function stateDir(): string {
  return process.env.KEEL_STATE_DIR || join(resolveHome(), '.keel', 'state')
}

const TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

/**
 * StateManager — persists enforcement state across process boundaries.
 *
 * Loads state from disk on construction, saves after each mutation.
 * Uses atomic file writes (.tmp + rename) to prevent corruption.
 * Drops entries older than 24h on load.
 *
 * CROSS-PROCESS SAFETY: each state slice (deny-first-time, circuit-breaker,
 * rate-counts, verification, oracle-failures) lives in its own JSON file
 * with its own `<file>.lock` lockfile (see file-lock.ts). Every mutating
 * method — markFirstTime, recordCircuitBreaker, checkRateLimit,
 * setVerification, clearVerification, setOracleFailure — acquires that
 * file's lock, re-reads the slice fresh from disk (NOT the possibly-stale
 * in-memory copy from construction time or an earlier mutation in this
 * process), applies the mutation, writes it back, then releases the lock.
 * That closes the lost-update race: without it, two processes each hold
 * their own in-memory snapshot, and the second save() blindly overwrites
 * whatever the first process added, silently dropping it. If the lock
 * can't be acquired within its bounded timeout, the mutation still runs
 * unlocked rather than being skipped or hung — see file-lock.ts's
 * fail-safe note.
 */
export class StateManager {
  denyFirstTime: DenyState = {}
  circuitBreaker: CircuitBreakerState = {}
  rateCounts: RateLimitState = {}
  verification: VerificationState = {}
  oracleFailures: OracleFailureState = {}

  private readonly dir: string
  private readonly lockOptions: LockOptions

  /**
   * `lockOptions` overrides file-lock.ts's default wait/stale-reclaim
   * bounds — production code should never need this (the defaults are
   * tuned for a hook invocation), but tests that deliberately create
   * heavy artificial contention need a wider wait than the production
   * default without that production default having to grow to
   * accommodate a synthetic worst case it will never see in the field.
   */
  constructor(dir: string = stateDir(), lockOptions: LockOptions = {}) {
    this.dir = dir
    this.lockOptions = lockOptions
    this.load()
  }

  private statePath(name: string): string {
    return join(this.dir, `${name}.json`)
  }

  private lockPath(name: string): string {
    return this.statePath(name) + '.lock'
  }

  private ensureDir(): void {
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* saveFile also tries; best effort */ }
  }

  /** Run `fn` holding the lock for state slice `name`, serializing with other processes. */
  private withSliceLock<T>(name: string, fn: () => T): T {
    this.ensureDir()
    return withFileLock(this.lockPath(name), fn, this.lockOptions)
  }

  /**
   * Parses `<name>.json` and returns it only when it is a genuine
   * dictionary — every `load*` caller immediately does `Object.entries()`
   * on the result, OUTSIDE any try/catch of its own, so a legally-parsing
   * but non-object JSON value (bare `null`, a number, a string, an array)
   * must be caught HERE or it throws an uncaught `TypeError` straight out
   * of the constructor. A syntax error is already caught below by the
   * JSON.parse try/catch; `null`/arrays/primitives parse fine and need
   * their own check. Centralized once so all five state files share the
   * same guard instead of every `load*` method re-deriving it.
   */
  private loadFile<T>(name: string, fallback: T): T {
    const p = this.statePath(name)
    try {
      if (existsSync(p)) {
        const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as T
        }
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

  private loadDenyFirstTime(): DenyState {
    const now = Date.now()
    const raw = this.loadFile<DenyState>('deny-first-time', {})
    const cleaned: DenyState = {}
    for (const [ruleId, value] of Object.entries(raw)) {
      const timestamp = typeof value === 'number' ? value : value.timestamp
      if (now - timestamp < TTL_MS) cleaned[ruleId] = value
    }
    return cleaned
  }

  private loadCircuitBreaker(): CircuitBreakerState {
    const now = Date.now()
    const raw = this.loadFile<CircuitBreakerState>('circuit-breaker', {})
    const cleaned: CircuitBreakerState = {}
    for (const [key, val] of Object.entries(raw)) {
      if (now - val.startTime < TTL_MS) cleaned[key] = val
    }
    return cleaned
  }

  private loadRateCounts(): RateLimitState {
    const now = Date.now()
    const raw = this.loadFile<RateLimitState>('rate-counts', {})
    const cleaned: RateLimitState = {}
    for (const [key, val] of Object.entries(raw)) {
      if (now - val.windowStart < TTL_MS) cleaned[key] = val
    }
    return cleaned
  }

  private loadVerificationState(): VerificationState {
    const now = Date.now()
    const raw = this.loadFile<VerificationState>('verification', {})
    const cleaned: VerificationState = {}
    for (const [key, val] of Object.entries(raw)) {
      if (now - val.createdAt < TTL_MS) cleaned[key] = val
    }
    return cleaned
  }

  private loadOracleFailuresState(): OracleFailureState {
    // The 24h TTL here is a hygiene bound (drop ancient entries so the
    // file doesn't grow forever) — it is NOT the recency window a rule
    // fires on; that is `rule.window_seconds` (default 900s), checked
    // separately by OracleTracker.recentFailure.
    const now = Date.now()
    const raw = this.loadFile<OracleFailureState>('oracle-failures', {})
    const cleaned: OracleFailureState = {}
    for (const [key, val] of Object.entries(raw)) {
      if (now - val.timestamp < TTL_MS) cleaned[key] = val
    }
    return cleaned
  }

  private load(): void {
    this.denyFirstTime = this.loadDenyFirstTime()
    this.circuitBreaker = this.loadCircuitBreaker()
    this.rateCounts = this.loadRateCounts()
    this.verification = this.loadVerificationState()
    this.oracleFailures = this.loadOracleFailuresState()
  }

  /** Mark a rule as having been violated (first time). */
  markFirstTime(ruleId: string, version?: string): void {
    this.withSliceLock('deny-first-time', () => {
      this.denyFirstTime = this.loadDenyFirstTime()
      this.denyFirstTime[ruleId] = version
        ? { timestamp: Date.now(), version }
        : Date.now()
      this.saveFile('deny-first-time', this.denyFirstTime)
    })
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
    return this.withSliceLock('circuit-breaker', () => {
      this.circuitBreaker = this.loadCircuitBreaker()
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
    })
  }

  /** Check and increment rate limit. Returns true if over limit. */
  checkRateLimit(ruleId: string, matchPattern: string, windowSec: number, maxCalls: number): boolean {
    const key = `rate:${ruleId}:${matchPattern}`
    return this.withSliceLock('rate-counts', () => {
      this.rateCounts = this.loadRateCounts()
      const now = Date.now()
      const existing = this.rateCounts[key]
      let overLimit: boolean

      if (existing && now - existing.windowStart < windowSec * 1000) {
        existing.count++
        this.rateCounts[key] = existing
        overLimit = existing.count > maxCalls
      } else {
        this.rateCounts[key] = { count: 1, windowStart: now }
        overLimit = false
      }

      this.saveFile('rate-counts', this.rateCounts)
      return overLimit
    })
  }

  setVerification(key: string, value: { createdAt: number; generation: number }): void {
    this.withSliceLock('verification', () => {
      this.verification = this.loadVerificationState()
      this.verification[key] = value
      this.saveFile('verification', this.verification)
    })
  }

  clearVerification(key: string): void {
    this.withSliceLock('verification', () => {
      this.verification = this.loadVerificationState()
      delete this.verification[key]
      this.saveFile('verification', this.verification)
    })
  }

  /** Record a failing test run for the oracle-tampering detector's recency window. */
  setOracleFailure(key: string, value: { timestamp: number; command: string }): void {
    this.withSliceLock('oracle-failures', () => {
      this.oracleFailures = this.loadOracleFailuresState()
      this.oracleFailures[key] = value
      this.saveFile('oracle-failures', this.oracleFailures)
    })
  }
}
