import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, type LockOptions } from './file-lock.js'
import { stateDir } from './state-manager.js'

/**
 * One armed "an enforcing injection detector matched this session" tag,
 * scoped to the session_id that produced it. Deliberately a SUPERSET of
 * flow-store.ts's `PersistedFlowTag` shape (same `source`/`timestamp`/
 * `originTool`/`path` fields, plus injection-specific ones) so a future
 * cross-turn taint-tracking lane ("Lane G", explicitly out of scope here)
 * can extend this same store without a migration — see docs/injection.md's
 * "What this does NOT cover".
 */
export interface PersistedInjectionTag {
  /** Always `'tool_output'` today — kept as a field (not a literal) for the same forward-compat reason as the superset shape above. */
  source: string
  timestamp: number
  originTool: string
  path?: string
  /** Every enforcing injection rule id that contributed to this detection. */
  ruleIds: string[]
  /** Raw marker-occurrence count from the scan that armed this tag (InjectionScanResult.markerCount — injection-scan.ts). */
  markerCount: number
  host?: string
  /** True only where `sanitized_output` was actually written back onto the host's own output object (OpenCode today) — false on every host where this is detection-only. */
  neutralized: boolean
}

interface InjectionTagFile {
  [sessionId: string]: PersistedInjectionTag[]
}

/**
 * How long an armed tag stays eligible to gate a LATER consequential call in
 * the same session. Shorter than flow-store.ts's FLOW_TAG_TTL_MS (1 hour):
 * the injection gate's own false-positive shape (types.ts's doc comment on
 * `KeelRule.next_call_scrutiny` and install.ts's `untrusted-content-
 * next-call`) is already "any detection this session arms ANY next write/
 * shell call, with no payload correlation" — a full hour of that reach is a
 * materially wider false-positive window than the 15 minutes here, for a
 * gate that already has no other precision to lean on. Enforced on write
 * (recordTag prunes before persisting) AND on read (peekPending/
 * consumePending filter again) so an idle session's tag ages out even if
 * nothing ever writes to that session again.
 */
export const INJECTION_TAG_TTL_MS = 15 * 60 * 1000 // 15 minutes

// Same bounding rationale as flow-store.ts's identical constants — an
// on-disk cap so this file can't grow without limit, scoped per axis
// because the failure mode differs: many SHORT sessions (MAX_SESSIONS) vs
// one CHATTY session (MAX_TAGS_PER_SESSION).
const MAX_SESSIONS = 200
const MAX_TAGS_PER_SESSION = 50

/**
 * PersistentInjectionStore — the disk-backed, session-scoped, TTL'd,
 * file-locked store behind the `untrusted-content-next-call` gate rule
 * (`KeelRule.next_call_scrutiny`, types.ts). Modeled DIRECTLY on
 * flow-store.ts's `PersistentFlowStore`: same `stateDir()`/
 * `KEEL_STATE_DIR` resolution (tests isolate it the same way), same
 * file-lock.ts-guarded load → merge → persist cycle, same atomic
 * tmp+rename write, same "never hang, never crash the caller, never throw"
 * fail-safe posture.
 *
 * KEYED BY session_id, same caveat as flow-store.ts: `session_id` is
 * host-supplied input this store does not independently authenticate.
 *
 * WHO WRITES: never `EnforcementPipeline.evaluateInjection()` itself — that
 * method keeps `evaluateOutput()`'s stated purity (text in, verdict +
 * candidate replacement out, never touches persisted state). The CALLERS
 * write, after a detection: `packages/cli/src/commands/enforce.ts`'s
 * output-scan wrapper (after recording the audit entry) and the OpenCode
 * plugin (after its write-back succeeds, so `neutralized` reflects what
 * actually happened). The pipeline only ever READS this store, via
 * `PipelineConfig.injectionStore`, inside `runTieredRules()`'s
 * `next_call_scrutiny` branch (pipeline.ts).
 *
 * FAIL-SAFE, and — just like flow-store.ts's own header states of
 * itself — this store backs a WARN/OBSERVE-tier rule only, NEVER a
 * `level: protect` floor: a lock timeout, a corrupt file, or any other
 * read/write failure degrades to "no correlation on this call"
 * (recordTag becomes a no-op, peekPending/consumePending return nothing)
 * — never to a thrown exception, and never to blocking one. Losing a tag
 * write only means a later call might miss a warn it would otherwise have
 * produced; that is an accepted trade for a rule that is explicitly not a
 * hard backstop. It must NEVER be used to back a deny-tier floor under
 * this same fail-open-on-corruption posture.
 */
export class PersistentInjectionStore {
  private readonly dir: string
  private readonly lockOptions: LockOptions

  constructor(dir: string = stateDir(), lockOptions: LockOptions = {}) {
    this.dir = dir
    this.lockOptions = lockOptions
  }

  private filePath(): string {
    return join(this.dir, 'injection-tags.json')
  }

  private lockPath(): string {
    return `${this.filePath()}.lock`
  }

  private ensureDir(): void {
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* save() also tries; best effort */ }
  }

  private load(): InjectionTagFile {
    try {
      const p = this.filePath()
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as InjectionTagFile
      }
    } catch { /* corrupt or unreadable — start fresh, never throw */ }
    return {}
  }

  private save(data: InjectionTagFile): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const p = this.filePath()
      const tmp = `${p}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, p)
    } catch { /* best-effort persistence — same posture as StateManager.saveFile */ }
  }

  /** Drop expired tags (per-session) and, if still over MAX_SESSIONS, the least-recently-active sessions. */
  private prune(data: InjectionTagFile, now: number): InjectionTagFile {
    const pruned: InjectionTagFile = {}
    for (const [sessionId, tags] of Object.entries(data)) {
      if (!Array.isArray(tags)) continue
      const live = tags.filter(t => t && typeof t.timestamp === 'number' && now - t.timestamp < INJECTION_TAG_TTL_MS)
      if (live.length) pruned[sessionId] = live.slice(-MAX_TAGS_PER_SESSION)
    }
    const sessionIds = Object.keys(pruned)
    if (sessionIds.length > MAX_SESSIONS) {
      const byRecency = sessionIds
        .map(id => ({ id, last: Math.max(...pruned[id].map(t => t.timestamp)) }))
        .sort((a, b) => a.last - b.last)
      for (const { id } of byRecency.slice(0, sessionIds.length - MAX_SESSIONS)) delete pruned[id]
    }
    return pruned
  }

  /**
   * Record one armed tag for `sessionId`, merging with — never replacing —
   * any tags already persisted by an EARLIER process for the same session:
   * load → merge → persist, under the file lock, so two concurrent writers
   * can't clobber each other's tag (see file-lock.ts). A missing/empty
   * `sessionId` is a no-op.
   */
  recordTag(sessionId: string, tag: PersistedInjectionTag): void {
    if (!sessionId) return
    this.ensureDir()
    withFileLock(this.lockPath(), () => {
      const now = Date.now()
      const data = this.prune(this.load(), now)
      const existing = data[sessionId] || []
      existing.push(tag)
      data[sessionId] = existing.slice(-MAX_TAGS_PER_SESSION)
      this.save(data)
    }, this.lockOptions)
  }

  /**
   * Non-expired, non-consumed tags for `sessionId` — read-only, never
   * mutates or consumes. Used by the gate's non-consequential-call path
   * (e.g. a read): the tag stays visible and armed, but is deliberately
   * left un-consumed (see `consumePending`'s own comment).
   */
  peekPending(sessionId: string): PersistedInjectionTag[] {
    if (!sessionId) return []
    const now = Date.now()
    const tags = this.load()[sessionId]
    if (!Array.isArray(tags)) return []
    return tags.filter(t => t && typeof t.timestamp === 'number' && now - t.timestamp < INJECTION_TAG_TTL_MS)
  }

  /**
   * Consume (clear) every non-expired tag for `sessionId` and return what
   * was consumed — called ONLY on a CONSEQUENTIAL call (a write or a shell
   * invocation; see pipeline.ts's `runTieredRules()` `next_call_scrutiny`
   * branch and `WRITE_TOOL_NAMES`, verification.ts). An unrecognized tool
   * name must NOT reach this method at all — the caller's own predicate
   * decides consequential-vs-not and leaves the tag armed (by calling
   * `peekPending` instead) for anything it doesn't recognize, the
   * conservative direction that can never produce a false all-clear. Under
   * the file lock, same load → merge → persist shape as `recordTag`, so a
   * concurrent consumer racing this one cannot double-consume or drop a
   * tag written mid-race.
   */
  consumePending(sessionId: string): PersistedInjectionTag[] {
    if (!sessionId) return []
    this.ensureDir()
    return withFileLock(this.lockPath(), () => {
      const now = Date.now()
      const data = this.prune(this.load(), now)
      const consumed = data[sessionId] || []
      if (consumed.length) {
        delete data[sessionId]
        this.save(data)
      }
      return consumed
    }, this.lockOptions)
  }
}
