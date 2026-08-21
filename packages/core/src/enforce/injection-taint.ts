import type { EnforceInput } from '../types.js'
import { commandSurfaces, argPath } from './arg-utils.js'
import { canonicalizePath } from './path-normalize.js'

/**
 * Cross-turn taint correlation ("Lane G") — the narrower, payload-correlated
 * sibling of Lane F's session-wide, payload-blind next-call scrutiny gate
 * (injection-scan.ts / injection-store.ts / install.ts's
 * `untrusted-content-next-call`). Standalone, pure module, same pattern as
 * injection-scan.ts/command-normalizer.ts/secret-confidence.ts: no
 * pipeline, store, or rule-hierarchy dependency, unit-testable on plain
 * strings and `EnforceInput` values alone.
 *
 * The idea: when an enforcing injection marker fires, pull a small set of
 * structured "artifacts" (URLs, hostnames, file paths, email addresses)
 * from a bounded window of text AROUND the marker — not the whole scanned
 * result, which can be up to 256KB (`MAX_OUTPUT_SCAN_CHARS`, pipeline.ts).
 * If a LATER consequential call's own arguments or content reference one of
 * those same artifacts, that is real evidence the call actually derives
 * from the flagged result, rather than merely happening within the same
 * session and TTL window. See docs/injection.md for the honest limits of
 * this — paraphrased/restructured targets are not caught (this is
 * exact-match only), and this tracks exactly one hop (flagged result ->
 * next call): no multi-hop propagation.
 *
 * Fail-safe posture matches every other piece of this infrastructure
 * (injection-store.ts's own header): a malformed candidate, an oversized
 * input, or any unexpected shape degrades to "no artifacts extracted" —
 * never a thrown exception. This backs a `warn`-tier rule only, never a
 * `level: protect` floor.
 */

export type ArtifactKind = 'url' | 'host' | 'path' | 'email'

export interface InjectionArtifact {
  kind: ArtifactKind
  value: string
}

/** How far around an enforcing marker span to look for a correlatable artifact. This is the whole precision mechanism — see extractOriginArtifacts's own comment. */
export const ARTIFACT_WINDOW_CHARS = 400
/** Cap on artifacts persisted per armed tag — keeps injection-tags.json bounded, same bounding rationale as injection-store.ts's MAX_TAGS_PER_SESSION. */
export const MAX_ARTIFACTS_PER_TAG = 8
/** Cap on how much of a later call's own write content gets scanned for correlatable artifacts. */
export const MAX_CALL_CONTENT_SCAN_CHARS = 64 * 1024
/** Cap on artifacts extracted from one later call — bounds the correlation Set's size, not a persisted value. */
export const MAX_ARTIFACTS_PER_CALL = 64

// Minimum length floor per artifact class — filters trivially short,
// high-false-positive-risk tokens (a bare 4-char path segment or a 5-char
// hostname fragment correlates on almost nothing).
const MIN_LEN_DEFAULT = 8
const MIN_LEN_EMAIL = 6

/**
 * Hosts and path basenames common enough across ordinary tool traffic that
 * correlating on them would be noise, not evidence. `.env` is deliberately
 * NOT here as a path artifact target because it is already the dedicated
 * signal for the existing `no-exfil-flow` rule family (flow-tracker.ts /
 * install.ts) — it appears in essentially every injection test fixture
 * this repo ships, and flagging it again here would just create overlap
 * with that separate, already-shipped control. It IS listed below as a
 * PATH BASENAME to stoplist for the same reason.
 */
const COMMON_HOSTS = new Set([
  'github.com', 'raw.githubusercontent.com', 'api.github.com', 'gitlab.com', 'bitbucket.org',
  'npmjs.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'crates.io',
  'go.dev', 'golang.org', 'docs.rs', 'stackoverflow.com', 'developer.mozilla.org',
  'localhost', '127.0.0.1', '0.0.0.0', 'example.com', 'example.org', 'example.net',
])

const COMMON_PATH_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'readme.md', 'license', '.gitignore',
  'index.ts', 'index.js', 'main.py', 'node_modules', 'dist', 'build', '.env',
])

/**
 * Everything a `type: content` rule branch already treats as write content
 * (pipeline.ts's `runTieredRules()` content-rule branch — `newString` AND
 * snake_case `new_string`, discovered necessary there after a live probe
 * found the camelCase-only check let a real Edit-shaped write past a
 * protect floor undetected). Kept in sync with that branch's own key list
 * by inspection, not by import, since that branch lives inside the
 * pipeline and this module must stay pipeline-free.
 */
function callContent(args: Record<string, unknown>): string {
  return String(args.content || args.text || args.newString || args.new_string || args.patchText || '')
}

// url: scheme-prefixed or `www.`-prefixed, greedy up to the next
// whitespace/quote/bracket boundary — trailing sentence punctuation is
// stripped afterward, never baked into the character class (a URL can
// legitimately end mid-sentence right before a comma or period).
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+|\bwww\.[^\s<>"'`)\]}]+/gi
// email: standard local@domain shape.
const EMAIL_RE = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g
// host: bare hostname-shaped token — 2+ dot-separated labels, final label
// 2-24 alpha chars (excludes version strings like "1.2.3", whose final
// label is numeric, and single-letter TLD-shaped noise).
const HOST_RE = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,24}\b/g
// IPv4-literal-shaped token.
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
// path: absolute (/...), home-relative (~/...), dotted-relative (./..., ../...).
const POSIX_PATH_RE = /~\/[^\s<>"'`)\]}]+|\.{1,2}\/[^\s<>"'`)\]}]+|\/[^\s<>"'`)\]}]+/g
// path: Windows-style, either separator after the drive letter (`C:\...`
// or `C:/...` — a drive-letter path written with forward slashes is still
// Windows-shaped, not POSIX-shaped, so it belongs here, not in
// POSIX_PATH_RE, which never matches a bare drive letter).
const WIN_PATH_RE = /[A-Za-z]:[\\/][^\s<>"'`)\]}]+/g

/** Strip trailing sentence/bracket punctuation that isn't part of the value itself. */
function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:)\]}'"]+$/, '')
}

/**
 * Parse a matched URL-shaped substring into its stored `url` form
 * (scheme+host+path, query/fragment stripped) and its `host` form. Never
 * throws — an unparseable candidate (rare, given the regex that fed it) is
 * simply dropped.
 */
function parseUrlParts(raw: string): { url: string; host: string } | null {
  try {
    const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
    const u = new URL(candidate)
    const path = u.pathname && u.pathname !== '/' ? u.pathname : ''
    return { url: `${u.protocol}//${u.hostname}${path}`, host: u.hostname }
  } catch {
    return null
  }
}

/** Canonicalize a path candidate so a Windows-separator path and its `/`-form equivalent land on the same stored value. */
function normalizePathCandidate(raw: string): string {
  try {
    return canonicalizePath(raw)
  } catch {
    return raw
  }
}

/**
 * Common to a `host`-kind check AND a `path`-kind basename check: a
 * filename-shaped token (`package.json`, `readme.md`, `index.ts`, ...) is
 * dot-separated the same way a real hostname is, so the bare-hostname
 * regex above legitimately matches it too. Checking the PATH basename
 * stoplist for a `host`-kind candidate as well closes that ambiguity
 * without inventing a third taxonomy — a token stoplisted as a common
 * filename is exactly as uninformative when it happens to also look like a
 * two-label hostname.
 */
function isStoplisted(kind: ArtifactKind, value: string): boolean {
  if (kind === 'host') return COMMON_HOSTS.has(value) || COMMON_PATH_BASENAMES.has(value)
  if (kind === 'path') {
    const base = value.split(/[\\/]/).pop() || value
    return COMMON_PATH_BASENAMES.has(base.toLowerCase())
  }
  return false
}

function minLenFor(kind: ArtifactKind): number {
  return kind === 'email' ? MIN_LEN_EMAIL : MIN_LEN_DEFAULT
}

/**
 * Collapse, cap, and strip every character class a stored artifact could
 * use to become a live, copy-pasteable, still-fetchable URL/path/email once
 * it lands in an audit log or a warning message surfaced back to the model
 * (Claude Code's `additionalContext` channel, for instance) — re-delivering
 * the payload's actionable half through keel's own tooling is exactly the
 * failure this exists to prevent. Stronger than injection-scan.ts's
 * `defangExcerpt` (which leaves `.`/`:`/`/` intact — fine for an excerpt of
 * MATCHED MARKER TEXT, not fine for a URL): this additionally breaks the
 * `http`/`https` scheme word itself (by interspersing it with the same
 * placeholder character used elsewhere) so no contiguous "http" substring
 * survives either, on top of replacing `.`, `:`, `/`, `@`.
 */
export function defangArtifact(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  const schemeBroken = collapsed.replace(/https?/gi, (m) => m.split('').join('\u00B7'))
  const defanged = schemeBroken.replace(/[.:/@]/g, '\u00B7')
  return defanged.slice(0, 80)
}

/** Push a validated, normalized, stoplist-checked, DEFANGED candidate onto `out` — the shared tail of every extraction path below. */
function pushCandidate(out: InjectionArtifact[], kind: ArtifactKind, rawValue: string): void {
  if (!rawValue) return
  const normalized = kind === 'path' ? normalizePathCandidate(rawValue) : rawValue
  const lower = normalized.toLowerCase()
  if (lower.length < minLenFor(kind)) return
  if (isStoplisted(kind, lower)) return
  out.push({ kind, value: defangArtifact(lower) })
}

/**
 * Run all four extractors against one chunk of plain text — shared by
 * `extractOriginArtifacts` (per detection window) and `extractCallArtifacts`
 * (per later call). Order matters: extract raw candidate -> normalize/
 * lowercase -> length floor -> stoplist -> defang. Never throws.
 */
function extractCandidates(text: string): InjectionArtifact[] {
  const out: InjectionArtifact[] = []
  try {
    for (const raw of text.match(URL_RE) || []) {
      const parts = parseUrlParts(stripTrailingPunct(raw))
      if (!parts) continue
      pushCandidate(out, 'url', parts.url)
      pushCandidate(out, 'host', parts.host)
    }
    for (const raw of text.match(HOST_RE) || []) pushCandidate(out, 'host', stripTrailingPunct(raw))
    for (const raw of text.match(IPV4_RE) || []) pushCandidate(out, 'host', stripTrailingPunct(raw))
    for (const raw of text.match(WIN_PATH_RE) || []) pushCandidate(out, 'path', stripTrailingPunct(raw))
    for (const raw of text.match(POSIX_PATH_RE) || []) pushCandidate(out, 'path', stripTrailingPunct(raw))
    for (const raw of text.match(EMAIL_RE) || []) pushCandidate(out, 'email', stripTrailingPunct(raw))
  } catch {
    return []
  }
  return out
}

/** Dedupe by kind+value (first-seen order preserved), cap at `cap`. */
function dedupeAndCap(candidates: InjectionArtifact[], cap: number): InjectionArtifact[] {
  const seen = new Set<string>()
  const out: InjectionArtifact[] = []
  for (const c of candidates) {
    const key = `${c.kind}:${c.value}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
    if (out.length >= cap) break
  }
  return out
}

/** Merge overlapping/adjacent `[start-ARTIFACT_WINDOW_CHARS, end+ARTIFACT_WINDOW_CHARS]` windows, clamped to `[0, textLen]`. */
function buildWindows(spans: Array<{ start: number; end: number }>, textLen: number): Array<{ start: number; end: number }> {
  const raw = spans
    .map((s) => ({
      start: Math.max(0, s.start - ARTIFACT_WINDOW_CHARS),
      end: Math.min(textLen, s.end + ARTIFACT_WINDOW_CHARS),
    }))
    .sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const w of raw) {
    const current = merged[merged.length - 1]
    if (current && w.start <= current.end) {
      current.end = Math.max(current.end, w.end)
    } else {
      merged.push({ ...w })
    }
  }
  return merged
}

/**
 * Extract correlatable artifacts from a ±`ARTIFACT_WINDOW_CHARS` window
 * around every ENFORCING marker span (`InjectionScanResult.spans` —
 * injection-scan.ts; empty when only `mode: observe` rules matched, which
 * is why an observe-only scan yields zero artifacts here). `scanText` MUST
 * be the exact same string the spans were located in — pipeline.ts's
 * `scanInjectionText()` passes its own `scanText` (the truncated,
 * post-redaction text), never the original `tool_output`, or every offset
 * would be wrong. Never throws; a malformed span or oversized text degrades
 * to `[]`.
 */
export function extractOriginArtifacts(scanText: string, spans: Array<{ start: number; end: number }>): InjectionArtifact[] {
  if (!scanText || !spans?.length) return []
  try {
    const windows = buildWindows(spans, scanText.length)
    const candidates: InjectionArtifact[] = []
    for (const w of windows) candidates.push(...extractCandidates(scanText.slice(w.start, w.end)))
    return dedupeAndCap(candidates, MAX_ARTIFACTS_PER_TAG)
  } catch {
    return []
  }
}

/**
 * Extract correlatable artifacts from a LATER call's own arguments and
 * content: `commandSurfaces(input)` (arg-utils.ts — quote-obfuscation
 * resistance and compound-command splitting for free, reusing
 * command-normalizer.ts's existing hardening), `argPath(args)` (arg-utils.ts
 * — the existing target-path extraction), `args.url`/`args.uri`/`args.host`
 * when present, and inline write content (see `callContent` above).
 * Content scanning is truncated at `MAX_CALL_CONTENT_SCAN_CHARS`. Never
 * throws — degrades to `[]` on any unexpected shape, matching every other
 * piece of this fail-safe infrastructure.
 */
export function extractCallArtifacts(input: EnforceInput): InjectionArtifact[] {
  try {
    const args = (input.args && typeof input.args === 'object' ? input.args : {}) as Record<string, unknown>
    const parts: string[] = []
    for (const surface of commandSurfaces(input)) if (surface) parts.push(surface)
    const path = argPath(args)
    if (path) parts.push(path)
    if (typeof args.url === 'string') parts.push(args.url)
    if (typeof args.uri === 'string') parts.push(args.uri)
    if (typeof args.host === 'string') parts.push(args.host)
    const content = callContent(args)
    if (content) parts.push(content.slice(0, MAX_CALL_CONTENT_SCAN_CHARS))
    const candidates = extractCandidates(parts.join('\n'))
    return dedupeAndCap(candidates, MAX_ARTIFACTS_PER_CALL)
  } catch {
    return []
  }
}

/**
 * Which of `tags` correlate against `callValues` (the defanged artifact
 * VALUES a later call's own extraction produced) — a tag matches if ANY of
 * its `artifacts[].value` is present in `callValues`. Deliberately does NOT
 * require `kind` to match on both sides: a URL emits both a `url` and a
 * `host` artifact from the origin side, so a call that only references the
 * bare domain still correlates against the URL's `host` artifact naturally,
 * with no special-casing needed here.
 */
export function correlateTags<T extends { artifacts?: InjectionArtifact[] }>(
  tags: T[],
  callValues: Set<string>,
): Array<{ tag: T; matched: InjectionArtifact[] }> {
  const out: Array<{ tag: T; matched: InjectionArtifact[] }> = []
  for (const tag of tags) {
    if (!tag.artifacts?.length) continue
    const matched = tag.artifacts.filter((a) => callValues.has(a.value))
    if (matched.length) out.push({ tag, matched })
  }
  return out
}
