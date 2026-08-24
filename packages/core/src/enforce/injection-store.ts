import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { withFileLock, writeFileAtomic, type LockOptions } from './file-lock.js'
import { stateDir } from './state-manager.js'

/** One correlatable artifact (URL, hostname, file path, or email address) recorded near an enforcing marker — see injection-taint.ts. */
export interface PersistedInjectionArtifact {
  kind: 'url' | 'host' | 'path' | 'email'
  value: string
}

/**
 * One armed "an enforcing injection detector matched this session" tag,
 * scoped to the session_id that produced it. Deliberately a SUPERSET of
 * flow-store.ts's `PersistedFlowTag` shape (same `source`/`timestamp`/
 * `originTool`/`path` fields, plus injection-specific ones) so the
 * cross-turn taint-tracking lane ("Lane G") could extend this same store
 * without a migration — see docs/injection.md. That extension has now
 * landed: `id`/`artifacts`/`consumedBy` below are all OPTIONAL specifically
 * so a tag written by pre-Lane-G code (none of the three fields) still
 * reads correctly under the new gate rule (it simply never correlates,
 * having no artifacts to match), and a tag written by new code is still
 * readable by old code, which just ignores fields it doesn't know about.
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
  /**
   * Stable per-tag identity. Assigned by `recordTag` when the caller omits
   * it, and backfilled by `prune()` on any surviving legacy tag with none —
   * so "every LIVE tag has an id" is a total invariant going forward, with
   * no migration pass required. Used by `consumePending`'s `ids` filter for
   * selective, single-tag consumption (Lane G's correlated rule consumes
   * only the tags it actually matched — see pipeline.ts's gate branch).
   */
  id?: string
  /** Correlatable artifacts (URL/host/path/email) found near the enforcing marker(s) that armed this tag — see injection-taint.ts's `extractOriginArtifacts`. Absent or empty when none were found. */
  artifacts?: PersistedInjectionArtifact[]
  /**
   * Gate rule ids that have already fired ON THIS TAG. Replaces
   * delete-on-consume (see `consumePending`'s own comment for why): a tag
   * is MARKED per rule id it fires for, never deleted, so a second gate
   * rule sharing this store can still independently consume the same tag
   * — the correctness fix Lane G required the moment a second
   * `next_call_scrutiny` rule existed sharing one store.
   */
  consumedBy?: string[]
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
 * this same fail-open-on-corruption posture. Lane G's correlation path
 * (injection-taint.ts) inherits the IDENTICAL posture: a corrupt store
 * file, a lock timeout, or a throwing extractor all degrade to "no
 * correlation on this call" — never a thrown exception, never a block.
 *
 * CONSUMPTION MODEL — per-rule MARKING, not deletion. `consumePending`
 * used to delete every tag for a session outright the first time ANY
 * `next_call_scrutiny` rule consumed it. That was correct while exactly
 * one such rule existed; the moment a second one shares this store (Lane
 * G's narrower, correlated `untrusted-content-derived-call`, alongside
 * Lane F's broad `untrusted-content-next-call`), it becomes a real
 * correctness bug: whichever rule's consequential call happens first
 * deletes the tag out from under the OTHER rule, which never gets a
 * chance to check it. `consumePending` now takes the consuming rule's own
 * id and marks the tag's `consumedBy` array instead of deleting it — a
 * tag is only ever removed by TTL expiry/pruning, never by consumption.
 * Each rule independently tracks, per tag, whether IT has already fired;
 * two different rules can each consume the same tag exactly once, in
 * either order, with no interference.
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
      writeFileAtomic(p, JSON.stringify(data))
    } catch { /* best-effort persistence — same posture as StateManager.saveFile */ }
  }

  /** Simple, sufficient per-process-unique id — not cryptographically meaningful, just a stable per-tag identity for selective consumption (see `PersistedInjectionTag.id`'s own comment). */
  private newTagId(): string {
    return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
  }

  /**
   * Drop expired tags (per-session) and, if still over MAX_SESSIONS, the
   * least-recently-active sessions. Also backfills a missing `id` on any
   * surviving legacy tag (written before Lane G), so "every LIVE tag has
   * an id" becomes a total invariant going forward with no migration pass
   * — a tag that ages out via TTL before ever being pruned simply never
   * needed one.
   */
  private prune(data: InjectionTagFile, now: number): InjectionTagFile {
    const pruned: InjectionTagFile = {}
    for (const [sessionId, tags] of Object.entries(data)) {
      if (!Array.isArray(tags)) continue
      const live = tags
        .filter(t => t && typeof t.timestamp === 'number' && now - t.timestamp < INJECTION_TAG_TTL_MS)
        .map(t => (t.id ? t : { ...t, id: this.newTagId() }))
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
   * `sessionId` is a no-op. Assigns `tag.id` when the caller omits it.
   */
  recordTag(sessionId: string, tag: PersistedInjectionTag): void {
    if (!sessionId) return
    this.ensureDir()
    withFileLock(this.lockPath(), () => {
      const now = Date.now()
      const data = this.prune(this.load(), now)
      const existing = data[sessionId] || []
      existing.push(tag.id ? tag : { ...tag, id: this.newTagId() })
      data[sessionId] = existing.slice(-MAX_TAGS_PER_SESSION)
      this.save(data)
    }, this.lockOptions)
  }

  /**
   * Non-expired tags for `sessionId` — read-only, never mutates or
   * consumes. Used by the gate's non-consequential-call path (e.g. a
   * read): the tag stays visible and armed, but is deliberately left
   * un-consumed (see `consumePending`'s own comment).
   *
   * When `forRuleId` is given, ADDITIONALLY excludes tags whose
   * `consumedBy` already includes it — "pending for THIS rule", not
   * merely "not yet expired". Omitting `forRuleId` returns every live tag
   * regardless of which rule(s) have already consumed it (used by tests
   * and by callers that want the raw pending set, not one rule's view of
   * it).
   */
  peekPending(sessionId: string, forRuleId?: string): PersistedInjectionTag[] {
    if (!sessionId) return []
    const now = Date.now()
    const tags = this.load()[sessionId]
    if (!Array.isArray(tags)) return []
    const live = tags.filter(t => t && typeof t.timestamp === 'number' && now - t.timestamp < INJECTION_TAG_TTL_MS)
    return forRuleId ? live.filter(t => !t.consumedBy?.includes(forRuleId)) : live
  }

  /**
   * Mark every non-expired tag for `sessionId` NOT already consumed by
   * `forRuleId` (restricted to `ids` when given) as now consumed by
   * `forRuleId`, and return the tags actually affected — called ONLY on a
   * CONSEQUENTIAL call (a write or a shell invocation; see pipeline.ts's
   * `runTieredRules()` `next_call_scrutiny` branch and `WRITE_TOOL_NAMES`,
   * verification.ts). An unrecognized tool name must NOT reach this method
   * at all — the caller's own predicate decides consequential-vs-not and
   * leaves the tag armed (by calling `peekPending` instead) for anything
   * it doesn't recognize, the conservative direction that can never
   * produce a false all-clear.
   *
   * MARKS, never deletes — this is the correctness fix a second gate rule
   * sharing this store requires (see this class's own header comment,
   * "CONSUMPTION MODEL"). A tag is removed only by TTL expiry/pruning.
   * Two different `forRuleId` values can each independently consume the
   * same tag exactly once; `ids`, when given, additionally restricts which
   * tag ids this call is even eligible to mark (used by the correlated
   * rule to consume only the specific tags it found an artifact match on,
   * leaving every other pending tag — including ones it did NOT match —
   * fully armed for the broad sibling rule to still cover).
   *
   * Under the file lock, same load → merge → persist shape as `recordTag`,
   * so a concurrent consumer racing this one — including a DIFFERENT rule
   * id racing on the very same tag — cannot double-mark, lose a mark, or
   * drop a tag written mid-race.
   */
  consumePending(sessionId: string, forRuleId: string, ids?: string[]): PersistedInjectionTag[] {
    if (!sessionId || !forRuleId) return []
    this.ensureDir()
    return withFileLock(this.lockPath(), () => {
      const now = Date.now()
      const data = this.prune(this.load(), now)
      const tags = data[sessionId] || []
      const affected: PersistedInjectionTag[] = []
      const next = tags.map(t => {
        const eligible = !t.consumedBy?.includes(forRuleId) && (!ids || (typeof t.id === 'string' && ids.includes(t.id)))
        if (!eligible) return t
        const marked: PersistedInjectionTag = { ...t, consumedBy: [...(t.consumedBy || []), forRuleId] }
        affected.push(marked)
        return marked
      })
      // Persist whenever there was anything to persist, not only when this
      // call itself marked a tag — `prune()` above may have backfilled a
      // missing `id` on a surviving legacy tag (see `PersistedInjectionTag.
      // id`'s own comment), and that backfilled id must land on disk or the
      // "every live tag has a STABLE id" invariant breaks the moment this
      // in-memory copy is discarded — a later read would regenerate a
      // DIFFERENT id for the same tag. `recordTag` always saves for the
      // identical reason.
      if (tags.length) {
        data[sessionId] = next
        this.save(data)
      }
      return affected
    }, this.lockOptions)
  }
}
