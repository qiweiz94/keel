import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { commandFingerprint } from './command-fingerprint.js'
import { withFileLock, type LockOptions } from './file-lock.js'
import { resolveHome } from '../home.js'

/**
 * ProblemLedger — the session/task memory of the harness.
 *
 * Records the shape of every problem the agent touches: failing commands,
 * fix attempts, research evidence, and root-cause HYPOTHESES. The
 * `diagnosis` rule consults it before complex/destructive fixes: a fresh
 * hypothesis (or diagnosis evidence) discharges the gate; otherwise the
 * agent is redirected to record one (`keel_hypothesis`).
 *
 * "I guessed" becomes visible: hypotheses are falsified when the next
 * verification still fails.
 *
 * CROSS-PROCESS SAFETY: every mutating method (recordOutcome,
 * addHypothesis, recordDiagnosis, falsifyStaleHypotheses) runs its whole
 * read-modify-write body inside `withLock()`, which holds an O_EXCL
 * lockfile (`ledger.json.lock`, see file-lock.ts) for the duration and
 * re-reads `ledger.json` fresh from disk before mutating. Without this, a
 * concurrent process's own in-memory copy — loaded at its construction
 * time or last read — would blindly overwrite whatever the other process
 * wrote in between, silently dropping ledger entries (lost update). If the
 * lock can't be acquired within its bounded timeout, the mutation still
 * runs unlocked rather than being skipped or hung — see file-lock.ts's
 * fail-safe note.
 */

export interface Hypothesis {
  id: string
  statement: string
  evidence: string[]
  at: number
  status: 'unverified' | 'falsified' | 'confirmed'
}

export interface LedgerProblem {
  problem_key: string
  first_seen: number
  last_seen: number
  fingerprint: string
  status: 'opened' | 'stuck' | 'resolved'
  failures: number
  last_exit: number | null
  hypotheses: Hypothesis[]
  recent_diagnosis: Array<{ at: number; command: string }>
}

export interface LedgerData {
  problems: Record<string, LedgerProblem>
  /** Per-session pointer to the most recently touched problem. */
  active: Record<string, string>
}

export function ledgerPath(): string {
  return join(process.env.KEEL_STATE_DIR || join(resolveHome(), '.keel', 'state'), 'ledger.json')
}

export function problemKey(cwd: string, fingerprint: string): string {
  return createHash('sha256').update(`${cwd}:${fingerprint}`).digest('hex').slice(0, 16)
}

export class ProblemLedger {
  private data: LedgerData = { problems: {}, active: {} }
  private lastMtimeMs = 0

  /**
   * `lockOptions` overrides file-lock.ts's default wait/stale-reclaim
   * bounds — see the matching note on StateManager's constructor. Tests
   * that create heavy artificial contention pass a wider wait here
   * rather than the production default having to grow for a synthetic
   * worst case.
   */
  constructor(private readonly path: string = ledgerPath(), private readonly lockOptions: LockOptions = {}) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) {
        this.data = { problems: {}, active: {} }
        return
      }
      this.data = JSON.parse(readFileSync(this.path, 'utf-8')) as LedgerData
      if (!this.data.problems) this.data.problems = {}
      if (!this.data.active) this.data.active = {}
    } catch {
      // Missing file or corrupt/unparseable JSON — only case where
      // starting over from an empty ledger is correct.
      this.data = { problems: {}, active: {} }
      return
    }
    // Freshness bookkeeping only, deliberately its own try/catch: a
    // statSync failure here (e.g. the file was removed between the
    // readFileSync above and this stat) must NOT fall through to the
    // catch above and wipe the ledger `this.data` we just successfully
    // parsed — every mutating method reloads via `load()` right before
    // mutating (see withLock), so discarding good data here would mean
    // the very next save() overwrites disk with an empty ledger.
    try {
      this.lastMtimeMs = statSync(this.path).mtimeMs
    } catch { /* best effort; reloadIfChanged just reloads more eagerly next time */ }
  }

  /**
   * Re-read if another instance (plugin vs daemon) wrote the file since we
   * last loaded/saved. Read-only callers (activeProblemKey,
   * hasFreshHypothesis, hasFreshDiagnosis) use this for best-effort
   * freshness; it is NOT what makes mutations safe under concurrency —
   * that's `withLock()` below, which always reloads under the lock
   * regardless of mtime.
   */
  private reloadIfChanged(): void {
    try {
      if (!existsSync(this.path)) return
      const mtime = statSync(this.path).mtimeMs
      if (mtime !== this.lastMtimeMs) {
        this.load()
      }
    } catch { /* best effort */ }
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
      renameSync(tmp, this.path)
      this.lastMtimeMs = statSync(this.path).mtimeMs
    } catch { /* best effort */ }
  }

  /**
   * Run `fn` holding the ledger's lockfile, having first reloaded
   * `this.data` fresh from disk under that lock. This is the unit of
   * cross-process safety for every mutating method below: lock, reload,
   * mutate `this.data`, save, unlock.
   */
  private withLock<T>(fn: () => T): T {
    try { mkdirSync(join(this.path, '..'), { recursive: true }) } catch { /* save() also tries */ }
    return withFileLock(`${this.path}.lock`, () => {
      this.load()
      return fn()
    }, this.lockOptions)
  }

  private touch(problem: LedgerProblem): void {
    problem.last_seen = Date.now()
  }

  /** Record a command outcome for a problem; exit 0 marks it resolved. */
  recordOutcome(cwd: string, command: string, exitCode: number | null, sessionId?: string): string {
    return this.withLock(() => {
      const fp = commandFingerprint(command)
      const key = problemKey(cwd, fp)
      let problem = this.data.problems[key]
      if (!problem) {
        problem = {
          problem_key: key,
          first_seen: Date.now(),
          last_seen: Date.now(),
          fingerprint: fp,
          status: 'opened',
          failures: 0,
          last_exit: null,
          hypotheses: [],
          recent_diagnosis: [],
        }
        this.data.problems[key] = problem
      }
      this.touch(problem)
      if (sessionId) this.data.active[sessionId] = key
      if (exitCode === 0) {
        problem.status = 'resolved'
        problem.last_exit = 0
      } else if (exitCode !== null && exitCode !== 0) {
        problem.failures += 1
        problem.last_exit = exitCode
        if (problem.failures >= 3) problem.status = 'stuck'
      }
      this.save()
      return key
    })
  }

  /** The problem the session touched most recently (its failing command). */
  activeProblemKey(sessionId: string): string | undefined {
    this.reloadIfChanged()
    return this.data.active[sessionId]
  }

  /** Record a root-cause hypothesis (keel_hypothesis). */
  addHypothesis(problem_key: string, statement: string, evidence: string[] = []): Hypothesis {
    return this.withLock(() => {
      const problem = this.data.problems[problem_key] || this.ensureProblem(problem_key)
      const hypothesis: Hypothesis = {
        id: `hyp_${createHash('sha256').update(`${problem_key}:${statement}:${Date.now()}`).digest('hex').slice(0, 12)}`,
        statement,
        evidence,
        at: Date.now(),
        status: 'unverified',
      }
      problem.hypotheses.push(hypothesis)
      // Keep the last 5 per problem.
      problem.hypotheses = problem.hypotheses.slice(-5)
      this.save()
      return hypothesis
    })
  }

  /** Record diagnosis evidence (git log/blame/bisect style investigation). */
  recordDiagnosis(problem_key: string, command: string): void {
    this.withLock(() => {
      const problem = this.data.problems[problem_key] || this.ensureProblem(problem_key)
      problem.recent_diagnosis.push({ at: Date.now(), command })
      problem.recent_diagnosis = problem.recent_diagnosis.slice(-10)
      this.save()
    })
  }

  /** A fresh hypothesis exists for the problem within the window. */
  hasFreshHypothesis(problem_key: string, withinSeconds: number): boolean {
    this.reloadIfChanged()
    const problem = this.data.problems[problem_key]
    if (!problem) return false
    const windowMs = withinSeconds * 1000
    return problem.hypotheses.some((h) => Date.now() - h.at <= windowMs)
  }

  /** Diagnosis evidence recorded for the problem within the window. */
  hasFreshDiagnosis(problem_key: string, withinSeconds: number): boolean {
    this.reloadIfChanged()
    const problem = this.data.problems[problem_key]
    if (!problem) return false
    const windowMs = withinSeconds * 1000
    return problem.recent_diagnosis.some((d) => Date.now() - d.at <= windowMs)
  }

  falsifyStaleHypotheses(): void {
    this.withLock(() => {
      // Hypotheses older than 24h with no confirmation become falsified.
      const day = 24 * 3600_000
      for (const problem of Object.values(this.data.problems)) {
        for (const h of problem.hypotheses) {
          if (h.status === 'unverified' && Date.now() - h.at > day) h.status = 'falsified'
        }
      }
      this.save()
    })
  }

  problem(problem_key: string): LedgerProblem | undefined {
    return this.data.problems[problem_key]
  }

  problems(): LedgerProblem[] {
    return Object.values(this.data.problems).sort((a, b) => b.last_seen - a.last_seen)
  }

  private ensureProblem(problem_key: string): LedgerProblem {
    const existing = this.data.problems[problem_key]
    if (existing) return existing
    const problem: LedgerProblem = {
      problem_key,
      first_seen: Date.now(),
      last_seen: Date.now(),
      fingerprint: '',
      status: 'opened',
      failures: 0,
      last_exit: null,
      hypotheses: [],
      recent_diagnosis: [],
    }
    this.data.problems[problem_key] = problem
    return problem
  }
}
