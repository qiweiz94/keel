/**
 * Known LLM-package-hallucination registry ("slopsquatting" deny signal).
 *
 * WHY THIS EXISTS: `package-verifier.ts`'s existence check answers "does
 * this name resolve on the registry right now?" — it cannot answer "is
 * this name one that LLMs are KNOWN to repeatedly invent?", which matters
 * even for a name that DOES currently exist. Slopsquatting works by an
 * attacker pre-registering a name several frontier models are documented
 * to hallucinate, then waiting for an agent to hallucinate the same name
 * and get told to install it — at that point the name resolves (verdict
 * `exists`), so a pure existence check waves it through. This registry is
 * a static, offline, zero-network lookup of documented hallucination
 * names, cross-checked against every install regardless of the existence
 * verdict, specifically to catch that exists-but-squatted case.
 *
 * SOURCE (binding — do not silently swap without updating this note):
 * Socket.dev slopsquatting research (2026). Methodology: regex-extracted
 * candidate package names from the coding outputs of 5 frontier LLMs
 * (Claude Haiku 4.5, Claude Sonnet 4.6, GPT-5.4-mini, Gemini 2.5 Pro,
 * DeepSeek V3.2), cross-checked against the live PyPI and npm registries
 * for non-existence at sample time, then manually reviewed to discard
 * false positives (real-but-obscure names, near-miss typos of a real
 * package rather than a genuinely invented one, etc). Reported result:
 * 53 REGISTRABLE hallucinated names total — 41 on PyPI, 12 on npm.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THIS FILE SHIPS WITH PLACEHOLDER DATA — NOT THE REAL 53 NAMES.
 * ═══════════════════════════════════════════════════════════════════════
 * The agent that built this mechanism (2026-08-21, branch
 * feat-hallucination-registry) had no live internet access in its
 * worktree and could not retrieve the Socket.dev publication to copy the
 * exact 53 names verbatim. Rather than guess at real-sounding package
 * names — which would risk shipping FABRICATED entries that look like
 * real research but aren't, actively misleading anyone who trusts this
 * file — every entry below is a structurally-valid but obviously-fake
 * `keel-placeholder-hallucination-*` / `keel_placeholder_hallucination_*`
 * stand-in. They exercise the lookup/normalization/decision mechanism
 * correctly (right shape, right ecosystem, right count: 12 npm + 41
 * PyPI = 53) but MUST NOT be treated as real hallucination data, and this
 * registry MUST NOT be relied on as a live production deny signal until
 * a human replaces them with the real names from the source research.
 *
 * TODO(human, before production use): replace every PLACEHOLDER entry
 * below with the real name from the Socket.dev source, keeping the
 * `ecosystem` field accurate per-entry. Delete the `note` field once a
 * real entry no longer needs the placeholder caveat. Bump
 * `HALLUCINATED_PACKAGE_REGISTRY_VERSION` and
 * `HALLUCINATED_PACKAGE_REGISTRY_LAST_UPDATED` when you do.
 *
 * REFRESH PROCEDURE (manual — no automated re-sampling lives in this
 * repo; keeping this current requires paid frontier-model API calls to
 * re-run the sampling methodology, which is out of scope for CI/agents
 * here):
 *   1. Obtain the current published hallucination list — either re-run
 *      the Socket.dev-style methodology (sample N frontier models on a
 *      broad set of coding prompts, regex-extract candidate package
 *      names, cross-check each against the live PyPI/npm registries for
 *      non-existence, manually review for false positives) or pull an
 *      updated published list from Socket.dev or an equivalent study.
 *   2. For each name: DO NOT drop it just because it now resolves on the
 *      registry — a name that was hallucinated-and-nonexistent at sample
 *      time but exists NOW is the single most dangerous entry in this
 *      file (it means someone squatted it), not a stale one. Keep it.
 *   3. Update the `KNOWN_HALLUCINATED_PACKAGES` array below: replace or
 *      append entries, each with an accurate `ecosystem` and an optional
 *      `note` (e.g. which model(s) produced it, if the source breaks
 *      that down).
 *   4. Bump `HALLUCINATED_PACKAGE_REGISTRY_VERSION` (a plain incrementing
 *      string, e.g. "1", "2", ...) and set
 *      `HALLUCINATED_PACKAGE_REGISTRY_LAST_UPDATED` to today's date
 *      (YYYY-MM-DD).
 *   5. Update `HALLUCINATED_PACKAGE_REGISTRY_SOURCE` if the source
 *      publication itself changed (new study, new URL, new date).
 *   6. Run the existing test suite
 *      (`packages/core/src/enforce/__tests__/package-verifier.test.ts`) —
 *      it is written against the mechanism, not the specific placeholder
 *      names, so it should pass unmodified against real data. Add a
 *      regression test for any real name if it has an unusual shape
 *      (e.g. underscores/dots/case) not already exercised.
 *
 * NORMALIZATION: npm package names are matched case-insensitively (npm
 * itself requires lowercase, but a defensively-lowercased comparison
 * costs nothing and avoids a false negative on a mixed-case typo). PyPI
 * names are matched per PEP 503 (case-insensitive, with runs of
 * `-`/`_`/`.` treated as equivalent) — `Foo__Bar` and `foo-bar` must
 * match the same registry entry, exactly like PyPI's own package-name
 * resolution.
 */

export type HallucinationEcosystem = 'npm' | 'pypi'

export interface HallucinatedPackageEntry {
  /** The hallucinated name, in its canonical (as-published) form. Matching is normalized — see `lookupKnownHallucination`. */
  name: string
  ecosystem: HallucinationEcosystem
  /** Free-text provenance note (e.g. which model(s) hallucinated it). Optional — the source research does not always break this down per-name. */
  note?: string
}

/** Plain incrementing version string for this data snapshot — bump on every refresh (see REFRESH PROCEDURE above). */
export const HALLUCINATED_PACKAGE_REGISTRY_VERSION = '0-placeholder'

/** YYYY-MM-DD of the last time this file's data was updated (not when the code around it changed). */
export const HALLUCINATED_PACKAGE_REGISTRY_LAST_UPDATED = '2026-08-21'

/** Human-readable source citation, threaded through to `PackageCheckResult.knownHallucination.source` and from there into the rule message text a user sees. */
export const HALLUCINATED_PACKAGE_REGISTRY_SOURCE =
  'Socket.dev slopsquatting research (2026): 53 registrable LLM-hallucinated package names ' +
  '(41 PyPI, 12 npm) across 5 frontier models — PLACEHOLDER DATA in this build, see file header'

const PLACEHOLDER_NOTE =
  'PLACEHOLDER — not a real hallucinated name. Replace with the actual name from the Socket.dev ' +
  '(2026) source before relying on this registry as a production deny signal. See this file’s header.'

/**
 * 53 entries total (41 PyPI + 12 npm), matching the source research's
 * reported counts — see this file's header for why every entry below is
 * a placeholder rather than real data.
 */
export const KNOWN_HALLUCINATED_PACKAGES: HallucinatedPackageEntry[] = [
  // ── npm (12 expected) ──────────────────────────────────────────────
  { name: 'keel-placeholder-hallucination-npm-01', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-02', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-03', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-04', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-05', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-06', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-07', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-08', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-09', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-10', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-11', ecosystem: 'npm', note: PLACEHOLDER_NOTE },
  { name: 'keel-placeholder-hallucination-npm-12', ecosystem: 'npm', note: PLACEHOLDER_NOTE },

  // ── PyPI (41 expected) ──────────────────────────────────────────────
  { name: 'keel_placeholder_hallucination_pypi_01', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_02', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_03', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_04', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_05', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_06', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_07', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_08', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_09', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_10', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_11', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_12', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_13', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_14', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_15', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_16', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_17', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_18', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_19', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_20', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_21', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_22', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_23', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_24', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_25', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_26', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_27', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_28', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_29', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_30', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_31', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_32', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_33', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_34', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_35', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_36', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_37', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_38', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_39', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_40', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
  { name: 'keel_placeholder_hallucination_pypi_41', ecosystem: 'pypi', note: PLACEHOLDER_NOTE },
]

/** npm match key: lowercase only — npm names are conventionally already lowercase; this is a defensive normalization, not evidence real npm names vary in case. */
function normalizeNpmName(name: string): string {
  return name.toLowerCase()
}

/** PyPI match key per PEP 503: lowercase, with any run of `-`/`_`/`.` collapsed to a single `-` — `Foo__Bar.Baz` and `foo-bar-baz` must resolve to the same entry, exactly like PyPI's own package index does. */
function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

function normalizeForEcosystem(name: string, ecosystem: HallucinationEcosystem): string {
  return ecosystem === 'npm' ? normalizeNpmName(name) : normalizePypiName(name)
}

function indexKey(name: string, ecosystem: HallucinationEcosystem): string {
  return `${ecosystem}:${normalizeForEcosystem(name, ecosystem)}`
}

/**
 * Built once at module load, not per-lookup — `lookupKnownHallucination`
 * runs on every extracted install spec (see package-verifier.ts's
 * `withKnownHallucination`), so this must stay O(1), never rescan the
 * array.
 */
const HALLUCINATION_INDEX: Map<string, HallucinatedPackageEntry> = new Map(
  KNOWN_HALLUCINATED_PACKAGES.map(entry => [indexKey(entry.name, entry.ecosystem), entry]),
)

/**
 * O(1), zero-I/O lookup — the entire point of this being a static file
 * rather than a network call. Scoped to `ecosystem` so an npm-list name
 * never false-positive-matches a same-spelled PyPI install (or vice
 * versa) — the two ecosystems' hallucination lists are drawn from
 * different model outputs against different name grammars, and treating
 * them as one flat namespace would be exactly the kind of cross-context
 * bleed `package-verifier.ts`'s own cache keying (`${ecosystem}:${name}`,
 * see `PackageVerifierCache.key`) already goes out of its way to avoid.
 * Only `npm`/`pypi` are covered by the source research — `crates`/`go`
 * always miss here (returns `undefined`), never an error.
 */
export function lookupKnownHallucination(
  name: string,
  ecosystem: HallucinationEcosystem,
): HallucinatedPackageEntry | undefined {
  return HALLUCINATION_INDEX.get(indexKey(name, ecosystem))
}
