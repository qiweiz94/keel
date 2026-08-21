/**
 * Popular-package typosquat proximity check.
 *
 * WHY THIS EXISTS: `known-hallucinated-packages.ts` catches an EXACT match
 * against a documented list of names LLMs are known to invent.
 * `package-verifier.ts`'s existence check catches a name that doesn't
 * resolve at all. Neither catches the classic manual-typosquatting shape
 * Socket.dev's broader research documents: an attacker registers a name
 * ONE OR TWO CHARACTER EDITS away from a genuinely popular package
 * (`paysafe-checkout` next to `paysafe`, `reqeusts` next to `requests`,
 * `colorama-cli` next to `colorama`) and waits for either a human fat-finger
 * or an LLM's imperfect recall of the exact spelling to install it instead
 * of the real thing. That name EXISTS (it's registered) and is NOT on any
 * hallucination list (a human or model didn't invent it from nothing — it's
 * a deliberate near-miss of something real), so neither existing signal in
 * this codebase sees it. This module is that third, independent signal: a
 * static, offline comparison of the requested name's EDIT DISTANCE against
 * a shipped list of genuinely popular, well-known package names.
 *
 * DATA SOURCING — deliberately NOT the same caveat as
 * known-hallucinated-packages.ts: that file's data (which SPECIFIC names
 * LLMs hallucinate) is a narrow empirical research finding that cannot be
 * known without access to that specific study, so it shipped honest
 * placeholders rather than fabricate one. Which packages are, in reality,
 * extremely popular, long-established, widely-depended-on libraries in each
 * ecosystem (react, lodash, express, requests, numpy, serde, tokio, ...) is
 * a much more stable, much more general fact — not a number that needs a
 * live download-ranking API to state honestly. Every name below is a real,
 * unambiguous, long-standing package the author is confident is genuinely
 * popular; none are placeholders. The list is intentionally modest (not an
 * attempt at an exhaustive top-N-by-downloads snapshot, which WOULD require
 * live ranking data and go stale immediately) — it exists to catch
 * near-misses of the names an attacker is most likely to target precisely
 * BECAUSE they are famous, not to be a complete popularity index.
 *
 * REFRESH PROCEDURE: this data is far lower-maintenance than the
 * hallucination registry — genuinely popular foundational packages (react,
 * requests, serde, ...) remain popular for years, so there is no scheduled
 * refresh requirement. Periodically (e.g. during a major version bump of
 * this package) it's worth: (1) confirming no shipped name has been
 * deprecated/renamed/transferred to a new maintainer in a way that changes
 * the trust calculus, (2) adding newer widely-adopted packages that have
 * since become genuinely popular, (3) NEVER adding a name without being
 * independently confident it's real and popular — a fabricated "popular
 * package" here would make this module warn on installs of the REAL thing
 * it invented a lookalike for, which is worse than shipping a short list.
 *
 * EXEMPTIONS (false-positive control — similarity-based matching has real
 * false-positive risk, unlike known-hallucinated-packages.ts's exact-match
 * design):
 *   1. Exact match (case-insensitive) to a shipped popular name is never
 *      flagged — installing "react" is not a typosquat of "react".
 *   2. npm scoped names (`@scope/pkg`) are EXEMPT from this check entirely.
 *      A scope is a distinct, separately-owned namespace — `@myorg/lodash`
 *      or `@sindresorhus/is` naming something similar to (or containing)
 *      a popular unscoped name on purpose is the ORDINARY shape of a
 *      legitimate org-scoped utility or wrapper package, not a squat.
 *      Comparing a scoped local name's spelling against the unscoped
 *      popular list would false-positive constantly on exactly this
 *      legitimate pattern. This also mirrors an existing precedent in
 *      package-verifier.ts: scoped names already get more lenient
 *      treatment elsewhere in this codebase (a 404 for a scoped name is
 *      `unverified`, never `not_found`) for the analogous reason that
 *      scope changes what a name-shape signal can prove.
 *   3. `TYPOSQUAT_EXEMPT_NAMES` — a small, ecosystem-scoped allowlist for
 *      specific UNSCOPED names that happen to sit within the edit-distance
 *      threshold of a shipped popular name but are independently verified,
 *      real, legitimate, unrelated-or-intentionally-similar packages (a
 *      long-standing fork under its own name, a well-known alternate
 *      spelling, etc). Ships EMPTY: the author is not aware of a real,
 *      currently-registered, unscoped package that both (a) lands within
 *      edit-distance 2 of one of the names shipped below and (b) is a
 *      verified-legitimate near-duplicate — and, per this file's own
 *      no-fabrication discipline above, would rather ship an empty-but-real
 *      allowlist than invent an example entry. Add an entry here only once
 *      a human has verified both conditions for that specific name; the
 *      mechanism itself is exercised directly by this file's own tests via
 *      `findTyposquatMatch`'s `exemptNames` override, independent of
 *      whether the shipped list has any entries.
 */

export type PopularPackageEcosystem = 'npm' | 'pypi' | 'crates' | 'go'

/**
 * A modest, high-confidence set of genuinely popular, long-established
 * package names per ecosystem — see this file's header for sourcing/
 * refresh rationale. Go entries are full module paths (the unit an
 * attacker would actually typosquat, e.g. `github.com/gin-gonic/gin`),
 * matching how `package-verifier.ts` treats Go names throughout.
 */
export const POPULAR_PACKAGES: Record<PopularPackageEcosystem, readonly string[]> = {
  npm: [
    'react', 'react-dom', 'vue', 'angular', 'lodash', 'underscore',
    'express', 'koa', 'axios', 'node-fetch', 'chalk', 'commander',
    'yargs', 'inquirer', 'typescript', 'eslint', 'prettier', 'webpack',
    'vite', 'rollup', 'jest', 'mocha', 'chai', 'moment', 'dayjs',
    'uuid', 'dotenv', 'nodemon', 'socket.io', 'redux', 'next', 'jquery',
    'bootstrap', 'classnames', 'debug', 'semver', 'glob', 'rimraf',
    'mkdirp', 'request',
  ],
  pypi: [
    'requests', 'numpy', 'pandas', 'flask', 'django', 'pytest', 'scipy',
    'matplotlib', 'boto3', 'sqlalchemy', 'click', 'pyyaml', 'jinja2',
    'urllib3', 'certifi', 'six', 'setuptools', 'wheel', 'pip',
    'virtualenv', 'tox', 'black', 'flake8', 'mypy', 'celery', 'gunicorn',
    'fastapi', 'uvicorn', 'pydantic', 'cryptography',
  ],
  crates: [
    'serde', 'tokio', 'clap', 'rand', 'regex', 'reqwest', 'anyhow',
    'thiserror', 'log', 'env_logger', 'futures', 'syn', 'quote',
    'proc-macro2', 'chrono',
  ],
  go: [
    'github.com/gin-gonic/gin', 'github.com/spf13/cobra',
    'github.com/spf13/viper', 'github.com/stretchr/testify',
    'github.com/pkg/errors', 'github.com/sirupsen/logrus',
    'github.com/gorilla/mux', 'github.com/golang/protobuf',
    'google.golang.org/grpc', 'github.com/aws/aws-sdk-go',
  ],
}

/**
 * Ecosystem-scoped exemption allowlist — see this file's header, exemption
 * (3). Ships empty per-ecosystem (no fabricated entries); the mechanism is
 * still fully exercised by this file's own test suite via
 * `findTyposquatMatch`'s optional `exemptNames` override.
 */
export const TYPOSQUAT_EXEMPT_NAMES: Record<PopularPackageEcosystem, ReadonlySet<string>> = {
  npm: new Set(),
  pypi: new Set(),
  crates: new Set(),
  go: new Set(),
}

/**
 * Standard iterative (two-row) Levenshtein edit distance — insertions,
 * deletions, substitutions, each cost 1. O(n*m) time, O(min(n,m)) space.
 * No external dependency: this is a small, well-known algorithm, not
 * worth a package for a handful of lines.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  // Keep the shorter string as `b` so the working row is as small as
  // possible — purely a space optimization, doesn't change the result.
  if (a.length < b.length) { const t = a; a = b; b = t }

  let prevRow = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prevRow[j] = j

  for (let i = 1; i <= a.length; i++) {
    const currRow = new Array(b.length + 1)
    currRow[0] = i
    const aChar = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1
      currRow[j] = Math.min(
        prevRow[j] + 1,      // deletion
        currRow[j - 1] + 1,  // insertion
        prevRow[j - 1] + cost, // substitution
      )
    }
    prevRow = currRow
  }
  return prevRow[b.length]
}

/**
 * Below this length, a name is exempt from the typosquat check entirely —
 * finding from the task brief's own guidance: an edit distance of 2 on a
 * 3-character name means MOST of the name changed (e.g. "abc" -> "xyz" is
 * only distance 3, and half the letters of a 3-char name is already
 * distance ~1.5), so a fixed distance-2 threshold is far too loose to mean
 * anything at that length — it would false-positive against huge swaths of
 * unrelated short names. A flat absolute threshold does NOT need to loosen
 * for LONGER names to compensate: as name length grows, an edit distance of
 * 2 represents a proportionally SMALLER change, which makes it a STRONGER
 * (not weaker) typosquat signal, not one that needs scaling down. So the
 * one length-aware guard this module needs is a MINIMUM length floor, not
 * a scaling formula for both directions.
 */
const MIN_NAME_LENGTH_FOR_CHECK = 4

/** Flat absolute threshold — see `MIN_NAME_LENGTH_FOR_CHECK`'s doc for why this doesn't need to scale with length once the minimum-length floor is in place. Matches the task brief's starting point. */
const MAX_EDIT_DISTANCE = 2

function normalize(name: string): string {
  return name.toLowerCase()
}

/** True for npm's `@scope/pkg` shape — see this file's header, exemption (2). Ecosystem-agnostic by name, but only ever meaningful for npm (the only ecosystem with this syntax); harmless no-op check for the other three. */
function isScopedName(name: string): boolean {
  return name.startsWith('@') && name.includes('/')
}

export interface TyposquatMatch {
  /** The popular name this install candidate landed close to. */
  popularName: string
  /** Edit distance between the (normalized) candidate name and `popularName`. Always in `[1, MAX_EDIT_DISTANCE]` — 0 (exact match) is never returned, see this file's header, exemption (1). */
  distance: number
}

/**
 * The core proximity check. Pure, synchronous, zero I/O — safe to run on
 * every extracted install candidate regardless of its registry verdict.
 *
 * Returns the CLOSEST popular-name match within threshold, or `undefined`
 * if `name` is exempt (scoped, allowlisted, too short) or not within
 * `MAX_EDIT_DISTANCE` of anything in `POPULAR_PACKAGES[ecosystem]`.
 *
 * `opts.exemptNames` overrides the shipped `TYPOSQUAT_EXEMPT_NAMES` for
 * that ecosystem — used by this module's own tests to exercise the
 * allowlist mechanism without needing a fabricated production entry (see
 * this file's header). `opts.popularNames` similarly overrides
 * `POPULAR_PACKAGES` for that ecosystem, letting tests probe the distance/
 * threshold logic against small, deterministic fixtures instead of the
 * full shipped list.
 */
export function findTyposquatMatch(
  name: string,
  ecosystem: PopularPackageEcosystem,
  opts: { exemptNames?: ReadonlySet<string>; popularNames?: readonly string[] } = {},
): TyposquatMatch | undefined {
  if (!name) return undefined
  if (ecosystem === 'npm' && isScopedName(name)) return undefined

  const exempt = opts.exemptNames ?? TYPOSQUAT_EXEMPT_NAMES[ecosystem]
  const target = normalize(name)
  if (exempt.has(target)) return undefined

  if (name.length < MIN_NAME_LENGTH_FOR_CHECK) return undefined

  const popularList = opts.popularNames ?? POPULAR_PACKAGES[ecosystem]
  let best: TyposquatMatch | undefined
  for (const popular of popularList) {
    const p = normalize(popular)
    if (p === target) return undefined // exact match -> legitimately IS the popular package, not a squat of it
    const d = levenshtein(target, p)
    if (d >= 1 && d <= MAX_EDIT_DISTANCE && (!best || d < best.distance)) {
      best = { popularName: popular, distance: d }
    }
  }
  return best
}
