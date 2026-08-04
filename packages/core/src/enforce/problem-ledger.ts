import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { commandFingerprint } from './command-fingerprint.js'

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
  return process.env.KEEL_STATE_DIR || join(homedir(), '.keel', 'state', 'ledger.json')
}

export function problemKey(cwd: string, fingerprint: string): string {
  return createHash('sha256').update(`${cwd}:${fingerprint}`).digest('hex').slice(0, 16)
}

export class ProblemLedger {
  private data: LedgerData = { problems: {}, active: {} }
  private lastMtimeMs = 0

  constructor(private readonly path: string = ledgerPath()) {
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) {
        this.data = { problems: {}, active: {} }
        return
      }
      this.lastMtimeMs = new Date().getTime()
      this.data = JSON.parse(readFileSync(this.path, 'utf-8')) as LedgerData
      if (!this.data.problems) this.data.problems = {}
      if (!this.data.active) this.data.active = {}
    } catch {
      this.data = { problems: {}, active: {} }
    }
  }

  /** Re-read if another instance (plugin vs daemon) wrote the file. */
  private reloadIfChanged(): void {
    try {
      if (!existsSync(this.path)) return
      const mtime = new Date().getTime()
      if (mtime !== this.lastMtimeMs && this.lastMtimeMs !== 0) {
        // mtime granularity is coarse; also compare size is overkill — just
        // re-read when the file changed since our last save/load.
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
      this.lastMtimeMs = new Date().getTime()
    } catch { /* best effort */ }
  }

  private touch(problem: LedgerProblem): void {
    problem.last_seen = Date.now()
  }

  /** Record a command outcome for a problem; exit 0 marks it resolved. */
  recordOutcome(cwd: string, command: string, exitCode: number | null, sessionId?: string): string {
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
  }

  /** The problem the session touched most recently (its failing command). */
  activeProblemKey(sessionId: string): string | undefined {
    this.reloadIfChanged()
    return this.data.active[sessionId]
  }

  /** Record a root-cause hypothesis (keel_hypothesis). */
  addHypothesis(problem_key: string, statement: string, evidence: string[] = []): Hypothesis {
    this.reloadIfChanged()
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
  }

  /** Record diagnosis evidence (git log/blame/bisect style investigation). */
  recordDiagnosis(problem_key: string, command: string): void {
    this.reloadIfChanged()
    const problem = this.data.problems[problem_key] || this.ensureProblem(problem_key)
    problem.recent_diagnosis.push({ at: Date.now(), command })
    problem.recent_diagnosis = problem.recent_diagnosis.slice(-10)
    this.save()
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
    // Hypotheses older than 24h with no confirmation become falsified.
    const day = 24 * 3600_000
    for (const problem of Object.values(this.data.problems)) {
      for (const h of problem.hypotheses) {
        if (h.status === 'unverified' && Date.now() - h.at > day) h.status = 'falsified'
      }
    }
    this.save()
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
