import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Ecosystem, PackageManager, PackageSpec } from './package-verifier.js'

/**
 * Ambient package-manager config detection — the fix for the confirmed
 * false-deny bug in `unverified-package-install`.
 *
 * `package-verifier.ts`'s registry check only ever sees the COMMAND LINE:
 * an unscoped npm 404, an unscoped pip/crates 404, or (formerly, before
 * this module) a pip `--index-url` flag. It never reads the config files a
 * real package manager itself consults before resolving a name — `.npmrc`,
 * `pip.conf`, `.cargo/config.toml`, `GOPRIVATE`. A team with an internal
 * mirror configured entirely through one of those files, with NO
 * command-line signal at all, got its own legitimate internal packages
 * hard-denied on the first try (`unverified-package-install` ships with no
 * `mode`/`level`, so pipeline.ts's `not_found` branch applies a first-strike
 * `deny`, `skipFirstWarning: true` — see pipeline.ts's `type: 'package'`
 * branch comment). This module closes that gap by resolving the SAME
 * ambient signals the real package manager would, offline, and handing
 * `package-verifier.ts` an enriched `PackageSpec` it can act on with its
 * EXISTING `privateIndex` downgrade path — no parallel mechanism.
 *
 * Deliberately kept separate from `extractPackageInstalls` (package-verifier
 * .ts): that function is documented as "pure/sync and cheap... zero
 * mocking" and its own test suite relies on exact-shape assertions that
 * must never depend on what happens to be sitting in the REAL filesystem
 * cwd/$HOME of whatever machine runs the test. `applyAmbientConfig` is
 * therefore a SEPARATE pass, run once per command by pipeline.ts, that only
 * ever touches the filesystem for commands `extractPackageInstalls` already
 * found at least one candidate install in — the same "pay nothing for the
 * 99%" discipline the rest of this feature already follows.
 *
 * CORRECTNESS DISCIPLINE (binding):
 *   - Every file read is wrapped in try/catch at the point of use AND the
 *     whole per-spec application is wrapped again in `applyAmbientConfig`
 *     itself — an unreadable/malformed config file (or a pathological
 *     GOPRIVATE glob) must NEVER crash the hot enforcement path or flip a
 *     spec's outcome; on any failure the spec is returned UNCHANGED, i.e.
 *     "assume public registry", i.e. no behavior change from today.
 *   - `.npmrc`'s cascade precedence is project > user > global (closer
 *     file wins) — see `resolveNpmAmbient`.
 *   - `${VAR}` interpolation in a real `.npmrc` (`_authToken=${NPM_TOKEN}`)
 *     is never resolved, but the plain-string line parser here can't throw
 *     on it either — it's just left as literal text in the value.
 *   - Cached PER CWD (`AmbientConfigCache`, one instance per
 *     `EnforcementPipeline`, mirroring `PackageVerifierCache`'s own
 *     per-pipeline-instance lifetime) so repeated evaluations in the same
 *     directory don't re-read the filesystem every call, without leaking
 *     one project's config into a different project's cwd.
 *   - Genuinely offline — every function in this module is synchronous,
 *     local-filesystem/env-only, no network calls.
 *
 * TEST DETERMINISM (binding, same spirit as package-verifier.ts's own
 * VITEST-aware `defaultRegistryBaseUrl` safety net): reading the REAL
 * machine's `$HOME/.npmrc` (or `~/.cargo/config.toml`, ambient `GOPRIVATE`,
 * ...) during the unit suite would make test outcomes depend on whatever
 * the CI/dev box happens to have configured there. `ambientEnabled`/
 * `ambientHomeDir` gate every NON-project-tier read (home dir, "global"
 * config, bare ambient env vars) behind `!env.VITEST || !!env.KEEL_HOME` —
 * under vitest, only an explicit `KEEL_HOME` (the pre-existing, documented
 * override from home.ts, not a new invented var) opts back in. PROJECT-tier
 * reads (the caller-supplied `cwd`) are always live: `cwd` is either the
 * real project directory (production) or a test's own scratch directory
 * (tests), never ambient machine state either way.
 */

// ── shared plumbing ─────────────────────────────────────────────────

function readTextFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/** See the module header's "TEST DETERMINISM" note. */
function ambientEnabled(env: NodeJS.ProcessEnv): boolean {
  return !env.VITEST || !!env.KEEL_HOME
}

/** Mirrors `home.ts`'s `resolveHome()` precedence (`KEEL_HOME > HOME > os.homedir()`), reading from the PASSED `env` rather than `process.env` directly so callers can inject a fully isolated env without mutating the real process — but returns `null` under vitest unless `KEEL_HOME` is explicitly set, per the module header. */
function ambientHomeDir(env: NodeJS.ProcessEnv): string | null {
  if (env.KEEL_HOME) return env.KEEL_HOME
  if (env.VITEST) return null
  return env.HOME || homedir()
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(url.trim())
  if (!m) return undefined
  return m[1].split('@').pop()?.toLowerCase()
}

/** Fail-OPEN toward "not private" on an unparseable value — used only for the DOWNGRADE decision, where the safe direction on garbage input is "no change from today's behavior" (never downgrade on a value we can't even parse). NEVER used for the dependency-confusion trigger — see `isExactPublicNpmHost`/`isExactPublicPypiHost` for that. */
function isPublicNpmRegistry(url: string | undefined): boolean {
  const h = hostOf(url)
  return !h || h === 'registry.npmjs.org'
}
function isPublicPypiIndex(url: string | undefined): boolean {
  const h = hostOf(url)
  return !h || h === 'pypi.org' || h === 'files.pythonhosted.org'
}

/** Fail-CLOSED (exact match required) — used only for the dependency-confusion trigger, where treating an unparseable `--registry=`/`--index-url` value as "the public registry" would fire a warn on garbage input instead of leaving the ordinary private-index path alone. */
function isExactPublicNpmHost(url: string | undefined): boolean {
  return hostOf(url) === 'registry.npmjs.org'
}
function isExactPublicPypiHost(url: string | undefined): boolean {
  const h = hostOf(url)
  return h === 'pypi.org' || h === 'files.pythonhosted.org'
}

// ── npm: .npmrc cascade ─────────────────────────────────────────────

function parseNpmrc(text: string): { defaultRegistry?: string; scoped: Map<string, string> } {
  const scoped = new Map<string, string>()
  let defaultRegistry: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key === 'registry') { defaultRegistry = value; continue }
    const m = /^(@[^:]+):registry$/i.exec(key)
    if (m) scoped.set(m[1], value)
  }
  return { defaultRegistry, scoped }
}

export interface NpmAmbient {
  defaultRegistry?: string
  scoped: Map<string, string>
  source?: string
}

/**
 * Cascade order (binding, finding [ambient]): global -> user -> project ->
 * `NPM_CONFIG_REGISTRY` env, each tier's `registry=`/`@scope:registry=`
 * OVERWRITING the previous tier's when both set the same key — i.e. the
 * CLOSER file wins, matching real npm's own precedence
 * (env > project rc > user rc > global rc). "Global" has no single
 * reliable cross-platform path without invoking the npm binary itself
 * (nvm/homebrew/volta/system node all differ), so it's opt-in via
 * `NPM_CONFIG_GLOBALCONFIG` rather than a guessed path — this is a
 * deliberate scope decision, not a missing tier.
 */
export function resolveNpmAmbient(cwd: string, env: NodeJS.ProcessEnv): NpmAmbient {
  const scoped = new Map<string, string>()
  let defaultRegistry: string | undefined
  let source: string | undefined

  const apply = (text: string | null, label: string) => {
    if (!text) return
    const p = parseNpmrc(text)
    if (p.defaultRegistry) { defaultRegistry = p.defaultRegistry; source = label }
    for (const [k, v] of p.scoped) scoped.set(k, v)
  }

  if (ambientEnabled(env) && env.NPM_CONFIG_GLOBALCONFIG) {
    apply(readTextFile(env.NPM_CONFIG_GLOBALCONFIG), 'global .npmrc')
  }
  const home = ambientHomeDir(env)
  if (home) apply(readTextFile(join(home, '.npmrc')), 'user .npmrc')
  // Project tier is always live — `cwd` is caller-supplied, never ambient
  // machine state, the same way it's caller-supplied for every other
  // rule-evaluation call in this codebase.
  apply(readTextFile(join(cwd, '.npmrc')), 'project .npmrc')

  if (ambientEnabled(env) && env.NPM_CONFIG_REGISTRY) {
    defaultRegistry = env.NPM_CONFIG_REGISTRY
    source = 'NPM_CONFIG_REGISTRY'
  }

  return { defaultRegistry, scoped, source }
}

// ── pip: pip.conf/pip.ini + env ─────────────────────────────────────

function parsePipConf(text: string): string[] {
  const urls: string[] = []
  let inGlobal = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[([^\]]+)\]$/.exec(line)
    if (section) { inGlobal = section[1].trim().toLowerCase() === 'global'; continue }
    if (!inGlobal) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    if (key !== 'index-url' && key !== 'extra-index-url') continue
    for (const u of line.slice(eq + 1).trim().split(/\s+/)) if (u) urls.push(u)
  }
  return urls
}

export interface PipAmbient {
  indexUrls: string[]
  source?: string
}

/** Standard pip.conf/pip.ini locations, checked in the order pip itself documents (venv overrides user overrides system) — but since this module only needs "is ANY ambient index configured", not precedence between them, every hit is simply unioned into `indexUrls` rather than overwritten tier-by-tier the way npm's single `registry=` value is. */
export function resolvePipAmbient(cwd: string, env: NodeJS.ProcessEnv): PipAmbient {
  const urls: string[] = []
  let source: string | undefined
  const add = (text: string | null, label: string) => {
    if (!text) return
    const found = parsePipConf(text)
    if (found.length) { urls.push(...found); source = source ?? label }
  }

  if (ambientEnabled(env) && env.VIRTUAL_ENV) add(readTextFile(join(env.VIRTUAL_ENV, 'pip.conf')), 'venv pip.conf')
  const home = ambientHomeDir(env)
  if (home) {
    add(readTextFile(join(home, '.config', 'pip', 'pip.conf')), 'user pip.conf')
    add(readTextFile(join(home, '.pip', 'pip.ini')), 'user pip.ini')
  }
  if (ambientEnabled(env)) add(readTextFile('/etc/pip.conf'), '/etc/pip.conf')
  // pip has no per-project config file the way npm/cargo do (no cwd tier).

  if (ambientEnabled(env)) {
    if (env.PIP_INDEX_URL) { urls.push(env.PIP_INDEX_URL); source = 'PIP_INDEX_URL' }
    if (env.PIP_EXTRA_INDEX_URL) {
      const extra = env.PIP_EXTRA_INDEX_URL.split(/\s+/).filter(Boolean)
      urls.push(...extra)
      source = source ?? 'PIP_EXTRA_INDEX_URL'
    }
  }
  return { indexUrls: urls, source }
}

// ── cargo: .cargo/config.toml ───────────────────────────────────────

/**
 * Minimal hand-rolled TOML reader — this module only ever needs
 * `[section]`/`[section.sub]` headers and scalar `key = "value"`
 * assignments, never arrays/inline-tables/multi-line strings, so pulling in
 * a real TOML parser dependency for `.cargo/config.toml` would be pure
 * overkill for what this feature actually reads.
 */
function parseSimpleToml(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>()
  let current: Record<string, string> | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const section = /^\[([^\]]+)\]$/.exec(line)
    if (section) { current = {}; sections.set(section[1].trim(), current); continue }
    if (!current) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    current[key] = value
  }
  return sections
}

export interface CargoAmbient {
  /** Resolved target of `[source.crates-io] replace-with = "..."`, following the indirection chain — a registry URL if the chain terminates in one, otherwise the final source table's name. `undefined` when crates-io is not replaced. */
  replacementRegistry?: string
  /** `[registries.<name>]` table names -> their `index` URL (or empty string if declared with no index), for cross-checking an explicit `cargo add --registry <name>` against a KNOWN non-default registry. */
  registries: Map<string, string>
  source?: string
}

/** Follows `[source.<name>] replace-with = "<other>"` to `[source.<other>]`, bounded against a cycle. Returns the final table's own `registry` URL if it has one, else just the final name it landed on. */
function followSourceReplacement(sections: Map<string, Record<string, string>>, start: string, maxHops = 5): { finalName: string; registryUrl?: string } {
  let name = start
  for (let hop = 0; hop < maxHops; hop++) {
    const table = sections.get(`source.${name}`)
    if (!table) return { finalName: name }
    const next = table['replace-with']
    if (next && next !== name) { name = next; continue }
    return { finalName: name, registryUrl: table.registry }
  }
  return { finalName: name } // cycle guard tripped — stop following, don't loop forever
}

export function resolveCargoAmbient(cwd: string, env: NodeJS.ProcessEnv): CargoAmbient {
  const registries = new Map<string, string>()
  let replacementRegistry: string | undefined
  let source: string | undefined

  const files: Array<[string, string]> = []
  const home = ambientHomeDir(env)
  if (home) files.push(['user', join(home, '.cargo', 'config.toml')])
  files.push(['project', join(cwd, '.cargo', 'config.toml')]) // project overrides user — read last, sections.set() below overwrites by key

  let sections = new Map<string, Record<string, string>>()
  for (const [, path] of files) {
    const text = readTextFile(path)
    if (!text) continue
    const parsed = parseSimpleToml(text)
    for (const [k, v] of parsed) sections.set(k, v) // closer file's section replaces the earlier one wholesale
  }

  for (const [name, table] of sections) {
    const m = /^registries\.(.+)$/.exec(name)
    if (m) registries.set(m[1], table.index ?? '')
  }

  const crateIo = sections.get('source.crates-io')
  if (crateIo?.['replace-with']) {
    const chain = followSourceReplacement(sections, crateIo['replace-with'])
    replacementRegistry = chain.registryUrl ?? chain.finalName
    source = 'source.crates-io replace-with'
  }

  return { replacementRegistry, registries, source }
}

// ── go: GOPRIVATE / GOPROXY / GONOSUMCHECK ──────────────────────────

export interface GoAmbient {
  privatePatterns: string[]
  hasCustomProxy: boolean
  source?: string
}

const DEFAULT_GOPROXY = 'https://proxy.golang.org,direct'

/** Ambient (process-env, not inline) GOPRIVATE/GOPROXY/GONOSUMCHECK — see `matchesGoPrivate` for the inline-command form, which is captured at extraction time and takes precedence over this. */
export function resolveGoAmbient(env: NodeJS.ProcessEnv): GoAmbient {
  if (!ambientEnabled(env)) return { privatePatterns: [], hasCustomProxy: false }
  const privatePatterns = (env.GOPRIVATE || '').split(',').map(s => s.trim()).filter(Boolean)
  const hasCustomProxy = !!(env.GOPROXY && env.GOPROXY !== DEFAULT_GOPROXY && env.GOPROXY !== 'off') || !!env.GONOSUMCHECK
  const source = privatePatterns.length ? 'GOPRIVATE' : (env.GOPROXY ? 'GOPROXY' : (env.GONOSUMCHECK ? 'GONOSUMCHECK' : undefined))
  return { privatePatterns, hasCustomProxy, source }
}

/**
 * GOPRIVATE glob matching, per Go's own documented semantics: comma-
 * separated `path.Match`-style glob patterns, matched against the module
 * path (a pattern matches the module and everything under it). `*` matches
 * any run of non-slash characters within one path element, `?` matches one
 * character. Wrapped in try/catch — a pathological pattern is agent/env-
 * controlled text reaching a `RegExp` construction on the hot enforcement
 * path, and per this module's correctness discipline must never crash it.
 */
export function matchesGoPrivate(modulePath: string, patterns: string[]): boolean {
  try {
    return patterns.some(p => {
      const escaped = p.split('/').map(seg =>
        seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.'),
      ).join('/')
      const re = new RegExp('^' + escaped + '(/.*)?$')
      return re.test(modulePath)
    })
  } catch {
    return false
  }
}

// ── per-cwd cache ────────────────────────────────────────────────────

interface AmbientBundle {
  npm: NpmAmbient
  pip: PipAmbient
  cargo: CargoAmbient
}

function safeResolve<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}

/**
 * One instance per `EnforcementPipeline`, exactly mirroring
 * `PackageVerifierCache`'s per-pipeline-instance lifetime (see pipeline.ts
 * constructor) — this is what keeps the cache scoped PER CWD without ever
 * leaking one project's ambient config into a different project's cwd: a
 * fresh pipeline (fresh test, fresh process) gets a fresh cache, and within
 * one pipeline's lifetime the key includes `cwd` plus the `KEEL_HOME`
 * override (if any) actually used to resolve it, so two different
 * cwd/env-override combinations can never collide.
 */
export class AmbientConfigCache {
  private byKey = new Map<string, AmbientBundle>()
  private goByKey = new Map<string, GoAmbient>()

  private resolveBundle(cwd: string, env: NodeJS.ProcessEnv): AmbientBundle {
    const key = `${cwd} ${env.KEEL_HOME ?? ''}`
    let bundle = this.byKey.get(key)
    if (!bundle) {
      bundle = {
        npm: safeResolve(() => resolveNpmAmbient(cwd, env), { scoped: new Map() }),
        pip: safeResolve(() => resolvePipAmbient(cwd, env), { indexUrls: [] }),
        cargo: safeResolve(() => resolveCargoAmbient(cwd, env), { registries: new Map() }),
      }
      this.byKey.set(key, bundle)
    }
    return bundle
  }

  npm(cwd: string, env: NodeJS.ProcessEnv): NpmAmbient { return this.resolveBundle(cwd, env).npm }
  pip(cwd: string, env: NodeJS.ProcessEnv): PipAmbient { return this.resolveBundle(cwd, env).pip }
  cargo(cwd: string, env: NodeJS.ProcessEnv): CargoAmbient { return this.resolveBundle(cwd, env).cargo }

  // Go's ambient signal is env-only, never cwd-scoped, so it gets its OWN
  // small keyed cache rather than riding along in the cwd-keyed npm/pip/
  // cargo bundle above — piggybacking it on an arbitrary cwd would mean a
  // Go-only command wastefully (if harmlessly) reads files under that cwd
  // it has no use for at all.
  go(env: NodeJS.ProcessEnv): GoAmbient {
    const key = env.KEEL_HOME ?? ''
    let ambient = this.goByKey.get(key)
    if (!ambient) {
      ambient = safeResolve(() => resolveGoAmbient(env), { privatePatterns: [], hasCustomProxy: false })
      this.goByKey.set(key, ambient)
    }
    return ambient
  }
}

// Duplicated (deliberately) from package-verifier.ts's own MANAGER_ECOSYSTEM
// table rather than imported, to avoid a real (non-type-only) circular
// import between the two modules — package-verifier.ts imports
// `applyAmbientConfig` (a value) from here, so this module importing a
// VALUE back from package-verifier.ts would create a genuine runtime
// circular dependency. This table is tiny and stable; keep it in sync with
// package-verifier.ts's own copy if a new manager is ever added.
const MANAGER_ECOSYSTEM: Record<PackageManager, Ecosystem> = {
  npm: 'npm', pnpm: 'npm', yarn: 'npm', bun: 'npm',
  pip: 'pypi', pip3: 'pypi', uv: 'pypi', poetry: 'pypi',
  cargo: 'crates',
  go: 'go',
}

function applySpecAmbient(spec: PackageSpec, cwd: string, env: NodeJS.ProcessEnv, cache: AmbientConfigCache): PackageSpec {
  const ecosystem = MANAGER_ECOSYSTEM[spec.manager]

  if (ecosystem === 'npm') {
    const ambient = cache.npm(cwd, env)
    const scope = spec.name.startsWith('@') ? spec.name.split('/')[0] : undefined
    const effective = (scope && ambient.scoped.get(scope)) ?? ambient.defaultRegistry
    const ambientPrivate = !!effective && !isPublicNpmRegistry(effective)

    if (spec.explicitRegistryOverride !== undefined) {
      // Only a genuine `--registry=` flag reaches here for npm (see
      // package-verifier.ts's extraction — npm's flag table has no
      // next-token entry, so only the `=`-joined form is captured).
      if (ambientPrivate && isExactPublicNpmHost(spec.explicitRegistryOverride)) {
        return { ...spec, dependencyConfusionRisk: true, ambientSource: ambient.source }
      }
      if (!isPublicNpmRegistry(spec.explicitRegistryOverride)) {
        return { ...spec, privateIndex: true, ambientSource: 'explicit --registry flag' }
      }
      return spec // explicit flag names the public registry, no ambient conflict
    }
    if (ambientPrivate) return { ...spec, privateIndex: true, ambientSource: ambient.source }
    return spec
  }

  if (ecosystem === 'pypi') {
    const ambient = cache.pip(cwd, env)
    const ambientPrivate = ambient.indexUrls.some(u => !isPublicPypiIndex(u))
    // spec.explicitRegistryOverride for pip is captured ONLY from a primary
    // index flag (-i/--index-url), never --extra-index-url — see
    // package-verifier.ts's extraction (isPipPrimaryIndexFlag).
    if (spec.explicitRegistryOverride !== undefined) {
      if (ambientPrivate && isExactPublicPypiHost(spec.explicitRegistryOverride)) {
        return { ...spec, privateIndex: false, dependencyConfusionRisk: true, ambientSource: ambient.source }
      }
      return spec // existing CLI-flag privateIndex behavior stands (set at extraction time)
    }
    if (!spec.privateIndex && ambientPrivate) return { ...spec, privateIndex: true, ambientSource: ambient.source }
    return spec
  }

  if (ecosystem === 'crates') {
    const ambient = cache.cargo(cwd, env)
    if (spec.explicitRegistryOverride !== undefined) {
      // `cargo add pkg --registry <name>` — spec.explicitRegistryOverride
      // holds the NAME, never a URL, for cargo; only used for this
      // registries-table membership check, never passed to a host parser.
      if (ambient.registries.has(spec.explicitRegistryOverride)) {
        return { ...spec, privateIndex: true, ambientSource: `--registry ${spec.explicitRegistryOverride}` }
      }
      return spec
    }
    if (ambient.replacementRegistry) return { ...spec, privateIndex: true, ambientSource: ambient.source }
    return spec
  }

  // go
  const inlineGoPrivate = spec.inlineEnv?.GOPRIVATE
  const inlinePatterns = inlineGoPrivate ? inlineGoPrivate.split(',').map(s => s.trim()).filter(Boolean) : []
  const patterns = inlinePatterns.length ? inlinePatterns : cache.go(env).privatePatterns
  if (patterns.length && matchesGoPrivate(spec.name, patterns)) {
    return {
      ...spec,
      privateIndex: true,
      ambientSource: inlinePatterns.length ? `inline GOPRIVATE=${inlineGoPrivate}` : 'GOPRIVATE',
    }
  }
  return spec
}

/**
 * Apply ambient package-manager config to every spec `extractPackageInstalls`
 * found, downgrading a would-be hard deny to the existing `privateIndex`
 * prompt path where ambient config marks the name as private, and flagging
 * the dependency-confusion attack shape (ambient private + command
 * explicitly forces public) via `dependencyConfusionRisk`. Called by
 * pipeline.ts's `type: 'package'` branch, once per command, only after
 * `extractPackageInstalls` has already found at least one candidate — never
 * on the 99% of commands with nothing to check.
 *
 * The per-spec `try/catch` here is deliberate DEFENSE IN DEPTH on top of
 * `AmbientConfigCache`'s own `safeResolve` — a malformed config or
 * pathological GOPRIVATE glob must never crash the hot enforcement path or
 * (worse) throw mid-map and leave later specs unevaluated; on any failure
 * the offending spec is returned exactly as extracted, unchanged.
 */
export function applyAmbientConfig(
  specs: PackageSpec[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  cache: AmbientConfigCache = new AmbientConfigCache(),
): PackageSpec[] {
  return specs.map(spec => {
    try {
      return applySpecAmbient(spec, cwd, env, cache)
    } catch {
      return spec
    }
  })
}
