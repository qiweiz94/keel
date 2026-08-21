/**
 * Local-only false-positive reduction for `no-secrets-in-code`-shaped
 * `type: content` rules (install.ts's DEFAULT_RULES_YAML) — a small,
 * deterministic allowlist of known-placeholder credential SHAPES, checked
 * against a MATCHED candidate before the deny-on-write path denies.
 *
 * Deliberately offline, no exceptions: nothing here makes a network call
 * to "verify" a candidate secret against its issuing provider (an earlier
 * research pass proposed exactly that — e.g. AWS STS GetCallerIdentity —
 * and it was rejected on two grounds: (1) the harm from a leaked secret
 * happens at WRITE time, before any "verify then decide" round trip could
 * return, so there is no safe way to defer the decision; (2) Keel is
 * itself an exfil-prevention tool (docs/exfil.md, the `no-exfil-flow`
 * rule) — having its OWN enforcement hook send candidate secret material
 * to a third-party credential-issuer API would make the guardrail itself
 * an exfil channel). See pipeline.ts's Tier-5 content branch for the only
 * caller.
 *
 * Design constraint from a design-review pass on the first draft of this
 * file (kept deliberately stricter than the original spec): entropy and
 * file-path context are NOT allowed to clear (downgrade or allow) a
 * match on their own.
 *   - Shannon entropy has no labeled corpus behind it here to calibrate a
 *     defensible cutoff, and a wrong cutoff fails SILENTLY — a real
 *     secret would pass with no error, ever. `shannonEntropyBitsPerChar`
 *     below is still implemented and exported (the original spec asked
 *     for entropy scoring as "a general signal"), and pipeline.ts folds
 *     it into the deny message as an observational annotation, but it
 *     never changes the verdict.
 *   - The file path a candidate was written to is ATTACKER-CONTROLLED
 *     input: an agent (compromised, prompt-injected, or just following
 *     bad instructions) picks its own target filename. "Lower confidence
 *     because the path looks like docs/" would be a two-line bypass —
 *     write the real credential to `docs/notes.md` instead of `src/`.
 *     Context is therefore not wired into the verdict at all here; see
 *     pipeline.ts's Tier-5 comment for the regression test that pins
 *     this (a real-shaped, non-allowlisted key must still deny
 *     identically in README.md / docs/ / *.test.ts / *.example paths).
 *
 * The only thing that clears a match here is EXACT or near-exact
 * structural membership in a known placeholder-credential SHAPE — never a
 * numeric threshold:
 *   1. An exact literal pulled directly from a provider's own docs
 *      (KNOWN_PLACEHOLDER_SECRETS) — e.g. AWS's AKIAIOSFODNN7EXAMPLE.
 *   2. AWS's own documented convention of ending fabricated example
 *      access keys in the literal suffix "EXAMPLE".
 *   3. A candidate whose variable body is a REDACTION placeholder — a
 *      single character (any character; the classic convention is X/x,
 *      but AAAA... or 0000... reads the same way to a human) repeated
 *      across essentially the whole matched string. A CSPRNG-generated
 *      credential repeating one byte across 8+ consecutive output bytes
 *      has probability on the order of 1-in-alphabet-size^7 — for a
 *      36-character AWS-key alphabet that is roughly 1-in-78-billion;
 *      for GitHub/Slack/OpenAI's larger alphabets it is smaller still.
 *      This is a structural, zero-calibration fact, not a fuzzy score.
 *
 * Scope note: only meaningful for patterns whose match span IS the secret
 * bytes themselves — i.e. `redact_span: true` patterns (see types.ts's
 * `redact_span` doc comment and install.ts's `no-secrets-in-code` header
 * comment). A pattern that matches only a nearby LABEL or HEADER (PEM
 * markers, `aws_secret_access_key[:=]`) has no secret-shaped substring to
 * score here — entropy/placeholder logic on the label text itself would
 * be meaningless (a PEM header is ~3-3.5 bits/char of English-ish text;
 * scoring it here would misfire on EVERY SINGLE match of those 3
 * patterns, not an edge case). The caller in pipeline.ts gates on
 * `pattern.redact_span === true` before calling into this module at all;
 * non-redact_span patterns keep their unconditional immediate-deny
 * behavior completely untouched, and this module is never invoked for
 * them.
 *
 * Write-side only: this module is used exclusively by evaluateTiers()'s
 * Tier-5 content branch (the deny-on-write decision). It is deliberately
 * NOT wired into EnforcementPipeline.evaluateOutput() (the redaction
 * consumer for arbitrary tool stdout) — that is a structurally different
 * consumer where under-redaction is irreversible the moment the model
 * reads the output, the opposite risk bias from a write-time deny, and
 * where "path" doesn't even mean the same thing (the tool call's target,
 * not necessarily anything about where the secret text came from — a
 * `cat docs/secrets.md` would launder a real credential through a
 * write-side downgrade if this were reachable from there).
 */

export type SecretConfidenceVerdict = 'allow' | 'deny'

/**
 * Exact, individually verified literal placeholder credentials pulled
 * directly from a provider's own documentation. Deliberately a SHORT
 * list: an entry here means "always allow, never even warn" for an exact
 * match, so an unverified guess does not belong in it. Only entries this
 * author is confident are real, current, documented placeholders are
 * included — a plausible-looking but unverified string (e.g. a guessed
 * GitHub/Slack/OpenAI example token) was explicitly left out rather than
 * risk shipping a wrong literal.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set<string>([
  // AWS's own SDK/CLI/IAM-console docs' canonical example access key ID —
  // the single most copy-pasted credential-shaped string on the internet,
  // and the literal case this feature exists to fix.
  'AKIAIOSFODNN7EXAMPLE',
])

// AWS's documentation style convention: fabricated example access keys are
// constructed to end with the literal uppercase suffix "EXAMPLE" — this is
// how AKIAIOSFODNN7EXAMPLE itself is built, and the same convention
// recurs across other AWS docs pages' example keys. Treated as
// near-certain rather than "low confidence": 7 of a 16-character
// uppercase-alnum body being exactly "EXAMPLE" is roughly 1-in-78-billion
// by chance for a genuinely random key, and a REAL AWS-issued key ending
// in AWS's own reserved documentation suffix would collide with AWS's
// own naming convention for its issued keys.
const AWS_EXAMPLE_SUFFIX = 'EXAMPLE'

/** Shannon entropy of `s`, in bits per character. Observational only — see this file's header for why it never gates the verdict. */
export function shannonEntropyBitsPerChar(s: string): number {
  if (!s.length) return 0
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / s.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/**
 * True when `candidate` ends in a run of `minRun` or more repetitions of
 * a single character covering essentially the whole string (the run may
 * start a few characters in, to allow for a short literal prefix like
 * `AKIA`, `ghp_`, `sk-`, `github_pat_`, `xoxb-` before the provider's
 * random body begins). This is the redaction-placeholder shape:
 * `AKIAXXXXXXXXXXXXXXXX`, `ghp_000000000000000000000000000000000000`,
 * a hand-typed `AAAAAAAAAAAAAAAA` test fixture. See this file's header
 * for why a run this long is treated as structural fact, not a score.
 */
export function isUniformRedactionShape(candidate: string, minRun = 8): boolean {
  if (candidate.length < minRun) return false
  const last = candidate[candidate.length - 1]
  let run = 0
  for (let i = candidate.length - 1; i >= 0 && candidate[i] === last; i--) run++
  if (run < minRun) return false
  // The run must cover essentially the whole candidate — allow up to a
  // 12-character non-repeating literal prefix (covers every shipped
  // prefix: `github_pat_` is the longest at 11) before it starts.
  return run >= candidate.length - 12
}

/**
 * Score ONE matched candidate substring — a `redact_span: true` pattern's
 * match, i.e. the secret bytes themselves, not a label — against the
 * deterministic placeholder-shape allowlist above.
 *
 * `allow` means "treat as if the pattern never matched at all, never even
 * warn." Everything else is `deny` — exactly today's unconditional
 * behavior, unchanged. There is no middle "warn" tier: entropy and
 * context are surfaced separately (see pipeline.ts) as annotations on the
 * deny message, never as a reason to soften it.
 */
export function scoreSecretCandidate(candidate: string): SecretConfidenceVerdict {
  if (KNOWN_PLACEHOLDER_SECRETS.has(candidate)) return 'allow'
  if (candidate.startsWith('AKIA') && candidate.endsWith(AWS_EXAMPLE_SUFFIX)) return 'allow'
  if (isUniformRedactionShape(candidate)) return 'allow'
  return 'deny'
}

/**
 * Scan every occurrence of `regexSource` in `content` (not just the
 * first — a real secret elsewhere in the same file must not be masked by
 * an earlier placeholder match) and return `'deny'` if ANY occurrence
 * scores `deny`, `'allow'` if every occurrence scored `allow`, or `null`
 * if the pattern did not match anything at all — distinct from `allow`,
 * so the caller's loop moves on to the next pattern exactly as it did
 * before this filter existed.
 *
 * Case-insensitive to match `matchesRulePattern`'s existing behavior for
 * this same pattern list. Capped at 1000 iterations as a cheap guard
 * against a pathological regex/content combination; every shipped
 * redact_span pattern is a short, non-catastrophic literal-prefix regex.
 */
export function worstSecretVerdict(regexSource: string, content: string): SecretConfidenceVerdict | null {
  let re: RegExp
  try {
    re = new RegExp(regexSource, 'gi')
  } catch {
    return null
  }
  let match: RegExpExecArray | null
  let sawAny = false
  let iterations = 0
  while ((match = re.exec(content)) && iterations < 1000) {
    iterations++
    if (match[0] === '') { re.lastIndex++; continue }
    sawAny = true
    if (scoreSecretCandidate(match[0]) === 'deny') return 'deny'
  }
  return sawAny ? 'allow' : null
}
