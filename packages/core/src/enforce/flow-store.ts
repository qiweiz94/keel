import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic, type LockOptions } from './file-lock.js'
import { stateDir } from './state-manager.js'

/** One matched source read, scoped to the session_id that produced it. */
export interface PersistedFlowTag {
  source: string       // matched source pattern / pseudo-source (FlowTracker's own vocabulary — see matchedRule/commandSource)
  timestamp: number
  originTool: string
  path?: string
}

interface FlowTagFile {
  [sessionId: string]: PersistedFlowTag[]
}

/**
 * How long a persisted tag stays eligible to correlate with a LATER hook
 * process in the same session. Long enough to span a realistic multi-turn
 * agent session (read a credential early, act on it many turns later)
 * without keeping a stale tag alive indefinitely — a short TTL would just
 * reopen the exact gap this store exists to close (a slow multi-turn
 * read-then-exfil), per docs/exfil.md's "Considered and deferred" section.
 * Enforced on write (recordTag prunes before persisting) AND on read
 * (getTags filters again) so an idle session's tags age out even if
 * nothing ever writes to that session again.
 */
export const FLOW_TAG_TTL_MS = 60 * 60 * 1000 // 1 hour

// Bounds so this file can't grow without limit — an on-disk equivalent of
// flow-tracker.ts's own in-memory "keep last 1000" cap on taggedValues,
// scoped per axis here because the failure mode is different: many SHORT
// sessions (MAX_SESSIONS) vs one CHATTY session (MAX_TAGS_PER_SESSION).
const MAX_SESSIONS = 200
const MAX_TAGS_PER_SESSION = 50

/**
 * PersistentFlowStore — the disk-backed, session-scoped, TTL'd, file-locked
 * companion to FlowTracker's in-memory `taggedValues` Map. Added to close
 * AUDIT §5: `keel hook <host>` (Claude Code, Gemini CLI, Cursor, Codex,
 * cline, generic) runs a FRESH PROCESS per tool call, so an in-memory-only
 * FlowTracker can never see a read from one call and a sink from a later
 * one — see docs/exfil.md's "Coverage depends on which host integration
 * you use". This store lets that fact survive across those processes.
 *
 * Deliberately mirrors StateManager's already-shipped pattern
 * (state-manager.ts: denyFirstTime / circuitBreaker / rateCounts /
 * verification / oracleFailures) rather than inventing a new one: same
 * `stateDir()`/`KEEL_STATE_DIR` resolution (so tests isolate the exact same
 * way), same file-lock.ts-guarded load → merge → persist cycle, same atomic
 * tmp+rename write, same "never hang, never crash the hook, never throw"
 * fail-safe posture.
 *
 * KEYED BY session_id: `recordTag`/`getTags` both take the caller's own
 * `session_id` and every tag is stored and looked up under that exact
 * string — tags recorded under one session_id are never visible to a
 * different (or missing) session_id, so one session's secret-read tags
 * cannot leak into another session's later call. `session_id` itself is
 * host-supplied input, not something this store independently verifies —
 * exactly like overrides.ts's `mode: session` override already accepts a
 * caller-supplied session_id as its scoping key with no further
 * authentication (see enforce.ts's own comment on where session_id comes
 * from for the honest caveat on that).
 *
 * BOUNDED: MAX_TAGS_PER_SESSION caps growth within one hot session;
 * MAX_SESSIONS caps the number of distinct sessions retained at all (least-
 * recently-active evicted first) so a machine running many short-lived hook
 * sessions can't grow this file without limit even inside the TTL window.
 *
 * FAIL-SAFE: this store backs a WARN/OBSERVE-tier rule only (see
 * flow-tracker.ts's `checkPersisted` and install.ts's
 * `no-exfil-flow-cross-call`) — never a `level: protect` floor. A lock
 * timeout, a corrupt file, or any other read/write failure degrades to "no
 * correlation on this call" (recordTag becomes a no-op, getTags returns
 * `[]`) — never to a thrown exception that could crash a hook invocation,
 * and never to blocking one. Losing a tag write only means a later call
 * might miss a warn it would otherwise have produced; that is an accepted
 * trade for a rule that is explicitly not a hard backstop (docs/exfil.md).
 * It must NEVER be used to back a deny-tier floor under this same
 * fail-open-on-corruption posture — a rule that does would fail open
 * exactly where a floor must not.
 */
export class PersistentFlowStore {
  private readonly dir: string
  private readonly lockOptions: LockOptions

  constructor(dir: string = stateDir(), lockOptions: LockOptions = {}) {
    this.dir = dir
    this.lockOptions = lockOptions
  }

  private filePath(): string {
    return join(this.dir, 'flow-tags.json')
  }

  private lockPath(): string {
    return `${this.filePath()}.lock`
  }

  private ensureDir(): void {
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* save() also tries; best effort */ }
  }

  private load(): FlowTagFile {
    try {
      const p = this.filePath()
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FlowTagFile
      }
    } catch { /* corrupt or unreadable — start fresh, never throw */ }
    return {}
  }

  private save(data: FlowTagFile): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const p = this.filePath()
      writeFileAtomic(p, JSON.stringify(data))
    } catch { /* best-effort persistence — same posture as StateManager.saveFile */ }
  }

  /** Drop expired tags (per-session) and, if still over MAX_SESSIONS, the least-recently-active sessions. */
  private prune(data: FlowTagFile, now: number): FlowTagFile {
    const pruned: FlowTagFile = {}
    for (const [sessionId, tags] of Object.entries(data)) {
      if (!Array.isArray(tags)) continue
      const live = tags.filter(t => t && typeof t.timestamp === 'number' && now - t.timestamp < FLOW_TAG_TTL_MS)
      if (live.length) pruned[sessionId] = live.slice(-MAX_TAGS_PER_SESSION)
    }
    const sessionIds = Object.keys(pruned)
    if (sessionIds.length > MAX_SESSIONS) {
      // Evict sessions with the OLDEST most-recent tag first (least
      // recently active) — the same "drop the oldest key" shape
      // flow-tracker.ts's own in-memory record() already uses for its
      // 1000-entry cap on taggedValues.
      const byRecency = sessionIds
        .map(id => ({ id, last: Math.max(...pruned[id].map(t => t.timestamp)) }))
        .sort((a, b) => a.last - b.last)
      for (const { id } of byRecency.slice(0, sessionIds.length - MAX_SESSIONS)) delete pruned[id]
    }
    return pruned
  }

  /**
   * Record one tag for `sessionId`, merging with — never replacing — any
   * tags already persisted by an EARLIER process for the same session:
   * load → merge → persist, under the file lock, so two concurrent writers
   * (two hook processes racing) can't clobber each other's tag (see
   * file-lock.ts). A missing/empty `sessionId` is a no-op — nothing worth
   * correlating against later without one.
   */
  recordTag(sessionId: string, tag: PersistedFlowTag): void {
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
   * Non-expired tags persisted for `sessionId` by ANY process (this one, or
   * an earlier one that has already exited) — read-only, does not mutate or
   * re-persist (recordTag's own prune already keeps the file bounded over
   * time). Never throws: a corrupt or unreadable file reads as "no tags",
   * per this class's fail-safe contract above.
   */
  getTags(sessionId: string): PersistedFlowTag[] {
    if (!sessionId) return []
    const now = Date.now()
    const tags = this.load()[sessionId]
    if (!Array.isArray(tags)) return []
    return tags.filter(t => t && typeof t.timestamp === 'number' && now - t.timestamp < FLOW_TAG_TTL_MS)
  }
}
