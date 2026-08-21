import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHome } from '../home.js'
import { applyAmbientConfig } from './ambient-registry-config.js'

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
 * Covers four ecosystems, each with its own registry and its own name
 * grammar: npm (npm/pnpm/yarn/bun), PyPI (pip/pip3/uv), crates.io (cargo),
 * and the Go module proxy (go get/install). See `Ecosystem` /
 * `ecosystemForManager` below.
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
 *     that doesn't exist cannot be legitimately installed either way) —
 *     EXCEPT the Go module proxy, where a 404 at the literal queried path
 *     is the routine, expected shape of a real subpackage, not proof of
 *     nonexistence (see `checkGoExistence`'s own header) — Go 404s always
 *     resolve to `unverified`, never `not_found`.
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
 *     This is an npm-only convention: PyPI/crates.io/Go have no equivalent
 *     syntactic marker, so their unscoped 404s ARE treated as deterministic
 *     nonexistence (except Go, per the subpackage caveat above).
 *   - pip install targets a non-default index (`--index-url` /
 *     `--extra-index-url` / `-i`)  -> prompt "unverified", registry NEVER
 *     queried — PyPI has no `@scope/`-style naming convention the way npm
 *     does, so a private-index install looks identical BY NAME to a public
 *     hallucination. Forcing `unverified` here is the PyPI analog of npm's
 *     scoped-404 handling, just triggered by a command-line flag instead of
 *     a name shape, since PyPI gives us no name-shape signal to use instead.
 *   - exists, published < age_days ago    -> prompt (age-gate; configurable
 *     per rule via `age_days`, default 30) — a brand-new package is exactly
 *     the shape a same-day slopsquat takes. For PyPI this MUST be computed
 *     from the package's first-ever publish date (`min()` over every file
 *     in every version in the JSON API's `releases` map), never the latest
 *     release's `urls[0].upload_time` — a squatted package's second release
 *     would otherwise clear the age gate on a re-publish while the name
 *     itself is still exactly as fresh as day one. This mirrors npm's own
 *     existing (correct) use of `time.created`, never `time.modified`.
 *   - exists, older than age_days         -> allow
 *
 * No SSRF guard (unlike enforce/research/fetcher.ts): every registry base
 * URL this module queries is a fixed, operator/rule-author-controlled URL
 * (`registryBaseUrl`/`pypiBaseUrl`/`cratesBaseUrl`/`goProxyBaseUrl`, each
 * with its own `KEEL_*_REGISTRY`/`KEEL_GO_PROXY` override), never derived
 * from agent-controlled input — only the URL PATH varies, with the package
 * name. A rules.yaml editor is already a trusted actor (see the shipped
 * `no-rules-tampering` / `keel-control-gate` rules), so this is not a live
 * attacker-controlled surface the way a fetched webpage's redirect chain
 * is. This is exactly why a pip `--index-url` value is NEVER queried
 * (above): that URL comes from the AGENT's command line, not the rule
 * author, and would be a live SSRF surface if this module ever fetched it.
 */

// ── Extraction ────────────────────────────────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'pip3' | 'uv' | 'poetry' | 'cargo' | 'go'
export type Ecosystem = 'npm' | 'pypi' | 'crates' | 'go'

export interface PackageSpec {
  name: string
  requestedVersion?: string
  manager: PackageManager
  raw: string
  /**
   * Set (to `true`) only when a pip-family command (`pip`/`pip3`/`uv add`/
   * `uv pip install`) passed `--index-url`/`--extra-index-url`/`-i`
   * anywhere on the command line, OR when `applyAmbientConfig`
   * (ambient-registry-config.ts) found the name resolving to a private
   * registry via `.npmrc`/`pip.conf`/`.cargo/config.toml`/`GOPRIVATE` — see
   * the module header's private-index rationale and
   * ambient-registry-config.ts's own header for the ambient-config half.
   * Deliberately OMITTED (not set to `false`) on every spec this doesn't
   * apply to, so pre-existing hand-built `PackageSpec` fixtures (predating
   * this field) stay structurally identical.
   */
  privateIndex?: boolean
  /**
   * The VALUE of an explicit registry/index override on the command line —
   * npm's `--registry=<url>` (`=`-joined form only, matching npm-family's
   * existing flag-skip behavior), pip's `-i`/`--index-url` (its PRIMARY
   * index flag only, never `--extra-index-url` — see
   * ambient-registry-config.ts's `PIP_PRIMARY_INDEX_FLAGS` note on why),
   * or cargo's `--registry <name>` (a registry NAME, not a URL). Consumed
   * by `applyAmbientConfig` to detect the dependency-confusion attack
   * shape: ambient config says this name is private, but the command
   * itself explicitly forces the public registry.
   */
  explicitRegistryOverride?: string
  /**
   * Inline per-command env var assignments (`GOPRIVATE=github.com/corp/*
   * go get ...`) for the handful of ambient-config-relevant var NAMES this
   * module watches for — captured at extraction time because the generic
   * leading env-assignment skip (just below) has no other way to hand a
   * matched var back to the caller before discarding the token.
   */
  inlineEnv?: Record<string, string>
  /** Set by `applyAmbientConfig` (ambient-registry-config.ts), never by `extractPackageInstalls` itself — free-text description of the ambient signal (npmrc tier, GOPRIVATE pattern, cargo replace-with, ...) that produced `privateIndex: true` or `dependencyConfusionRisk: true`, threaded through to the rule's message. */
  ambientSource?: string
  /** Set by `applyAmbientConfig` — ambient config marks this name as normally resolving to a PRIVATE registry, but the command's own explicit registry/index flag forces the PUBLIC one: the dependency-confusion attack shape (see `decidePackageAction` / `buildDependencyConfusionMessage`). */
  dependencyConfusionRisk?: boolean
}

const MANAGERS = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'poetry', 'cargo', 'go'])

const MANAGER_ECOSYSTEM: Record<PackageManager, Ecosystem> = {
  npm: 'npm', pnpm: 'npm', yarn: 'npm', bun: 'npm',
  pip: 'pypi', pip3: 'pypi', uv: 'pypi', poetry: 'pypi',
  cargo: 'crates',
  go: 'go',
}

/** Which registry a manager's specs resolve against. `poetry` and `cargo`/`go` both use `@`-splitting name/version parsing (see `parseSpec`); only pip-family managers get the PEP-440 grammar (see `PIP_GRAMMAR_MANAGERS`). */
export function ecosystemForManager(manager: PackageManager): Ecosystem {
  return MANAGER_ECOSYSTEM[manager]
}

// Which subcommand, for each npm-family manager, actually names NEW
// packages to add. `npm install`/`npm ci` with no args, `pnpm install`,
// bare `yarn` all read from the lockfile/package.json — nothing to verify,
// and treating them as installs would false-positive on every ordinary
// dependency restore. (Non-npm-family managers are handled directly in
// `matchAddSubcommand` below — pip/poetry/cargo/go don't share npm's
// install-vs-add distinction cleanly enough to fit one shared table.)
const ADD_SUBCOMMANDS: Record<'npm' | 'pnpm' | 'yarn' | 'bun', Set<string>> = {
  npm: new Set(['install', 'i']),
  pnpm: new Set(['add']),
  yarn: new Set(['add']),
  bun: new Set(['add']),
}

/**
 * Returns how many tokens starting at `tokens[i]` form a recognized
 * "this names NEW packages" subcommand for `manager`, or `null` if this
 * invocation reads from a lockfile/manifest/current-module instead
 * (nothing to verify) or isn't a subcommand this rule covers at all.
 *
 * `cargo install` (global binary install — a DIFFERENT cargo subcommand
 * from `cargo add`, which edits `Cargo.toml`) is deliberately NOT matched
 * here — out of scope per this feature's own scoping notes. `go install`
 * IS matched (unlike `cargo install`): for Go, `go install <module>@version`
 * and `go get <module>@version` both name a registry package to verify,
 * whereas `cargo install <crate>` names a binary-install target that
 * `cargo add` has no equivalent for — the two ecosystems' subcommands
 * aren't actually parallel despite the shared word.
 */
function matchAddSubcommand(manager: PackageManager, tokens: string[], i: number): number | null {
  const tok = tokens[i]?.toLowerCase()
  if (tok === undefined) return null
  switch (manager) {
    case 'npm': case 'pnpm': case 'yarn': case 'bun':
      return ADD_SUBCOMMANDS[manager].has(tok) ? 1 : null
    case 'pip': case 'pip3':
      return tok === 'install' ? 1 : null
    case 'poetry': case 'cargo':
      return tok === 'add' ? 1 : null
    case 'go':
      return (tok === 'get' || tok === 'install') ? 1 : null
    case 'uv':
      if (tok === 'add') return 1
      if (tok === 'pip' && tokens[i + 1]?.toLowerCase() === 'install') return 2
      return null
  }
}

// Managers whose spec grammar is pip's, not npm's — finding 3f. `uv add`
// and `uv pip install` are both pip-compatible by design (uv literally
// ships a `pip install`-alike subcommand and pyproject-style `add`), so
// both get this grammar rather than npm/cargo/go/poetry's `@`-splitting
// one. Key differences handled by `parsePipSpec` + the scanning loop in
// `extractSegmentInstalls`, NOT by reusing `parseSpec`:
//   - extras (`pkg[extra1,extra2]`) are stripped before name validation,
//     not rejected outright.
//   - the version, if any, is split off at a PEP 440 comparison operator
//     (`===`/`~=`/`==`/`!=`/`<=`/`>=`/`<`/`>`), never at `@`.
//   - `pkg @ https://...` (PEP 508 URL reference) is THREE separate shell
//     tokens (name, bare `@`, url) — not one token with an embedded `@`
//     like npm's `pkg@1.2.3` — and is skipped entirely as a
//     non-registry-verifiable reference, one level up in the scan loop.
const PIP_GRAMMAR_MANAGERS = new Set<PackageManager>(['pip', 'pip3', 'uv'])

// Flags whose VALUE is a SEPARATE shell token — finding 3a. npm/pnpm/yarn/
// bun deliberately have NO entry: every npm-family flag that takes a value
// is either boolean or `=`-joined in practice (`--registry=https://...`),
// which is why the original flag-skip (`tok.startsWith('-')` -> skip just
// that one token) never needed a table. That does NOT generalize: pip's
// `-r requirements.txt`, cargo's `--vers 1.0`, poetry's `--source pypi`
// all put the value in the NEXT token, which — without this table — reads
// as an unflagged bare word and gets treated as a candidate package name
// (`pip install -r requirements.txt` would otherwise query the registry
// for a package literally named "requirements.txt" and 404 -> deny).
const PIP_FLAG_VALUES = new Set([
  '-r', '--requirement', '-c', '--constraint', '-e', '--editable',
  '-i', '--index-url', '--extra-index-url', '-t', '--target',
  '--trusted-host', '--platform', '--python-version', '--implementation',
  '--abi', '--prefix', '--root', '--cache-dir', '--proxy', '--retries',
  '--timeout', '--src', '-b', '--build', '--log',
])
const FLAG_VALUE_CONSUMING: Partial<Record<PackageManager, Set<string>>> = {
  pip: PIP_FLAG_VALUES,
  pip3: PIP_FLAG_VALUES,
  uv: PIP_FLAG_VALUES,
  cargo: new Set(['--vers', '--version', '--registry', '--rename', '--manifest-path', '--target', '--features', '-F', '--config']),
  poetry: new Set(['--source', '--python', '--extras', '-E']),
  go: new Set(['-mod', '-modfile']),
}

// pip flags that make a name unverifiable by construction — finding 3b.
// PyPI has no `@scope/`-style syntactic marker for "this is a private
// package" the way npm does, so the ONLY signal available that a name
// might be a private-index package rather than a public hallucination is
// whether the COMMAND itself points at a non-default index.
const PIP_INDEX_FLAGS = new Set(['-i', '--index-url', '--extra-index-url'])
function isPipIndexFlag(tok: string): boolean {
  return PIP_INDEX_FLAGS.has(tok.split('=')[0])
}

// pip's PRIMARY index flag only — `-i`/`--index-url` REPLACES the default
// index; `--extra-index-url` only ADDS a fallback while the ambient private
// index (if any) stays primary. Used to capture `explicitRegistryOverride`
// for the dependency-confusion check in ambient-registry-config.ts: only a
// flag that actually FORCES a different primary index is a candidate for
// "this command forced the public registry", never an additive fallback.
const PIP_PRIMARY_INDEX_FLAGS = new Set(['-i', '--index-url'])
function isPipPrimaryIndexFlag(tok: string): boolean {
  return PIP_PRIMARY_INDEX_FLAGS.has(tok.split('=')[0])
}

/** Find the value of a flag whose value is a SEPARATE next token OR `=`-joined, scanning `tokens[from..]`. Used to capture `explicitRegistryOverride` for pip's index flags and cargo's `--registry`, both already members of their manager's `FLAG_VALUE_CONSUMING` table (next-token form) but which can also appear `=`-joined in practice. */
function findFlagValue(tokens: string[], from: number, matchFlag: (tok: string) => boolean): string | undefined {
  for (let j = from; j < tokens.length; j++) {
    const tok = tokens[j]
    if (!matchFlag(tok)) continue
    const eq = tok.indexOf('=')
    if (eq !== -1) return tok.slice(eq + 1)
    return tokens[j + 1]
  }
  return undefined
}

/** `=`-joined-only flag value lookup — npm-family flags are always `=`-joined in practice (see `FLAG_VALUE_CONSUMING`'s own header note on why npm has no next-token table entry); a space-separated `--registry <url>` is deliberately NOT matched here, matching npm-family's existing "no consuming table" behavior byte-for-byte (see the "npm flag-skip behavior is byte-identical to before" test). */
function findEqJoinedFlagValue(tokens: string[], from: number, flagName: string): string | undefined {
  const prefix = `${flagName}=`
  for (let j = from; j < tokens.length; j++) {
    if (tokens[j].startsWith(prefix)) return tokens[j].slice(prefix.length)
  }
  return undefined
}

// Env var names this module captures when they appear as an inline
// per-command prefix (`GOPRIVATE=github.com/corp/* go get ...`) — see
// PackageSpec.inlineEnv's own doc and ambient-registry-config.ts's header.
const WATCHED_INLINE_ENV_VARS = new Set([
  'NPM_CONFIG_REGISTRY', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL',
  'GOPRIVATE', 'GONOSUMCHECK', 'GOPROXY',
])

// Cheap reject before any tokenizing — the vast majority of commands never
// mention a package manager at all, and this is the check that makes
// "only commands matching an install pattern pay any cost" literally true.
const QUICK_PREFILTER = /\b(npm|pnpm|yarn|bun|pip3?|uv|poetry|cargo|go)\b/

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
 * no-curl-pipe-shell) — checking them against the registry would be
 * meaningless at best and a guaranteed false "not found" at worst.
 *
 * The extension list also excludes a handful of common non-package file
 * extensions (`.txt`, `.cfg`, `.ini`, `.toml`, `.lock`, `.whl`) — defense
 * in depth for finding 3a's flag-value problem alongside the proper
 * per-flag consuming table in `FLAG_VALUE_CONSUMING`: even if some future
 * flag is missing from that table, `pip install -r requirements.txt`
 * still can't reach the registry as a literal package name.
 */
function isNonRegistrySpec(spec: string): boolean {
  if (!spec) return true
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || spec.startsWith('~')) return true
  if (/^(file|git|git\+ssh|git\+https|git\+http|github|http|https):/i.test(spec)) return true
  if (/\.(tgz|tar\.gz|tar|txt|cfg|ini|toml|lock|whl)$/i.test(spec)) return true
  // Bare `user/repo` GitHub shorthand — exactly one slash, no leading '@',
  // no leading dot/tilde/scheme already ruled out above.
  if (!spec.startsWith('@') && /^[^@/\s]+\/[^@/\s]+(#.*)?$/.test(spec)) return true
  return false
}

function nameRegexFor(ecosystem: Ecosystem): RegExp {
  switch (ecosystem) {
    case 'npm': return /^@?[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/i
    case 'crates': return /^[a-z0-9][a-z0-9_-]*$/i
    // Go import paths are multi-segment (`github.com/user/repo/subpkg`),
    // unlike npm's at-most-one-slash scoped form — each segment may contain
    // letters, digits, `.`/`_`/`~`/`-`.
    case 'go': return /^[A-Za-z0-9](?:[A-Za-z0-9._~-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._~-]*[A-Za-z0-9])?)*$/
    case 'pypi': return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i
  }
}

/** npm/poetry/cargo/go spec grammar: `@`-splits name from version (npm's original logic, now ecosystem-parameterized for its name-validity regex only — the splitting logic itself is unchanged and shared by every manager EXCEPT pip-family, which uses `parsePipSpec` instead). */
function parseSpec(spec: string, ecosystem: Ecosystem): { name: string; requestedVersion?: string } | null {
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
  if (!nameRegexFor(ecosystem).test(name)) return null
  return { name, requestedVersion: version || undefined }
}

/**
 * pip-family spec parsing (pip/pip3/uv add/uv pip install) — finding 3f.
 * Deliberately does NOT reuse `parseSpec`'s `@`-splitting: pip's `@` means
 * a PEP 508 URL reference (`pkg @ https://...`), a completely different
 * thing from a version pin, and is handled one level up in
 * `extractSegmentInstalls` (as three separate shell tokens — this function
 * only ever sees a single token already known not to be part of a
 * `name @ url` triple).
 *
 * Strips a trailing `[extras]` bracket before name validation, then splits
 * any remaining PEP 440 comparison operator (`===`/`~=`/`==`/`!=`/`<=`/
 * `>=`/`<`/`>`) off as the version. A trailing suffix that is neither an
 * extras bracket nor a recognized operator is conservatively treated as
 * unparseable (`null`) rather than guessed at — matching `parseSpec`'s own
 * existing "unparseable -> skipped, never a false deny" behavior.
 */
function parsePipSpec(tok: string): { name: string; requestedVersion?: string } | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?(.*)$/.exec(tok)
  if (!m) return null
  const name = m[1]
  const rest = (m[3] || '').trim()
  let version: string | undefined
  if (rest) {
    const vm = /^(===|~=|==|!=|<=|>=|<|>)\s*(.+)$/.exec(rest)
    if (!vm) return null
    version = vm[0]
  }
  if (!nameRegexFor('pypi').test(name)) return null
  return { name, requestedVersion: version || undefined }
}

function extractSegmentInstalls(segment: string): PackageSpec[] {
  const tokens = tokenize(segment)
  let i = 0
  let inlineEnv: Record<string, string> | undefined
  // Skip leading `sudo` and inline env assignments (`FOO=bar npm install x`)
  // — the skip itself is UNCHANGED; this only additionally captures the
  // handful of ambient-config-relevant var NAMES along the way (see
  // WATCHED_INLINE_ENV_VARS) before the token is discarded, since this loop
  // has no other way to hand a match back to the caller.
  while (i < tokens.length && (tokens[i] === 'sudo' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) {
    const eq = tokens[i].indexOf('=')
    if (eq > 0) {
      const varName = tokens[i].slice(0, eq)
      if (WATCHED_INLINE_ENV_VARS.has(varName)) {
        inlineEnv ??= {}
        inlineEnv[varName] = tokens[i].slice(eq + 1)
      }
    }
    i++
  }
  if (i >= tokens.length) return []
  const manager = managerFromToken(tokens[i])
  if (!manager) return []
  i++
  if (i >= tokens.length) return []
  const consumed = matchAddSubcommand(manager, tokens, i)
  if (consumed === null) return []
  i += consumed

  const ecosystem = MANAGER_ECOSYSTEM[manager]
  const grammar = PIP_GRAMMAR_MANAGERS.has(manager) ? 'pip' : 'default'
  const flagValues = FLAG_VALUE_CONSUMING[manager]

  // pip's private-index case (3b) is a property of the WHOLE command, not
  // any one token's position relative to a package name — `pip install
  // mypkg --index-url https://...` and `pip install --index-url
  // https://... mypkg` must both be caught regardless of flag order.
  const privateIndex = grammar === 'pip' && tokens.slice(i).some(isPipIndexFlag)

  // explicitRegistryOverride: the VALUE of an explicit registry/index flag,
  // for the dependency-confusion check in ambient-registry-config.ts. Pip
  // uses its PRIMARY index flag only (never --extra-index-url — see
  // isPipPrimaryIndexFlag's own note); npm-family only the `=`-joined
  // `--registry=` form (matching npm's existing byte-identical flag-skip
  // behavior — no next-token consumption); cargo's `--registry <name>`
  // reuses its existing FLAG_VALUE_CONSUMING entry's next-token/`=`-joined
  // shape.
  let explicitRegistryOverride: string | undefined
  if (grammar === 'pip') {
    explicitRegistryOverride = findFlagValue(tokens, i, isPipPrimaryIndexFlag)
  } else if (manager === 'npm' || manager === 'pnpm' || manager === 'yarn' || manager === 'bun') {
    explicitRegistryOverride = findEqJoinedFlagValue(tokens, i, '--registry')
  } else if (manager === 'cargo') {
    explicitRegistryOverride = findFlagValue(tokens, i, tok => tok.split('=')[0] === '--registry')
  }

  const specs: PackageSpec[] = []
  for (; i < tokens.length; i++) {
    const tok = tokens[i]
    if (!tok) continue
    if (tok.startsWith('-')) {
      // This flag's value is the NEXT token, not a package name — consume
      // both (finding 3a). Managers with no table here (npm-family) keep
      // the exact original "skip just this one token" behavior.
      if (flagValues?.has(tok)) i++
      continue
    }
    if (grammar === 'pip') {
      // PEP 508 URL reference: `name @ url` is three separate shell
      // tokens (unlike npm/cargo/go/poetry, where `pkg@1.2.3` is ONE
      // token) — finding 3f. Skip all three; this is a URL dependency,
      // not a registry-verifiable name.
      if (tokens[i + 1] === '@') { i += 2; continue }
      if (isNonRegistrySpec(tok)) continue
      const parsed = parsePipSpec(tok)
      if (parsed) specs.push({
        ...parsed, manager, raw: tok,
        ...(privateIndex ? { privateIndex: true } : {}),
        ...(explicitRegistryOverride !== undefined ? { explicitRegistryOverride } : {}),
        ...(inlineEnv ? { inlineEnv } : {}),
      })
      continue
    }
    if (isNonRegistrySpec(tok)) continue
    const parsed = parseSpec(tok, ecosystem)
    if (parsed) specs.push({
      ...parsed, manager, raw: tok,
      ...(explicitRegistryOverride !== undefined ? { explicitRegistryOverride } : {}),
      ...(inlineEnv ? { inlineEnv } : {}),
    })
  }
  return specs
}

/**
 * Extract candidate registry package installs from a shell command string.
 *
 * Covers `npm install|i`, `pnpm add`, `yarn add`, `bun add` (npm registry);
 * `pip install`, `pip3 install`, `uv add`, `uv pip install` (PyPI);
 * `poetry add` (PyPI); `cargo add` (crates.io); `go get`, `go install` (Go
 * module proxy). Versioned (`pkg@1.2.3` / pip's PEP 440 operators) and
 * scoped (`@scope/pkg`) names; compound commands (`cd x && npm install y`)
 * via `&&`/`||`/`;`/`|` splitting. Ignores flags (including a manager-
 * specific table of flags whose VALUE is a separate token — see
 * `FLAG_VALUE_CONSUMING`), local paths (`./`, `../`, `/`, `~`), `file:`,
 * `git+`/`git:`/`github:` refs, bare GitHub shorthand (`user/repo`),
 * tarball/non-package-file URLs or paths, workspace/link protocol
 * versions, PEP 508 URL references (pip's `name @ url`), and a bare
 * `npm install`/`npm ci`/`pnpm install`/`yarn`/`go install` with no
 * package args (reads from the lockfile/manifest/current module).
 *
 * Known false-negative (documented, not fixed): `bash -c "npm install x"`
 * — the tokenizer treats the quoted string as a single opaque token, so the
 * inner command is invisible to this pass. Out of scope for a regex-level
 * extractor; a real shell parse would be needed to unwrap it. This applies
 * equally to every ecosystem covered here, not just npm.
 *
 * Deliberately out of scope: `python -m pip install`, `cargo install`
 * (binary install — a different cargo subcommand than `add`).
 *
 * Ambient config files (`.npmrc`, `pip.conf`, `.cargo/config.toml`,
 * `GOPRIVATE`) that mark a name as private WITHOUT any command-line signal
 * are NOT handled by this pure/sync extraction pass — they require
 * filesystem reads, which this function deliberately never does (see this
 * function's own "cheap, sync, regex/tokenizer only" contract above). They
 * ARE handled, one layer up, by `applyAmbientConfig`
 * (ambient-registry-config.ts), a separate pass pipeline.ts runs over
 * exactly the specs this function returns — see that module's header for
 * the full rationale and the false-deny bug it closes.
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
export type UnverifiedReason =
  | 'timeout' | 'network_error' | 'scoped_not_public' | 'budget_exhausted' | 'too_large' | 'not_yet_checked'
  | 'private_index' | 'go_ambiguous' | 'ambient_private_registry'

export interface PackageCheckResult {
  name: string
  requestedVersion?: string
  verdict: PackageVerdict
  reason?: UnverifiedReason
  ageDays?: number
  createdAt?: string
  didYouMean?: string[]
  fromCache: boolean
  /** Threaded through from `PackageSpec.ambientSource` when `reason` is `ambient_private_registry`, or when `dependencyConfusionRisk` is set — free-text description of the ambient config signal, for the rule message. */
  ambientSource?: string
  /** Threaded through from `PackageSpec.dependencyConfusionRisk` — see that field's own doc and `decidePackageAction`. */
  dependencyConfusionRisk?: boolean
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

/** Same call-time-read + VITEST-closed-loopback safety net as `defaultRegistryBaseUrl`, for PyPI's JSON API. */
export function defaultPypiBaseUrl(): string {
  if (process.env.KEEL_PYPI_REGISTRY) return process.env.KEEL_PYPI_REGISTRY
  if (process.env.VITEST) return 'http://127.0.0.1:1'
  return 'https://pypi.org/pypi'
}

/** Same call-time-read + VITEST-closed-loopback safety net as `defaultRegistryBaseUrl`, for crates.io's API. */
export function defaultCratesBaseUrl(): string {
  if (process.env.KEEL_CRATES_REGISTRY) return process.env.KEEL_CRATES_REGISTRY
  if (process.env.VITEST) return 'http://127.0.0.1:1'
  return 'https://crates.io/api/v1/crates'
}

/** Same call-time-read + VITEST-closed-loopback safety net as `defaultRegistryBaseUrl`, for the Go module proxy. */
export function defaultGoProxyBaseUrl(): string {
  if (process.env.KEEL_GO_PROXY) return process.env.KEEL_GO_PROXY
  if (process.env.VITEST) return 'http://127.0.0.1:1'
  return 'https://proxy.golang.org'
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

/** Status-only fetch, no body parsing — used by the Go module proxy's `@v/list` endpoint, which returns plain text (not JSON) and whose body content this module never needs (existence is entirely a function of the HTTP status). Shares the same abort/timeout/error-classification shape as `fetchJsonCapped`. */
async function fetchStatusCapped(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status?: number; kind?: 'timeout' | 'network_error' | 'http_error' }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs))
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'keel-package-verifier/0.1' } })
    if (res.body && typeof (res.body as any).cancel === 'function') {
      try { await res.body.cancel() } catch { /* best-effort drain, never fatal */ }
    }
    if (!res.ok) return { ok: false, status: res.status, kind: 'http_error' }
    return { ok: true, status: res.status }
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

/** All four ecosystems' base URLs together, threaded through `checkPackages` and dispatched per-spec by `checkExistenceForEcosystem`. */
interface MultiLookupOptions {
  registryBaseUrl: string
  pypiBaseUrl: string
  cratesBaseUrl: string
  goProxyBaseUrl: string
  fetchImpl: typeof fetch
  maxBytes: number
}

type ExistenceResult = { verdict: PackageVerdict; reason?: UnverifiedReason; ageDays?: number; createdAt?: string }

async function checkPackageExistence(
  name: string,
  opts: LookupOptions,
  timeoutMs: number,
): Promise<ExistenceResult> {
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

/**
 * PyPI JSON API existence + age check — finding 3d, the single most
 * important correctness point in this feature. `urls[0].upload_time` (the
 * LATEST release's upload time) is the easy-to-reach WRONG field: a
 * squatted package's second release would clear a 30-day age gate on that
 * field while the NAME itself is still exactly as fresh as its first
 * publish. The correct field is `min()` over `upload_time_iso_8601` (or
 * the older `upload_time`) across every file in every version in the
 * `releases` map — the direct PyPI analog of npm's own (correct)
 * `time.created` usage above, never `time.modified`.
 */
async function checkPyPiExistence(name: string, opts: LookupOptions, timeoutMs: number): Promise<ExistenceResult> {
  if (timeoutMs <= 0) return { verdict: 'unverified', reason: 'budget_exhausted' }
  const url = `${opts.registryBaseUrl}/${encodeURIComponent(name)}/json`
  const outcome = await fetchJsonCapped(url, timeoutMs, opts.fetchImpl, opts.maxBytes)

  if (outcome.ok) {
    const releases = (outcome.json as { releases?: Record<string, Array<{ upload_time_iso_8601?: string; upload_time?: string }>> } | undefined)?.releases
    let earliestMs: number | undefined
    if (releases) {
      for (const files of Object.values(releases)) {
        if (!Array.isArray(files)) continue
        for (const f of files) {
          const t = f?.upload_time_iso_8601 ?? f?.upload_time
          if (!t) continue
          const ms = Date.parse(t)
          if (Number.isNaN(ms)) continue
          if (earliestMs === undefined || ms < earliestMs) earliestMs = ms
        }
      }
    }
    if (earliestMs === undefined) return { verdict: 'exists' } // no usable date anywhere -> no age signal, never blocks
    return { verdict: 'exists', createdAt: new Date(earliestMs).toISOString(), ageDays: (Date.now() - earliestMs) / 86_400_000 }
  }
  // PyPI has no scoped-name convention like npm's `@scope/pkg` — an
  // unscoped 404 really does mean "not on the registry" here (the
  // private-index case is handled entirely upstream of this function, via
  // `PackageSpec.privateIndex`, and never reaches a network call at all).
  if (outcome.kind === 'http_error' && outcome.status === 404) return { verdict: 'not_found' }
  if (outcome.kind === 'timeout') return { verdict: 'unverified', reason: 'timeout' }
  if (outcome.kind === 'too_large') return { verdict: 'unverified', reason: 'too_large' }
  return { verdict: 'unverified', reason: 'network_error' }
}

/** crates.io existence + age check. `crate.created_at` is the crate's own first-publish date directly (no per-version scan needed like PyPI's — crates.io's API already exposes the first-publish date as a top-level field). */
async function checkCratesExistence(name: string, opts: LookupOptions, timeoutMs: number): Promise<ExistenceResult> {
  if (timeoutMs <= 0) return { verdict: 'unverified', reason: 'budget_exhausted' }
  const url = `${opts.registryBaseUrl}/${encodeURIComponent(name)}`
  const outcome = await fetchJsonCapped(url, timeoutMs, opts.fetchImpl, opts.maxBytes)

  if (outcome.ok) {
    const created = (outcome.json as { crate?: { created_at?: string } } | undefined)?.crate?.created_at
    if (!created) return { verdict: 'exists' }
    const ms = Date.parse(created)
    if (Number.isNaN(ms)) return { verdict: 'exists' }
    return { verdict: 'exists', createdAt: created, ageDays: (Date.now() - ms) / 86_400_000 }
  }
  if (outcome.kind === 'http_error' && outcome.status === 404) return { verdict: 'not_found' }
  if (outcome.kind === 'timeout') return { verdict: 'unverified', reason: 'timeout' }
  if (outcome.kind === 'too_large') return { verdict: 'unverified', reason: 'too_large' }
  return { verdict: 'unverified', reason: 'network_error' }
}

// Go module proxy path escaping (golang.org/x/mod/module.EscapePath):
// every uppercase letter becomes `!` + its lowercase form, since Go module
// paths ARE case-sensitive but the proxy's own storage layer commonly
// isn't. Slashes are structural and must NOT be percent-encoded (unlike
// this module's npm/PyPI/crates lookups, which encode the whole name — a
// Go module path is not a single path segment).
function escapeGoModulePath(p: string): string {
  return p.replace(/[A-Z]/g, c => '!' + c.toLowerCase())
}

/** Strip the LAST path segment only — "at most ONE segment shorter", never further (finding 3e explicitly rules out walking all the way to the domain root). Returns `null` when there is nothing left to strip. */
function shortenGoModulePath(name: string): string | null {
  const idx = name.lastIndexOf('/')
  if (idx <= 0) return null
  return name.slice(0, idx)
}

async function goProxyListLookup(name: string, opts: LookupOptions, timeoutMs: number): Promise<{ verdict: 'exists' | 'not_found' | 'unverified'; reason?: UnverifiedReason }> {
  if (timeoutMs <= 0) return { verdict: 'unverified', reason: 'budget_exhausted' }
  const url = `${opts.registryBaseUrl}/${escapeGoModulePath(name)}/@v/list`
  const outcome = await fetchStatusCapped(url, timeoutMs, opts.fetchImpl)
  if (outcome.ok) return { verdict: 'exists' }
  // 410 (Gone) shows up for modules the proxy has explicitly excluded/
  // withdrawn — same "not confirmed at this exact path" shape as a 404 for
  // our purposes, so it feeds the same one-segment-shorter retry.
  if (outcome.kind === 'http_error' && (outcome.status === 404 || outcome.status === 410)) return { verdict: 'not_found' }
  if (outcome.kind === 'timeout') return { verdict: 'unverified', reason: 'timeout' }
  return { verdict: 'unverified', reason: 'network_error' }
}

/**
 * Go module proxy existence check — finding 3e. Two load-bearing decisions:
 *
 *   1. A 404/410 at the LITERAL queried path is NOT deterministic
 *      nonexistence, unlike npm/PyPI/crates.io's unscoped-404 case. The Go
 *      proxy indexes MODULE roots (`@v/list` on a path with no `go.mod`
 *      404s even though the path is a perfectly real, importable
 *      SUBPACKAGE of a real module one or more segments up) — this is the
 *      ROUTINE case for any multi-package Go repo, not a hallucination
 *      signal. One retry at a single segment shorter (never further —
 *      "don't walk to the domain root") disambiguates the common case
 *      cheaply; whether that retry succeeds or also 404s, the LITERAL
 *      queried path itself was never confirmed to exist either way, so the
 *      verdict is `unverified`, NEVER `not_found`/deny, in both outcomes.
 *
 *   2. No age-gate signal is produced here — a deliberate, named scope
 *      decision, not an oversight. Getting Go's FIRST-publish date
 *      correctly (the `min()`-over-all-versions pattern this module uses
 *      for npm and PyPI) would require `@v/list` (already fetched here)
 *      PLUS `@v/<version>.info` for the EARLIEST of possibly many listed
 *      versions to read its `Time` field. The easy-to-reach `@latest`
 *      endpoint only gives the LATEST version's time — exactly the
 *      wrong-field bug finding 3d calls out for PyPI, and this function
 *      refuses to repeat it for Go rather than ship a plausible-looking
 *      but backwards age gate. Doing it correctly would also cost 2-3 more
 *      requests against the SAME shared ~2000ms command-wide budget that
 *      finding 3e separately warns must not be starved by one Go path.
 *      `exists` with no `ageDays` is treated exactly like every other
 *      "age unknown" case in this module (see npm's `!created` branch
 *      above): it never blocks. A same-day-squatted Go module therefore
 *      passes this rule today on the age axis specifically — a known,
 *      documented gap (see this module's test suite for an explicit
 *      assertion of this exact allow outcome), not a silent one.
 */
async function checkGoExistence(name: string, opts: LookupOptions, timeoutMs: number): Promise<ExistenceResult> {
  if (timeoutMs <= 0) return { verdict: 'unverified', reason: 'budget_exhausted' }
  const perAttempt = Math.max(1, Math.floor(timeoutMs / 2))
  const first = await goProxyListLookup(name, opts, perAttempt)
  if (first.verdict === 'exists') return { verdict: 'exists' }
  if (first.verdict === 'unverified') return { verdict: 'unverified', reason: first.reason }

  const shorter = shortenGoModulePath(name)
  if (!shorter) return { verdict: 'unverified', reason: 'go_ambiguous' }
  const second = await goProxyListLookup(shorter, opts, Math.max(1, timeoutMs - perAttempt))
  return { verdict: 'unverified', reason: second.reason ?? 'go_ambiguous' }
}

async function checkExistenceForEcosystem(
  ecosystem: Ecosystem,
  name: string,
  opts: MultiLookupOptions,
  timeoutMs: number,
): Promise<ExistenceResult> {
  const { fetchImpl, maxBytes } = opts
  switch (ecosystem) {
    case 'npm': return checkPackageExistence(name, { registryBaseUrl: opts.registryBaseUrl, fetchImpl, maxBytes }, timeoutMs)
    case 'pypi': return checkPyPiExistence(name, { registryBaseUrl: opts.pypiBaseUrl, fetchImpl, maxBytes }, timeoutMs)
    case 'crates': return checkCratesExistence(name, { registryBaseUrl: opts.cratesBaseUrl, fetchImpl, maxBytes }, timeoutMs)
    case 'go': return checkGoExistence(name, { registryBaseUrl: opts.goProxyBaseUrl, fetchImpl, maxBytes }, timeoutMs)
  }
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
  /**
   * Defaults to 'npm' when absent — keeps every pre-existing on-disk
   * cache file and every hand-built `CachedVerdict` test fixture that
   * predates multi-ecosystem support valid without modification.
   */
  ecosystem?: Ecosystem
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

  /**
   * Cache key is namespaced `${ecosystem}:${name}`, not bare name —
   * finding 3c. Four ecosystems now share one cache file; without this
   * namespacing, a PyPI 404 for "foo" would poison the cache and deny an
   * npm package also named "foo" for the cache's TTL, and
   * `npm install foo && cargo add foo` in one command would incorrectly
   * reuse one ecosystem's verdict for the other.
   */
  private key(name: string, ecosystem: Ecosystem): string {
    return `${ecosystem}:${name}`
  }

  get(name: string, now: number = Date.now(), ecosystem: Ecosystem = 'npm'): CachedVerdict | null {
    const entry = this.load()[this.key(name, ecosystem)]
    if (!entry) return null
    if (this.expired(entry, now)) return null
    return entry
  }

  set(entry: CachedVerdict, now: number = Date.now()): void {
    const all = this.load()
    all[this.key(entry.name, entry.ecosystem ?? 'npm')] = entry
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
  /** npm registry base URL. Defaults to `defaultRegistryBaseUrl()`. */
  registryBaseUrl?: string
  /** PyPI JSON API base URL. Defaults to `defaultPypiBaseUrl()`. */
  pypiBaseUrl?: string
  /** crates.io API base URL. Defaults to `defaultCratesBaseUrl()`. */
  cratesBaseUrl?: string
  /** Go module proxy base URL. Defaults to `defaultGoProxyBaseUrl()`. */
  goProxyBaseUrl?: string
  fetchImpl?: typeof fetch
  cache?: PackageVerifierCache
  maxBytes?: number
  now?: () => number
}

/**
 * Check every extracted spec against its ecosystem's registry, sharing ONE
 * total time budget across all of them (default 2000ms — the binding
 * total-lookup timeout). A cache hit costs nothing against the budget.
 * Once the budget is exhausted, remaining unchecked specs get verdict
 * 'unverified' / 'budget_exhausted' rather than being silently skipped —
 * silently skipping would let a hallucinated name after a slow real one
 * through unverified without saying so, whereas 'unverified' correctly
 * downgrades to prompt.
 */
/** Overlay `PackageSpec.dependencyConfusionRisk`/`ambientSource` onto a `PackageCheckResult`, conditionally so no `undefined`-valued keys ever appear (matches every other conditional-spread field in this module — keeps hand-built test fixtures and pre-existing exact-shape assertions unaffected when the flag isn't set). Shared by `checkPackages` and `checkPackagesCacheOnly` so both the network path and the cache-only hot path carry it identically. */
function withDependencyConfusion(result: PackageCheckResult, spec: PackageSpec): PackageCheckResult {
  return spec.dependencyConfusionRisk
    ? { ...result, dependencyConfusionRisk: true, ambientSource: spec.ambientSource }
    : result
}

export async function checkPackages(specs: PackageSpec[], opts: EvaluateInstallOptions = {}): Promise<PackageCheckResult[]> {
  const now = opts.now ?? Date.now
  const totalTimeoutMs = opts.totalTimeoutMs ?? 2000
  const registryBaseUrl = opts.registryBaseUrl ?? defaultRegistryBaseUrl()
  const pypiBaseUrl = opts.pypiBaseUrl ?? defaultPypiBaseUrl()
  const cratesBaseUrl = opts.cratesBaseUrl ?? defaultCratesBaseUrl()
  const goProxyBaseUrl = opts.goProxyBaseUrl ?? defaultGoProxyBaseUrl()
  const fetchImpl = opts.fetchImpl ?? fetch
  const cache = opts.cache ?? new PackageVerifierCache()
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const lookupOpts: MultiLookupOptions = { registryBaseUrl, pypiBaseUrl, cratesBaseUrl, goProxyBaseUrl, fetchImpl, maxBytes }

  const deadline = now() + totalTimeoutMs
  const seen = new Map<string, PackageCheckResult>()
  const results: PackageCheckResult[] = []

  for (const spec of specs) {
    const ecosystem = ecosystemForManager(spec.manager)
    const key = `${ecosystem}:${spec.name}`
    const already = seen.get(key)
    if (already) {
      results.push(withDependencyConfusion({ ...already, requestedVersion: spec.requestedVersion }, spec))
      continue
    }

    let result: PackageCheckResult
    if (spec.privateIndex) {
      // Never queried — see the module header's private-index rationale
      // (finding 3b): the URL a `--index-url` flag names comes from the
      // AGENT's command line, not the rule author, and fetching it would
      // reopen exactly the SSRF surface this module's header explains it
      // otherwise doesn't have to defend against. Ambient-config-sourced
      // private-index specs (see ambient-registry-config.ts) get the same
      // never-queried treatment, distinguished only by `reason` (so the
      // rule message can name the actual ambient signal that fired).
      result = {
        name: spec.name,
        requestedVersion: spec.requestedVersion,
        verdict: 'unverified',
        reason: spec.ambientSource ? 'ambient_private_registry' : 'private_index',
        fromCache: false,
        ...(spec.ambientSource ? { ambientSource: spec.ambientSource } : {}),
      }
    } else {
      const cached = cache.get(spec.name, now(), ecosystem)
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
        const existence = await checkExistenceForEcosystem(ecosystem, spec.name, lookupOpts, remaining)
        let didYouMean: string[] | undefined
        // Did-you-mean search only exists against npm's `-/v1/search`
        // endpoint — PyPI/crates.io/the Go proxy have no equivalent this
        // module calls, and guessing one would spend a second request out
        // of the shared per-command budget for no benefit (the same
        // budget-starvation concern finding 3e raises about Go applies
        // here too).
        if (existence.verdict === 'not_found' && ecosystem === 'npm') {
          didYouMean = await searchDidYouMean(spec.name, { registryBaseUrl, fetchImpl, maxBytes }, deadline - now())
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
          ecosystem,
          verdict: result.verdict,
          reason: result.reason,
          ageDays: result.ageDays,
          createdAt: result.createdAt,
          didYouMean: result.didYouMean,
          checkedAt: now(),
        }, now())
      }
    }
    result = withDependencyConfusion(result, spec)
    seen.set(key, result)
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
 * A `privateIndex` spec (finding 3b) never becomes a cache miss at all —
 * it resolves to `unverified`/`private_index` directly, on every call,
 * with zero I/O either way, and is never queued into `misses`: caching it
 * under `pypi:<name>` would mean a LATER plain `pip install <same name>`
 * (no `--index-url` this time) reads back the private-index verdict for
 * the rest of the TTL — a fresh instance of the exact cross-context-bleed
 * bug finding 3c fixes for cross-ecosystem collisions.
 *
 * `misses` carries the deduplicated specs (by ecosystem+name) that need a
 * real registry lookup, in first-seen order — pass them to
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
    const ecosystem = ecosystemForManager(spec.manager)
    if (spec.privateIndex) {
      results.push(withDependencyConfusion({
        name: spec.name,
        requestedVersion: spec.requestedVersion,
        verdict: 'unverified',
        reason: spec.ambientSource ? 'ambient_private_registry' : 'private_index',
        fromCache: false,
        ...(spec.ambientSource ? { ambientSource: spec.ambientSource } : {}),
      }, spec))
      continue
    }
    const cached = cache.get(spec.name, t, ecosystem)
    if (cached) {
      results.push(withDependencyConfusion({
        name: spec.name,
        requestedVersion: spec.requestedVersion,
        verdict: cached.verdict,
        reason: cached.reason,
        ageDays: cached.ageDays,
        createdAt: cached.createdAt,
        didYouMean: cached.didYouMean,
        fromCache: true,
      }, spec))
    } else {
      results.push(withDependencyConfusion({
        name: spec.name,
        requestedVersion: spec.requestedVersion,
        verdict: 'unverified',
        reason: 'not_yet_checked',
        fromCache: false,
      }, spec))
      const missKey = `${ecosystem}:${spec.name}`
      if (!missSeen.has(missKey)) {
        missSeen.add(missKey)
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

export type PackageDecisionReason = 'not_found' | 'unverified' | 'age_gate' | 'dependency_confusion' | 'ok'

export interface PackageRuleDecision {
  reason: PackageDecisionReason
  message: string
  result?: PackageCheckResult
}

function buildNotFoundMessage(r: PackageCheckResult): string {
  const suggestion = r.didYouMean?.length ? ` Did you mean: ${r.didYouMean.join(', ')}?` : ''
  return `Package "${r.name}" does not exist on its package registry — this install is unfulfillable regardless of intent.${suggestion}`
}

function buildUnverifiedMessage(r: PackageCheckResult): string {
  if (r.reason === 'scoped_not_public') {
    return `unverified — "${r.name}" returned 404 from the public npm registry. Scoped names 404 publicly for private/org registry packages too, so this is not proof it doesn't exist — treating as unverified, not denying.`
  }
  if (r.reason === 'private_index') {
    return `unverified — "${r.name}" targets a non-default package index (--index-url, --extra-index-url, or -i). PyPI has no scoped-name convention like npm to signal "private" by name alone, and keel does not query agent-supplied index URLs (that would reopen the SSRF surface this module's own registry lookups are otherwise exempt from) — approve only if you recognize and trust this index.`
  }
  if (r.reason === 'ambient_private_registry') {
    return `unverified — "${r.name}" resolves to a private/internal registry per your ambient package-manager config (${r.ambientSource ?? 'local .npmrc/pip.conf/.cargo/config.toml/GOPRIVATE'}), not the public registry. keel does not query ambient-configured private registries (same SSRF-avoidance rationale as an explicit --index-url) — approve only if you recognize and trust this registry.`
  }
  if (r.reason === 'go_ambiguous') {
    return `unverified — "${r.name}" 404'd at its literal import path on the Go module proxy. This is the routine, expected result for a subpackage of a larger module, not proof of nonexistence — the Go proxy indexes MODULE roots, not every importable subpackage path. Approve if this looks like a plausible subpackage of a real module.`
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

function buildDependencyConfusionMessage(r: PackageCheckResult): string {
  return `dependency-confusion risk — "${r.name}" normally resolves via your ambient private-registry config (${r.ambientSource ?? 'ambient package-manager config'}), but this command explicitly forces the PUBLIC registry instead. If an attacker has squatted this name on the public registry, forcing the public registry here installs THEIR package, not your internal one. Verify this override is intentional before proceeding.`
}

/**
 * Pure decision function — no I/O, easy to test independently of the
 * network layer. Priority order across a multi-package command mirrors
 * severity: a not_found ANYWHERE denies the whole command (deterministic,
 * highest confidence); otherwise an unverified anywhere prompts; otherwise
 * an age-gated package prompts; otherwise a dependency-confusion-risked
 * package warns; otherwise allow.
 *
 * dependency_confusion is deliberately LAST, below not_found/unverified/
 * age_gate, not first — it is a `warn`, strictly weaker than `deny` or
 * `prompt`. Checking it first would let `npm i <hallucinated-name>
 * --registry=https://registry.npmjs.org` in a repo with an ambient private
 * `.npmrc` DOWNGRADE a deterministic not_found deny to a warn — an explicit
 * public-registry flag would become a deny-ESCAPE for exactly the
 * hallucinated-name attack this rule exists to stop. Checked last, it only
 * ever fires when every result has already cleared not_found/unverified/
 * age_gate (i.e. every package genuinely exists and is old enough) — the
 * actual squatted-name shape: a real, aged, PUBLIC package sitting under a
 * name your ambient config normally routes internally.
 */
export function decidePackageAction(results: PackageCheckResult[], ageThresholdDays: number): PackageRuleDecision {
  const notFound = results.find(r => r.verdict === 'not_found')
  if (notFound) return { reason: 'not_found', message: buildNotFoundMessage(notFound), result: notFound }

  const unverified = results.find(r => r.verdict === 'unverified')
  if (unverified) return { reason: 'unverified', message: buildUnverifiedMessage(unverified), result: unverified }

  const young = results.find(r => r.verdict === 'exists' && r.ageDays !== undefined && r.ageDays < ageThresholdDays)
  if (young) return { reason: 'age_gate', message: buildAgeGateMessage(young, ageThresholdDays), result: young }

  const confusion = results.find(r => r.dependencyConfusionRisk)
  if (confusion) return { reason: 'dependency_confusion', message: buildDependencyConfusionMessage(confusion), result: confusion }

  return { reason: 'ok', message: 'All installed packages verified against their package registries.' }
}

/** Convenience: extract + check + decide in one call. Primarily for tests/CLI use; the pipeline calls the three steps separately to keep the cheap extraction gate visible. `cwd` defaults to `process.cwd()` for `applyAmbientConfig`'s project-tier `.npmrc`/`.cargo/config.toml` lookup — see ambient-registry-config.ts. */
export async function evaluateInstallCommand(command: string, opts: EvaluateInstallOptions & { ageThresholdDays?: number; cwd?: string } = {}): Promise<PackageRuleDecision> {
  const rawSpecs = extractPackageInstalls(command)
  if (!rawSpecs.length) return { reason: 'ok', message: 'No package installs in this command.' }
  const specs = applyAmbientConfig(rawSpecs, opts.cwd ?? process.cwd())
  const results = await checkPackages(specs, opts)
  return decidePackageAction(results, opts.ageThresholdDays ?? 30)
}
