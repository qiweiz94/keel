import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHome } from '../home.js'

/**
 * Slopsquatting install gate.
 *
 * 19.7% of LLM-recommended packages don't exist (USENIX Security 2025,
 * "We Have a Package for You!"). Attackers register the hallucinated name
 * ahead of time and wait for an agent to `npm install` it — the real-world
 * case is `huggingface-cli` (the actual PyPI package is `huggingface_hub`;
 * `huggingface-cli` was squatted and shipped a reverse shell). Keel cannot
 * stop an LLM from hallucinating, but it CAN check whether the name it is
 * about to install exists before the shell runs — that check is
 * deterministic and near-zero-false-positive: a name that doesn't exist on
 * the registry is unfulfillable regardless of intent.
 *
 * Two-stage design:
 *   1. `extractPackageInstalls` — cheap, synchronous, regex/tokenizer only.
 *      Pays nothing for the 99% of commands that are not an install. This
 *      is what lets a `type: package` rule sit in the default ruleset
 *      without taxing every other tool call.
 *   2. `checkPackages` / `decidePackageAction` — the network-touching half,
 *      called ONLY when step 1 found at least one candidate package.
 *
 * SEMANTICS (binding, see session/DECISIONS.md wave-2 slopsquatting lane):
 *   - not found on the registry           -> deny   (deterministic; a name
 *     that doesn't exist cannot be legitimately installed either way)
 *   - registry unreachable / timed out    -> prompt "unverified — registry
 *     unreachable" — NEVER deny on a network failure. A network blip must
 *     never brick `npm install <real package>`.
 *   - scoped name (`@scope/pkg`) 404s     -> prompt "unverified" — a 404 for
 *     a scoped name is not proof of nonexistence. Private/org registries
 *     (Verdaccio, Artifactory, GitHub Packages) commonly scope their
 *     internal packages, and those 404 against the PUBLIC registry by
 *     construction. Hard-denying every 404'd scope would brick every
 *     private monorepo dependency; deny is reserved for UNSCOPED names,
 *     where "not on the public registry" really does mean "unfulfillable".
 *   - exists, published < age_days ago    -> prompt (age-gate; configurable
 *     per rule via `age_days`, default 30) — a brand-new package is exactly
 *     the shape a same-day slopsquat takes.
 *   - exists, older than age_days         -> allow
 *
 * No SSRF guard (unlike enforce/research/fetcher.ts): the destination host
 * is a fixed, operator/rule-author-controlled base URL
 * (`registryBaseUrl` / `KEEL_NPM_REGISTRY`), never derived from
 * agent-controlled input — only the URL PATH varies, with the package name.
 * A rules.yaml editor is already a trusted actor (see the shipped
 * `no-rules-tampering` / `keel-control-gate` rules), so this is not a live
 * attacker-controlled surface the way a fetched webpage's redirect chain is.
 */

// ── Extraction ────────────────────────────────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface PackageSpec {
  name: string
  requestedVersion?: string
  manager: PackageManager
  raw: string
}

const MANAGERS = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun'])

// Which subcommand, for each manager, actually names NEW packages to add.
// `npm install`/`npm ci` with no args, `pnpm install`, bare `yarn` all read
// from the lockfile/package.json — nothing to verify, and treating them as
// installs would false-positive on every ordinary dependency restore.
const ADD_SUBCOMMANDS: Record<PackageManager, Set<string>> = {
  npm: new Set(['install', 'i']),
  pnpm: new Set(['add']),
  yarn: new Set(['add']),
  bun: new Set(['add']),
}

// Cheap reject before any tokenizing — the vast majority of commands never
// mention a package manager at all, and this is the check that makes
// "only commands matching an install pattern pay any cost" literally true.
const QUICK_PREFILTER = /\b(npm|pnpm|yarn|bun)\b/

function tokenize(segment: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segment))) {
    const tok = m[1] ?? m[2] ?? m[3]
    if (tok) tokens.push(tok)
  }
  return tokens
}

function managerFromToken(token: string): PackageManager | null {
  const base = token.split('/').pop() ?? token
  return MANAGERS.has(base as PackageManager) ? (base as PackageManager) : null
}

/**
 * True for a spec that is not a public-registry package reference at all:
 * a local path, a tarball, a git/GitHub reference, or a bare URL. These are
 * either unfulfillable-by-registry-check-anyway (local paths always
 * "exist" on disk) or already handled by other keel rules (no-remote-exec,
 * no-curl-pipe-shell) — checking them against npm's registry would be
 * meaningless at best and a guaranteed false "not found" at worst.
 */
function isNonRegistrySpec(spec: string): boolean {
  if (!spec) return true
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || spec.startsWith('~')) return true
  if (/^(file|git|git\+ssh|git\+https|git\+http|github|http|https):/i.test(spec)) return true
  if (/\.(tgz|tar\.gz|tar)$/i.test(spec)) return true
  // Bare `user/repo` GitHub shorthand — exactly one slash, no leading '@',
  // no leading dot/tilde/scheme already ruled out above.
  if (!spec.startsWith('@') && /^[^@/\s]+\/[^@/\s]+(#.*)?$/.test(spec)) return true
  return false
}

function parseSpec(spec: string): { name: string; requestedVersion?: string } | null {
  let name: string
  let version: string | undefined
  if (spec.startsWith('@')) {
    const secondAt = spec.indexOf('@', 1)
    if (secondAt === -1) { name = spec; version = undefined } else { name = spec.slice(0, secondAt); version = spec.slice(secondAt + 1) }
  } else {
    const at = spec.indexOf('@')
    if (at <= 0) { name = spec; version = undefined } else { name = spec.slice(0, at); version = spec.slice(at + 1) }
  }
  if (!name) return null
  // A version protocol that isn't a plain semver/tag/range is not a public
  // registry reference (workspace deps, local links, git deps expressed
  // via the version position rather than the name position).
  if (version && /^(workspace|link|file|git|git\+ssh|git\+https|github):/i.test(version)) return null
  if (!/^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i.test(name)) return null
  return { name, requestedVersion: version || undefined }
}

function extractSegmentInstalls(segment: string): PackageSpec[] {
  const tokens = tokenize(segment)
  let i = 0
  // Skip leading `sudo` and inline env assignments (`FOO=bar npm install x`).
  while (i < tokens.length && (tokens[i] === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++
  if (i >= tokens.length) return []
  const manager = managerFromToken(tokens[i])
  if (!manager) return []
  i++
  if (i >= tokens.length) return []
  const subcommand = tokens[i].toLowerCase()
  if (!ADD_SUBCOMMANDS[manager].has(subcommand)) return []
  i++
  const specs: PackageSpec[] = []
  for (; i < tokens.length; i++) {
    const tok = tokens[i]
    if (!tok || tok.startsWith('-')) continue // flags (and their inline values, best-effort)
    if (isNonRegistrySpec(tok)) continue
    const parsed = parseSpec(tok)
    if (parsed) specs.push({ ...parsed, manager, raw: tok })
  }
  return specs
}

/**
 * Extract candidate registry package installs from a shell command string.
 *
 * Covers `npm install|i`, `pnpm add`, `yarn add`, `bun add`; versioned
 * (`pkg@1.2.3`) and scoped (`@scope/pkg`, `@scope/pkg@1.2.3`) names;
 * compound commands (`cd x && npm install y`) via `&&`/`||`/`;`/`|`
 * splitting. Ignores flags, local paths (`./`, `../`, `/`, `~`), `file:`,
 * `git+`/`git:`/`github:` refs, bare GitHub shorthand (`user/repo`),
 * tarball URLs/paths, workspace/link protocol versions, and a bare
 * `npm install`/`npm ci`/`pnpm install`/`yarn` with no package args.
 *
 * Known false-negative (documented, not fixed): `bash -c "npm install x"`
 * — the tokenizer treats the quoted string as a single opaque token, so the
 * inner command is invisible to this pass. Out of scope for a regex-level
 * extractor; a real shell parse would be needed to unwrap it.
 */
export function extractPackageInstalls(command: string): PackageSpec[] {
  if (!command || !QUICK_PREFILTER.test(command)) return []
  const segments = command.split(/&&|\|\||;|\|/)
  const out: PackageSpec[] = []
  for (const seg of segments) out.push(...extractSegmentInstalls(seg.trim()))
  return out
}

// ── Registry lookups ─────────────────────────────────────────────────

export type PackageVerdict = 'exists' | 'not_found' | 'unverified'
export type UnverifiedReason = 'timeout' | 'network_error' | 'scoped_not_public' | 'budget_exhausted' | 'too_large' | 'not_yet_checked'

export interface PackageCheckResult {
  name: string
  requestedVersion?: string
  verdict: PackageVerdict
  reason?: UnverifiedReason
  ageDays?: number
  createdAt?: string
  didYouMean?: string[]
  fromCache: boolean
}

/**
 * Read the KEEL_NPM_REGISTRY override at CALL time, not at module load —
 * state-manager.ts's STATE_DIR constant is captured once at import, before
 * a test's `beforeAll` can set the env var; that bug is not repeated here
 * (see enforce/research/research-cache.ts's `researchCacheDir()` for the
 * same call-time pattern).
 *
 * Safety net: with no explicit override, a run under vitest (which always
 * sets `VITEST=1`) defaults to a closed loopback port instead of the real
 * registry. An unmocked `type: package` rule exercised by a harness that
 * doesn't know about `packageVerifierFetch` (e.g. the shipped default
 * ruleset run through packages/cli's fixture-harness.test.ts once pasted
 * in) then fails FAST via ECONNREFUSED -> verdict 'unverified' -> prompt,
 * instead of making a real network call from the unit suite or hanging for
 * the full 2s budget. This is the "no network in unit tests" constraint
 * enforced structurally, not just by test discipline.
 */
export function defaultRegistryBaseUrl(): string {
  if (process.env.KEEL_NPM_REGISTRY) return process.env.KEEL_NPM_REGISTRY
  if (process.env.VITEST) return 'http://127.0.0.1:1'
  return 'https://registry.npmjs.org'
}

// Full packuments for very popular packages can be multi-MB (embedded
// per-version readmes/dependency snapshots is a known npm registry quirk).
// Measured empirically against the real registry while building this
// module: lodash ~248KB, express ~805KB, left-pad ~23KB, but react ~6.9MB
// — react alone would blow a 2MB cap and prompt on every install. 10MB
// covers react comfortably with headroom; the outer 2000ms total-timeout
// AbortController (not this cap) is the actual defense against a slow or
// pathological connection — this cap exists as a backstop against a truly
// runaway response, not as the primary size control.
const DEFAULT_MAX_RESPONSE_BYTES = 10_000_000

function registryPath(name: string): string {
  if (name.startsWith('@')) {
    const [scope, pkg] = name.slice(1).split('/')
    return `@${encodeURIComponent(scope)}/${encodeURIComponent(pkg ?? '')}`
  }
  return encodeURIComponent(name)
}

interface FetchOutcome {
  ok: boolean
  status?: number
  json?: unknown
  kind?: 'timeout' | 'network_error' | 'http_error' | 'too_large'
}

async function fetchJsonCapped(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  maxBytes: number,
): Promise<FetchOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs))
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'keel-package-verifier/0.1' } })
    if (!res.ok) return { ok: false, status: res.status, kind: 'http_error' }
    if (!res.body || typeof (res.body as any).getReader !== 'function') {
      // Test doubles / older Response polyfills may not stream — fall back
      // to a plain read, still under the overall AbortController timeout.
      const json = await res.json()
      return { ok: true, status: res.status, json }
    }
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return { ok: false, kind: 'too_large' }
      }
      chunks.push(value)
    }
    const text = Buffer.concat(chunks).toString('utf-8')
    return { ok: true, status: res.status, json: JSON.parse(text) }
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, kind: 'timeout' }
    return { ok: false, kind: 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}

interface LookupOptions {
  registryBaseUrl: string
  fetchImpl: typeof fetch
  maxBytes: number
}

async function checkPackageExistence(
  name: string,
  opts: LookupOptions,
  timeoutMs: number,
): Promise<{ verdict: PackageVerdict; reason?: UnverifiedReason; ageDays?: number; createdAt?: string }> {
  if (timeoutMs <= 0) return { verdict: 'unverified', reason: 'budget_exhausted' }
  const url = `${opts.registryBaseUrl}/${registryPath(name)}`
  const outcome = await fetchJsonCapped(url, timeoutMs, opts.fetchImpl, opts.maxBytes)

  if (outcome.ok) {
    const created = (outcome.json as { time?: { created?: string } } | undefined)?.time?.created
    if (!created) return { verdict: 'exists' } // ageDays unknown -> treated as "no age signal", never blocks
    const createdMs = Date.parse(created)
    if (Number.isNaN(createdMs)) return { verdict: 'exists' }
    return { verdict: 'exists', createdAt: created, ageDays: (Date.now() - createdMs) / 86_400_000 }
  }
  if (outcome.kind === 'http_error' && outcome.status === 404) {
    // Scoped names 404 on the public registry for private/org packages too
    // — see the module header rationale. Only an UNSCOPED 404 is treated
    // as deterministic nonexistence.
    if (name.startsWith('@')) return { verdict: 'unverified', reason: 'scoped_not_public' }
    return { verdict: 'not_found' }
  }
  if (outcome.kind === 'timeout') return { verdict: 'unverified', reason: 'timeout' }
  if (outcome.kind === 'too_large') return { verdict: 'unverified', reason: 'too_large' }
  return { verdict: 'unverified', reason: 'network_error' } // any other http_error (5xx, 429, ...) or network_error
}

async function searchDidYouMean(name: string, opts: LookupOptions, timeoutMs: number): Promise<string[]> {
  if (timeoutMs <= 0) return []
  try {
    const url = `${opts.registryBaseUrl}/-/v1/search?text=${encodeURIComponent(name)}&size=5`
    const outcome = await fetchJsonCapped(url, timeoutMs, opts.fetchImpl, opts.maxBytes)
    if (!outcome.ok) return []
    const objects = (outcome.json as { objects?: Array<{ package?: { name?: string } }> } | undefined)?.objects
    if (!Array.isArray(objects)) return []
    return objects.map(o => o?.package?.name).filter((n): n is string => typeof n === 'string' && n.length > 0).slice(0, 5)
  } catch {
    return []
  }
}

// ── Disk cache (KEEL_STATE_DIR, 24h/1h/5m tiered TTL) ──────────────────

interface CachedVerdict {
  name: string
  verdict: PackageVerdict
  reason?: UnverifiedReason
  ageDays?: number
  createdAt?: string
  didYouMean?: string[]
  checkedAt: number
}

/**
 * Deliberate deviation from a flat 24h TTL (documented for the gate):
 *   - `exists`     24h  — matches the spec text; package metadata is
 *                         effectively static on this timescale.
 *   - `not_found`  1h   — a shorter TTL than `exists`. A flat 24h cache on
 *                         "not found" would freeze the PRE-REGISTRATION
 *                         state: a name that didn't exist at 9am but was
 *                         legitimately published at 10am would still read
 *                         as denied at 5pm. 1h keeps the repeat-hallucinated-
 *                         install case (the actual threat) cheap without
 *                         that failure mode.
 *   - `unverified` 5min — caching a transient network failure for 24h would
 *                         mean one blip turns into a day of unnecessary
 *                         prompts for an otherwise-legitimate install. See
 *                         MEMORY.md "Controls that lie" — a cached failure
 *                         state that outlives the failure is exactly that
 *                         pattern.
 */
export const CACHE_TTL_MS: Record<PackageVerdict, number> = {
  exists: 24 * 60 * 60 * 1000,
  not_found: 60 * 60 * 1000,
  unverified: 5 * 60 * 1000,
}

export function packageVerifierStateDir(): string {
  return process.env.KEEL_STATE_DIR || join(resolveHome(), '.keel', 'state')
}

export class PackageVerifierCache {
  constructor(private readonly stateDir: string = packageVerifierStateDir()) {}

  private filePath(): string {
    return join(this.stateDir, 'package-verifier.json')
  }

  private load(): Record<string, CachedVerdict> {
    try {
      const p = this.filePath()
      if (!existsSync(p)) return {}
      return JSON.parse(readFileSync(p, 'utf-8'))
    } catch {
      return {}
    }
  }

  private save(data: Record<string, CachedVerdict>): void {
    try {
      mkdirSync(this.stateDir, { recursive: true })
      const p = this.filePath()
      const tmp = `${p}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, p)
    } catch { /* state persistence is non-critical, matches state-manager.ts */ }
  }

  private expired(entry: CachedVerdict, now: number): boolean {
    return now - entry.checkedAt > CACHE_TTL_MS[entry.verdict]
  }

  get(name: string, now: number = Date.now()): CachedVerdict | null {
    const entry = this.load()[name]
    if (!entry) return null
    if (this.expired(entry, now)) return null
    return entry
  }

  set(entry: CachedVerdict, now: number = Date.now()): void {
    const all = this.load()
    all[entry.name] = entry
    // Prune expired entries opportunistically (mirrors state-manager.ts's
    // load-time TTL prune) so the file doesn't grow unbounded. `now` must
    // be the SAME clock the caller used for `entry.checkedAt` (checkPackages
    // threads its own `opts.now` through) — a hardcoded Date.now() here
    // would prune entries the caller's fake clock considers fresh.
    for (const [k, v] of Object.entries(all)) {
      if (this.expired(v, now)) delete all[k]
    }
    this.save(all)
  }
}

// ── Evaluation ───────────────────────────────────────────────────────

export interface EvaluateInstallOptions {
  ageThresholdDays?: number
  totalTimeoutMs?: number
  registryBaseUrl?: string
  fetchImpl?: typeof fetch
  cache?: PackageVerifierCache
  maxBytes?: number
  now?: () => number
}

/**
 * Check every extracted spec against the registry, sharing ONE total time
 * budget across all of them (default 2000ms — the binding total-lookup
 * timeout). A cache hit costs nothing against the budget. Once the budget
 * is exhausted, remaining unchecked specs get verdict 'unverified' /
 * 'budget_exhausted' rather than being silently skipped — silently skipping
 * would let a hallucinated name after a slow real one through unverified
 * without saying so, whereas 'unverified' correctly downgrades to prompt.
 */
export async function checkPackages(specs: PackageSpec[], opts: EvaluateInstallOptions = {}): Promise<PackageCheckResult[]> {
  const now = opts.now ?? Date.now
  const totalTimeoutMs = opts.totalTimeoutMs ?? 2000
  const registryBaseUrl = opts.registryBaseUrl ?? defaultRegistryBaseUrl()
  const fetchImpl = opts.fetchImpl ?? fetch
  const cache = opts.cache ?? new PackageVerifierCache()
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const lookupOpts: LookupOptions = { registryBaseUrl, fetchImpl, maxBytes }

  const deadline = now() + totalTimeoutMs
  const seen = new Map<string, PackageCheckResult>()
  const results: PackageCheckResult[] = []

  for (const spec of specs) {
    const already = seen.get(spec.name)
    if (already) {
      results.push({ ...already, requestedVersion: spec.requestedVersion })
      continue
    }

    const cached = cache.get(spec.name, now())
    let result: PackageCheckResult
    if (cached) {
      result = {
        name: spec.name,
        requestedVersion: spec.requestedVersion,
        verdict: cached.verdict,
        reason: cached.reason,
        ageDays: cached.ageDays,
        createdAt: cached.createdAt,
        didYouMean: cached.didYouMean,
        fromCache: true,
      }
    } else {
      const remaining = deadline - now()
      const existence = await checkPackageExistence(spec.name, lookupOpts, remaining)
      let didYouMean: string[] | undefined
      if (existence.verdict === 'not_found') {
        didYouMean = await searchDidYouMean(spec.name, lookupOpts, deadline - now())
      }
      result = {
        name: spec.name,
        requestedVersion: spec.requestedVersion,
        verdict: existence.verdict,
        reason: existence.reason,
        ageDays: existence.ageDays,
        createdAt: existence.createdAt,
        didYouMean,
        fromCache: false,
      }
      cache.set({
        name: spec.name,
        verdict: result.verdict,
        reason: result.reason,
        ageDays: result.ageDays,
        createdAt: result.createdAt,
        didYouMean: result.didYouMean,
        checkedAt: now(),
      }, now())
    }
    seen.set(spec.name, result)
    results.push(result)
  }
  return results
}

// ── Cache-first hot path (never blocks on the network) ─────────────────

/**
 * Cache-only pass over a spec list — zero I/O, no `await`, no `fetchImpl`
 * call. This is the hot-path half of the two-stage design that keeps a
 * `type: package` rule under the `<50ms` budget (see pipeline.ts's
 * `rule.type === 'package'` branch): a fresh disk-cache verdict (deny/
 * prompt/allow, per `decidePackageAction`) is used exactly as `checkPackages`
 * would have used it. Anything with no fresh cache entry comes back as an
 * `unverified` / `not_yet_checked` placeholder — that reason is what makes
 * `decidePackageAction` prompt instead of allowing an unverified install
 * through, without ever touching the network on this call.
 *
 * `misses` carries the deduplicated specs (by name) that need a real
 * registry lookup, in first-seen order — pass them to
 * `scheduleBackgroundVerification` to fill the cache for the NEXT call on
 * the same package.
 */
export function checkPackagesCacheOnly(
  specs: PackageSpec[],
  cache: PackageVerifierCache,
  now: () => number = Date.now,
): { results: PackageCheckResult[]; misses: PackageSpec[] } {
  const results: PackageCheckResult[] = []
  const misses: PackageSpec[] = []
  const missSeen = new Set<string>()
  const t = now()
  for (const spec of specs) {
    const cached = cache.get(spec.name, t)
    if (cached) {
      results.push({
        name: spec.name,
        requestedVersion: spec.requestedVersion,
        verdict: cached.verdict,
        reason: cached.reason,
        ageDays: cached.ageDays,
        createdAt: cached.createdAt,
        didYouMean: cached.didYouMean,
        fromCache: true,
      })
    } else {
      results.push({
        name: spec.name,
        requestedVersion: spec.requestedVersion,
        verdict: 'unverified',
        reason: 'not_yet_checked',
        fromCache: false,
      })
      if (!missSeen.has(spec.name)) {
        missSeen.add(spec.name)
        misses.push(spec)
      }
    }
  }
  return { results, misses }
}

/**
 * Fire a real registry lookup for cache-miss specs WITHOUT blocking the
 * caller — `checkPackages` populates `cache` as each spec resolves, exactly
 * as it does on the existing synchronous path, so the NEXT
 * `checkPackagesCacheOnly` call for the same package sees a real verdict.
 * The caller (pipeline.ts) never `await`s this; it fires with `void` and
 * moves on. Errors are swallowed here — a failed background fill just
 * means the cache stays empty and the next call prompts again, the same
 * outcome as today's network-failure path — specifically so a rejected
 * promise here can never surface as an unhandled rejection in a host
 * process. The settlement promise is returned purely so tests (and an
 * optional `packageVerifierOnBackgroundStart` observer hook in pipeline.ts)
 * can await it deterministically instead of racing a real timer.
 */
export function scheduleBackgroundVerification(
  misses: PackageSpec[],
  opts: EvaluateInstallOptions = {},
): Promise<void> {
  if (misses.length === 0) return Promise.resolve()
  return checkPackages(misses, opts).then(() => undefined, () => undefined)
}

export type PackageDecisionReason = 'not_found' | 'unverified' | 'age_gate' | 'ok'

export interface PackageRuleDecision {
  reason: PackageDecisionReason
  message: string
  result?: PackageCheckResult
}

function buildNotFoundMessage(r: PackageCheckResult): string {
  const suggestion = r.didYouMean?.length ? ` Did you mean: ${r.didYouMean.join(', ')}?` : ''
  return `Package "${r.name}" does not exist on the npm registry — this install is unfulfillable regardless of intent.${suggestion}`
}

function buildUnverifiedMessage(r: PackageCheckResult): string {
  if (r.reason === 'scoped_not_public') {
    return `unverified — "${r.name}" returned 404 from the public npm registry. Scoped names 404 publicly for private/org registry packages too, so this is not proof it doesn't exist — treating as unverified, not denying.`
  }
  if (r.reason === 'budget_exhausted') {
    return `unverified — registry lookup budget exhausted before "${r.name}" could be checked`
  }
  if (r.reason === 'too_large') {
    return `unverified — registry response for "${r.name}" exceeded the size cap before it could be checked`
  }
  if (r.reason === 'not_yet_checked') {
    return `unverified — registry not yet checked for "${r.name}"; approve to proceed. A background lookup is filling the cache now, so a repeat of this install will get a real verdict.`
  }
  return `unverified — registry unreachable (could not verify "${r.name}": ${r.reason ?? 'unknown error'})`
}

function buildAgeGateMessage(r: PackageCheckResult, ageThresholdDays: number): string {
  const days = r.ageDays !== undefined ? Math.max(0, Math.floor(r.ageDays)) : undefined
  return `Package "${r.name}" was published ${days ?? '?'} day(s) ago (younger than the ${ageThresholdDays}-day threshold) — verify this isn't a fresh, potentially attacker-registered release before installing.`
}

/**
 * Pure decision function — no I/O, easy to test independently of the
 * network layer. Priority order across a multi-package command mirrors
 * severity: a not_found ANYWHERE denies the whole command (deterministic,
 * highest confidence); otherwise an unverified anywhere prompts; otherwise
 * an age-gated package prompts; otherwise allow.
 */
export function decidePackageAction(results: PackageCheckResult[], ageThresholdDays: number): PackageRuleDecision {
  const notFound = results.find(r => r.verdict === 'not_found')
  if (notFound) return { reason: 'not_found', message: buildNotFoundMessage(notFound), result: notFound }

  const unverified = results.find(r => r.verdict === 'unverified')
  if (unverified) return { reason: 'unverified', message: buildUnverifiedMessage(unverified), result: unverified }

  const young = results.find(r => r.verdict === 'exists' && r.ageDays !== undefined && r.ageDays < ageThresholdDays)
  if (young) return { reason: 'age_gate', message: buildAgeGateMessage(young, ageThresholdDays), result: young }

  return { reason: 'ok', message: 'All installed packages verified against the npm registry.' }
}

/** Convenience: extract + check + decide in one call. Primarily for tests/CLI use; the pipeline calls the three steps separately to keep the cheap extraction gate visible. */
export async function evaluateInstallCommand(command: string, opts: EvaluateInstallOptions & { ageThresholdDays?: number } = {}): Promise<PackageRuleDecision> {
  const specs = extractPackageInstalls(command)
  if (!specs.length) return { reason: 'ok', message: 'No package installs in this command.' }
  const results = await checkPackages(specs, opts)
  return decidePackageAction(results, opts.ageThresholdDays ?? 30)
}
